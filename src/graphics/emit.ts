/**
 * Front half of Graphics (ARCHITECTURE §26.3–§26.7, §27.4), chunk `graphics`.
 *
 * Per node: classify the context's paint operations into SDF shape runs and
 * mesh parts (in painter's order, compile.ts), keep the node's records in
 * the per-renderer persistent stores (shape records, a node record, unified
 * mesh vertices; pools.ts), rewrite them only when the world transform,
 * alpha, tint, pick id or the context changed, and emit draws.
 *
 * Unified batch (§27.4; WebGL2, and WebGPU with `caps.vertexStorage`): a
 * node appends its items (u32 indices naming shape corners and mesh
 * vertices) to the item region of `frame.retainSegment` (0 = the per-frame
 * region) and emits GFX_DRAW_UNIFIED, growing the previous draw command in
 * place when the run continues it, so a mixed tree of shapes and paths is
 * one draw. Items are rewritten only when they would differ from what the
 * same place held in the region's previous recording. Textured mesh parts
 * and contexts shared by HEAVY_USERS nodes or more keep the M4 instanced
 * GFX_DRAW_MESH; WebGPU without vertex storage keeps the M4 split path
 * (GFX_DRAW_SHAPES over the same persistent shape records).
 *
 * Retained rendering (§27.2): `drawVersion` changes whenever the node's
 * draw commands or items would change; `sync` is the replay path that only
 * brings the records up to date. Anything that cannot be synced without new
 * items (a context edit, a finer tessellation, a chunk or texture still
 * loading) bumps the version and `nodeStore.drawEpoch`, so the scene packer
 * re-records the segment next frame.
 *
 * Loading this chunk registers the core system's loader for the GRAPHICS
 * range; the tessellator (`graphics-tess`) is loaded only by contexts that
 * have a mesh part.
 */
import { BlendModeId } from '../backend/types';
import {
  CH_PAYLOAD_BYTES,
  COMMAND_HEADER_BYTES,
  CommandFlag,
  OpcodeRange,
} from '../commands/opcodes';
import {
  GFX_DRAW_UNIFIED_BYTES,
  GFX_DRAW_UNIFIED_COUNT_WORD,
  GfxDrawFlag,
  GfxMeshFlag,
  GfxOp,
  GfxPoolKind,
} from '../commands/gfxOpcodes';
import type { CommandEncoder } from '../commands/types';
import {
  loadCoreSystem,
  registerCoreSystemLoader,
} from '../renderer/lazySystems';
import { ensureTextureUploaded } from '../scene/Texture';
import type { FrontFrame, FrontFrameHook } from '../types/core';
import { NO_ID } from '../types/ids';
import { SI_PICK_MAX, SI_PICK_SHIFT } from '../types/layouts';
import {
  GFX_ITEM_CORNER_BITS,
  GFX_ITEM_KIND_SHIFT,
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_UVERTEX_BYTES,
  GN_A,
  GN_COLOR,
  GN_FLAGS,
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_W,
  GS_STROKE,
  GUV_COLOR,
  GUV_NODE,
  GfxItemKind,
} from '../types/gfxLayouts';
import { SPRITE_INSTANCE_F32_PER } from '../types/layouts';
import type { Compiled } from './compile';
import {
  DRAW_MESH_BYTES,
  DRAW_SHAPES_BYTES,
  MESH_COUNT_WORD,
  SHAPES_COUNT_WORD,
  SHAPE_WORDS,
  W_RESERVED,
} from './compileFormat';
import {
  PART,
  PART_MESH,
  PART_SDF,
  PART_TEX,
  PT_FIRST,
  PT_COUNT,
  PT_INDEX,
  PT_INDICES,
  PT_TEX,
  PT_TYPE,
  compile,
  deadMeshes,
} from './compile';
import type { GraphicsContext } from './GraphicsContext';
import { ItemRegion, LEGACY_NODES, LEGACY_SHAPES, RecordStore } from './pools';
import type {
  GraphicsBinding,
  GraphicsContextApi,
  GraphicsNode,
} from './types';

registerCoreSystemLoader(OpcodeRange.GRAPHICS, () =>
  import('./core').then(m => m.createGraphicsCoreSystem),
);

let tessChunk: Promise<typeof import('./tess')> | null = null;
let tess: typeof import('./tess') | null = null;

/** Loads the tessellator once per process (chunk `graphics-tess`). */
export function loadTess(): Promise<typeof import('./tess')> {
  return (tessChunk ??= import('./tess').then(m => (tess = m)));
}

/** Backs `GPU.loadGraphics` (src/graphics/Graphics.ts). */
export function preloadGraphics(which: 'core' | 'all'): Promise<void> {
  const core = loadCoreSystem(OpcodeRange.GRAPHICS);
  return which === 'all'
    ? Promise.all([core, loadTess()]).then(() => undefined)
    : core;
}

