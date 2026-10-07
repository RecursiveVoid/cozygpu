/**
 * NodeStore. Process-wide SoA storage for every scene node
 * (ARCHITECTURE §5.1). Nodes are handles holding a `slot`; their numbers live
 * here. Arrays are replaced on growth (×2), so always read them through the
 * `nodeStore` object, never cache a view across node creation.
 */
import { affineIdentity } from '../math/affine';

// ─── Position: POS_STRIDE f32 per slot (x, y) ────────────────────────────────
// Kept apart from the local record: per-frame position updates then touch an
// 8-byte stride instead of a whole local record (memory bandwidth at 1M).
export const POS_STRIDE = 2;

// ─── Local record: LOCAL_STRIDE f32 per slot ─────────────────────────────────
export const LOCAL_STRIDE = 12;
export const L_ROT = 0;
export const L_SCALE_X = 1;
export const L_SCALE_Y = 2;
export const L_SKEW_X = 3;
export const L_SKEW_Y = 4;
export const L_PIVOT_X = 5;
export const L_PIVOT_Y = 6;
export const L_ALPHA = 7;
/** Sprite only. */
export const L_ANCHOR_X = 8;
export const L_ANCHOR_Y = 9;
/** Sprite only: texture frame size in px. */
export const L_FRAME_W = 10;
export const L_FRAME_H = 11;

/** 6 f32 per slot: [a, b, c, d, tx, ty]. */
export const AFFINE_STRIDE = 6;
/** 4 u16 per slot: u0, v0, u1, v1 (unorm16). */
export const UV_STRIDE = 4;

/** Per-slot dirty bits. */
export const Dirty = {
  /** A TRS component changed: recompute local affine and world. */
  LOCAL: 1 << 0,
  /** alpha changed: recompute worldAlpha. */
  ALPHA: 1 << 1,
  /** Sprite data changed (tint, anchor, texture frame): rewrite the instance. */
  SPRITE: 1 << 2,
  /**
   * Only x / y changed: the cached local 2×2 is still valid, so the packer
   * updates translations only. LOCAL implies POSITION.
   */
  POSITION: 1 << 3,
  ALL: (1 << 0) | (1 << 1) | (1 << 2),
} as const;

const INITIAL_CAPACITY = 256;
/**
 * `touch` wraps inside the small-integer range so the hot counter never turns
 * into a heap double (1M markDirty calls per frame pass 2^30 in ~18 s).
 */
export const TOUCH_MASK = 0x3fffffff;

export interface NodeStore {
  capacity: number;
  /** x, y per slot (POS_STRIDE). */
  pos: Float32Array;
  local: Float32Array;
  /** Cached local affine (valid after a LOCAL recompute). */
  localAffine: Float32Array;
  world: Float32Array;
  /**
   * Authoritative world translation, x and y per slot. The packer's hot loop
   * for moved sprites writes only this dense pair, not `world`'s 24-byte
   * stride, so `world[4]`/`world[5]` may lag; `materializeWorld()` refreshes
   * them. Every other writer of `world` writes both.
   */
  worldT: Float32Array;
  worldAlpha: Float32Array;
  dirty: Uint8Array;
  /** 0xRRGGBB. */
  tint: Uint32Array;
  uv: Uint16Array;
  /**
   * SI_FLAGS word per slot: SpriteInstanceFlag bits 0–7 and the pick id in
   * bits 8–31 (the node id when pickable, else 0), written verbatim into the
   * instance.
   */
  flags: Uint32Array;
  /**
   * M2.5: `SceneNode.userId` per slot (ARCHITECTURE §19.3). Never drawn, so
   * writes set no dirty bit.
   */
  userId: Uint32Array;
  /**
   * Bumped on anything that changes draw order or batch boundaries: add,
   * remove, reorder, visibility, texture source or blend mode changes.
   */
  structureVersion: number;
  /**
   * Bumped by every markDirty() (and slot alloc/free). A packer whose tree
   * did not change structure and saw the same value last frame can skip its
   * transform pass entirely.
   */
  touch: number;
  /**
   * M5 (ARCHITECTURE §27.2). Bumped by changes that alter draw commands or
   * Graphics records without touching a node (a GraphicsContext edit, a
   * Graphics tint or blend mode, something a drawable waits for landing). A
   * retained frame with the same structure, `touch` and `drawEpoch` as the
   * last one replays every segment without visiting a node.
   */
  drawEpoch: number;
  /**
   * M5 (ARCHITECTURE §27.5). Static scope per slot: the scope id of the
   * static container whose bake draws the node, 0 for none. Allocated (and
   * grown) by the `static` chunk; null while no static container exists.
   */
  scope?: Uint32Array;
  /** M5. Changes inside each static scope, by scope id (`static` chunk). */
  scopeTouch?: Uint32Array;
  /** Live slot count (debug/tests). */
  live: number;
  /**
   * M3. Live `Group` nodes (ARCHITECTURE §21.4). A group is a batch
   * boundary with children, which the incremental structure pass cannot
   * splice, so the packer takes full rebuilds while any group exists.
   */
  groups: number;
}

