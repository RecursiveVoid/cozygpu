/**
 * ScenePacker (ARCHITECTURE §5.2). One per renderer.
 *
 * pack(stage, frame):
 *   1. Structure pass (only when nodeStore.structureVersion or the stage
 *      changed): DFS assigns each visible sprite its instance index and
 *      builds the batch list (contiguous (texture source, blend) runs, split
 *      by CustomDrawables). Incremental (ARCHITECTURE §16.2): the structure
 *      log names the containers / nodes that changed, and only their flat
 *      regions are re-visited and spliced in (tails shifted with copyWithin,
 *      shifted instances re-uploaded). Anything the log cannot describe falls
 *      back to a full rebuild.
 *   2. Transform pass over the flat list: local 2×2 on LOCAL, world on
 *      LOCAL / POSITION or parent change (translation only when only
 *      translations changed), worldAlpha on alpha changes; changed sprites
 *      rewrite the affected bytes of their 40-byte instance and extend the
 *      dirty ranges. Runs of translated sibling sprites take a tight loop.
 *   3. Upload: SPRITE_BUFFER_ALLOC on growth/generation, then
 *      SPRITE_UPLOAD_SHARED (shared memory) or SPRITE_UPLOAD (inline bytes).
 *   4. Draw: SPRITE_DRAW per batch; CustomDrawable._emitDraw in tree order.
 *
 * Steady state allocates nothing: all per-node state is in typed arrays that
 * only grow during a structure pass.
 */
import { Op, CommandFlag } from '../commands/opcodes';
import { AFFINE_STRIDE as AFF } from '../scene/store';
import { NodeBase } from '../scene/Node';
import { Sprite } from '../scene/Sprite';
import {
  Dirty,
  L_ALPHA,
  L_ANCHOR_X,
  L_ANCHOR_Y,
  L_FRAME_H,
  L_FRAME_W,
  L_PIVOT_X,
  L_PIVOT_Y,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  L_SKEW_X,
  L_SKEW_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  UV_STRIDE,
  STRUCT_LOG_SIZE,
  StructEdit,
  allocSlot,
  nodeStore,
  structLog,
} from '../scene/store';
import {
  ensureTextureUploaded,
  flushTextureDestroys,
  sameTextureSource,
} from '../scene/Texture';
import type { StaticBinding } from '../retained/static';
import type { ContainerNode, SceneNode, TextureHandle } from '../scene/types';
import { isCustomDrawable, isRenderGroup } from '../types/core';
import type {
  CustomDrawable,
  FrontFrame,
  RenderGroup,
  ScenePacker,
} from '../types/core';
import { ids } from '../types/ids';
import { SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { DirtyRanges, MERGE_GAP } from './DirtyRanges';
import { InstanceStore } from './InstanceStore';

const KIND_CONTAINER = 0;
const KIND_SPRITE = 1;
const KIND_CUSTOM = 2;
/** M3: a container drawn inside an effect (ARCHITECTURE §21.4). */
const KIND_GROUP = 3;

export const BATCH_SPRITES = 0;
export const BATCH_CUSTOM = 1;
/** M3: the two ends of a render group; both carry its flat index. */
export const BATCH_GROUP_BEGIN = 2;
export const BATCH_GROUP_END = 3;
/** M5: a static container drawn by its bake (ARCHITECTURE §27.5). */
export const BATCH_STATIC = 4;

/** The fields of a static container the packer reads (src/scene/Container.ts). */
interface StaticLeaf {
  _sbLeaf?: boolean;
  _sb: StaticBinding | null;
}

/** Per-flat-entry "changed this frame" bits propagated to children. */
const CH_WORLD = 1;
const CH_ALPHA = 2;
/** Only the world translation changed (the 2×2 part is unchanged). */
const CH_TRANSLATE = 4;

/**
 * Rebuild-time force bits, stored above the kind in flatKind (one byte per
 * entry keeps the hot loop on fewer memory streams).
 */
const KIND_MASK = 3;
const FORCE_WORLD = 4;
const FORCE_INSTANCE = 8;

/** f32/u32 slots per instance, and u16 offsets of the uv block. */
const I_PER = SPRITE_INSTANCE_BYTES / 4;
const I_COLOR = 6;
const I_UV16 = 14; // byte 28 / 2
const U16_PER = SPRITE_INSTANCE_BYTES / 2;
const I_FLAGS = 9;
/** f32 per instance in instOff: pivot offset x, y; anchor offset x, y. */
export const INST_OFF = 4;

/** Stable proxy slots for SceneNodes that do not extend NodeBase. */
const foreignSlots = new WeakMap<object, number>();

function slotOf(node: SceneNode): number {
  if (node instanceof NodeBase) return node._slot;
  let slot = foreignSlots.get(node);
  if (slot === undefined) {
    slot = allocSlot();
    foreignSlots.set(node, slot);
  }
  return slot;
}

function growI32(
  a: Int32Array<ArrayBuffer>,
  n: number,
): Int32Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const next = new Int32Array(Math.max(n, a.length * 2));
  next.set(a);
  return next;
}
function growU8(
  a: Uint8Array<ArrayBuffer>,
  n: number,
): Uint8Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const next = new Uint8Array(Math.max(n, a.length * 2));
  next.set(a);
  return next;
}
function growU32(
  a: Uint32Array<ArrayBuffer>,
  n: number,
): Uint32Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const next = new Uint32Array(Math.max(n, a.length * 2));
  next.set(a);
  return next;
}

/** Run ends of out entries [from, to) (local), stored as absolute indices. */
export function computeRuns(
  list: FlatList,
  from: number,
  to: number,
  base: number,
): void {
  const kinds = list.kind;
  const parents = list.parent;
  const runEnd = list.runEnd;
  for (let i = to - 1, end = to; i >= from; i--) {
    if ((kinds[i] & KIND_MASK) !== KIND_SPRITE) {
      end = i;
      runEnd[i] = base + i + 1;
      continue;
    }
    if (i + 1 >= end || parents[i + 1] !== parents[i]) end = i + 1;
    runEnd[i] = base + end;
  }
}