const NODE_WORDS = GFX_NODE_BYTES >> 2;
const UV_WORDS = GFX_UVERTEX_BYTES >> 2;
const MV_WORDS = GFX_MESH_VERTEX_BYTES >> 2;
const KIND_SHAPES = 1;
const KIND_MESH = 2;
const KIND_UNIFIED = 3;
/**
 * Contexts drawn by this many nodes keep the instanced M4 mesh draw: the
 * unified path stores a context's vertices once per node (§27.4).
 */
export const HEAVY_USERS = 16;
const SHAPE_ITEM = GfxItemKind.SHAPE << GFX_ITEM_KIND_SHIFT;

/** Mesh ids, private to the graphics core's table. */
let nextMeshId = 1;

/** Per-renderer state: record stores, item regions, the open draw. */
export class RendererState implements FrontFrameHook {
  frameId = -1;
  /** Frames this renderer drew Graphics in (records-written check). */
  seq = 0;
  gen = -1;
  /** Unified batch available (§27.4). */
  unified = false;
  /** Payload offset of the last GFX_DRAW_* this frame (-1: none). */
  lastDraw = -1;
  lastKind = 0;
  /** Encoder offset up to which no DRAW command follows the last draw. */
  lastEnd = 0;
  readonly shapes = new RecordStore(SHAPE_WORDS, LEGACY_SHAPES);
  readonly nodes = new RecordStore(NODE_WORDS, LEGACY_NODES);
  readonly verts = new RecordStore(UV_WORDS, GfxPoolKind.VERTICES);
  readonly sprites = new RecordStore(
    SPRITE_INSTANCE_F32_PER,
    GfxPoolKind.SPRITES,
  );
  readonly regions: ItemRegion[] = [];
  private region: ItemRegion | null = null;
  /**
   * Static bakes (§27.5): while non-zero, items go to this region key and
   * draws carry `transform` / `slots`.
   */
  bakeKey = 0;
  transform = 0;
  slots = 0;
  /** Next texture slot table id (GFX_SET_TEXTURE_SLOTS, private to the core). */
  nextSlots = 1;
  remove: (() => void) | null = null;

  constructor(readonly rid: number) {}

  /** The item region for `key`, created on first use. */
  regionFor(key: number): ItemRegion {
    const cached = this.region;
    if (cached !== null && cached.key === key) return cached;
    const list = this.regions;
    for (let i = 0; i < list.length; i++) {
      if (list[i].key === key) return (this.region = list[i]);
    }
    const region = new ItemRegion(key);
    list.push(region);
    return (this.region = region);
  }

  /** Per-frame reset; device loss drops every GPU copy. */
  beginFrame(frame: FrontFrame): void {
    if (this.frameId === frame.frameId) return;
    this.frameId = frame.frameId;
    this.seq++;
    this.lastDraw = -1;
    this.lastKind = 0;
    const caps = frame.caps;
    this.unified = caps.shaderLanguage !== 'wgsl' || caps.vertexStorage;
    if (this.gen !== frame.generation) {
      this.gen = frame.generation;
      this.shapes.lost();
      this.nodes.lost();
      this.verts.lost();
      this.sprites.lost();
      for (let i = 0; i < this.regions.length; i++) this.regions[i].lost();
    }
  }

  encodeFrame(): void {}

  encodeFrameEnd(frame: FrontFrame): void {
    flush(this, frame);
  }

  onRendererDestroyed(): void {
    const i = renderers.indexOf(this);
    if (i >= 0) renderers.splice(i, 1);
    let w = 0;
    for (let k = 0; k < deadMeshes.length; k += 2) {
      if (deadMeshes[k] !== this.rid) {
        deadMeshes[w++] = deadMeshes[k];
        deadMeshes[w++] = deadMeshes[k + 1];
      }
    }
    deadMeshes.length = w;
  }
}

const renderers: RendererState[] = [];

/** The Graphics state of renderer `rid`, or null (static bakes, tests). */
export function findRendererState(rid: number): RendererState | null {
  for (let i = 0; i < renderers.length; i++) {
    if (renderers[i].rid === rid) return renderers[i];
  }
  return null;
}

/** The Graphics state of the renderer encoding `frame` (created on first use). */
export function rendererState(frame: FrontFrame): RendererState {
  const found = findRendererState(frame.rendererId);
  if (found !== null) return found;
  const r = new RendererState(frame.rendererId);
  renderers.push(r);
  r.remove = frame._addFrameHook?.(r) ?? null;
  return r;
}