export const nodeStore: NodeStore = {
  capacity: 0,
  pos: new Float32Array(0),
  local: new Float32Array(0),
  localAffine: new Float32Array(0),
  world: new Float32Array(0),
  worldT: new Float32Array(0),
  worldAlpha: new Float32Array(0),
  dirty: new Uint8Array(0),
  tint: new Uint32Array(0),
  uv: new Uint16Array(0),
  flags: new Uint32Array(0),
  userId: new Uint32Array(0),
  structureVersion: 1,
  touch: 0,
  drawEpoch: 0,
  live: 0,
  groups: 0,
};

const freeSlots: number[] = [];
let nextSlot = 0;

function grow<T extends Float32Array | Uint8Array | Uint16Array | Uint32Array>(
  old: T,
  make: (n: number) => T,
  n: number,
): T {
  const next = make(n);
  next.set(old);
  return next;
}

function ensureCapacity(slots: number): void {
  const s = nodeStore;
  if (slots <= s.capacity) return;
  let cap = Math.max(INITIAL_CAPACITY, s.capacity);
  while (cap < slots) cap *= 2;
  s.pos = grow(s.pos, n => new Float32Array(n), cap * POS_STRIDE);
  s.local = grow(s.local, n => new Float32Array(n), cap * LOCAL_STRIDE);
  s.localAffine = grow(
    s.localAffine,
    n => new Float32Array(n),
    cap * AFFINE_STRIDE,
  );
  s.world = grow(s.world, n => new Float32Array(n), cap * AFFINE_STRIDE);
  s.worldT = grow(s.worldT, n => new Float32Array(n), cap * 2);
  s.worldAlpha = grow(s.worldAlpha, n => new Float32Array(n), cap);
  s.dirty = grow(s.dirty, n => new Uint8Array(n), cap);
  s.tint = grow(s.tint, n => new Uint32Array(n), cap);
  s.uv = grow(s.uv, n => new Uint16Array(n), cap * UV_STRIDE);
  s.flags = grow(s.flags, n => new Uint32Array(n), cap);
  s.userId = grow(s.userId, n => new Uint32Array(n), cap);
  s.capacity = cap;
}

/** Allocates and resets a slot to defaults (identity, alpha 1, white, all dirty). */
export function allocSlot(): number {
  const slot = freeSlots.length > 0 ? (freeSlots.pop() as number) : nextSlot++;
  ensureCapacity(slot + 1);
  const s = nodeStore;
  const lo = slot * LOCAL_STRIDE;
  const L = s.local;
  s.pos[slot * POS_STRIDE] = 0;
  s.pos[slot * POS_STRIDE + 1] = 0;
  L[lo + L_ROT] = 0;
  L[lo + L_SCALE_X] = 1;
  L[lo + L_SCALE_Y] = 1;
  L[lo + L_SKEW_X] = 0;
  L[lo + L_SKEW_Y] = 0;
  L[lo + L_PIVOT_X] = 0;
  L[lo + L_PIVOT_Y] = 0;
  L[lo + L_ALPHA] = 1;
  L[lo + L_ANCHOR_X] = 0;
  L[lo + L_ANCHOR_Y] = 0;
  L[lo + L_FRAME_W] = 0;
  L[lo + L_FRAME_H] = 0;
  affineIdentity(s.localAffine, slot * AFFINE_STRIDE);
  affineIdentity(s.world, slot * AFFINE_STRIDE);
  s.worldT[slot * 2] = 0;
  s.worldT[slot * 2 + 1] = 0;
  s.worldAlpha[slot] = 1;
  s.dirty[slot] = Dirty.ALL;
  s.tint[slot] = 0xffffff;
  const uo = slot * UV_STRIDE;
  s.uv[uo] = 0;
  s.uv[uo + 1] = 0;
  s.uv[uo + 2] = 0xffff;
  s.uv[uo + 3] = 0xffff;
  s.flags[slot] = 0;
  s.userId[slot] = 0;
  if (s.scope) s.scope[slot] = 0;
  s.touch = (s.touch + 1) & TOUCH_MASK;
  s.live++;
  return slot;
}

