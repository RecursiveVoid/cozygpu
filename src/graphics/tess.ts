/**
 * Graphics tessellator (ARCHITECTURE §26.4), chunk `graphics-tess`. Pure,
 * DOM-free, zero dependencies; every output goes into caller-owned buffers
 * that grow and are reused, so re-tessellating a context allocates only
 * when it needs more room than before.
 *
 *   - curve flattening (quadratic, cubic, arc, arcTo) adaptive to the
 *     tolerance in device px at the context's tessellation scale
 *     (flatten.ts);
 *   - polygon triangulation with holes (ear clipping with hole bridging and
 *     a z-order hash for large rings, earcut.ts);
 *   - stroke geometry: miter (with miterLimit → bevel), round and bevel
 *     joins; butt, round and square caps; alignment; closed rings
 *     (stroke.ts).
 *
 * `tessellate` builds a compiled context's mesh: every mesh job (paint) of
 * every mesh part, in painter's order, into one vertex + index buffer in
 * context space, recording each part's index range.
 */
import type { Compiled } from './compile';
import {
  HOLE,
  JOB,
  PART,
  PART_SDF,
  PART_TEX,
  PT_COUNT,
  PT_FIRST,
  PT_INDEX,
  PT_INDICES,
  PT_TEX,
  PT_TYPE,
} from './compile';
import { triangulate } from './earcut';
import type { PathBuf } from './flatten';
import { createPathBuf, flattenPath } from './flatten';
import type { GraphicsContext } from './GraphicsContext';
import {
  P_ALIGN,
  P_CAP,
  P_COLOR,
  P_GLOBAL,
  P_HAS_MAT,
  P_JOIN,
  P_MAT,
  P_MITER,
  P_PIXEL,
  P_WIDTH,
} from './compileFormat';
import type { MeshOut } from './stroke';
import { addVertex, createMeshOut, reserve, strokePolyline } from './stroke';

export { triangulate } from './earcut';

const path = createPathBuf();
const holes = createPathBuf();
/** Outer ring + holes of one fill, and the holes' first vertices. */
let ring = new Float64Array(256);
let holeStarts = new Uint32Array(16);

function reset(b: PathBuf): void {
  b.n = b.sn = 0;
  b.curved = false;
}

function subEnd(b: PathBuf, k: number): number {
  return k + 1 < b.sn ? b.sub[k + 1] : b.n;
}

/** Fills every sub-path of `path` (implicitly closed), cut by `holes`. */
function fill(m: MeshOut, color: number): void {
  const p = path.p;
  for (let k = 0; k < path.sn; k++) {
    const s = path.sub[k];
    const e = subEnd(path, k);
    if (e - s < 3) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = s; i < e; i++) {
      x0 = Math.min(x0, p[2 * i]);
      x1 = Math.max(x1, p[2 * i]);
      y0 = Math.min(y0, p[2 * i + 1]);
      y1 = Math.max(y1, p[2 * i + 1]);
    }
    let n = 0;
    let hc = 0;
    n = append(p, s, e, n);
    for (let h = 0; h < holes.sn; h++) {
      const hs = holes.sub[h];
      const he = subEnd(holes, h);
      if (he - hs < 3 || !overlaps(hs, he, x0, y0, x1, y1)) continue;
      if (hc === holeStarts.length) {
        const t = new Uint32Array(hc * 2);
        t.set(holeStarts);
        holeStarts = t;
      }
      holeStarts[hc++] = n;
      n = append(holes.p, hs, he, n);
    }
    const base = m.vn;
    reserve(m, n, 3 * (n + 2 * hc));
    for (let i = 0; i < n; i++)
      addVertex(m, ring[2 * i], ring[2 * i + 1], color);
    m.in += triangulate(ring, 2 * n, holeStarts, hc, m.i, m.in, base);
  }
}

/** Copies points [s, e) of `src` into `ring` after `n` points; returns the new count. */
function append(src: Float64Array, s: number, e: number, n: number): number {
  const need = 2 * (n + e - s);
  if (need > ring.length) {
    const r = new Float64Array(Math.max(need, ring.length * 2));
    r.set(ring);
    ring = r;
  }
  for (let i = s; i < e; i++) {
    ring[2 * n] = src[2 * i];
    ring[2 * n + 1] = src[2 * i + 1];
    n++;
  }
  return n;
}

function overlaps(
  s: number,
  e: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const p = holes.p;
  let hx0 = Infinity;
  let hy0 = Infinity;
  let hx1 = -Infinity;
  let hy1 = -Infinity;
  for (let i = s; i < e; i++) {
    hx0 = Math.min(hx0, p[2 * i]);
    hx1 = Math.max(hx1, p[2 * i]);
    hy0 = Math.min(hy0, p[2 * i + 1]);
    hy1 = Math.max(hy1, p[2 * i + 1]);
  }
  return hx0 < x1 && hx1 > x0 && hy0 < y1 && hy1 > y0;
}

function strokeAll(
  b: PathBuf,
  m: MeshOut,
  args: Float64Array,
  sa: number,
  w: number,
  color: number,
  scale: number,
  tol: number,
  closeAll: boolean,
): void {
  for (let k = 0; k < b.sn; k++) {
    const s = b.sub[k];
    strokePolyline(
      b.p,
      s,
      subEnd(b, k) - s,
      closeAll || b.closed[k] === 1,
      w,
      args[sa + P_ALIGN],
      args[sa + P_JOIN],
      args[sa + P_CAP],
      args[sa + P_MITER],
      color,
      scale,
      tol,
      m,
    );
  }
}