/** A node's records and items on one renderer, for one use (draw / mask). */
class NodeState {
  /** RendererState.seq of the last record check. */
  seq = -1;
  c: Compiled | null = null;
  /** Compiled version the shape records were written from. */
  version = -1;
  shape0 = -1;
  ns = 0;
  node0 = -1;
  vert0 = -1;
  nv = 0;
  /** Mesh stamp and node record the vertices were written with. */
  vStamp = -1;
  vNode = -1;
  /** Mesh stamp of the last drawn index ranges (instanced mesh draws). */
  mStamp = -1;
  heavy = false;
  /**
   * World a, b, c, d, tx, ty and alpha the records were written with. A
   * typed array: double stores into object fields can allocate.
   */
  readonly w = new Float64Array([0, 0, 0, 0, 0, 0, -1]);
  tint = -1;
  pick = -1;
  /** Bumped whenever the items would differ (allocation, parts, mesh). */
  ver = 0;
  /** Where the items were last written. */
  iRegion: ItemRegion | null = null;
  iSeq = -1;
  iAt = -1;
  iVer = -1;
  iTransform = -1;

  constructor(
    readonly rid: number,
    readonly use: number,
  ) {}

  /** Frees the records (node destroyed or context dropped). */
  release(): void {
    const r = findRendererState(this.rid);
    if (r !== null) {
      r.shapes.free(this.shape0, this.ns);
      if (this.node0 >= 0) r.nodes.free(this.node0, 1);
      r.verts.free(this.vert0, this.nv);
    }
    this.shape0 = this.node0 = this.vert0 = -1;
    this.ns = this.nv = 0;
    this.c = null;
    this.iRegion = null;
  }
}

/** Packed RGBA8 × tint (0xRRGGBB) × alpha. */
function tinted(c: number, tint: number, alpha: number): number {
  if (tint === 0xffffff && alpha === 1) return c;
  const r = ((c & 0xff) * ((tint >>> 16) & 0xff)) / 255;
  const g = (((c >>> 8) & 0xff) * ((tint >>> 8) & 0xff)) / 255;
  const b = (((c >>> 16) & 0xff) * (tint & 0xff)) / 255;
  const a = (c >>> 24) * Math.min(Math.max(alpha, 0), 1);
  return (
    ((r + 0.5) |
      0 |
      (((g + 0.5) | 0) << 8) |
      (((b + 0.5) | 0) << 16) |
      (((a + 0.5) | 0) << 24)) >>>
    0
  );
}

/**
 * Power-of-two tessellation scale for a world transform (§26.4). Static
 * bakes use it for their container's zoom.
 */
export function scaleBucket(
  w: Float32Array,
  o: number,
  resolution: number,
): number {
  const s =
    Math.max(Math.hypot(w[o], w[o + 1]), Math.hypot(w[o + 2], w[o + 3])) *
    resolution;
  return s > 0 ? 2 ** Math.max(-6, Math.min(16, Math.ceil(Math.log2(s)))) : 1;
}

/** No DRAW command between encoder offset `from` and the end. */
function noDrawSince(enc: CommandEncoder, from: number): boolean {
  const u = enc.u32View;
  const end = enc.byteLength;
  for (let p = from; p < end; ) {
    if ((u[p >> 2] >>> 16) & CommandFlag.DRAW) return false;
    p += COMMAND_HEADER_BYTES + u[(p + CH_PAYLOAD_BYTES) >> 2];
  }
  return true;
}

/** GFX_DRAW_UNIFIED of items [first, first + count), or grows the open one. */
export function drawUnified(
  r: RendererState,
  enc: CommandEncoder,
  region: ItemRegion,
  first: number,
  count: number,
  blend: number,
  flags: number,
): void {
  if (count === 0) return;
  const slots = r.slots;
  const transform = r.transform;
  if (r.lastKind === KIND_UNIFIED && noDrawSince(enc, r.lastEnd)) {
    const u = enc.u32View;
    const w = r.lastDraw >> 2;
    const n = w + GFX_DRAW_UNIFIED_COUNT_WORD;
    if (
      u[w] === region.id &&
      u[w + 1] + u[n] === first &&
      u[w + 7] === slots &&
      u[w + 8] === transform &&
      u[w + 9] === blend &&
      u[w + 10] === flags
    ) {
      u[n] += count;
      r.lastEnd = enc.byteLength;
      return;
    }
  }
  r.lastDraw = enc.begin(
    GfxOp.GFX_DRAW_UNIFIED,
    GFX_DRAW_UNIFIED_BYTES,
    CommandFlag.DRAW,
  );
  enc.u32(region.id);
  enc.u32(first);
  enc.u32(count);
  enc.u32(r.shapes.id);
  enc.u32(r.verts.id);
  enc.u32(r.nodes.id);
  enc.u32(r.sprites.id);
  enc.u32(slots);
  enc.u32(transform);
  enc.u32(blend);
  enc.u32(flags);
  enc.end();
  r.lastKind = KIND_UNIFIED;
  r.lastEnd = enc.byteLength;
}

