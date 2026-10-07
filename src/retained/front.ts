/**
 * Retained segments, front half (M5, ARCHITECTURE §27.2), chunk `retain`.
 * Loaded by the scene packer once a scene is large and stable enough
 * (`loadSegments` in src/sprites/front.ts); it then emits every frame's draw
 * commands in place of `emitDraws`.
 *
 * The packer's batch list is partitioned into segments: maximal runs of
 * sprite batches and RetainableDrawables (Graphics). Everything else is
 * volatile and emitted immediately every frame: CustomDrawables without
 * `_syncDraw` (Swarm, Particles, SpriteLayer) and whole render groups (a
 * group's commands carry pass breaks and its effects are per packet).
 *
 * Per frame and segment the packer emits either RETAIN_DRAW(id) (the core
 * replays its recording) or RETAIN_BEGIN(id), the segment's commands exactly
 * as the immediate path emits them, RETAIN_END(id). A segment is clean when
 * it was recorded at the current generation, every sprite batch still draws
 * the recorded texture id and every drawable reports the recorded
 * `_drawVersion`; its drawables then get `_syncDraw` (records only).
 * Uploads are not draws: sprites moving inside a clean segment upload as
 * always and the replayed draws read the new bytes.
 *
 * Clean frame: no structure change and `nodeStore.touch`, `drawEpoch`, the
 * generation and the resolution as in the last frame. Every segment then replays without
 * visiting a node (segments with a texture provider still poll it).
 *
 * Structure changes re-partition; a new segment whose batches equal an old
 * one's (same sprite ranges, same drawables, in order) keeps its id and
 * recording, other old ids are freed with RETAIN_DESTROY. Zero allocations
 * per frame outside structure changes.
 */
import { CommandFlag, Op, OpcodeRange } from '../commands/opcodes';
import {
  RETAIN_BEGIN_BYTES,
  RETAIN_DESTROY_BYTES,
  RETAIN_DRAW_BYTES,
  RETAIN_END_BYTES,
  RetainOp,
} from '../commands/retainOpcodes';
import { registerCoreSystemLoader } from '../renderer/lazySystems';
import { AFFINE_STRIDE as AFF, nodeStore } from '../scene/store';
import { ensureTextureUploaded } from '../scene/Texture';
import type { TextureHandle } from '../scene/types';
import {
  BATCH_GROUP_BEGIN,
  BATCH_SPRITES,
  skipGroup,
  type SpriteScenePacker,
} from '../sprites/front';
import type { FrontFrame, RetainableDrawable } from '../types/core';
import { NO_ID } from '../types/ids';
import { allocSegmentId, freeSegmentId } from './ids';

registerCoreSystemLoader(OpcodeRange.RETAIN, () =>
  import('./core').then(m => m.createRetainCoreSystem),
);

/** SPRITE_DRAW payload: bufferId, first, count, texId, blendModeId. */
const SPRITE_DRAW_BYTES = 20;
/** Old segments a new one is compared with (insertions, removals). */
const LOOKAHEAD = 4;

function growI32(
  a: Int32Array<ArrayBuffer>,
  n: number,
): Int32Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const b = new Int32Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
function growU32(
  a: Uint32Array<ArrayBuffer>,
  n: number,
): Uint32Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const b = new Uint32Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}
function growF64(
  a: Float64Array<ArrayBuffer>,
  n: number,
): Float64Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const b = new Float64Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}

/** A partition of the batch list into segments, and what each recorded. */
class Plan {
  /** Segments: batch range [first, end), id, generation recorded at (-1: never). */
  n = 0;
  first = new Int32Array(16);
  end = new Int32Array(16);
  id = new Uint32Array(16);
  gen = new Int32Array(16);
  /** 1 when a sprite batch's texture is a provider or not ready (polled). */
  live = new Uint32Array(16);
  /** Matching scratch (old plan): 1 once reused. */
  used = new Uint32Array(16);
  // Per batch index of the partitioned list (recordable batches only).
  kind = new Uint32Array(64);
  a = new Uint32Array(64);
  b = new Uint32Array(64);
  c = new Uint32Array(64);
  node: unknown[] = [];
  tex = new Uint32Array(64);
  ver = new Float64Array(64);

  growSegments(n: number): void {
    this.first = growI32(this.first, n);
    this.end = growI32(this.end, n);
    this.id = growU32(this.id, n);
    this.gen = growI32(this.gen, n);
    this.live = growU32(this.live, n);
    this.used = growU32(this.used, n);
  }

  growBatches(n: number): void {
    this.kind = growU32(this.kind, n);
    this.a = growU32(this.a, n);
    this.b = growU32(this.b, n);
    this.c = growU32(this.c, n);
    this.tex = growU32(this.tex, n);
    this.ver = growF64(this.ver, n);
  }
}

