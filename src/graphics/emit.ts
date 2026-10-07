/**
 * Front half of Graphics (ARCHITECTURE §26.3–§26.7), chunk `graphics`.
 *
 * Per node: classify the context's paint operations into SDF shape runs and
 * mesh parts (in painter's order, compile.ts), keep the node's ranges in the
 * per-renderer draw-order arenas (shape instances, node records), rewrite
 * them only when the world transform, alpha, tint, pick id, the context or
 * the slot changed, upload dirty ranges, and emit GFX_DRAW_* — growing the
 * previous draw command in place when the run continues it.
 *
 * Loading this chunk registers the core system's loader for the GRAPHICS
 * range (main-thread renderers fetch `graphics-core` on the first
 * `frame.isSystemReady(OpcodeRange.GRAPHICS)`; the worker entry registers
 * its own). The tessellator (`graphics-tess`) is loaded only by contexts
 * that have a mesh part.
 *
 * Command conventions (the graphics core reads them this way):
 *   - shape and node buffers are re-allocated (ALLOC, then a full upload)
 *     after growth and after a device loss; `_SHARED` uploads pass
 *     byteOffset 0, the data of slot `first` sits at first × stride;
 *   - a GFX_MESH_UPLOAD is emitted before the first draw that needs the
 *     mesh in a frame (once per renderer, context version and scale bucket);
 *     a mesh is never re-tessellated after a draw of the same frame used it
 *     (a larger bucket waits for the next frame), so every draw of a frame
 *     matches the mesh uploaded for it;
 *   - SDF instances: see compile.ts (`shape`) for the per-kind fields.
 */
import { BlendModeId } from '../backend/types';
import {
  CH_PAYLOAD_BYTES,
  COMMAND_HEADER_BYTES,
  CommandFlag,
  Op,
  OpcodeRange,
} from '../commands/opcodes';
import { GfxDrawFlag, GfxMeshFlag, GfxOp } from '../commands/gfxOpcodes';
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
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GN_A,
  GN_COLOR,
  GN_FLAGS,
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_W,
  GS_STROKE,
} from '../types/gfxLayouts';
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
import type {
  CreateGraphicsBinding,
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
const KIND_SHAPES = 1;
const KIND_MESH = 2;

/** Buffer and mesh ids, private to the graphics core's tables. */
let nextBufferId = 1;
let nextMeshId = 1;

/** One draw-order store (shape instances or node records) and its GPU buffer. */
class Arena {
  buf: ArrayBuffer | SharedArrayBuffer = new ArrayBuffer(0);
  f32: Float32Array<ArrayBufferLike> = new Float32Array(0);
  u32: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  /** Capacity in records, on the CPU and on the GPU. */
  cap = 0;
  gpuCap = 0;
  /** Dirty record interval [lo, hi) of this frame. */
  lo = 0;
  hi = 0;
  sharedBuf: ArrayBuffer | SharedArrayBuffer | null = null;
  sharedId = 0;
  readonly id = nextBufferId++;

  constructor(readonly words: number) {}

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
    this.f32 = new Float32Array(buf);
    this.cap = cap;
  }

  dirty(first: number, count: number): void {
    if (this.hi <= this.lo) {
      this.lo = first;
      this.hi = first + count;
    } else {
      if (first < this.lo) this.lo = first;
      if (first + count > this.hi) this.hi = first + count;
    }
  }

  lost(): void {
    this.gpuCap = 0;
    this.sharedBuf = null;
    this.sharedId = 0;
  }
}

/** Per-renderer state: arenas, frame cursors, the last draw for coalescing. */
class RendererState implements FrontFrameHook {
  frameId = -1;
  /** Frames this renderer drew Graphics in (slot reuse check). */
  seq = 0;
  gen = -1;
  shapeCursor = 0;
  nodeCursor = 0;
  /** Payload offset of the last GFX_DRAW_* this frame (-1: none). */
  lastDraw = -1;
  lastKind = 0;
  /** Encoder offset up to which no DRAW command follows the last draw. */
  lastEnd = 0;
  readonly shapes = new Arena(SHAPE_WORDS);
  readonly nodes = new Arena(NODE_WORDS);
  remove: (() => void) | null = null;