function drawShapes(
  r: RendererState,
  enc: CommandEncoder,
  first: number,
  count: number,
  blend: number,
  flags: number,
): void {
  const buf = r.shapes.id;
  if (r.lastKind === KIND_SHAPES && noDrawSince(enc, r.lastEnd)) {
    const u = enc.u32View;
    const w = r.lastDraw >> 2;
    const n = w + SHAPES_COUNT_WORD;
    if (
      u[w] === buf &&
      u[w + 1] + u[n] === first &&
      u[w + 3] === blend &&
      u[w + 4] === flags
    ) {
      u[n] += count;
      r.lastEnd = enc.byteLength;
      return;
    }
  }
  r.lastDraw = enc.begin(
    GfxOp.GFX_DRAW_SHAPES,
    DRAW_SHAPES_BYTES,
    CommandFlag.DRAW,
  );
  enc.u32(buf);
  enc.u32(first);
  enc.u32(count);
  enc.u32(blend);
  enc.u32(flags);
  enc.end();
  r.lastKind = KIND_SHAPES;
  r.lastEnd = enc.byteLength;
}

function drawMesh(
  r: RendererState,
  enc: CommandEncoder,
  meshId: number,
  firstIndex: number,
  indexCount: number,
  firstNode: number,
  texId: number,
  blend: number,
  flags: number,
  uv: Float32Array,
  uvAt: number,
): void {
  const nodes = r.nodes.id;
  if (r.lastKind === KIND_MESH && noDrawSince(enc, r.lastEnd)) {
    const u = enc.u32View;
    const f = enc.f32View;
    const w = r.lastDraw >> 2;
    const n = w + MESH_COUNT_WORD;
    if (
      u[w] === meshId &&
      u[w + 1] === firstIndex &&
      u[w + 2] === indexCount &&
      u[w + 3] === nodes &&
      u[w + 4] + u[n] === firstNode &&
      u[w + 6] === texId &&
      u[w + 7] === blend &&
      u[w + 8] === flags &&
      f[w + 9] === uv[uvAt] &&
      f[w + 10] === uv[uvAt + 1] &&
      f[w + 11] === uv[uvAt + 2] &&
      f[w + 12] === uv[uvAt + 3] &&
      f[w + 13] === uv[uvAt + 4] &&
      f[w + 14] === uv[uvAt + 5]
    ) {
      u[n]++;
      r.lastEnd = enc.byteLength;
      return;
    }
  }
  r.lastDraw = enc.begin(
    GfxOp.GFX_DRAW_MESH,
    DRAW_MESH_BYTES,
    CommandFlag.DRAW,
  );
  enc.u32(meshId);
  enc.u32(firstIndex);
  enc.u32(indexCount);
  enc.u32(nodes);
  enc.u32(firstNode);
  enc.u32(1);
  enc.u32(texId);
  enc.u32(blend);
  enc.u32(flags);
  for (let i = 0; i < 6; i++) enc.f32(uv[uvAt + i]);
  enc.end();
  r.lastKind = KIND_MESH;
  r.lastEnd = enc.byteLength;
}

/** The context's mesh id on this renderer; uploads it when stale. */
function meshFor(r: RendererState, frame: FrontFrame, c: Compiled): number {
  c.drawRid = r.rid;
  c.drawFrame = frame.frameId;
  let k = c.rids.indexOf(r.rid);
  if (k < 0) {
    k = c.rids.length;
    c.rids.push(r.rid);
    c.mids.push(nextMeshId++);
    c.gens.push(-1);
    c.stamps.push(-1);
  }
  if (c.gens[k] !== r.gen || c.stamps[k] !== c.meshStamp) {
    c.gens[k] = r.gen;
    c.stamps[k] = c.meshStamp;
    const m = c.mesh!;
    const wide = m.vn > 0xffff;
    const indexBytes = m.in * (wide ? 4 : 2);
    const enc = frame.encoder;
    enc.begin(
      GfxOp.GFX_MESH_UPLOAD,
      16 + m.vn * GFX_MESH_VERTEX_BYTES + ((indexBytes + 3) & ~3),
    );
    enc.u32(c.mids[k]);
    enc.u32(m.vn);
    enc.u32(m.in);
    enc.u32(wide ? GfxMeshFlag.U32_INDEX : 0);
    enc.bytes(m.vf, 0, m.vn * GFX_MESH_VERTEX_BYTES);
    enc.bytes(wide ? m.i : c.i16!, 0, indexBytes);
    enc.end();
  }
  return c.mids[k];
}