export function freeSlot(slot: number): void {
  nodeStore.dirty[slot] = Dirty.ALL;
  nodeStore.touch = (nodeStore.touch + 1) & TOUCH_MASK;
  nodeStore.live--;
  freeSlots.push(slot);
}

/**
 * Copies `worldT[slot]` into `world[slot]`'s translation, so the six floats at
 * `slot * AFFINE_STRIDE` are again a complete affine. Cheap and unconditional:
 * `worldT` always holds the value, whichever path wrote it.
 */
export function materializeWorld(slot: number): void {
  const s = nodeStore;
  const wo = slot * AFFINE_STRIDE;
  s.world[wo + 4] = s.worldT[slot * 2];
  s.world[wo + 5] = s.worldT[slot * 2 + 1];
}

/** Sets dirty bits on `slot`. The only way front code should dirty a node. */
export function markDirty(slot: number, bits: number): void {
  nodeStore.dirty[slot] |= bits;
  nodeStore.touch = (nodeStore.touch + 1) & TOUCH_MASK;
  touchScope(slot);
}

/**
 * M5 (ARCHITECTURE §27.5). Something about `slot` changed: the static
 * container baking it (if any) re-bakes.
 */
export function touchScope(slot: number): void {
  const scope = nodeStore.scope;
  // Past the column's end reads undefined: no scope.
  if (scope && scope[slot]) nodeStore.scopeTouch![scope[slot]]++;
}

/**
 * Touches the scopes an edit of `target` affects: the scope baking the
 * node, and with `inner` (its children changed) a static container's own
 * scope. Bulk writers of a container's children call it with `inner`.
 */
export function touchScopeOf(target: object, inner: boolean): void {
  if (!nodeStore.scope) return;
  const t = target as { _slot?: number; _scopeId?: number };
  if (inner && t._scopeId) nodeStore.scopeTouch![t._scopeId]++;
  if (t._slot !== undefined) touchScope(t._slot);
}

// ─── Structure log (ARCHITECTURE §16.2) ───────────────────────────────────────
// Every structureVersion bump records what changed, so a packer can rebuild
// only the affected flat spans. Entries live in a ring; a packer that fell
// more than STRUCT_LOG_SIZE entries behind (or meets an UNKNOWN entry) does a
// full rebuild. Consecutive edits of the same target collapse into one entry.

export const STRUCT_LOG_SIZE = 64;
const STRUCT_LOG_MASK = STRUCT_LOG_SIZE - 1;

/** Entry kinds. */
export const StructEdit = {
  /** Anything: packers rebuild everything. */
  UNKNOWN: 0,
  /** `target`'s children list changed at child index >= `index`. */
  CHILDREN: 1,
  /** `target`'s own visibility, texture source or blend mode changed. */
  NODE: 2,
} as const;

export interface StructLog {
  /** Entries written so far (entry k lives at k & (STRUCT_LOG_SIZE - 1)). */
  head: number;
  readonly kind: Uint8Array;
  readonly index: Uint32Array;
  /** structureVersion after the entry's latest edit (monotonic in k). */
  readonly version: Float64Array;
  readonly target: (object | null)[];
}

export const structLog: StructLog = {
  head: 0,
  kind: new Uint8Array(STRUCT_LOG_SIZE),
  index: new Uint32Array(STRUCT_LOG_SIZE),
  version: new Float64Array(STRUCT_LOG_SIZE),
  target: new Array<object | null>(STRUCT_LOG_SIZE).fill(null),
};

function logEdit(kind: number, target: object | null, index: number): void {
  const log = structLog;
  const version = ++nodeStore.structureVersion;
  if (log.head > 0) {
    const last = (log.head - 1) & STRUCT_LOG_MASK;
    if (log.kind[last] === kind && log.target[last] === target) {
      if (index < log.index[last]) log.index[last] = index;
      log.version[last] = version;
      return;
    }
  }
  const k = log.head & STRUCT_LOG_MASK;
  log.kind[k] = kind;
  log.target[k] = target;
  log.index[k] = index;
  log.version[k] = version;
  log.head++;
}

/**
 * Structure changed in a way the log cannot describe: every packer does a
 * full rebuild.
 */
export function bumpStructure(): void {
  logEdit(StructEdit.UNKNOWN, null, 0);
}

/** `container`'s children list changed at child index >= `index`. */
export function bumpChildren(container: object, index: number): void {
  logEdit(StructEdit.CHILDREN, container, index < 0 ? 0 : index);
  touchScopeOf(container, true);
}

/** `node`'s visibility, texture source or blend mode changed. */
export function bumpNode(node: object): void {
  logEdit(StructEdit.NODE, node, 0);
  touchScopeOf(node, false);
}
