/**
 * Persistent GPU record stores of the Graphics front (ARCHITECTURE §27.4),
 * chunk `graphics`.
 *
 * A `RecordStore` keeps fixed-size records at stable indices: a node's shape
 * records, its node record and its unified mesh vertices are allocated once
 * (first fit over a sorted free list, capacity grown ×1.5) and rewritten in
 * place when their inputs change. Draw order is not stored here: it lives in
 * the item streams (`ItemRegion`), so moving a node rewrites its records and
 * nothing else.
 *
 * An `ItemRegion` is a store of u32 items filled front to back by one
 * recording: the per-frame region (key 0, refilled every frame), a retained
 * segment's region (refilled when the segment is recorded) or a static bake's
 * region. `seq` counts recordings, so a node whose items sit at the same
 * place as in the previous recording can skip rewriting them.
 *
 * Uploads: one ALLOC after growth or a device loss (then everything up to
 * `top` is re-sent), otherwise the dirty ranges, inline or from shared
 * memory. Steady state allocates nothing.
 */
import { Op } from '../commands/opcodes';
import { GfxOp, GfxPoolKind } from '../commands/gfxOpcodes';
import type { FrontFrame } from '../types/core';

/** Pool kind of the stores that use the M4 shape / node buffer opcodes. */
export const LEGACY_SHAPES = -1;
export const LEGACY_NODES = -2;

/** Dirty ranges kept per store; more are merged (nearest first). */
const MAX_DIRTY = 4;
/** Records between two dirty ranges that are uploaded rather than split. */
const DIRTY_GAP = 16;

/**
 * Sorted, disjoint record ranges [starts[i], ends[i]) to upload. Kept here
 * rather than shared with the sprite packer's DirtyRanges, so this chunk does
 * not split that module out of the minimal program.
 */
export class Dirty {
  readonly starts = new Int32Array(MAX_DIRTY + 1);
  readonly ends = new Int32Array(MAX_DIRTY + 1);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  add(start: number, end: number): void {
    const s = this.starts;
    const e = this.ends;
    let i = 0;
    while (i < this.count && e[i] + DIRTY_GAP < start) i++;
    if (i < this.count && s[i] <= end + DIRTY_GAP) {
      // Overlaps or nearly touches range i: grow it, then swallow followers.
      if (start < s[i]) s[i] = start;
      if (end > e[i]) e[i] = end;
      let j = i + 1;
      while (j < this.count && s[j] <= e[i] + DIRTY_GAP) {
        if (e[j] > e[i]) e[i] = e[j];
        j++;
      }
      const gone = j - i - 1;
      if (gone > 0) {
        for (let k = i + 1; k + gone < this.count; k++) {
          s[k] = s[k + gone];
          e[k] = e[k + gone];
        }
        this.count -= gone;
      }
      return;
    }
    for (let k = this.count; k > i; k--) {
      s[k] = s[k - 1];
      e[k] = e[k - 1];
    }
    s[i] = start;
    e[i] = end;
    if (++this.count > MAX_DIRTY) {
      // Merge the two ranges with the smallest gap.
      let best = 0;
      for (let k = 1; k < this.count - 1; k++) {
        if (s[k + 1] - e[k] < s[best + 1] - e[best]) best = k;
      }
      e[best] = e[best + 1];
      for (let k = best + 1; k < this.count - 1; k++) {
        s[k] = s[k + 1];
        e[k] = e[k + 1];
      }
      this.count--;
    }
  }
}

/** Ids of the M4 shape and node buffers (shared id space, private to the core). */
let nextBufferId = 1;
/** Pool ids, one id space per GfxPoolKind (private to the core). */
const nextPoolId = [1, 1, 1];

export class RecordStore {
  buf: ArrayBuffer | SharedArrayBuffer = new ArrayBuffer(0);
  u8: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  f32: Float32Array<ArrayBufferLike> = new Float32Array(0);
  u32: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  /** Capacity in records, on the CPU and on the GPU. */
  cap = 0;
  gpuCap = 0;
  /** End of the used records (allocator high-water mark, or the item cursor). */
  top = 0;
  /** Sorted free blocks below `top`. */
  private freeAt = new Int32Array(8);
  private freeLen = new Int32Array(8);
  private nFree = 0;
  readonly dirty = new Dirty();
  /** Everything below `top` goes up with the next upload. */
  private full = true;
  private sharedBuf: ArrayBuffer | SharedArrayBuffer | null = null;
  private sharedId = 0;
  readonly id: number;

  /**
   * @param words u32 words per record
   * @param kind  GfxPoolKind, or LEGACY_SHAPES / LEGACY_NODES
   */
  constructor(
    readonly words: number,
    readonly kind: number,
  ) {
    this.id = kind < 0 ? nextBufferId++ : nextPoolId[kind]++;
  }

  /** Grows the CPU store to hold `n` records (×1.5, copying). */
  ensure(n: number, sab: boolean): void {
    if (n <= this.cap) return;
    const cap = Math.max(64, Math.ceil(n * 1.5));
    const bytes = cap * this.words * 4;
    const buf =
      sab && typeof SharedArrayBuffer !== 'undefined'
        ? new SharedArrayBuffer(bytes)
        : new ArrayBuffer(bytes);
    const u32 = new Uint32Array(buf);
    u32.set(this.u32);
    this.buf = buf;
    this.u32 = u32;
    this.u8 = new Uint8Array(buf);
    this.f32 = new Float32Array(buf);
    this.cap = cap;
  }