/** A mesh part drawn by the unified batch (not textured, context not shared widely). */
function unifiedMesh(type: number, heavy: boolean): boolean {
  return type === PART_MESH && !heavy;
}

const MODE_DRAW = 0;
const MODE_SYNC = 1;
/**
 * Resolution × world scale of the static container a bake draws in (its
 * `world` is relative to the container), 0 outside a bake.
 */
let bakeScale = 0;
/** NodeState uses: drawn, mask geometry, baked into a static container. */
const USE_MASK = 1;
const USE_BAKE = 2;

/**
 * Packs one node into the stores and (MODE_DRAW) emits its draws.
 * `flags`: GfxDrawFlag bits for every draw (MASK_WRITE for stencil mask
 * geometry); `use` keeps the mask copy's records apart from the drawn
 * copy's. Returns false while something it needs is still loading.
 */
function pack(
  bd: Binding,
  frame: FrontFrame,
  world: Float32Array,
  wo: number,
  alpha: number,
  flags: number,
  use: number,
  mode: number,
): boolean {
  const node = bd.node;
  const ctx = node.context as GraphicsContext;
  if (ctx._destroyed) return true;
  if (!frame.isSystemReady(OpcodeRange.GRAPHICS)) return bd.pending();
  const c = compile(ctx);
  const sync = mode === MODE_SYNC;
  let deferred = false;
  if (c.nj > 0) {
    if (tess === null) {
      void loadTess();
      return bd.pending();
    }
    if (c.meshVersion !== c.version || c.dep) {
      const s = scaleBucket(
        world,
        wo,
        use === USE_BAKE ? bakeScale : frame.resolution,
      );
      const want = Math.max(s, c.wantScale);
      if (c.meshVersion !== c.version) {
        if (sync) return bd.pending();
        tess.tessellate(ctx, c, Math.max(want, c.meshScale));
      } else if (want > c.meshScale) {
        // A larger bucket: not while an earlier draw of this frame holds
        // the current mesh, and never while replaying (the recorded items
        // point at the current vertices): next frame re-records.
        if (
          sync ||
          (c.drawRid === frame.rendererId && c.drawFrame === frame.frameId)
        ) {
          c.wantScale = want;
          if (sync) bd.pending();
          // A bake keeps no frame-to-frame draw: it bakes again next frame.
          else if (use === USE_BAKE) deferred = true;
        } else {
          tess.tessellate(ctx, c, want);
        }
      }
    }
  }

  const r = rendererState(frame);
  r.beginFrame(frame);
  const st = bd.state(r.rid, use);
  const sab = frame.useSharedArrayBuffer;
  const unified = r.unified;
  // A bake never uses the instanced mesh draw: it ignores the transform slot.
  const heavy = use !== USE_BAKE && ctx._users >= HEAVY_USERS;
  const mesh = c.nj > 0 ? c.mesh : null;

  // ── record allocation: a change means new items (MODE_SYNC: re-record).
  const ns = c.ns;
  const nv = unified && mesh !== null && !heavy ? mesh.vn : 0;
  if (
    st.c !== c ||
    st.ns !== ns ||
    st.nv !== nv ||
    st.heavy !== heavy ||
    (mesh !== null) !== st.node0 >= 0 ||
    st.version !== c.version ||
    (nv > 0 && st.vStamp !== c.meshStamp) ||
    // Recorded instanced mesh draws carry index ranges of one tessellation.
    (sync && mesh !== null && st.mStamp !== c.meshStamp)
  ) {
    if (sync) return bd.pending();
    st.c = c;
    st.heavy = heavy;
    st.version = -1;
    if (st.ns !== ns) {
      r.shapes.free(st.shape0, st.ns);
      st.shape0 = ns > 0 ? r.shapes.alloc(ns, sab) : -1;
      st.ns = ns;
    }
    if (mesh !== null && st.node0 < 0) st.node0 = r.nodes.alloc(1, sab);
    else if (mesh === null && st.node0 >= 0) {
      r.nodes.free(st.node0, 1);
      st.node0 = -1;
    }
    if (st.nv !== nv) {
      r.verts.free(st.vert0, st.nv);
      st.vert0 = nv > 0 ? r.verts.alloc(nv, sab) : -1;
      st.nv = nv;
      st.vStamp = -1;
    }
    st.seq = -1; // rewrite every record below
    st.ver++;
    bd.ver++;
  }

  // ── records: rewritten only when their inputs changed (§26.6).
  const pick =
    node.pickable && node.id <= SI_PICK_MAX
      ? (node.id << SI_PICK_SHIFT) >>> 0
      : 0;
  const n0 = st.node0;
  writeRecords(st, c, r, world, wo, alpha, node.tint, pick);
  st.seq = r.seq;

  // ── unified vertices: context-space positions + colour + node record.
  if (nv > 0 && (st.vStamp !== c.meshStamp || st.vNode !== n0)) {
    st.vStamp = c.meshStamp;
    st.vNode = n0;
    const src = mesh!.vu;
    const sf = mesh!.vf;
    const du = r.verts.u32;
    const df = r.verts.f32;
    for (let v = 0; v < nv; v++) {
      const i = v * MV_WORDS;
      const o = (st.vert0 + v) * UV_WORDS;
      df[o] = sf[i];
      df[o + 1] = sf[i + 1];
      du[o + (GUV_COLOR >> 2)] = src[i + 2];
      du[o + (GUV_NODE >> 2)] = n0;
    }
    r.verts.touch(st.vert0, nv);
    st.ver++;
    bd.ver++;
  }
  if (sync) return true;
  if (mesh !== null) st.mStamp = c.meshStamp;

  // ── items (unified) and draws, in painter's order.
  const enc = frame.encoder;
  const blend = BlendModeId[node.blendMode];
  const parts = c.parts;
  let region: ItemRegion | null = null;
  let at = 0;
  if (unified) {
    let n = 0;
    for (let p = 0; p < c.np; p++) {
      const P = p * PART;
      const type = parts[P + PT_TYPE];
      if (type === PART_SDF) n += 6 * parts[P + PT_COUNT];
      else if (unifiedMesh(type, heavy)) n += parts[P + PT_INDICES];
    }
    region = r.regionFor(
      r.bakeKey !== 0 ? r.bakeKey : (frame.retainSegment ?? 0),
    );
    region.begin(frame.frameId);
    at = region.top;
    region.top += n;
    region.ensure(region.top, sab);
    if (
      st.iRegion !== region ||
      st.iSeq !== region.seq - 1 ||
      st.iAt !== at ||
      st.iVer !== st.ver
    ) {
      writeItems(st, c, region.u32, at, heavy);
      region.touch(at, n);
      st.iRegion = region;
      st.iAt = at;
      st.iVer = st.ver;
    }
    st.iSeq = region.seq;
  }
  let off = at;
  for (let p = 0; p < c.np; p++) {
    const P = p * PART;
    const type = parts[P + PT_TYPE];
    if (type === PART_SDF) {
      const count = parts[P + PT_COUNT];
      if (region !== null) {
        drawUnified(r, enc, region, off, 6 * count, blend, flags);
        off += 6 * count;
      } else {
        drawShapes(
          r,
          enc,
          st.shape0 + parts[P + PT_FIRST],
          count,
          blend,
          flags,
        );
      }
      continue;
    }
    const count = parts[P + PT_INDICES];
    if (count === 0) continue;
    if (region !== null && unifiedMesh(type, heavy)) {
      drawUnified(r, enc, region, off, count, blend, flags);
      off += count;
      continue;
    }
    let texId = NO_ID;
    let f = flags;
    if (type === PART_TEX) {
      texId = ensureTextureUploaded(frame, ctx._tex[parts[P + PT_TEX]]);
      if (texId === NO_ID) {
        bd.pending();
        continue;
      }
      f |= GfxDrawFlag.TEXTURED;
    }
    drawMesh(
      r,
      enc,
      meshFor(r, frame, c),
      parts[P + PT_INDEX],
      count,
      n0,
      texId,
      blend,
      f,
      c.uv,
      p * 6,
    );
  }
  return !deferred;
}

