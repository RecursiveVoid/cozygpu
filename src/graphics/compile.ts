/**
 * Classification of a recorded context (ARCHITECTURE §26.3), chunk
 * `graphics`. Runs when a frame first draws a context after a change and
 * produces, in painter's order:
 *
 *   - SDF shape instances in context space (GFX_SHAPE_BYTES each, the
 *     affine mapping shape space to context space; the node's world affine,
 *     tint, alpha and pick id are applied when a node writes its slots);
 *   - mesh jobs (one per mesh paint: the path, its style and its holes),
 *     tessellated by `graphics-tess` into one shared mesh;
 *   - parts: runs of SDF instances and mesh index ranges. Consecutive
 *     untextured mesh paints share one part; a textured paint is a part of
 *     its own (its texture and uv matrix travel in the draw).
 *
 * Everything lives in typed arrays that grow and are reused, so recompiling
 * an SDF-only context every frame (clear + redraw) allocates nothing.
 */
import {
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_W,
  GS_STROKE,
  GS_STROKE_IN,
} from '../types/gfxLayouts';
import {
  G_ARC,
  G_ARGS,
  G_BEGIN,
  G_CUT,
  G_ELLIPSE,
  G_LINE,
  G_MOVE,
  G_POLY,
  G_RECT,
  G_RRECT,
  G_STROKE,
  G_XFORM,
  P_ALIGN,
  P_CAP,
  P_COLOR,
  P_JOIN,
  P_MITER,
  P_PIXEL,
  P_TEX,
  P_WIDTH,
  F_CAP_ROUND,
  F_CAP_SQUARE,
  F_FILL,
  F_JOIN_BEVEL,
  F_JOIN_ROUND,
  F_PIXEL_LINE,
  K_ARC,
  K_ELLIPSE,
  K_RECT,
  K_SEGMENT,
  KIND_MASK,
  SHAPE_WORDS,
  W_HALF_H,
  W_P0,
  W_P1,
  W_RESERVED,
  W_STROKE_OUT,
} from './compileFormat';
import type { GraphicsContext } from './GraphicsContext';
import type { MeshOut } from './stroke';

export const PART_SDF = 0;
export const PART_MESH = 1;
export const PART_TEX = 2;
/** Part record: type, first, count (instances or jobs), texture slot, first index, index count. */
export const PART = 6;
export const PT_TYPE = 0;
export const PT_FIRST = 1;
export const PT_COUNT = 2;
export const PT_TEX = 3;
export const PT_INDEX = 4;
export const PT_INDICES = 5;
/** Job record: op0, arg0, op1, transform arg (-1), style arg, stroke (0|1), first hole, hole count. */
export const JOB = 8;
/** Hole record: op0, arg0, op1, transform arg. */
export const HOLE = 4;

const S = SHAPE_WORDS;

/** (rendererId, meshId) pairs of destroyed contexts, drained by emit.ts per renderer. */
export const deadMeshes: number[] = [];