/** Re-joins the sprite run that ends right before flat index `at`. */
export function fixRunAt(list: FlatList, at: number): void {
  if (at <= 0 || at > list.count) return;
  const kinds = list.kind;
  const parents = list.parent;
  const runEnd = list.runEnd;
  const a = at - 1;
  if ((kinds[a] & KIND_MASK) !== KIND_SPRITE) return;
  const p = parents[a];
  const end =
    at < list.count &&
    (kinds[at] & KIND_MASK) === KIND_SPRITE &&
    parents[at] === p
      ? runEnd[at]
      : at;
  if (runEnd[a] === end) return; // every entry of a run shares its end
  for (
    let j = a;
    j >= 0 && (kinds[j] & KIND_MASK) === KIND_SPRITE && parents[j] === p;
    j--
  ) {
    runEnd[j] = end;
  }
}

/** Flat draw-order list: one entry per visible node, parents first. */
export class FlatList {
  count = 0;
  slot = new Int32Array(1024);
  /** Parent flat index (-1 for the stage). */
  parent = new Int32Array(1024);
  /** KIND_* | FORCE_* bits (force bits cleared after the transform pass). */
  kind = new Uint8Array(1024);
  changed = new Uint8Array(1024);
  foreign = new Uint8Array(1024);
  /**
   * Exclusive end of the run of consecutive sprite siblings starting at each
   * sprite entry (same parent, no other node in between). May be shorter
   * than the real run (the fast path then just restarts), never longer.
   */
  runEnd = new Int32Array(1024);
  /** Exclusive end of each entry's subtree. */
  end = new Int32Array(1024);
  /** Instance index of the entry (sprites) or of the next sprite after it. */
  inst = new Int32Array(1024);
  nodes: SceneNode[] = [];

  grow(n: number): void {
    this.slot = growI32(this.slot, n);
    this.parent = growI32(this.parent, n);
    this.kind = growU8(this.kind, n);
    this.changed = growU8(this.changed, n);
    this.foreign = growU8(this.foreign, n);
    this.runEnd = growI32(this.runEnd, n);
    this.end = growI32(this.end, n);
    this.inst = growI32(this.inst, n);
  }
}

/** Draw batches in flat order. */
export class BatchList {
  count = 0;
  kind = new Uint8Array(64);
  /** Sprite batches: first instance. */
  first = new Uint32Array(64);
  /** Sprite batches: instance count. */
  size = new Uint32Array(64);
  blend = new Uint32Array(64);
  /** Flat index of the CustomDrawable (custom batches). */
  flat = new Int32Array(64);
  texture: (TextureHandle | null)[] = [];

  push(kind: number, flat: number): number {
    const b = this.count++;
    if (b >= this.kind.length) {
      const n = b + 1;
      this.kind = growU8(this.kind, n);
      this.first = growU32(this.first, n);
      this.size = growU32(this.size, n);
      this.blend = growU32(this.blend, n);
      this.flat = growI32(this.flat, n);
    }
    this.kind[b] = kind;
    this.flat[b] = flat;
    this.texture[b] = null;
    return b;
  }

  /** Appends a batch, merging contiguous sprite batches with the same key. */
  append(
    kind: number,
    first: number,
    size: number,
    blend: number,
    texture: TextureHandle | null,
    flat: number,
  ): void {
    const last = this.count - 1;
    if (
      kind === BATCH_SPRITES &&
      last >= 0 &&
      this.kind[last] === BATCH_SPRITES &&
      this.blend[last] === blend &&
      this.first[last] + this.size[last] === first &&
      sameTextureSource(
        this.texture[last] as TextureHandle,
        texture as TextureHandle,
      )
    ) {
      this.size[last] += size;
      return;
    }
    const b = this.push(kind, flat);
    this.first[b] = first;
    this.size[b] = size;
    this.blend[b] = blend;
    this.texture[b] = texture;
  }
}

type PatchFn = (
  packer: SpriteScenePacker,
  stage: ContainerNode,
  useSAB: boolean,
) => boolean;
let patchFn: PatchFn | null = null;
let patchLoading: Promise<void> | null = null;

/**
 * Loads the incremental structure pass (frontPatch.ts). pack() starts it the
 * first time the structure changes and uses full rebuilds until it lands;
 * tests await it to exercise patches deterministically.
 */
export function loadPatcher(): Promise<void> {
  return (patchLoading ||= import('./frontPatch').then(m => {
    patchFn = m.patch;
  }));
}

/**
 * Copies of RETAIN_MIN_ENTRIES and RETAIN_WARMUP_FRAMES
 * (src/commands/retainOpcodes.ts; src/retained/contracts.test.ts keeps them
 * equal): importing that module here would split it into a chunk of its own
 * on the minimal path.
 */
export const PACKER_RETAIN_MIN_ENTRIES = 8;
export const PACKER_RETAIN_WARMUP_FRAMES = 2;

type SegmentsModule = typeof import('../retained/front');
let segments: SegmentsModule | null = null;
let segmentsLoading: Promise<void> | null = null;

/**
 * M5 (ARCHITECTURE §27.2). Loads the retained segment emitter (chunk
 * `retain`). pack() starts it once a scene with RETAIN_MIN_ENTRIES batches
 * kept its structure for RETAIN_WARMUP_FRAMES frames; until it lands every
 * draw is emitted immediately.
 */
export function loadSegments(): Promise<void> {
  return (segmentsLoading ||= import('../retained/front').then(m => {
    segments = m;
  }));
}

