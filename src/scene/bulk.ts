/**
 * ChildBulk — owner: "sprites". The dense writer behind
 * `Container.bulkChildren()` (ARCHITECTURE §16.1).
 *
 * Holds a snapshot of the children's NodeStore slots (refreshed when the
 * container's `childrenVersion` changes) and one growable typed array per
 * field. `commit` copies a field into the store in one tight loop per field,
 * ORs the dirty bits and bumps `touch` once. A POSITION-only commit sets only
 * `Dirty.POSITION`, so the packer takes its translation fast path over the
 * whole run of children.
 *
 * Arrays are sized for every field requested so far (a field requested once
 * stays sized), so alternating `bulkChildren(POSITION)` and
 * `bulkChildren(ROTATION)` never reallocates. Fields never requested are
 * zero-length.
 */
import { CozyGPUError } from '../types/errors';
import { NodeBase } from './Node';
import {
  Dirty,
  L_ALPHA,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  TOUCH_MASK,
  nodeStore,
} from './store';
import { BulkField } from './types';
import type { BulkChildren, SceneNode, SpriteNode } from './types';

/** What the writer needs from its Container (avoids an import cycle). */
export interface BulkHost {
  readonly _children: SceneNode[];
  readonly _childrenVersion: number;
}

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);
const ALL_FIELDS =
  BulkField.POSITION |
  BulkField.ROTATION |
  BulkField.SCALE |
  BulkField.ALPHA |
  BulkField.TINT;

function growF32(buf: Float32Array, n: number): Float32Array {
  if (buf.length >= n) return buf;
  const next = new Float32Array(Math.max(n, buf.length * 2));
  next.set(buf);
  return next;
}

export class ChildBulk implements BulkChildren {
  count = 0;
  /** -1 until the first acquire. */
  version = -1;
  position: Float32Array = EMPTY_F32;
  rotation: Float32Array = EMPTY_F32;
  scale: Float32Array = EMPTY_F32;
  alpha: Float32Array = EMPTY_F32;
  tint: Uint32Array = EMPTY_U32;

  /** Store slot per child; -1 for SceneNodes that do not extend NodeBase. */
  private slots = new Int32Array(0);
  /** 1 when the child is a sprite (TINT applies). */
  private sprite = new Uint8Array(0);
  private foreign = false;
  /** BulkField bits whose arrays are sized. */
  private sized = 0;
  private posBuf: Float32Array = EMPTY_F32;
  private rotBuf: Float32Array = EMPTY_F32;
  private scaleBuf: Float32Array = EMPTY_F32;
  private alphaBuf: Float32Array = EMPTY_F32;
  private tintBuf: Uint32Array = EMPTY_U32;

  constructor(private readonly host: BulkHost) {}

  /** @internal Called by Container.bulkChildren(). */
  _acquire(fields: number): void {
    const host = this.host;
    const want = (fields & ALL_FIELDS) | this.sized;
    if (host._childrenVersion !== this.version) {
      this.snapshot();
      this.resize(want, true);
    } else if (want !== this.sized) {
      this.resize(want, false);
    }
  }

  private snapshot(): void {
    const children = this.host._children;
    const n = children.length;
    if (this.slots.length < n) {
      const cap = Math.max(n, this.slots.length * 2);
      this.slots = new Int32Array(cap);
      this.sprite = new Uint8Array(cap);
    }
    const slots = this.slots;
    const sprite = this.sprite;
    let foreign = false;
    for (let i = 0; i < n; i++) {
      const child = children[i];
      if (child instanceof NodeBase) {
        slots[i] = child._slot;
      } else {
        slots[i] = -1;
        foreign = true;
      }
      sprite[i] = child.kind === 'sprite' ? 1 : 0;
    }
    this.foreign = foreign;
    this.count = n;
    this.version = this.host._childrenVersion;
  }