/**
 * uv matrix of a textured part (context position → uv in the source):
 * inverse(style matrix), then the path's bounds ('local') or one texture
 * pixel per unit ('global'), then the texture frame inside its source.
 */
function uvMatrix(
  c: Compiled,
  part: number,
  ctx: GraphicsContext,
  sa: number,
): void {
  const args = ctx._a;
  const t = ctx._tex[c.parts[part * PART + PT_TEX]];
  const out = c.uv;
  const o = part * 6;
  // Inverse of the style matrix (identity without one).
  let a = 1;
  let b = 0;
  let cc = 0;
  let d = 1;
  let tx = 0;
  let ty = 0;
  if (args[sa + P_HAS_MAT]) {
    const m = sa + P_MAT;
    const det = args[m] * args[m + 3] - args[m + 1] * args[m + 2] || 1;
    a = args[m + 3] / det;
    b = -args[m + 1] / det;
    cc = -args[m + 2] / det;
    d = args[m] / det;
    tx = -(a * args[m + 4] + cc * args[m + 5]);
    ty = -(b * args[m + 4] + d * args[m + 5]);
  }
  const fr = t.frame;
  let kx = 1 / t.sourceWidth;
  let ky = 1 / t.sourceHeight;
  let ox = fr.x * kx;
  let oy = fr.y * ky;
  if (!args[sa + P_GLOBAL]) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const p = path.p;
    for (let i = 0; i < path.n; i++) {
      x0 = Math.min(x0, p[2 * i]);
      x1 = Math.max(x1, p[2 * i]);
      y0 = Math.min(y0, p[2 * i + 1]);
      y1 = Math.max(y1, p[2 * i + 1]);
    }
    const w = x1 - x0 || 1;
    const h = y1 - y0 || 1;
    kx *= fr.width / w;
    ky *= fr.height / h;
    ox -= kx * x0;
    oy -= ky * y0;
  }
  out[o] = kx * a;
  out[o + 1] = ky * b;
  out[o + 2] = kx * cc;
  out[o + 3] = ky * d;
  out[o + 4] = kx * tx + ox;
  out[o + 5] = ky * ty + oy;
}

/**
 * Builds the mesh of every mesh part of `c` at `scale` (device px per
 * context unit; a power of two, §26.4) and records it on `c`.
 */
export function tessellate(
  ctx: GraphicsContext,
  c: Compiled,
  scale: number,
): void {
  const m = (c.mesh ??= createMeshOut());
  m.vn = m.in = 0;
  const ops = ctx._o;
  const args = ctx._a;
  const tol = ctx.tolerance;
  const jobs = c.jobs;
  let dep = false;
  for (let part = 0; part < c.np; part++) {
    const P = part * PART;
    const type = c.parts[P + PT_TYPE];
    if (type === PART_SDF) continue;
    const first = m.in;
    const j1 = c.parts[P + PT_FIRST] + c.parts[P + PT_COUNT];
    for (let j = c.parts[P + PT_FIRST]; j < j1; j++) {
      const J = j * JOB;
      const sa = jobs[J + 4];
      reset(path);
      reset(holes);
      flattenPath(
        ops,
        args,
        jobs[J],
        jobs[J + 1],
        jobs[J + 2],
        jobs[J + 3],
        scale,
        tol,
        path,
      );
      for (let h = jobs[J + 6]; h < jobs[J + 6] + jobs[J + 7]; h++) {
        const H = h * HOLE;
        flattenPath(
          ops,
          args,
          c.holes[H],
          c.holes[H + 1],
          c.holes[H + 2],
          c.holes[H + 3],
          scale,
          tol,
          holes,
        );
      }
      const color = args[sa + P_COLOR];
      dep ||= path.curved || holes.curved;
      if (jobs[J + 5]) {
        const pixel = args[sa + P_PIXEL] > 0;
        // Round joins and caps, and device-px widths, depend on the scale.
        dep ||= pixel || args[sa + P_JOIN] === 1 || args[sa + P_CAP] === 1;
        const w = args[sa + P_WIDTH] / (pixel ? scale : 1);
        strokeAll(path, m, args, sa, w, color, scale, tol, false);
        strokeAll(holes, m, args, sa, w, color, scale, tol, true);
      } else {
        fill(m, color);
      }
      if (type === PART_TEX) uvMatrix(c, part, ctx, sa);
    }
    c.parts[P + PT_INDEX] = first;
    c.parts[P + PT_INDICES] = m.in - first;
  }
  c.dep = dep;
  c.meshScale = scale;
  c.meshVersion = c.version;
  c.meshStamp++;
  if (m.vn <= 0xffff) {
    if (c.i16 === null || c.i16.length < m.in) {
      c.i16 = new Uint16Array(Math.max(m.in, 2 * (c.i16?.length ?? 0)));
    }
    const i16 = c.i16;
    for (let i = 0; i < m.in; i++) i16[i] = m.i[i];
  }
  ctx._nv = m.vn;
  ctx._nt = m.in / 3;
}