/**
 * Rewrites the node's shape records and node record when the world, alpha,
 * tint, pick id or the compiled context changed (§26.6). Its own function:
 * the doubles stay local, which keeps optimizing compilers from boxing them.
 */
function writeRecords(
  st: NodeState,
  c: Compiled,
  r: RendererState,
  world: Float32Array,
  wo: number,
  alpha: number,
  tint: number,
  pick: number,
): void {
  const a = world[wo];
  const b = world[wo + 1];
  const cc = world[wo + 2];
  const d = world[wo + 3];
  const tx = world[wo + 4];
  const ty = world[wo + 5];
  const s0 = st.shape0;
  const n0 = st.node0;
  const ns = c.ns;
  const sw = st.w;
  if (
    st.seq < 0 ||
    st.version !== c.version ||
    sw[0] !== a ||
    sw[1] !== b ||
    sw[2] !== cc ||
    sw[3] !== d ||
    sw[4] !== tx ||
    sw[5] !== ty ||
    sw[6] !== alpha ||
    st.tint !== tint ||
    st.pick !== pick
  ) {
    st.version = c.version;
    sw[0] = a;
    sw[1] = b;
    sw[2] = cc;
    sw[3] = d;
    sw[4] = tx;
    sw[5] = ty;
    sw[6] = alpha;
    st.tint = tint;
    st.pick = pick;
    if (ns > 0) {
      const f = r.shapes.f32;
      const u = r.shapes.u32;
      const tf = c.sf;
      const tu = c.su;
      for (let k = 0; k < ns; k++) {
        const src = k * SHAPE_WORDS + (GS_A >> 2);
        const o = (s0 + k) * SHAPE_WORDS;
        const dst = o + (GS_A >> 2);
        const la = tf[src];
        const lb = tf[src + 1];
        const lc = tf[src + 2];
        const ld = tf[src + 3];
        const ltx = tf[src + 4];
        const lty = tf[src + 5];
        f[dst] = a * la + cc * lb;
        f[dst + 1] = b * la + d * lb;
        f[dst + 2] = a * lc + cc * ld;
        f[dst + 3] = b * lc + d * ld;
        f[dst + 4] = a * ltx + cc * lty + tx;
        f[dst + 5] = b * ltx + d * lty + ty;
        // Half extents, kind parameters and stroke bands are copied as is.
        for (let w = GS_HALF_W >> 2; w < GS_FILL >> 2; w++) {
          f[o + w] = tf[k * SHAPE_WORDS + w];
        }
        const t = k * SHAPE_WORDS;
        u[o + (GS_FILL >> 2)] = tinted(tu[t + (GS_FILL >> 2)], tint, alpha);
        u[o + (GS_STROKE >> 2)] = tinted(tu[t + (GS_STROKE >> 2)], tint, alpha);
        u[o + (GS_FLAGS >> 2)] = tu[t + (GS_FLAGS >> 2)] | pick;
        u[o + W_RESERVED] = 0;
      }
      r.shapes.touch(s0, ns);
    }
    if (n0 >= 0) {
      const f = r.nodes.f32;
      const o = n0 * NODE_WORDS;
      const A = o + (GN_A >> 2);
      f[A] = a;
      f[A + 1] = b;
      f[A + 2] = cc;
      f[A + 3] = d;
      f[A + 4] = tx;
      f[A + 5] = ty;
      r.nodes.u32[o + (GN_COLOR >> 2)] = tinted(0xffffffff, tint, alpha);
      r.nodes.u32[o + (GN_FLAGS >> 2)] = pick;
      r.nodes.touch(n0, 1);
    }
  }
}