  /** Sizes the arrays of `fields`; `force` re-slices every sized view. */
  private resize(fields: number, force: boolean): void {
    const n = this.count;
    if ((fields & BulkField.POSITION) !== 0) {
      const buf = growF32(this.posBuf, n * 2);
      if (force || buf !== this.posBuf || this.position.length !== n * 2) {
        this.posBuf = buf;
        this.position = buf.subarray(0, n * 2);
      }
    }
    if ((fields & BulkField.ROTATION) !== 0) {
      const buf = growF32(this.rotBuf, n);
      if (force || buf !== this.rotBuf || this.rotation.length !== n) {
        this.rotBuf = buf;
        this.rotation = buf.subarray(0, n);
      }
    }
    if ((fields & BulkField.SCALE) !== 0) {
      const buf = growF32(this.scaleBuf, n * 2);
      if (force || buf !== this.scaleBuf || this.scale.length !== n * 2) {
        this.scaleBuf = buf;
        this.scale = buf.subarray(0, n * 2);
      }
    }
    if ((fields & BulkField.ALPHA) !== 0) {
      const buf = growF32(this.alphaBuf, n);
      if (force || buf !== this.alphaBuf || this.alpha.length !== n) {
        this.alphaBuf = buf;
        this.alpha = buf.subarray(0, n);
      }
    }
    if ((fields & BulkField.TINT) !== 0) {
      let buf = this.tintBuf;
      if (buf.length < n) {
        const next = new Uint32Array(Math.max(n, buf.length * 2));
        next.set(buf);
        buf = next;
      }
      if (force || buf !== this.tintBuf || this.tint.length !== n) {
        this.tintBuf = buf;
        this.tint = buf.subarray(0, n);
      }
    }
    this.sized = fields;
  }