  /** First index of `n` free consecutive records (first fit). */
  alloc(n: number, sab: boolean): number {
    const at = this.freeAt;
    const len = this.freeLen;
    for (let i = 0; i < this.nFree; i++) {
      if (len[i] < n) continue;
      const first = at[i];
      if (len[i] === n) {
        this.nFree--;
        for (let j = i; j < this.nFree; j++) {
          at[j] = at[j + 1];
          len[j] = len[j + 1];
        }
      } else {
        at[i] += n;
        len[i] -= n;
      }
      return first;
    }
    const first = this.top;
    this.top += n;
    this.ensure(this.top, sab);
    return first;
  }

  /** Returns records [first, first + n) to the free list. */
  free(first: number, n: number): void {
    if (n <= 0) return;
    let at = this.freeAt;
    let len = this.freeLen;
    if (first + n === this.top) {
      this.top = first;
      // A free block that now touches the top shrinks it further.
      const last = this.nFree - 1;
      if (last >= 0 && at[last] + len[last] === this.top) {
        this.top = at[last];
        this.nFree--;
      }
      return;
    }
    let i = 0;
    while (i < this.nFree && at[i] < first) i++;
    // Merge with the block before and/or after.
    const before = i > 0 && at[i - 1] + len[i - 1] === first;
    const after = i < this.nFree && first + n === at[i];
    if (before && after) {
      len[i - 1] += n + len[i];
      this.nFree--;
      for (let j = i; j < this.nFree; j++) {
        at[j] = at[j + 1];
        len[j] = len[j + 1];
      }
      return;
    }
    if (before) {
      len[i - 1] += n;
      return;
    }
    if (after) {
      at[i] = first;
      len[i] += n;
      return;
    }
    if (this.nFree === at.length) {
      const a = new Int32Array(at.length * 2);
      const l = new Int32Array(at.length * 2);
      a.set(at);
      l.set(len);
      this.freeAt = at = a;
      this.freeLen = len = l;
    }
    for (let j = this.nFree; j > i; j--) {
      at[j] = at[j - 1];
      len[j] = len[j - 1];
    }
    at[i] = first;
    len[i] = n;
    this.nFree++;
  }

  /** Free records below `top` (tests). */
  get freeRecords(): number {
    let n = 0;
    for (let i = 0; i < this.nFree; i++) n += this.freeLen[i];
    return n;
  }

  /** Marks records [first, first + n) for the next upload. */
  touch(first: number, n: number): void {
    if (n > 0) this.dirty.add(first, first + n);
  }

  /** The GPU copy is gone (device loss): re-allocate and re-send all. */
  lost(): void {
    this.gpuCap = 0;
    this.sharedBuf = null;
    this.sharedId = 0;
  }

  /** Empties the store (an item region starting a new recording). */
  reset(): void {
    this.top = 0;
    this.nFree = 0;
    this.dirty.clear();
  }

  /** ALLOC after growth, then the dirty records up to `top`. */
  upload(frame: FrontFrame): void {
    const count = this.top;
    const dirty = this.dirty;
    if (count === 0) {
      dirty.clear();
      return;
    }
    const enc = frame.encoder;
    const pool = this.kind >= 0;
    if (this.gpuCap < this.cap) {
      if (pool) {
        enc.begin(GfxOp.GFX_POOL_ALLOC, 12);
        enc.u32(this.kind);
      } else {
        enc.begin(
          this.kind === LEGACY_SHAPES
            ? GfxOp.GFX_SHAPE_BUFFER_ALLOC
            : GfxOp.GFX_NODE_BUFFER_ALLOC,
          8,
        );
      }
      enc.u32(this.id);
      enc.u32(this.cap);
      enc.end();
      this.gpuCap = this.cap;
      this.full = true;
    }
    if (this.full) {
      this.full = false;
      dirty.clear();
      dirty.add(0, count);
    }
    const stride = this.words * 4;
    const shared = frame.sharedMemory;
    if (shared && dirty.count > 0 && this.sharedBuf !== this.buf) {
      if (this.sharedId !== 0) {
        enc.begin(Op.SHARED_RELEASE, 4);
        enc.u32(this.sharedId);
        enc.end();
      }
      this.sharedBuf = this.buf;
      this.sharedId = frame.registerShared(this.buf);
    }
    const head = pool ? 16 : 12;
    for (let r = 0; r < dirty.count; r++) {
      const first = dirty.starts[r];
      const n = Math.min(dirty.ends[r], count) - first;
      if (n <= 0) continue;
      if (shared) {
        enc.begin(
          pool
            ? GfxOp.GFX_POOL_UPLOAD_SHARED
            : this.kind === LEGACY_SHAPES
              ? GfxOp.GFX_SHAPE_UPLOAD_SHARED
              : GfxOp.GFX_NODE_UPLOAD_SHARED,
          head + 8,
        );
      } else {
        enc.begin(
          pool
            ? GfxOp.GFX_POOL_UPLOAD
            : this.kind === LEGACY_SHAPES
              ? GfxOp.GFX_SHAPE_UPLOAD
              : GfxOp.GFX_NODE_UPLOAD,
          head + n * stride,
        );
      }
      if (pool) enc.u32(this.kind);
      enc.u32(this.id);
      enc.u32(first);
      enc.u32(n);
      if (shared) {
        enc.u32(this.sharedId);
        enc.u32(0);
      } else {
        enc.bytes(this.u8, first * stride, n * stride);
      }
      enc.end();
    }
    dirty.clear();
  }
}

/** One item stream (§27.4): a run of u32 items filled by one recording. */
export class ItemRegion extends RecordStore {
  /** Recordings so far; bumped when a new one starts. */
  seq = 0;
  /** Frame of the current recording. */
  frameId = -1;

  constructor(readonly key: number) {
    super(1, GfxPoolKind.ITEMS);
  }

  /** Starts a new recording the first time `frameId` writes this region. */
  begin(frameId: number): void {
    if (this.frameId === frameId) return;
    this.frameId = frameId;
    this.seq++;
    this.reset();
  }
}