/** Per-packer state (SpriteScenePacker.segState). */
class SegState {
  cur = new Plan();
  old = new Plan();
  /** Partitioned for the packer's current batch list. */
  ready = false;
  touch = -1;
  epoch = -1;
  gen = -1;
  /** Resolution of the last frame: a change re-tessellates curved Graphics. */
  res = -1;
  /** RendererStats.retainedSegments, rewritten every frame. */
  stats = { replayed: 0, recorded: 0 };
}

/** Emits the frame's draws (SpriteScenePacker.pack, step 4). */
export function emitSegments(
  pk: SpriteScenePacker,
  frame: FrontFrame,
  rebuilt: boolean,
): void {
  const batches = pk.batches;
  if (!frame.isSystemReady(OpcodeRange.RETAIN)) {
    pk.emitDraws(frame, 0, batches.count);
    return;
  }
  let st = pk.segState as SegState | undefined;
  if (st === undefined) pk.segState = st = new SegState();
  const gen = frame.generation;
  if (rebuilt || !st.ready) partition(pk, st, frame);
  // Captured before drawing: anything a drawable bumps while emitting makes
  // the next frame a checked one.
  const clean =
    !rebuilt &&
    nodeStore.touch === st.touch &&
    nodeStore.drawEpoch === st.epoch &&
    gen === st.gen &&
    frame.resolution === st.res;
  st.touch = nodeStore.touch;
  st.epoch = nodeStore.drawEpoch;
  st.gen = gen;
  st.res = frame.resolution;
  const plan = st.cur;
  const stats = st.stats;
  stats.replayed = stats.recorded = 0;
  let b = 0;
  for (let s = 0; s < plan.n; s++) {
    const first = plan.first[s];
    if (b < first) pk.emitDraws(frame, b, first);
    if (emitSegment(pk, plan, s, frame, clean)) stats.replayed++;
    else stats.recorded++;
    b = plan.end[s];
  }
  if (b < batches.count) pk.emitDraws(frame, b, batches.count);
}

/**
 * The packer is destroyed: its segment ids go back (the core's segments die
 * with the renderer, or with RETAIN_DESTROY of a later owner of the id).
 */
export function releaseSegments(pk: SpriteScenePacker): void {
  const st = pk.segState as SegState | undefined;
  if (st === undefined) return;
  const plan = st.cur;
  for (let s = 0; s < plan.n; s++) freeSegmentId(plan.id[s]);
  plan.n = 0;
  plan.node.length = 0;
  st.ready = false;
}

/** One segment: RETAIN_DRAW when clean (returns true), else a new recording. */
function emitSegment(
  pk: SpriteScenePacker,
  plan: Plan,
  s: number,
  frame: FrontFrame,
  clean: boolean,
): boolean {
  const enc = frame.encoder;
  const first = plan.first[s];
  const end = plan.end[s];
  const batches = pk.batches;
  if (plan.gen[s] === frame.generation) {
    let same = clean && plan.live[s] === 0;
    if (!same) {
      same = true;
      for (let k = first; k < end; k++) {
        if (plan.kind[k] === BATCH_SPRITES) {
          if (batches.size[k] === 0) continue;
          const texId = ensureTextureUploaded(
            frame,
            batches.texture[k] as TextureHandle,
          );
          if (texId !== plan.tex[k]) same = false;
        } else if (
          (plan.node[k] as RetainableDrawable)._drawVersion !== plan.ver[k]
        ) {
          same = false;
        }
      }
    }
    if (same) {
      enc.begin(RetainOp.RETAIN_DRAW, RETAIN_DRAW_BYTES, CommandFlag.DRAW);
      enc.u32(plan.id[s]);
      enc.end();
      if (!clean) sync(pk, plan, first, end, frame);
      return true;
    }
  }
  record(pk, plan, s, frame);
  return false;
}

/** `_syncDraw` for the drawables of a replayed segment. */
function sync(
  pk: SpriteScenePacker,
  plan: Plan,
  first: number,
  end: number,
  frame: FrontFrame,
): void {
  const list = pk.list;
  const batches = pk.batches;
  const world = nodeStore.world;
  const alpha = nodeStore.worldAlpha;
  for (let k = first; k < end; k++) {
    if (plan.kind[k] === BATCH_SPRITES) continue;
    const slot = list.slot[batches.flat[k]];
    (plan.node[k] as RetainableDrawable)._syncDraw(
      frame,
      world,
      slot * AFF,
      alpha[slot],
    );
  }
}

