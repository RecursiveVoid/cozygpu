/**
 * NodeBase — owner: "sprites". Shared implementation of SceneNode.
 *
 * A node is a small handle: `_slot` indexes the NodeStore, and every numeric
 * property reads/writes the shared typed arrays and sets a dirty bit. No
 * setter allocates.
 *
 * Other drawables (Swarm, later Graphics/Text) should `extends NodeBase` so
 * the ScenePacker computes their world transform in the same flat pass.
 */
import { affineFromTRS, affineMultiply, affineCopy } from '../math/affine';
import { CozyGPUError } from '../types/errors';
import { ids } from '../types/ids';
import { SI_PICK_MAX, SI_PICK_SHIFT } from '../types/layouts';
import {
  AFFINE_STRIDE,
  Dirty,
  L_ALPHA,
  L_PIVOT_X,
  L_PIVOT_Y,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  L_SKEW_X,
  L_SKEW_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  TOUCH_MASK,
  allocSlot,
  bumpNode,
  markDirty,
  freeSlot,
  materializeWorld,
  nodeStore,
} from './store';
import type {
  ContainerNode,
  DestroyOptions,
  NodeKind,
  NodeOptions,
  SceneNode,
} from './types';

export abstract class NodeBase implements SceneNode {
  readonly id: number;
  /** Defaults to '' through the prototype (no per-node field until set). */
  declare label: string;
  /** @internal NodeStore slot. */
  _slot: number;
  /** @internal */
  _parent: ContainerNode | null = null;
  /** @internal */
  _visible = true;
  /** @internal */
  _destroyed = false;
  /** @internal M2: undefined = kind default (sprite true, others false). */
  _pickable: boolean | undefined = undefined;

  abstract get kind(): NodeKind;

  constructor(options?: NodeOptions) {
    this.id = ids.node.alloc();
    this._slot = allocSlot();
    if (options) this._applyNodeOptions(options);
    if (this.pickable) this._writePickId(true);
  }

  /** @internal Pick id bits of the slot's SI_FLAGS word (ARCHITECTURE §4.1). */
  _writePickId(pickable: boolean): void {
    const f = nodeStore.flags;
    const slot = this._slot;
    const id = this.id;
    const bits = pickable && id <= SI_PICK_MAX ? id << SI_PICK_SHIFT : 0;
    f[slot] = (f[slot] & ((1 << SI_PICK_SHIFT) - 1)) | bits;
  }

  /** @internal */
  protected _applyNodeOptions(o: NodeOptions): void {
    if (o.label !== undefined) this.label = o.label;
    const L = nodeStore.local;
    const lo = this._slot * LOCAL_STRIDE;
    const P = nodeStore.pos;
    if (o.x !== undefined) P[this._slot * POS_STRIDE] = o.x;
    if (o.y !== undefined) P[this._slot * POS_STRIDE + 1] = o.y;
    if (o.rotation !== undefined) L[lo + L_ROT] = o.rotation;
    if (o.scale !== undefined) {
      L[lo + L_SCALE_X] = o.scale;
      L[lo + L_SCALE_Y] = o.scale;
    }
    if (o.scaleX !== undefined) L[lo + L_SCALE_X] = o.scaleX;
    if (o.scaleY !== undefined) L[lo + L_SCALE_Y] = o.scaleY;
    if (o.skewX !== undefined) L[lo + L_SKEW_X] = o.skewX;
    if (o.skewY !== undefined) L[lo + L_SKEW_Y] = o.skewY;
    if (o.pivotX !== undefined) L[lo + L_PIVOT_X] = o.pivotX;
    if (o.pivotY !== undefined) L[lo + L_PIVOT_Y] = o.pivotY;
    if (o.alpha !== undefined) L[lo + L_ALPHA] = o.alpha;
    if (o.visible !== undefined) this._visible = o.visible;
    if (o.pickable !== undefined) this._pickable = o.pickable;
  }

  get parent(): ContainerNode | null {
    return this._parent;
  }

  // ─── Transform components ──────────────────────────────────────────────────