/** Writes the node's unified items at `items[at]`, in painter's order. */
function writeItems(
  st: NodeState,
  c: Compiled,
  items: Uint32Array<ArrayBufferLike>,
  at: number,
  heavy: boolean,
): void {
  const parts = c.parts;
  let k = at;
  for (let p = 0; p < c.np; p++) {
    const P = p * PART;
    const type = parts[P + PT_TYPE];
    if (type === PART_SDF) {
      const first = st.shape0 + parts[P + PT_FIRST];
      const end = first + parts[P + PT_COUNT];
      for (let s = first; s < end; s++) {
        // Quad corners 0, 1, 2, 2, 1, 3 (two triangles).
        const base = (SHAPE_ITEM | (s << GFX_ITEM_CORNER_BITS)) >>> 0;
        items[k] = base;
        items[k + 1] = base + 1;
        items[k + 2] = base + 2;
        items[k + 3] = base + 2;
        items[k + 4] = base + 1;
        items[k + 5] = base + 3;
        k += 6;
      }
    } else if (unifiedMesh(type, heavy)) {
      const idx = c.mesh!.i;
      const v0 = st.vert0;
      const from = parts[P + PT_INDEX];
      const end = from + parts[P + PT_INDICES];
      for (let i = from; i < end; i++) items[k++] = v0 + idx[i];
    }
  }
}

/** FrontFrameHook.encodeFrameEnd: mesh destroys, then the store uploads. */
function flush(r: RendererState, frame: FrontFrame): void {
  const enc = frame.encoder;
  if (deadMeshes.length > 0) {
    let w = 0;
    for (let k = 0; k < deadMeshes.length; k += 2) {
      if (deadMeshes[k] === r.rid) {
        enc.begin(GfxOp.GFX_MESH_DESTROY, 4);
        enc.u32(deadMeshes[k + 1]);
        enc.end();
      } else {
        deadMeshes[w++] = deadMeshes[k];
        deadMeshes[w++] = deadMeshes[k + 1];
      }
    }
    deadMeshes.length = w;
  }
  if (r.frameId !== frame.frameId) return;
  r.shapes.upload(frame);
  r.nodes.upload(frame);
  r.verts.upload(frame);
  r.sprites.upload(frame);
  const regions = r.regions;
  for (let i = 0; i < regions.length; i++) regions[i].upload(frame);
}