function grow<T extends Int32Array | Float32Array>(a: T, n: number): T {
  if (n <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(
    Math.max(n, a.length * 2),
  );
  b.set(a);
  return b;
}

export class Compiled {
  /** Context version compiled (-1: never). */
  version = -1;
  /** SDF instance templates (f32 and u32 views of one buffer). */
  sf = new Float32Array(S * 4);
  su = new Uint32Array(this.sf.buffer);
  /** Instance count. */
  ns = 0;
  parts = new Int32Array(PART * 4);
  /** Part count. */
  np = 0;
  /** uv matrix (6) per part, textured parts only. */
  uv = new Float32Array(6 * 4);
  jobs = new Int32Array(JOB * 4);
  /** Job (mesh paint) count. */
  nj = 0;
  holes = new Int32Array(HOLE * 4);
  nh = 0;

  // Mesh, filled by tess.ts.
  mesh: MeshOut | null = null;
  /** u16 copy of the indices when the vertex count allows. */
  i16: Uint16Array | null = null;
  /** Version the mesh was built from (-1: none). */
  meshVersion = -1;
  /** Tessellation scale of the mesh (device px per context unit). */
  meshScale = 0;
  /** The mesh depends on the scale (curves, round joins, pixel lines). */
  dep = false;
  /** Bumped by every tessellation. */
  meshStamp = 0;
  /**
   * Renderer and frame of the last draw that referenced the mesh: the core
   * runs every upload before any draw, so the mesh cannot change again
   * within that frame (a draw emitted earlier would read the new mesh with
   * its old index ranges).
   */
  drawRid = -1;
  drawFrame = -1;
  /** Larger scale bucket asked for within such a frame: tessellated next frame. */
  wantScale = 0;

  // Per renderer: mesh id, generation and stamp it was uploaded with.
  rids: number[] = [];
  mids: number[] = [];
  gens: number[] = [];
  stamps: number[] = [];

  dispose(): void {
    for (let k = 0; k < this.rids.length; k++) {
      deadMeshes.push(this.rids[k], this.mids[k]);
    }
    this.rids.length = 0;
    this.mids.length = 0;
    this.gens.length = 0;
    this.stamps.length = 0;
    this.mesh = null;
    this.i16 = null;
  }

  /**
   * MaskDrawable._maskRect: exactly one filled, sharp, unstroked rect whose
   * context transform keeps it axis-aligned.
   */
  rect(out: Float32Array): boolean {
    const f = this.sf;
    if (
      this.ns !== 1 ||
      this.nj !== 0 ||
      (this.su[GS_FLAGS >> 2] & (KIND_MASK | F_FILL)) !== (K_RECT | F_FILL) ||
      f[W_P0] !== 0 ||
      f[GS_STROKE_IN >> 2] !== 0 ||
      f[W_STROKE_OUT] !== 0 ||
      f[(GS_A >> 2) + 1] !== 0 ||
      f[(GS_A >> 2) + 2] !== 0
    ) {
      return false;
    }
    const w = f[GS_HALF_W >> 2] * Math.abs(f[GS_A >> 2]);
    const h = f[W_HALF_H] * Math.abs(f[(GS_A >> 2) + 3]);
    out[0] = f[(GS_A >> 2) + 4] - w;
    out[1] = f[(GS_A >> 2) + 5] - h;
    out[2] = 2 * w;
    out[3] = 2 * h;
    return true;
  }
}

// Paint table of the compile in progress (scratch): op0, arg0, op1, xf,
// style arg, stroke, group, primitive (opcode of the single SDF-able call,
// G_LINE for moveTo + lineTo, -1 for none).
const PAINT = 8;
let paints = new Int32Array(PAINT * 16);
/** First hole and hole count per paint group. */
let groupHole = new Int32Array(32);

/** The single SDF-able call of path [op0, op1), or -1. */
function primitive(ops: Uint8Array, op0: number, op1: number): number {
  const op = ops[op0];
  if (op1 - op0 === 1) {
    return op === G_RECT || op === G_RRECT || op === G_ELLIPSE || op === G_ARC
      ? op
      : -1;
  }
  return op1 - op0 === 2 && op === G_MOVE && ops[op0 + 1] === G_LINE
    ? G_LINE
    : -1;
}

/** Compiles `ctx` when its version changed; returns its compiled state. */
export function compile(ctx: GraphicsContext): Compiled {
  let c = ctx._c as Compiled | null;
  if (c === null) ctx._c = c = new Compiled();
  if (c.version === ctx._version) return c;
  c.version = ctx._version;
  const ops = ctx._o;
  const args = ctx._a;
  const n = ctx._on;

  // Pass 1: paths, paints, groups and holes.
  let np = 0;
  let ng = 0;
  let nh = 0;
  let a = 0;
  let xf = -1;
  let p0 = -1; // first op of the current path (-1: none)
  let pa = 0;
  let pxf = -1;
  let pEnd = 0;
  let pg = -1; // paint group of the current path (-1: not painted yet)
  let fresh = true;
  for (let o = 0; o < n; o++) {
    const op = ops[o];
    const at = a;
    a += op === G_POLY ? 2 + 2 * args[at] : G_ARGS[op];
    if (op === G_XFORM) {
      xf = at;
    } else if (op <= G_POLY) {
      if (fresh) {
        fresh = false;
        p0 = o;
        pa = at;
        pxf = xf;
        pg = -1;
      }
      pEnd = o + 1;
    } else if (op === G_BEGIN || op === G_CUT) {
      // A cut takes the path recorded since the last paint (none when it
      // directly follows a paint, as in Pixi).
      if (op === G_CUT && !fresh && ng > 0) {
        // Holes of the latest group are contiguous: it is the only one a
        // cut can still reach.
        c.holes = grow(c.holes, (nh + 1) * HOLE);
        const h = nh++ * HOLE;
        c.holes[h] = p0;
        c.holes[h + 1] = pa;
        c.holes[h + 2] = pEnd;
        c.holes[h + 3] = pxf;
        if (groupHole[2 * ng - 1]++ === 0) groupHole[2 * ng - 2] = nh - 1;
      }
      p0 = -1;
      fresh = true;
    } else {
      fresh = true;
      if (p0 < 0) continue;
      if (pg < 0) {
        pg = ng++;
        groupHole = grow(groupHole, 2 * ng);
        groupHole[2 * pg] = 0;
        groupHole[2 * pg + 1] = 0;
      }
      paints = grow(paints, (np + 1) * PAINT);
      const k = np++ * PAINT;
      paints[k] = p0;
      paints[k + 1] = pa;
      paints[k + 2] = pEnd;
      paints[k + 3] = pxf;
      paints[k + 4] = at;
      paints[k + 5] = op === G_STROKE ? 1 : 0;
      paints[k + 6] = pg;
      paints[k + 7] = primitive(ops, p0, pEnd);
    }
  }
  c.nh = nh;

  // Pass 2: SDF instances, mesh jobs and parts, in painter's order.
  c.ns = 0;
  c.np = 0;
  c.nj = 0;
  for (let i = 0; i < np; i++) {
    const k = i * PAINT;
    const g = paints[k + 6];
    const stroke = paints[k + 5];
    const sa = paints[k + 4];
    const textured = args[sa + P_TEX] >= 0;
    let prim =
      ctx.sdf && !textured && groupHole[2 * g + 1] === 0 ? paints[k + 7] : -1;
    if (!stroke && prim === G_LINE) continue; // a fill of one segment is empty
    if (!stroke && prim === G_ARC) prim = -1; // filled arcs are paths
    if (prim >= 0) {
      let fill = -1;
      let line = sa;
      if (!stroke) {
        // fill + stroke of the same path: one instance.
        fill = sa;
        line = -1;
        const q = k + PAINT;
        if (
          i + 1 < np &&
          paints[q + 5] === 1 &&
          paints[q + 6] === g &&
          args[paints[q + 4] + P_TEX] < 0
        ) {
          line = paints[q + 4];
          i++;
        }
      }
      shape(c, args, paints[k + 1], paints[k + 3], prim, fill, line);
      addPart(c, PART_SDF, c.ns - 1, 0);
    } else {
      c.jobs = grow(c.jobs, (c.nj + 1) * JOB);
      const j = c.nj++ * JOB;
      for (let f = 0; f < 6; f++) c.jobs[j + f] = paints[k + f];
      c.jobs[j + 6] = groupHole[2 * g];
      c.jobs[j + 7] = groupHole[2 * g + 1];
      addPart(c, textured ? PART_TEX : PART_MESH, c.nj - 1, args[sa + P_TEX]);
    }
  }
  ctx._ns = c.ns;
  if (c.nj === 0) ctx._nv = ctx._nt = 0;
  return c;
}

/** Appends item `first` to the last part when it continues it, else opens a part. */
function addPart(c: Compiled, type: number, first: number, tex: number): void {
  const last = (c.np - 1) * PART;
  if (c.np > 0 && type !== PART_TEX && c.parts[last + PT_TYPE] === type) {
    c.parts[last + PT_COUNT]++;
    return;
  }
  c.parts = grow(c.parts, (c.np + 1) * PART);
  c.uv = grow(c.uv, (c.np + 1) * 6);
  const p = c.np++ * PART;
  c.parts[p + PT_TYPE] = type;
  c.parts[p + PT_FIRST] = first;
  c.parts[p + PT_COUNT] = 1;
  c.parts[p + PT_TEX] = tex;
  c.parts[p + PT_INDEX] = 0;
  c.parts[p + PT_INDICES] = 0;
}

/**
 * Writes one SDF instance template (context space). `fill` / `line`: style
 * arg offsets of the fill and the stroke (-1: none).
 */
function shape(
  c: Compiled,
  args: Float64Array,
  at: number,
  xf: number,
  prim: number,
  fill: number,
  line: number,
): void {
  c.sf = grow(c.sf, (c.ns + 1) * S);
  if (c.su.buffer !== c.sf.buffer) c.su = new Uint32Array(c.sf.buffer);
  const f = c.sf;
  const o = c.ns++ * S;
  // Recording transform.
  let m0 = 1;
  let m1 = 0;
  let m2 = 0;
  let m3 = 1;
  let m4 = 0;
  let m5 = 0;
  if (xf >= 0) {
    m0 = args[xf];
    m1 = args[xf + 1];
    m2 = args[xf + 2];
    m3 = args[xf + 3];
    m4 = args[xf + 4];
    m5 = args[xf + 5];
  }
  const x = args[at];
  const y = args[at + 1];
  let cx = x;
  let cy = y;
  let hw = Math.abs(args[at + 2]);
  let hh = Math.abs(args[at + 3]);
  let p0 = 0;
  let p1 = 0;
  let cos = 1;
  let sin = 0;
  let kind: number = K_RECT;
  if (prim === G_RECT || prim === G_RRECT) {
    cx = x + args[at + 2] / 2;
    cy = y + args[at + 3] / 2;
    hw /= 2;
    hh /= 2;
    if (prim === G_RRECT) p0 = Math.min(Math.max(args[at + 4], 0), hw, hh);
  } else if (prim === G_ELLIPSE) {
    kind = K_ELLIPSE;
  } else if (prim === G_ARC) {
    kind = K_ARC;
    hw = hh = Math.abs(args[at + 2]);
    p0 = args[at + 3];
    p1 = args[at + 4];
  } else {
    // moveTo (x, y) + lineTo: shape space x runs along the segment.
    kind = K_SEGMENT;
    const dx = args[at + 2] - x;
    const dy = args[at + 3] - y;
    const len = Math.hypot(dx, dy);
    cx = x + dx / 2;
    cy = y + dy / 2;
    hw = len / 2;
    hh = 0;
    if (len > 0) {
      cos = dx / len;
      sin = dy / len;
    }
  }
  const A = GS_A >> 2;
  f[o + A] = m0 * cos + m2 * sin;
  f[o + A + 1] = m1 * cos + m3 * sin;
  f[o + A + 2] = m2 * cos - m0 * sin;
  f[o + A + 3] = m3 * cos - m1 * sin;
  f[o + A + 4] = m0 * cx + m2 * cy + m4;
  f[o + A + 5] = m1 * cx + m3 * cy + m5;
  f[o + W_P0] = p0;
  f[o + W_P1] = p1;
  let sIn = 0;
  let sOut = 0;
  let flags = kind;
  let strokeColor = 0;
  if (line >= 0) {
    // Widths do not scale with the recording transform (as on the mesh path).
    const det = Math.sqrt(Math.abs(m0 * m3 - m1 * m2));
    const pixel = args[line + P_PIXEL] > 0;
    const w = args[line + P_WIDTH] / (pixel || !(det > 0) ? 1 : det);
    const cap = args[line + P_CAP];
    const join = args[line + P_JOIN];
    strokeColor = args[line + P_COLOR];
    if (pixel) flags |= F_PIXEL_LINE;
    if (kind === K_SEGMENT || kind === K_ARC) {
      if (kind === K_SEGMENT) hh = w / 2;
      else sIn = sOut = w / 2;
      if (cap === 1) flags |= F_CAP_ROUND;
      if (cap === 2) flags |= F_CAP_SQUARE;
    } else {
      const align = args[line + P_ALIGN];
      sIn = w * align;
      sOut = w - sIn;
      if (kind === K_RECT) {
        if (join === 1) flags |= F_JOIN_ROUND;
        else if (join === 2 || args[line + P_MITER] < Math.SQRT2) {
          flags |= F_JOIN_BEVEL;
        }
      }
    }
  }
  f[o + (GS_HALF_W >> 2)] = hw;
  f[o + W_HALF_H] = hh;
  f[o + (GS_STROKE_IN >> 2)] = sIn;
  f[o + W_STROKE_OUT] = sOut;
  const u = c.su;
  u[o + (GS_FILL >> 2)] = fill >= 0 ? args[fill + P_COLOR] : 0;
  u[o + (GS_STROKE >> 2)] = strokeColor;
  u[o + (GS_FLAGS >> 2)] =
    fill >= 0 && kind < K_SEGMENT ? flags | F_FILL : flags;
  u[o + W_RESERVED] = 0;
}