  get x(): number {
    return nodeStore.pos[this._slot * POS_STRIDE];
  }
  set x(v: number) {
    nodeStore.pos[this._slot * POS_STRIDE] = v;
    markDirty(this._slot, Dirty.POSITION);
  }
  get y(): number {
    return nodeStore.pos[this._slot * POS_STRIDE + 1];
  }
  set y(v: number) {
    nodeStore.pos[this._slot * POS_STRIDE + 1] = v;
    markDirty(this._slot, Dirty.POSITION);
  }
  get rotation(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_ROT];
  }
  set rotation(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_ROT] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get scaleX(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_SCALE_X];
  }
  set scaleX(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_SCALE_X] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get scaleY(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_SCALE_Y];
  }
  set scaleY(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_SCALE_Y] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get skewX(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_SKEW_X];
  }
  set skewX(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_SKEW_X] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get skewY(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_SKEW_Y];
  }
  set skewY(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_SKEW_Y] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get pivotX(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_PIVOT_X];
  }
  set pivotX(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_PIVOT_X] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get pivotY(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_PIVOT_Y];
  }
  set pivotY(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_PIVOT_Y] = v;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get alpha(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_ALPHA];
  }
  set alpha(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_ALPHA] = v;
    markDirty(this._slot, Dirty.ALPHA);
  }
  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    if (this._visible === v) return;
    this._visible = v;
    bumpNode(this);
  }

  /**
   * M2 (ARCHITECTURE §16.3). Default: true for sprites, false otherwise.
   * Rewrites the pick id in the slot's instance flags (Dirty.SPRITE, no
   * structure change).
   */
  get pickable(): boolean {
    const p = this._pickable;
    return p === undefined ? this.kind === 'sprite' : p;
  }
  set pickable(v: boolean) {
    v = !!v;
    if (v === this.pickable && this._pickable !== undefined) return;
    this._pickable = v;
    this._writePickId(v);
    markDirty(this._slot, Dirty.SPRITE);
  }

  setPosition(x: number, y: number): this {
    // Hot in per-frame update loops: markDirty inlined by hand.
    const s = nodeStore;
    const slot = this._slot;
    const P = s.pos;
    const po = slot * POS_STRIDE;
    P[po] = x;
    P[po + 1] = y;
    s.dirty[slot] |= Dirty.POSITION;
    s.touch = (s.touch + 1) & TOUCH_MASK;
    return this;
  }

  setScale(x: number, y: number = x): this {
    const L = nodeStore.local;
    L[this._slot * LOCAL_STRIDE + L_SCALE_X] = x;
    L[this._slot * LOCAL_STRIDE + L_SCALE_Y] = y;
    markDirty(this._slot, Dirty.LOCAL);
    return this;
  }

  setPivot(x: number, y: number): this {
    const L = nodeStore.local;
    L[this._slot * LOCAL_STRIDE + L_PIVOT_X] = x;
    L[this._slot * LOCAL_STRIDE + L_PIVOT_Y] = y;
    markDirty(this._slot, Dirty.LOCAL);
    return this;
  }

  // ─── World ─────────────────────────────────────────────────────────────────

  get worldTransform(): Float32Array {
    // The packer may keep a moved sprite's translation in `worldT` only.
    materializeWorld(this._slot);
    return nodeStore.world;
  }
  get worldTransformOffset(): number {
    return this._slot * AFFINE_STRIDE;
  }
  get worldAlpha(): number {
    return nodeStore.worldAlpha[this._slot];
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  get destroyed(): boolean {
    return this._destroyed;
  }

  removeFromParent(): void {
    if (this._parent) this._parent.removeChild(this);
  }

  destroy(_options?: DestroyOptions): void {
    if (this._destroyed) return;
    this.removeFromParent();
    this._destroyed = true;
    freeSlot(this._slot);
    ids.node.free(this.id);
  }

  /** @internal Throws when used after destroy(). */
  protected _assertAlive(what: string): void {
    if (this._destroyed) {
      throw new CozyGPUError('DESTROYED', `${what} on a destroyed node`);
    }
  }
}

NodeBase.prototype.label = '';

/** @internal Recomputes `slot`'s local affine from its TRS components. */
export function computeLocalAffine(slot: number): void {
  const s = nodeStore;
  const L = s.local;
  const lo = slot * LOCAL_STRIDE;
  affineFromTRS(
    s.localAffine,
    slot * AFFINE_STRIDE,
    s.pos[slot * POS_STRIDE],
    s.pos[slot * POS_STRIDE + 1],
    L[lo + L_ROT],
    L[lo + L_SCALE_X],
    L[lo + L_SCALE_Y],
    L[lo + L_SKEW_X],
    L[lo + L_SKEW_Y],
    L[lo + L_PIVOT_X],
    L[lo + L_PIVOT_Y],
  );
}

/**
 * @internal world(slot) = world(parentSlot) · local(slot); parentSlot < 0 means
 * root (world = local).
 */
export function computeWorld(slot: number, parentSlot: number): void {
  const s = nodeStore;
  const wo = slot * AFFINE_STRIDE;
  if (parentSlot < 0) {
    affineCopy(s.world, wo, s.localAffine, wo);
    s.worldAlpha[slot] = s.local[slot * LOCAL_STRIDE + L_ALPHA];
  } else {
    affineMultiply(
      s.world,
      wo,
      s.world,
      parentSlot * AFFINE_STRIDE,
      s.localAffine,
      wo,
    );
    s.worldAlpha[slot] =
      s.worldAlpha[parentSlot] * s.local[slot * LOCAL_STRIDE + L_ALPHA];
  }
  // worldT is the authoritative translation (see NodeStore.worldT).
  s.worldT[slot * 2] = s.world[wo + 4];
  s.worldT[slot * 2 + 1] = s.world[wo + 5];
}

export function isNodeBase(node: unknown): node is NodeBase {
  return node instanceof NodeBase;
}