export class Binding implements GraphicsBinding {
  private states: NodeState[] = [];
  /** Draw version (§27.2): see RetainableDrawable._drawVersion. */
  ver = 0;
  private seenCtx: GraphicsContextApi | null = null;
  private seenCtxVersion = -1;
  private seenBlend = '';
  private seenHeavy = false;
  /** The context this binding counts itself a user of (`_users`). */
  private ctxRef: GraphicsContext;
  /** Context version the texture check of `bake` ran on, and its result. */
  private texChecked = -1;
  private textured = false;
  /** The last `bake` drew everything (false: something was loading). */
  baked = true;

  constructor(readonly node: GraphicsNode) {
    this.ctxRef = node.context as GraphicsContext;
    this.ctxRef._users++;
  }

  get ready(): Promise<void> {
    const ctx = this.node.context as GraphicsContext;
    return preloadGraphics(
      !ctx._destroyed && compile(ctx).nj > 0 ? 'all' : 'core',
    );
  }

  state(rid: number, use: number): NodeState {
    const s = this.states;
    for (let i = 0; i < s.length; i++) {
      if (s[i].rid === rid && s[i].use === use) return s[i];
    }
    const st = new NodeState(rid, use);
    s.push(st);
    return st;
  }

  /**
   * Something the node needs is still loading: keep the scene packer
   * re-recording (and calling `emitDraw`) until it has landed.
   */
  pending(): false {
    this.ver++;
    // The shell bumps nodeStore.drawEpoch (this chunk does not import the
    // store, which would split it out of the minimal program).
    (this.node as unknown as { _touchEpoch(): void })._touchEpoch();
    return false;
  }

  /** RetainableDrawable._drawVersion. */
  get drawVersion(): number {
    const node = this.node;
    const ctx = node.context as GraphicsContext;
    const heavy = ctx._users >= HEAVY_USERS;
    if (
      ctx !== this.seenCtx ||
      ctx._version !== this.seenCtxVersion ||
      node.blendMode !== this.seenBlend ||
      heavy !== this.seenHeavy
    ) {
      this.seenCtx = ctx;
      this.seenCtxVersion = ctx._version;
      this.seenBlend = node.blendMode;
      this.seenHeavy = heavy;
      this.ver++;
    }
    return this.ver;
  }

  emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    pack(this, frame, world, worldOffset, worldAlpha, 0, 0, MODE_DRAW);
  }

  /** RetainableDrawable._syncDraw: records only, no draw. */
  syncDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    pack(this, frame, world, worldOffset, worldAlpha, 0, 0, MODE_SYNC);
  }

  maskRect(out: Float32Array): boolean {
    const ctx = this.node.context as GraphicsContext;
    return !ctx._destroyed && compile(ctx).rect(out);
  }

  emitMaskGeometry(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    stencil: boolean,
  ): boolean {
    return pack(
      this,
      frame,
      world,
      worldOffset,
      1,
      stencil ? GfxDrawFlag.MASK_WRITE : 0,
      USE_MASK,
      MODE_DRAW,
    );
  }

  /**
   * Static bake (§27.5): draws the node into the bake set up on the renderer
   * state (`bakeKey`, `transform`, `slots`) with `world` relative to the
   * static container. False when the node cannot be baked (a texture fill
   * keeps its uv matrix per draw; no unified batch on this device), so the
   * bake draws it live; `pending` reports a part still loading. `scale`:
   * the container's world scale × resolution (curves tessellate for it).
   */
  bake(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
    scale: number,
  ): boolean {
    const ctx = this.node.context as GraphicsContext;
    const caps = frame.caps;
    if (caps.shaderLanguage === 'wgsl' && !caps.vertexStorage) return false;
    if (!ctx._destroyed && ctx._version === this.texChecked) {
      if (this.textured) return false;
    } else if (!ctx._destroyed) {
      this.texChecked = ctx._version;
      const c = compile(ctx);
      this.textured = false;
      for (let p = 0; p < c.np; p++) {
        if (c.parts[p * PART + PT_TYPE] === PART_TEX) this.textured = true;
      }
      if (this.textured) return false;
    }
    bakeScale = scale;
    this.baked = pack(
      this,
      frame,
      world,
      worldOffset,
      worldAlpha,
      0,
      USE_BAKE,
      MODE_DRAW,
    );
    bakeScale = 0;
    return true;
  }

  setContext(context: GraphicsContextApi): void {
    // drawVersion notices the new context; records are re-allocated on the
    // next draw (st.c differs).
    this.ctxRef._users--;
    this.ctxRef = context as GraphicsContext;
    this.ctxRef._users++;
  }

  destroy(): void {
    const s = this.states;
    for (let i = 0; i < s.length; i++) s[i].release();
    s.length = 0;
    this.ctxRef._users--;
  }
}

/** The per-node binding (§26.6). */
export const createGraphicsBinding = (node: GraphicsNode): Binding =>
  new Binding(node);