/** RETAIN_BEGIN, the segment's commands as the immediate path emits them, RETAIN_END. */
function record(
  pk: SpriteScenePacker,
  plan: Plan,
  s: number,
  frame: FrontFrame,
): void {
  const enc = frame.encoder;
  const id = plan.id[s];
  const batches = pk.batches;
  const list = pk.list;
  const world = nodeStore.world;
  const alpha = nodeStore.worldAlpha;
  enc.begin(RetainOp.RETAIN_BEGIN, RETAIN_BEGIN_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  enc.u32(0);
  enc.end();
  frame.retainSegment = id;
  let live = 0;
  for (let k = plan.first[s]; k < plan.end[s]; k++) {
    if (plan.kind[k] === BATCH_SPRITES) {
      const count = batches.size[k];
      if (count === 0) continue;
      const texture = batches.texture[k] as TextureHandle;
      const texId = ensureTextureUploaded(frame, texture);
      plan.tex[k] = texId;
      if (
        texId === NO_ID ||
        (texture as { _source?: { provider?: unknown } })._source?.provider
      ) {
        live = 1;
      }
      enc.begin(Op.SPRITE_DRAW, SPRITE_DRAW_BYTES, CommandFlag.DRAW);
      enc.u32(pk.bufferId);
      enc.u32(batches.first[k]);
      enc.u32(count);
      enc.u32(texId);
      enc.u32(batches.blend[k]);
      enc.end();
    } else {
      const node = plan.node[k] as RetainableDrawable;
      const slot = list.slot[batches.flat[k]];
      node._emitDraw(frame, world, slot * AFF, alpha[slot]);
      plan.ver[k] = node._drawVersion;
    }
  }
  frame.retainSegment = 0;
  enc.begin(RetainOp.RETAIN_END, RETAIN_END_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  enc.end();
  plan.gen[s] = frame.generation;
  plan.live[s] = live;
}

/**
 * Splits the batch list into segments and carries the recordings of the
 * segments that did not change over (structure-change frames only).
 */
function partition(pk: SpriteScenePacker, st: SegState, frame: FrontFrame) {
  const prev = st.cur;
  const plan = st.old;
  st.old = prev;
  st.cur = plan;
  st.ready = true;
  const batches = pk.batches;
  const list = pk.list;
  const count = batches.count;
  plan.n = 0;
  plan.growBatches(count);
  plan.node.length = count;
  let open = -1;
  for (let b = 0; b < count; b++) {
    const kind = batches.kind[b];
    let node: unknown = null;
    let recordable = kind === BATCH_SPRITES;
    if (!recordable && kind !== BATCH_GROUP_BEGIN) {
      node = list.nodes[batches.flat[b]];
      // isRetainableDrawable (src/types/core.ts), inlined: a custom batch is
      // a CustomDrawable already.
      recordable =
        typeof (node as { _syncDraw?: unknown })._syncDraw === 'function';
    }
    if (!recordable) {
      if (open >= 0) {
        plan.end[plan.n++] = b;
        open = -1;
      }
      // A render group is drawn immediately as a whole.
      if (kind === BATCH_GROUP_BEGIN) b = skipGroup(batches, b);
      continue;
    }
    if (open < 0) {
      plan.growSegments(plan.n + 1);
      plan.first[plan.n] = open = b;
    }
    plan.kind[b] = kind;
    plan.node[b] = node;
    plan.a[b] = batches.first[b];
    plan.b[b] = batches.size[b];
    plan.c[b] = batches.blend[b];
  }
  if (open >= 0) plan.end[plan.n++] = count;

  // Carry recordings over: each new segment against the next few old ones.
  const old = prev;
  old.used.fill(0, 0, old.n);
  let j = 0;
  for (let s = 0; s < plan.n; s++) {
    let match = -1;
    for (let t = j; t < old.n && t < j + LOOKAHEAD; t++) {
      if (old.used[t] === 0 && same(plan, s, old, t)) {
        match = t;
        break;
      }
    }
    if (match < 0) {
      plan.id[s] = allocSegmentId();
      plan.gen[s] = -1;
      plan.live[s] = 0;
      continue;
    }
    old.used[match] = 1;
    j = match + 1;
    plan.id[s] = old.id[match];
    plan.gen[s] = old.gen[match];
    plan.live[s] = old.live[match];
    const d = old.first[match] - plan.first[s];
    for (let k = plan.first[s]; k < plan.end[s]; k++) {
      plan.tex[k] = old.tex[k + d];
      plan.ver[k] = old.ver[k + d];
    }
  }
  const enc = frame.encoder;
  for (let t = 0; t < old.n; t++) {
    if (old.used[t] !== 0) continue;
    enc.begin(RetainOp.RETAIN_DESTROY, RETAIN_DESTROY_BYTES);
    enc.u32(old.id[t]);
    enc.end();
    freeSegmentId(old.id[t]);
  }
  old.node.length = 0;
}

/** Segment `s` of `a` draws the same batches as segment `t` of `b`. */
function same(a: Plan, s: number, b: Plan, t: number): boolean {
  const n = a.end[s] - a.first[s];
  if (b.end[t] - b.first[t] !== n) return false;
  for (let i = 0; i < n; i++) {
    const p = a.first[s] + i;
    const q = b.first[t] + i;
    if (a.kind[p] !== b.kind[q]) return false;
    if (a.kind[p] === BATCH_SPRITES) {
      if (a.a[p] !== b.a[q] || a.b[p] !== b.b[q] || a.c[p] !== b.c[q]) {
        return false;
      }
    } else if (a.node[p] !== b.node[q]) {
      return false;
    }
  }
  return true;
}