export class SpriteScenePacker implements ScenePacker {
  readonly bufferId = ids.spriteBuffer.alloc();
  readonly instances = new InstanceStore();
  readonly ranges = new DirtyRanges();
  /**
   * Incremental structure pass (ARCHITECTURE §16.2). Tests turn it off to
   * build a full-rebuild reference.
   */
  incremental = true;
  /** Debug/tests: full rebuilds and incremental patches so far. */
  rebuildCount = 0;
  patchCount = 0;
  /**
   * M5 (ARCHITECTURE §27.2). Retained segments; false keeps the immediate
   * path (`RendererOptions.retained`).
   */
  retained = true;
  /** Frames since the last structure change (retain warm-up). */
  private stableFrames = 0;
  /** @internal State of the retained segment emitter (src/retained/front.ts). */
  declare segState?: unknown;

  /** @internal frontPatch.ts */
  list = new FlatList();
  /** Build target of the structure passes (swapped with `list` on rebuild).
   * @internal frontPatch.ts
   */
  staging = new FlatList();
  /** @internal frontPatch.ts */
  batches = new BatchList();
  /** @internal frontPatch.ts */
  stagingBatches = new BatchList();
  /** @internal frontPatch.ts */
  spareBatches = new BatchList();

  instanceCount = 0;
  /**
   * INST_OFF f32 per instance index: the local pivot offset (la·px + lc·py,
   * lb·px + ld·py) and the world-space anchor offset (a·ax + c·ay,
   * b·ax + d·ay). Valid whenever the instance's 2×2 is, so translation-only
   * updates read positions and this compact record instead of the local
   * record, the local 2×2 and the world 2×2. @internal frontPatch.ts */
  instOff = new Float32Array(4 * 1024);
  /** Node slot that owns each instance index. @internal frontPatch.ts */
  instOwner = new Int32Array(1024).fill(-1);
  /** Staged owners of a patched region (applied after the tail shift).
   * @internal frontPatch.ts
   */
  stagedOwner = new Int32Array(256);
  // ── per node slot ──
  /** Flat index of the slot's entry (validated through `list.nodes`).
   * @internal frontPatch.ts
   */
  slotFlat = new Int32Array(0);
  /** 1 while the slot is in the flat list (its world is maintained).
   * @internal frontPatch.ts
   */
  inFlat = new Uint8Array(0);
  /** Structure pass stamp of the last visit. @internal frontPatch.ts */
  seen = new Uint32Array(0);
  /** @internal frontPatch.ts */
  stamp = 0;
  /** @internal frontPatch.ts */
  hadForce = false;
  /**
   * Some instance had a non-zero pivot offset (instOff[0..1]). False lets
   * the moved-sprite loop skip those two reads; a pivot set later turns it on
   * before that sprite's next fast pass. Sticky (see rebuild()).
   */
  private hasPivots = false;
  /** Some flat entry is a SceneNode that does not extend NodeBase.
   * @internal frontPatch.ts
   */
  hasForeign = false;
  /** nodeStore.touch after the last transform pass. */
  private lastTouch = -1;
  /** Instances from here to the end moved this frame and must be re-uploaded.
   * @internal frontPatch.ts
   */
  shiftedFrom = -1;

  // ── build cursors (visit) ──
  private out: FlatList = this.staging;
  private outBatches: BatchList = this.stagingBatches;
  /** Absolute flat index of out entry 0. */
  private outBase = 0;
  /** Next absolute instance index. @internal frontPatch.ts */
  outInst = 0;
  private outInstBase = 0;
  private patching = false;
  /** @internal frontPatch.ts */
  sawForeign = false;

  /** @internal frontPatch.ts */
  structureVersion = -1;
  private lastStage: ContainerNode | null = null;
  private generation = -1;
  private gpuCapacity = 0;
  /** @internal frontPatch.ts */
  fullUpload = true;
  private sharedId = 0;
  private sharedBuffer: ArrayBuffer | SharedArrayBuffer | null = null;
  private destroyed = false;

  /** Tests / compatibility: views of the current flat list. */
  get flatCount(): number {
    return this.list.count;
  }
  get flatSlot(): Int32Array {
    return this.list.slot;
  }
  get batchCount(): number {
    return this.batches.count;
  }