  constructor(readonly rid: number) {}

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

function rendererState(frame: FrontFrame): RendererState {
  const rid = frame.rendererId;
  for (let i = 0; i < renderers.length; i++) {
    if (renderers[i].rid === rid) return renderers[i];
  }
  const r = new RendererState(rid);
  renderers.push(r);
  r.remove = frame._addFrameHook?.(r) ?? null;
  return r;
}

/** Last inputs a node wrote its slots with, per renderer and use (draw / mask). */
class NodeState {
  seq = -1;
  c: Compiled | null = null;
  version = -1;
  shape0 = -1;
  node0 = -1;
  a = 0;
  b = 0;
  c2 = 0;
  d = 0;
  tx = 0;
  ty = 0;
  alpha = -1;
  tint = -1;
  pick = -1;

  constructor(
    readonly rid: number,
    readonly use: number,
  ) {}
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

/** Power-of-two tessellation scale for a world transform (§26.4). */
function scaleBucket(w: Float32Array, o: number, resolution: number): number {
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

/**
 * Packs one node into the arenas and emits its draws. `flags`: GfxDrawFlag
 * bits for every draw (MASK_WRITE for stencil mask geometry); `use` keeps
 * the mask copy's slots apart from the drawn copy's.
 */
function draw(
  bd: Binding,
  frame: FrontFrame,
  world: Float32Array,
  wo: number,
  alpha: number,
  flags: number,
  use: number,
): boolean {
  const node = bd.node;
  const ctx = node.context as GraphicsContext;
  if (ctx._destroyed) return true;
  if (!frame.isSystemReady(OpcodeRange.GRAPHICS)) return false;
  const c = compile(ctx);
  if (c.nj > 0) {
    if (tess === null) {
      void loadTess();
      return false;
    }
    if (c.meshVersion !== c.version || c.dep) {
      const s = scaleBucket(world, wo, frame.resolution);
      const want = Math.max(s, c.wantScale);
      if (c.meshVersion !== c.version) {
        tess.tessellate(ctx, c, Math.max(want, c.meshScale));
      } else if (want > c.meshScale) {
        // A larger bucket: not while an earlier draw of this frame holds
        // the current index ranges (see Compiled.drawFrame).
        if (c.drawRid === frame.rendererId && c.drawFrame === frame.frameId) {
          c.wantScale = want;
        } else {
          tess.tessellate(ctx, c, want);
        }
      }
    }
  }

  const r = rendererState(frame);
  if (r.frameId !== frame.frameId) {
    r.frameId = frame.frameId;
    r.seq++;
    r.shapeCursor = r.nodeCursor = 0;
    r.lastDraw = -1;
    r.lastKind = 0;
    if (r.gen !== frame.generation) {
      r.gen = frame.generation;
      r.shapes.lost();
      r.nodes.lost();
    }
  }
  const shapes = c.ns;
  const nodes = c.nj > 0 ? 1 : 0;
  const s0 = r.shapeCursor;
  const n0 = r.nodeCursor;
  r.shapeCursor += shapes;
  r.nodeCursor += nodes;
  const sab = frame.useSharedArrayBuffer;
  if (shapes) r.shapes.ensure(r.shapeCursor, sab);
  if (nodes) r.nodes.ensure(r.nodeCursor, sab);

  // Change detection by value (§26.6).
  const st = bd.state(r.rid, use);
  const tint = node.tint;
  const pick =
    node.pickable && node.id <= SI_PICK_MAX
      ? (node.id << SI_PICK_SHIFT) >>> 0
      : 0;
  const a = world[wo];
  const b = world[wo + 1];
  const cc = world[wo + 2];
  const d = world[wo + 3];
  const tx = world[wo + 4];
  const ty = world[wo + 5];
  if (
    st.seq !== r.seq - 1 ||
    st.c !== c ||
    st.version !== c.version ||
    st.shape0 !== s0 ||
    st.node0 !== n0 ||
    st.a !== a ||
    st.b !== b ||
    st.c2 !== cc ||
    st.d !== d ||
    st.tx !== tx ||
    st.ty !== ty ||
    st.alpha !== alpha ||
    st.tint !== tint ||
    st.pick !== pick
  ) {
    st.c = c;
    st.version = c.version;
    st.shape0 = s0;
    st.node0 = n0;
    st.a = a;
    st.b = b;
    st.c2 = cc;
    st.d = d;
    st.tx = tx;
    st.ty = ty;
    st.alpha = alpha;
    st.tint = tint;
    st.pick = pick;
    if (shapes) {
      const f = r.shapes.f32;
      const u = r.shapes.u32;
      const tf = c.sf;
      const tu = c.su;
      for (let k = 0; k < shapes; k++) {
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
      r.shapes.dirty(s0, shapes);
    }
    if (nodes) {
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
      r.nodes.dirty(n0, 1);
    }
  }
  st.seq = r.seq;

  // Draws, in painter's order.
  const enc = frame.encoder;
  const blend = BlendModeId[node.blendMode];
  const parts = c.parts;
  for (let p = 0; p < c.np; p++) {
    const P = p * PART;
    const type = parts[P + PT_TYPE];
    if (type === PART_SDF) {
      drawShapes(
        r,
        enc,
        s0 + parts[P + PT_FIRST],
        parts[P + PT_COUNT],
        blend,
        flags,
      );
      continue;
    }
    const count = parts[P + PT_INDICES];
    if (count === 0) continue;
    let texId = NO_ID;
    let f = flags;
    if (type === PART_TEX) {
      texId = ensureTextureUploaded(frame, ctx._tex[parts[P + PT_TEX]]);
      if (texId === NO_ID) continue;
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
  return true;
}

function upload(
  a: Arena,
  count: number,
  frame: FrontFrame,
  alloc: number,
  inline: number,
  shared: number,
  stride: number,
): void {
  const enc = frame.encoder;
  if (count > 0 && a.gpuCap < a.cap) {
    enc.begin(alloc, 8);
    enc.u32(a.id);
    enc.u32(a.cap);
    enc.end();
    a.gpuCap = a.cap;
    a.lo = 0;
    a.hi = count;
  }
  const first = a.lo;
  const n = Math.min(a.hi, count) - first;
  a.lo = a.hi = 0;
  if (n <= 0) return;
  if (frame.sharedMemory) {
    if (a.sharedBuf !== a.buf) {
      if (a.sharedId !== 0) {
        enc.begin(Op.SHARED_RELEASE, 4);
        enc.u32(a.sharedId);
        enc.end();
      }
      a.sharedBuf = a.buf;
      a.sharedId = frame.registerShared(a.buf);
    }
    enc.begin(shared, 20);
    enc.u32(a.id);
    enc.u32(first);
    enc.u32(n);
    enc.u32(a.sharedId);
    enc.u32(0);
  } else {
    enc.begin(inline, 12 + n * stride);
    enc.u32(a.id);
    enc.u32(first);
    enc.u32(n);
    enc.bytes(a.u32, first * stride, n * stride);
  }
  enc.end();
}

/** FrontFrameHook.encodeFrameEnd: mesh destroys, then one upload per arena. */
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
  upload(
    r.shapes,
    r.shapeCursor,
    frame,
    GfxOp.GFX_SHAPE_BUFFER_ALLOC,
    GfxOp.GFX_SHAPE_UPLOAD,
    GfxOp.GFX_SHAPE_UPLOAD_SHARED,
    GFX_SHAPE_BYTES,
  );
  upload(
    r.nodes,
    r.nodeCursor,
    frame,
    GfxOp.GFX_NODE_BUFFER_ALLOC,
    GfxOp.GFX_NODE_UPLOAD,
    GfxOp.GFX_NODE_UPLOAD_SHARED,
    GFX_NODE_BYTES,
  );
}

class Binding implements GraphicsBinding {
  private states: NodeState[] = [];

  constructor(readonly node: GraphicsNode) {}

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

  emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    draw(this, frame, world, worldOffset, worldAlpha, 0, 0);
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
    return draw(
      this,
      frame,
      world,
      worldOffset,
      1,
      stencil ? GfxDrawFlag.MASK_WRITE : 0,
      1,
    );
  }

  setContext(_context: GraphicsContextApi): void {
    // Change detection compares the compiled context: nothing to reset.
  }

  destroy(): void {
    this.states.length = 0;
  }
}

/** The per-node binding (§26.6). */
export const createGraphicsBinding: CreateGraphicsBinding = node =>
  new Binding(node);