  private check(
    what: string,
    fields: number,
    first: number,
    count: number,
  ): void {
    if (this.version !== this.host._childrenVersion) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `BulkChildren.${what}: the children changed; call bulkChildren() again`,
      );
    }
    if (
      !(first >= 0 && count >= 0 && first + count <= this.count) ||
      first !== Math.floor(first) ||
      count !== Math.floor(count)
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `BulkChildren.${what}: range [${first}, ${first + count}) outside [0, ${this.count}]`,
      );
    }
    const missing = fields & ALL_FIELDS & ~this.sized;
    if (missing !== 0) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `BulkChildren.${what}: fields ${missing} were not requested in bulkChildren()`,
      );
    }
  }

  pull(fields: number, first = 0, count = this.count - first): void {
    this.check('pull', fields, first, count);
    const s = nodeStore;
    const slots = this.slots;
    const end = first + count;
    if (this.foreign) {
      this.pullForeign(fields, first, end);
      return;
    }
    if ((fields & BulkField.POSITION) !== 0) {
      const P = s.pos;
      const out = this.position;
      for (let i = first; i < end; i++) {
        const po = slots[i] * POS_STRIDE;
        out[i * 2] = P[po];
        out[i * 2 + 1] = P[po + 1];
      }
    }
    const L = s.local;
    if ((fields & BulkField.ROTATION) !== 0) {
      const out = this.rotation;
      for (let i = first; i < end; i++) {
        out[i] = L[slots[i] * LOCAL_STRIDE + L_ROT];
      }
    }
    if ((fields & BulkField.SCALE) !== 0) {
      const out = this.scale;
      for (let i = first; i < end; i++) {
        const lo = slots[i] * LOCAL_STRIDE;
        out[i * 2] = L[lo + L_SCALE_X];
        out[i * 2 + 1] = L[lo + L_SCALE_Y];
      }
    }
    if ((fields & BulkField.ALPHA) !== 0) {
      const out = this.alpha;
      for (let i = first; i < end; i++) {
        out[i] = L[slots[i] * LOCAL_STRIDE + L_ALPHA];
      }
    }
    if ((fields & BulkField.TINT) !== 0) {
      const out = this.tint;
      const T = s.tint;
      const sprite = this.sprite;
      for (let i = first; i < end; i++) {
        if (sprite[i] === 1) out[i] = T[slots[i]];
      }
    }
  }

  commit(fields: number, first = 0, count = this.count - first): void {
    this.check('commit', fields, first, count);
    if (count === 0) return;
    const s = nodeStore;
    const slots = this.slots;
    const dirty = s.dirty;
    const end = first + count;
    if (this.foreign) {
      this.commitForeign(fields, first, end);
      return;
    }
    if ((fields & BulkField.POSITION) !== 0) {
      const P = s.pos;
      const src = this.position;
      for (let i = first; i < end; i++) {
        const slot = slots[i];
        const po = slot * POS_STRIDE;
        P[po] = src[i * 2];
        P[po + 1] = src[i * 2 + 1];
        dirty[slot] |= Dirty.POSITION;
      }
    }
    const L = s.local;
    if ((fields & BulkField.ROTATION) !== 0) {
      const src = this.rotation;
      for (let i = first; i < end; i++) {
        const slot = slots[i];
        L[slot * LOCAL_STRIDE + L_ROT] = src[i];
        dirty[slot] |= Dirty.LOCAL;
      }
    }
    if ((fields & BulkField.SCALE) !== 0) {
      const src = this.scale;
      for (let i = first; i < end; i++) {
        const slot = slots[i];
        const lo = slot * LOCAL_STRIDE;
        L[lo + L_SCALE_X] = src[i * 2];
        L[lo + L_SCALE_Y] = src[i * 2 + 1];
        dirty[slot] |= Dirty.LOCAL;
      }
    }
    if ((fields & BulkField.ALPHA) !== 0) {
      const src = this.alpha;
      for (let i = first; i < end; i++) {
        const slot = slots[i];
        L[slot * LOCAL_STRIDE + L_ALPHA] = src[i];
        dirty[slot] |= Dirty.ALPHA;
      }
    }
    if ((fields & BulkField.TINT) !== 0) {
      const src = this.tint;
      const T = s.tint;
      const sprite = this.sprite;
      for (let i = first; i < end; i++) {
        if (sprite[i] !== 1) continue;
        const slot = slots[i];
        T[slot] = src[i] & 0xffffff;
        dirty[slot] |= Dirty.SPRITE;
      }
    }
    s.touch = (s.touch + 1) & TOUCH_MASK;
  }

  /** Slow path through the public setters when a child is not a NodeBase. */
  private commitForeign(fields: number, first: number, end: number): void {
    const children = this.host._children;
    for (let i = first; i < end; i++) {
      const node = children[i];
      if ((fields & BulkField.POSITION) !== 0) {
        node.setPosition(this.position[i * 2], this.position[i * 2 + 1]);
      }
      if ((fields & BulkField.ROTATION) !== 0) node.rotation = this.rotation[i];
      if ((fields & BulkField.SCALE) !== 0) {
        node.setScale(this.scale[i * 2], this.scale[i * 2 + 1]);
      }
      if ((fields & BulkField.ALPHA) !== 0) node.alpha = this.alpha[i];
      if ((fields & BulkField.TINT) !== 0 && this.sprite[i] === 1) {
        (node as SpriteNode).tint = this.tint[i];
      }
    }
  }

  private pullForeign(fields: number, first: number, end: number): void {
    const children = this.host._children;
    for (let i = first; i < end; i++) {
      const node = children[i];
      if ((fields & BulkField.POSITION) !== 0) {
        this.position[i * 2] = node.x;
        this.position[i * 2 + 1] = node.y;
      }
      if ((fields & BulkField.ROTATION) !== 0) this.rotation[i] = node.rotation;
      if ((fields & BulkField.SCALE) !== 0) {
        this.scale[i * 2] = node.scaleX;
        this.scale[i * 2 + 1] = node.scaleY;
      }
      if ((fields & BulkField.ALPHA) !== 0) this.alpha[i] = node.alpha;
      if ((fields & BulkField.TINT) !== 0 && this.sprite[i] === 1) {
        this.tint[i] = (node as SpriteNode).tint;
      }
    }
  }
}