  pack(stage: ContainerNode, frame: FrontFrame): void {
    if (this.destroyed) return;
    if (flushTextureDestroys(frame)) {
      // A clean retained frame would replay the destroyed texture's id.
      nodeStore.drawEpoch = (nodeStore.drawEpoch + 1) | 0;
    }

    if (frame.generation !== this.generation) {
      this.generation = frame.generation;
      this.gpuCapacity = 0;
      this.sharedBuffer = null;
      this.sharedId = 0;
    }
    let rebuilt = false;
    if (
      nodeStore.structureVersion !== this.structureVersion ||
      stage !== this.lastStage
    ) {
      const useSAB = frame.useSharedArrayBuffer;
      if (
        !this.incremental ||
        stage !== this.lastStage ||
        // A render group spans a range of batches, which the incremental
        // splice cannot describe (ARCHITECTURE §21.4).
        nodeStore.groups > 0 ||
        !this.patch(stage, useSAB)
      ) {
        this.rebuild(stage, useSAB);
      }
      rebuilt = true;
    } else if (
      this.instances.ensure(this.instanceCount, frame.useSharedArrayBuffer)
    ) {
      this.fullUpload = true;
    }

    // Nothing marked dirty since the last pass: world transforms and
    // instances are current (foreign nodes are polled, so never skip them).
    if (rebuilt || this.hasForeign || nodeStore.touch !== this.lastTouch) {
      this.transformPass();
      this.lastTouch = nodeStore.touch;
    } else {
      this.ranges.clear();
    }
    this.upload(frame);
    if (segments !== null && this.retained) {
      segments.emitSegments(this, frame, rebuilt);
      return;
    }
    this.emitDraws(frame, 0, this.batches.count);
    if (rebuilt) {
      this.stableFrames = 0;
    } else if (
      ++this.stableFrames >= PACKER_RETAIN_WARMUP_FRAMES &&
      this.batches.count >= PACKER_RETAIN_MIN_ENTRIES &&
      this.retained
    ) {
      void loadSegments();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // The GPU buffer dies with the renderer's core; the id can be reused.
    ids.spriteBuffer.free(this.bufferId);
    segments?.releaseSegments(this);
    this.list.nodes.length = 0;
    this.staging.nodes.length = 0;
    this.batches.texture.length = 0;
    this.stagingBatches.texture.length = 0;
    this.spareBatches.texture.length = 0;
    this.lastStage = null;
  }

  // ─── 1. Structure ──────────────────────────────────────────────────────────

  /** @internal frontPatch.ts */
  ensureSlotArrays(n: number): void {
    if (n <= this.seen.length) return;
    const cap = Math.max(n, nodeStore.capacity, this.seen.length * 2);
    const slotFlat = new Int32Array(cap).fill(-1);
    slotFlat.set(this.slotFlat);
    this.slotFlat = slotFlat;
    this.inFlat = growU8(this.inFlat, cap);
    this.seen = growU32(this.seen, cap);
  }

  /** @internal frontPatch.ts */
  beginOut(
    out: FlatList,
    batches: BatchList,
    flatBase: number,
    instBase: number,
    patching: boolean,
  ): void {
    out.count = 0;
    out.nodes.length = 0;
    batches.count = 0;
    batches.texture.length = 0;
    this.out = out;
    this.outBatches = batches;
    this.outBase = flatBase;
    this.outInst = instBase;
    this.outInstBase = instBase;
    this.patching = patching;
  }

  /** Incremental structure pass once loaded (loadPatcher); false = rebuild. */
  private patch(stage: ContainerNode, useSAB: boolean): boolean {
    if (patchFn === null) {
      void loadPatcher();
      return false;
    }
    return patchFn(this, stage, useSAB);
  }

  /** Full structure pass: DFS of the whole stage into a fresh list. */
  private rebuild(stage: ContainerNode, useSAB: boolean): void {
    this.rebuildCount++;
    this.structureVersion = nodeStore.structureVersion;
    this.lastStage = stage;
    this.stamp++;
    this.hadForce = true;
    this.sawForeign = false;
    this.shiftedFrom = -1;
    // hasPivots is NOT reset here: a rebuild rewrites only the instances it
    // forces (new owner, force bits), so an unchanged sprite with a pivot
    // would not turn it back on and its next translation-only move would
    // drop the pivot offset.
    this.ensureSlotArrays(nodeStore.capacity);
    const old = this.list;
    const prevCount = this.instanceCount;
    const next = this.staging;
    this.beginOut(next, this.stagingBatches, 0, 0, false);
    this.visit(stage, -1);
    computeRuns(next, 0, next.count, 0);

    // Slots that left the list lose their "world is maintained" mark.
    const seen = this.seen;
    const inFlat = this.inFlat;
    const stamp = this.stamp;
    for (let i = 0; i < old.count; i++) {
      const slot = old.slot[i];
      if (seen[slot] !== stamp) inFlat[slot] = 0;
    }
    old.nodes.length = 0;
    this.list = next;
    this.staging = old;
    const batches = this.batches;
    this.batches = this.stagingBatches;
    this.stagingBatches = batches;
    batches.texture.length = 0;

    this.hasForeign = this.sawForeign;
    this.instanceCount = this.outInst;
    // Instance indices vacated by this build lose their owner, so a sprite
    // that re-occupies one later is rewritten (its bytes there are stale).
    if (this.instanceCount < prevCount) {
      this.instOwner.fill(-1, this.instanceCount, prevCount);
    }
    this.ensureInstanceArrays(this.instanceCount);
    if (this.instances.ensure(this.instanceCount, useSAB)) {
      this.fullUpload = true;
    }
  }

  /** @internal frontPatch.ts */
  ensureInstanceArrays(count: number): void {
    if (count * INST_OFF > this.instOff.length) {
      const next = new Float32Array(
        Math.max(count * INST_OFF, this.instOff.length * 2),
      );
      next.set(this.instOff);
      this.instOff = next;
    }
    if (count > this.instOwner.length) {
      const prev = this.instOwner.length;
      this.instOwner = growI32(this.instOwner, count);
      this.instOwner.fill(-1, prev);
    }
  }

  /** Flat index of `node` in the current list, or -1.
   * @internal frontPatch.ts
   */
  flatIndexOf(node: SceneNode): number {
    if (!(node instanceof NodeBase)) return -1;
    const slot = node._slot;
    if (slot >= this.slotFlat.length) return -1;
    const i = this.slotFlat[slot];
    const list = this.list;
    return i >= 0 && i < list.count && list.nodes[i] === node ? i : -1;
  }

  /** @internal frontPatch.ts */
  visit(node: SceneNode, parentFlat: number): void {
    if (!node.visible) return;
    const out = this.out;
    const i = out.count++;
    if (i >= out.slot.length) out.grow(i + 1);
    const abs = this.outBase + i;
    const slot = slotOf(node);
    const foreign = node instanceof NodeBase ? 0 : 1;
    out.slot[i] = slot;
    out.parent[i] = parentFlat;
    out.foreign[i] = foreign;
    out.inst[i] = this.outInst;
    out.nodes[i] = node;
    if (foreign) this.sawForeign = true;

    if (node instanceof Sprite) {
      out.kind[i] = this.visitSprite(node, abs, slot);
      out.end[i] = abs + 1;
      return;
    }
    let kind = KIND_CONTAINER;
    if ((node as unknown as StaticLeaf)._sbLeaf) {
      // M5 (§27.5): a baked static container is a leaf; its bake draws it.
      out.kind[i] = kind | this.mark(slot, abs);
      this.outBatches.push(BATCH_STATIC, abs);
      out.end[i] = abs + 1;
      return;
    }
    if (isCustomDrawable(node)) {
      kind = KIND_CUSTOM;
      this.outBatches.push(BATCH_CUSTOM, abs);
    } else if (isRenderGroup(node)) {
      // A group ends the open batch on both sides (ARCHITECTURE §21.4).
      kind = KIND_GROUP;
      this.outBatches.push(BATCH_GROUP_BEGIN, abs);
    }
    out.kind[i] = kind | this.mark(slot, abs);

    const children = (node as ContainerNode).children;
    if (children) this.visitChildren(children, 0, abs);
    out.end[i] = this.outBase + out.count;
    if (kind === KIND_GROUP) this.outBatches.push(BATCH_GROUP_END, abs);
  }

  /** @internal frontPatch.ts */
  visitChildren(
    children: readonly SceneNode[],
    from: number,
    parentFlat: number,
  ): void {
    const out = this.out;
    for (let c = from; c < children.length; c++) {
      const child = children[c];
      // Sprite leaves inline (no recursion): the common 100k-children case.
      if (child instanceof Sprite) {
        if (!child._visible) continue;
        const ci = out.count++;
        if (ci >= out.slot.length) out.grow(ci + 1);
        const abs = this.outBase + ci;
        const cs = child._slot;
        out.slot[ci] = cs;
        out.parent[ci] = parentFlat;
        out.foreign[ci] = 0;
        out.inst[ci] = this.outInst;
        out.nodes[ci] = child;
        out.kind[ci] = this.visitSprite(child, abs, cs);
        out.end[ci] = abs + 1;
      } else {
        this.visit(child, parentFlat);
      }
    }
  }

  /**
   * Marks `slot` as visited at flat index `abs`; returns FORCE_WORLD when the
   * slot was not in the list (its world may be stale: hidden or detached
   * while its ancestors moved).
   */
  private mark(slot: number, abs: number): number {
    if (slot >= this.seen.length) this.ensureSlotArrays(slot + 1);
    this.seen[slot] = this.stamp;
    this.slotFlat[slot] = abs;
    if (this.inFlat[slot] === 1) return 0;
    this.inFlat[slot] = 1;
    return FORCE_WORLD;
  }

  /** Instance index, owner and batch for a visible sprite; returns the kind. */
  private visitSprite(node: Sprite, abs: number, slot: number): number {
    let force = this.mark(slot, abs);
    const inst = this.outInst++;
    if (this.patching) {
      // Owners are staged: the tail has not been shifted yet. Old owners at
      // or past the region end belong to nodes outside it (never `slot`).
      const local = inst - this.outInstBase;
      if (local >= this.stagedOwner.length) {
        this.stagedOwner = growI32(this.stagedOwner, local + 1);
      }
      this.stagedOwner[local] = slot;
      const owner = this.instOwner;
      if (inst >= owner.length || owner[inst] !== slot) force |= FORCE_INSTANCE;
    } else {
      if (inst >= this.instOwner.length) this.ensureInstanceArrays(inst + 1);
      if (this.instOwner[inst] !== slot) {
        this.instOwner[inst] = slot;
        force |= FORCE_INSTANCE;
      }
    }
    const tex = node._texture;
    const blend = node._blendId;
    const batches = this.outBatches;
    const b = batches.count - 1;
    if (
      b >= 0 &&
      batches.kind[b] === BATCH_SPRITES &&
      batches.blend[b] === blend &&
      sameTextureSource(batches.texture[b] as TextureHandle, tex)
    ) {
      batches.size[b]++;
    } else {
      const nb = batches.push(BATCH_SPRITES, abs);
      batches.first[nb] = inst;
      batches.size[nb] = 1;
      batches.blend[nb] = blend;
      batches.texture[nb] = tex;
    }
    return KIND_SPRITE | force;
  }

  // ─── 2. Transforms + instance packing ──────────────────────────────────────

  /**
   * Hot loop (100k sprites per frame). Local affine, world multiply, and
   * instance packing are inlined over cached array locals; the dirty run is
   * tracked inline because instance indices increase along the flat list.
   * Mirrors computeLocalAffine / computeWorld / writeInstance.
   *
   * The cost at 100k+ is dominated by how many distinct arrays each sprite
   * touches (memory streams), so work is split by what changed:
   *  - nothing (static sprite under an unchanged parent): skip;
   *  - translation only (Dirty.POSITION, or a parent whose world only
   *    translated): world tx/ty and instance bytes 16..23, using the cached
   *    pivot and world-space anchor offsets (`instOff`) instead of the local
   *    record, the 2×2s and the sprite's frame/anchor;
   *  - 2×2 change (Dirty.LOCAL, forced, parent 2×2 changed): full affine,
   *    full multiply, all six instance floats and a fresh anchor offset;
   *  - color / uv / flags are repacked only on alpha, Dirty.SPRITE or a
   *    forced instance rewrite.
   * The parent's world, alpha and change bits are cached while consecutive
   * entries share a parent (a parent precedes all its descendants in the
   * flat list, so its values are final once any child is reached).
   *
   * Every path computes translations from the same f32-rounded inputs
   * (`Math.fround` of the pivot offset, world translation and anchor offset,
   * exactly what `instOff` and `world` store), so an instance's bytes do not
   * depend on which path wrote them (incremental and full rebuilds match
   * byte for byte).
   *
   * Only the 2×2 of localAffine is cached here; its translation slots (4, 5)
   * are not maintained by the packer (Container.updateTransform() fills them).
   */
  private transformPass(): void {
    const s = nodeStore;
    const dirty = s.dirty;
    const list = this.list;
    const n = list.count;
    const fSlot = list.slot;
    const fParent = list.parent;
    const fKind = list.kind;
    const fChanged = list.changed;
    const fForeign = list.foreign;
    const fRunEnd = list.runEnd;
    const hadForce = this.hadForce;
    const ranges = this.ranges;
    ranges.clear();

    if (this.hasForeign) {
      for (let i = 0; i < n; i++) {
        if (fForeign[i] === 1) this.readForeign(i, fSlot[i]);
      }
    }

    const P = s.pos;
    const L = s.local;
    const LA = s.localAffine;
    const W = s.world;
    const WT = s.worldT;
    const WA = s.worldAlpha;
    const tints = s.tint;
    const uvs = s.uv;
    const sflags = s.flags;
    const store = this.instances;
    const f32 = store.f32;
    const u32 = store.u32;
    const u16 = store.u16;
    const OFF = this.instOff;
    let runStart = -1;
    let runEnd = -1;
    /**
     * Instance index of the next sprite: visible sprites take consecutive
     * indices in flat order (visit()).
     */
    let nextInst = 0;
    let cachedParent = -2;
    let pa = 1;
    let pb = 0;
    let pc = 0;
    let pd = 1;
    let ptx = 0;
    let pty = 0;
    let pAlpha = 1;
    let pChanged = 0;

    for (let i = 0; i < n; i++) {
      const slot = fSlot[i];
      const d = dirty[slot];
      const kind = fKind[i];
      const p = fParent[i];
      if (p !== cachedParent) {
        cachedParent = p;
        if (p < 0) {
          pa = 1;
          pb = 0;
          pc = 0;
          pd = 1;
          ptx = 0;
          pty = 0;
          pAlpha = 1;
          pChanged = 0;
        } else {
          const ps = fSlot[p];
          const po = ps * AFF;
          pa = W[po];
          pb = W[po + 1];
          pc = W[po + 2];
          pd = W[po + 3];
          ptx = W[po + 4];
          pty = W[po + 5];
          pAlpha = WA[ps];
          pChanged = fChanged[p];
        }
      }
      const force = kind & ~KIND_MASK;
      if ((d | force | pChanged) === 0) {
        // force bits are 0 here. Sprites are leaves: their flatChanged
        // entries are never read, so only parents get one.
        if (kind === KIND_SPRITE) nextInst++;
        else fChanged[i] = 0;
        continue;
      }
      const lo = slot * LOCAL_STRIDE;
      const wo = slot * AFF;

      // Fast path: moved sprites under an unchanged parent. A tight inner
      // loop consumes the whole run of such siblings. Sprites are leaves, so
      // their flatChanged entries are never read.
      if (d === Dirty.POSITION && kind === KIND_SPRITE && pChanged === 0) {
        let j = i;
        let jslot = slot;
        // Rebuild frames carry force bits, so only trust runs without them.
        const end = hadForce ? i + 1 : fRunEnd[i];
        // Instance-indexed offsets walk forward with the run; the slot-indexed
        // ones share `jpo` because pos and worldT both hold 2 f32 per slot.
        let oo = nextInst * INST_OFF;
        let o = nextInst * I_PER;
        if (!this.hasPivots) {
          // No sprite in this packer has a pivot, so the local offset is 0.
          for (;;) {
            const jpo = jslot * POS_STRIDE;
            const ltx = P[jpo];
            const lty = P[jpo + 1];
            const wx = pa * ltx + pc * lty + ptx;
            const wy = pb * ltx + pd * lty + pty;
            WT[jpo] = wx;
            WT[jpo + 1] = wy;
            f32[o + 4] = Math.fround(wx) - OFF[oo + 2];
            f32[o + 5] = Math.fround(wy) - OFF[oo + 3];
            dirty[jslot] = 0;
            nextInst++;
            oo += INST_OFF;
            o += I_PER;
            j++;
            if (j >= end) break;
            jslot = fSlot[j];
            if (dirty[jslot] !== Dirty.POSITION) break;
          }
        } else
          // Same loop, paying the two cached pivot-offset reads.
          for (;;) {
            const jpo = jslot * POS_STRIDE;
            const ltx = P[jpo] - OFF[oo];
            const lty = P[jpo + 1] - OFF[oo + 1];
            const wx = pa * ltx + pc * lty + ptx;
            const wy = pb * ltx + pd * lty + pty;
            WT[jpo] = wx;
            WT[jpo + 1] = wy;
            f32[o + 4] = Math.fround(wx) - OFF[oo + 2];
            f32[o + 5] = Math.fround(wy) - OFF[oo + 3];
            dirty[jslot] = 0;
            nextInst++;
            oo += INST_OFF;
            o += I_PER;
            j++;
            if (j >= end) break;
            jslot = fSlot[j];
            if (dirty[jslot] !== Dirty.POSITION) break;
          }
        const inst = nextInst - (j - i);
        if (runEnd < 0) {
          runStart = inst;
        } else if (inst > runEnd + MERGE_GAP) {
          ranges.addRange(runStart, runEnd);
          runStart = inst;
        }
        runEnd = nextInst;
        i = j - 1;
        continue;
      }

      // The hot loop leaves `world`'s translation behind (worldT is
      // authoritative); this node needs the full record now.
      W[wo + 4] = WT[slot * 2];
      W[wo + 5] = WT[slot * 2 + 1];

      let changed = 0;
      if ((d & Dirty.LOCAL) !== 0) {
        const rot = L[lo + L_ROT];
        const sx = L[lo + L_SCALE_X];
        const sy = L[lo + L_SCALE_Y];
        const skx = L[lo + L_SKEW_X];
        const sky = L[lo + L_SKEW_Y];
        if (skx === 0 && sky === 0) {
          if (rot === 0) {
            LA[wo] = sx;
            LA[wo + 1] = 0;
            LA[wo + 2] = 0;
            LA[wo + 3] = sy;
          } else {
            const cos = Math.cos(rot);
            const sin = Math.sin(rot);
            LA[wo] = cos * sx;
            LA[wo + 1] = sin * sx;
            LA[wo + 2] = -sin * sy;
            LA[wo + 3] = cos * sy;
          }
        } else {
          LA[wo] = Math.cos(rot + sky) * sx;
          LA[wo + 1] = Math.sin(rot + sky) * sx;
          LA[wo + 2] = -Math.sin(rot - skx) * sy;
          LA[wo + 3] = Math.cos(rot - skx) * sy;
        }
      }

      if (
        ((d & Dirty.LOCAL) | (force & FORCE_WORLD) | (pChanged & CH_WORLD)) !==
        0
      ) {
        const la = LA[wo];
        const lb = LA[wo + 1];
        const lc = LA[wo + 2];
        const ld = LA[wo + 3];
        const px = L[lo + L_PIVOT_X];
        const py = L[lo + L_PIVOT_Y];
        const ltx = P[slot * POS_STRIDE] - Math.fround(px * la + py * lc);
        const lty = P[slot * POS_STRIDE + 1] - Math.fround(px * lb + py * ld);
        W[wo] = pa * la + pc * lb;
        W[wo + 1] = pb * la + pd * lb;
        W[wo + 2] = pa * lc + pc * ld;
        W[wo + 3] = pb * lc + pd * ld;
        const wtx = pa * ltx + pc * lty + ptx;
        const wty = pb * ltx + pd * lty + pty;
        W[wo + 4] = wtx;
        W[wo + 5] = wty;
        WT[slot * 2] = wtx;
        WT[slot * 2 + 1] = wty;
        changed = CH_WORLD;
      } else if (((d & Dirty.POSITION) | (pChanged & CH_TRANSLATE)) !== 0) {
        let ltx = P[slot * POS_STRIDE];
        let lty = P[slot * POS_STRIDE + 1];
        const px = L[lo + L_PIVOT_X];
        const py = L[lo + L_PIVOT_Y];
        if (px !== 0 || py !== 0) {
          ltx -= Math.fround(px * LA[wo] + py * LA[wo + 2]);
          lty -= Math.fround(px * LA[wo + 1] + py * LA[wo + 3]);
        }
        const wtx = pa * ltx + pc * lty + ptx;
        const wty = pb * ltx + pd * lty + pty;
        W[wo + 4] = wtx;
        W[wo + 5] = wty;
        WT[slot * 2] = wtx;
        WT[slot * 2 + 1] = wty;
        changed = CH_TRANSLATE;
      }

      if (
        ((d & Dirty.ALPHA) | (force & FORCE_WORLD) | (pChanged & CH_ALPHA)) !==
        0
      ) {
        WA[slot] = pAlpha * L[lo + L_ALPHA];
        changed |= CH_ALPHA;
      }
      if (d !== 0) dirty[slot] = 0;

      if ((kind & KIND_MASK) !== KIND_SPRITE) {
        fChanged[i] = changed;
        continue;
      }
      const inst = nextInst++;
      const full = (d & Dirty.SPRITE) | (force & FORCE_INSTANCE);
      if ((changed | full) === 0) continue;

      // ── instance (ARCHITECTURE §4.1): world · T(-anchor·size) · S(size)
      const o = inst * I_PER;
      const oo = inst * INST_OFF;
      if (full !== 0 || (changed & CH_WORLD) !== 0) {
        const fw = L[lo + L_FRAME_W];
        const fh = L[lo + L_FRAME_H];
        const ax = L[lo + L_ANCHOR_X] * fw;
        const ay = L[lo + L_ANCHOR_Y] * fh;
        const a = W[wo];
        const b = W[wo + 1];
        const c = W[wo + 2];
        const dd = W[wo + 3];
        const aox = a * ax + c * ay;
        const aoy = b * ax + dd * ay;
        const px = L[lo + L_PIVOT_X];
        const py = L[lo + L_PIVOT_Y];
        if (px !== 0 || py !== 0) this.hasPivots = true;
        OFF[oo] = px * LA[wo] + py * LA[wo + 2];
        OFF[oo + 1] = px * LA[wo + 1] + py * LA[wo + 3];
        OFF[oo + 2] = aox;
        OFF[oo + 3] = aoy;
        f32[o] = a * fw;
        f32[o + 1] = b * fw;
        f32[o + 2] = c * fh;
        f32[o + 3] = dd * fh;
        f32[o + 4] = W[wo + 4] - Math.fround(aox);
        f32[o + 5] = W[wo + 5] - Math.fround(aoy);
      } else if ((changed & CH_TRANSLATE) !== 0) {
        f32[o + 4] = W[wo + 4] - OFF[oo + 2];
        f32[o + 5] = W[wo + 5] - OFF[oo + 3];
      }
      if (full !== 0 || (changed & CH_ALPHA) !== 0) {
        const tint = tints[slot];
        const wa = WA[slot];
        const alpha = wa <= 0 ? 0 : wa >= 1 ? 255 : (wa * 255 + 0.5) | 0;
        u32[o + I_COLOR] =
          (((tint >>> 16) & 0xff) |
            (((tint >>> 8) & 0xff) << 8) |
            ((tint & 0xff) << 16) |
            (alpha << 24)) >>>
          0;
      }
      if (full !== 0) {
        const uo = slot * UV_STRIDE;
        const io = inst * U16_PER + I_UV16;
        u16[io] = uvs[uo];
        u16[io + 1] = uvs[uo + 1];
        u16[io + 2] = uvs[uo + 2];
        u16[io + 3] = uvs[uo + 3];
        u32[o + I_FLAGS] = sflags[slot];
      }

      // ── dirty run (inst strictly increases along the flat list)
      if (runEnd < 0) {
        runStart = inst;
      } else if (inst > runEnd + MERGE_GAP) {
        ranges.addRange(runStart, runEnd);
        runStart = inst;
      }
      runEnd = inst + 1;
    }
    if (runEnd >= 0) ranges.addRange(runStart, runEnd);

    if (this.hadForce) {
      for (let i = 0; i < n; i++) fKind[i] &= KIND_MASK;
      this.hadForce = false;
    }
  }

  private readForeign(i: number, slot: number): void {
    const node = this.list.nodes[i];
    const L = nodeStore.local;
    const lo = slot * LOCAL_STRIDE;
    nodeStore.pos[slot * POS_STRIDE] = node.x;
    nodeStore.pos[slot * POS_STRIDE + 1] = node.y;
    L[lo + L_ROT] = node.rotation;
    L[lo + L_SCALE_X] = node.scaleX;
    L[lo + L_SCALE_Y] = node.scaleY;
    L[lo + L_SKEW_X] = node.skewX;
    L[lo + L_SKEW_Y] = node.skewY;
    L[lo + L_PIVOT_X] = node.pivotX;
    L[lo + L_PIVOT_Y] = node.pivotY;
    L[lo + L_ALPHA] = node.alpha;
    nodeStore.dirty[slot] |= Dirty.LOCAL | Dirty.ALPHA;
  }

  // ─── 3. Upload ─────────────────────────────────────────────────────────────

  private upload(frame: FrontFrame): void {
    const enc = frame.encoder;
    const store = this.instances;
    const count = this.instanceCount;

    if (this.gpuCapacity < store.capacity && count > 0) {
      enc.begin(Op.SPRITE_BUFFER_ALLOC, 8);
      enc.u32(this.bufferId);
      enc.u32(store.capacity);
      enc.end();
      this.gpuCapacity = store.capacity;
      this.fullUpload = true;
    }
    if (count === 0) {
      this.ranges.clear();
      return;
    }

    const ranges = this.ranges;
    if (this.shiftedFrom >= 0) {
      // A structure patch moved these instances in the store.
      if (this.shiftedFrom < count) ranges.addRange(this.shiftedFrom, count);
      this.shiftedFrom = -1;
    }
    if (this.fullUpload) {
      ranges.clear();
      ranges.addRange(0, count);
      this.fullUpload = false;
    } else {
      ranges.finalize();
    }
    if (ranges.count === 0) return;

    if (frame.sharedMemory) {
      if (this.sharedBuffer !== store.buffer) {
        if (this.sharedId !== 0) {
          enc.begin(Op.SHARED_RELEASE, 4);
          enc.u32(this.sharedId);
          enc.end();
        }
        this.sharedBuffer = store.buffer;
        this.sharedId = frame.registerShared(store.buffer);
      }
      for (let r = 0; r < ranges.count; r++) {
        const first = ranges.starts[r];
        const end = Math.min(ranges.ends[r], count);
        if (end <= first) continue;
        enc.begin(Op.SPRITE_UPLOAD_SHARED, 20);
        enc.u32(this.bufferId);
        enc.u32(first);
        enc.u32(end - first);
        enc.u32(this.sharedId);
        enc.u32(0);
        enc.end();
      }
    } else {
      for (let r = 0; r < ranges.count; r++) {
        const first = ranges.starts[r];
        const end = Math.min(ranges.ends[r], count);
        if (end <= first) continue;
        const bytes = (end - first) * SPRITE_INSTANCE_BYTES;
        enc.begin(Op.SPRITE_UPLOAD, 12 + bytes);
        enc.u32(this.bufferId);
        enc.u32(first);
        enc.u32(end - first);
        enc.bytes(store.u8, first * SPRITE_INSTANCE_BYTES, bytes);
        enc.end();
      }
    }
  }

  // ─── 4. Draw ───────────────────────────────────────────────────────────────

  /**
   * @internal Immediate draw commands of batches [from, to); a range never
   * splits a render group (src/retained/front.ts emits the rest).
   */
  emitDraws(frame: FrontFrame, from: number, to: number): void {
    const enc = frame.encoder;
    const s = nodeStore;
    const batches = this.batches;
    const list = this.list;
    for (let b = from; b < to; b++) {
      if (batches.kind[b] === BATCH_SPRITES) {
        const count = batches.size[b];
        if (count === 0) continue;
        const texId = ensureTextureUploaded(
          frame,
          batches.texture[b] as TextureHandle,
        );
        enc.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
        enc.u32(this.bufferId);
        enc.u32(batches.first[b]);
        enc.u32(count);
        enc.u32(texId);
        enc.u32(batches.blend[b]);
        enc.end();
      } else {
        const kind = batches.kind[b];
        const flat = batches.flat[b];
        const node = list.nodes[flat];
        const slot = list.slot[flat];
        if (kind === BATCH_CUSTOM) {
          (node as unknown as CustomDrawable)._emitDraw(
            frame,
            s.world,
            slot * AFF,
            s.worldAlpha[slot],
          );
        } else if (kind === BATCH_STATIC) {
          (node as unknown as StaticLeaf)._sb?.emit(
            frame,
            s.world,
            slot * AFF,
            s.worldAlpha[slot],
          );
        } else if (kind === BATCH_GROUP_BEGIN) {
          // False = the group's effect is not drawable this frame; its whole
          // subtree is skipped so a mask never flashes unclipped content.
          const drawable = (node as unknown as RenderGroup)._emitGroupBegin(
            frame,
            s.world,
            slot * AFF,
            s.worldAlpha[slot],
          );
          if (!drawable) b = skipGroup(batches, b);
        } else {
          (node as unknown as RenderGroup)._emitGroupEnd(frame);
        }
      }
    }
  }
}

/** Batch index of the BATCH_GROUP_END matching the begin at `b`. */
export function skipGroup(batches: BatchList, b: number): number {
  let depth = 1;
  for (let j = b + 1; j < batches.count; j++) {
    const kind = batches.kind[j];
    if (kind === BATCH_GROUP_BEGIN) depth++;
    else if (kind === BATCH_GROUP_END && --depth === 0) return j;
  }
  return batches.count;
}

export function createScenePacker(): ScenePacker {
  return new SpriteScenePacker();
}
