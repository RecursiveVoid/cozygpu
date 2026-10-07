/**
 * Stroke geometry (ARCHITECTURE §26.4), chunk `graphics-tess`: one polyline
 * (open or closed) becomes triangles in a MeshOut.
 *
 * Each segment is a quad between its two end pairs. At a join the inner
 * side shares one point (the intersection of the two offset edges) when it
 * lies within both segments, so a translucent stroke does not overlap
 * itself at gentle bends (flattened curves); otherwise the quads overlap on
 * the inner side and P itself anchors the join. The outer side is filled by
 * the join: miter (tip, or bevel beyond `miterLimit`), bevel (one
 * triangle) or round (a fan). Open ends get butt, square or round caps.
 *
 * Alignment (closed rings only): 1 puts the band inside the ring, 0
 * outside, whatever the ring's winding.
 */
import { arcSegments } from './flatten';

/**
 * Growable mesh under construction: GFX_MESH_VERTEX_BYTES vertices (x, y
 * f32, straight RGBA8) and u32 indices (narrowed to u16 at upload when the
 * vertex count allows).
 */
export interface MeshOut {
  v: ArrayBuffer;
  vf: Float32Array;
  vu: Uint32Array;
  /** Vertex count. */
  vn: number;
  i: Uint32Array;
  /** Index count. */
  in: number;
}

export function createMeshOut(): MeshOut {
  const v = new ArrayBuffer(64 * 12);
  return {
    v,
    vf: new Float32Array(v),
    vu: new Uint32Array(v),
    vn: 0,
    i: new Uint32Array(192),
    in: 0,
  };
}

/** Makes room for `vertices` more vertices and `indices` more indices. */
export function reserve(o: MeshOut, vertices: number, indices: number): void {
  if ((o.vn + vertices) * 3 > o.vf.length) {
    const v = new ArrayBuffer(
      Math.max(o.v.byteLength * 2, (o.vn + vertices) * 12),
    );
    new Uint8Array(v).set(new Uint8Array(o.v));
    o.v = v;
    o.vf = new Float32Array(v);
    o.vu = new Uint32Array(v);
  }
  if (o.in + indices > o.i.length) {
    const i = new Uint32Array(Math.max(o.i.length * 2, o.in + indices));
    i.set(o.i);
    o.i = i;
  }
}

export function addVertex(
  o: MeshOut,
  x: number,
  y: number,
  rgba: number,
): number {
  reserve(o, 1, 0);
  const k = o.vn++;
  o.vf[3 * k] = x;
  o.vf[3 * k + 1] = y;
  o.vu[3 * k + 2] = rgba;
  return k;
}

export function addTri(o: MeshOut, a: number, b: number, c: number): void {
  reserve(o, 0, 3);
  const i = o.i;
  i[o.in++] = a;
  i[o.in++] = b;
  i[o.in++] = c;
}

export const JOIN_MITER = 0;
export const JOIN_ROUND = 1;
export const JOIN_BEVEL = 2;
export const CAP_BUTT = 0;
export const CAP_ROUND = 1;
export const CAP_SQUARE = 2;

const EPS = 1e-9;

// Per-call settings (module level: no closure, no object per call).
let m: MeshOut;
let color = 0;
let S = 1;
let TOL = 0.25;
let join = 0;
let miterLimit = 10;
/** Offsets along the left normal (+n) and the right one (−n). */
let lw = 0;
let rw = 0;
/** Join outputs: end pair of the incoming segment, start pair of the outgoing one. */
let eL = 0;
let eR = 0;
let sL = 0;
let sR = 0;

/** Fan around (cx, cy) from vertex `from` to vertex `to`: radius r, from angle a0 over `sweep`. */
function fan(
  center: number,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  sweep: number,
  from: number,
  to: number,
): void {
  const n = arcSegments(r, sweep, S, TOL);
  let prev = from;
  for (let i = 1; i < n; i++) {
    const a = a0 + (sweep * i) / n;
    const v = addVertex(m, cx + r * Math.cos(a), cy + r * Math.sin(a), color);
    addTri(m, center, prev, v);
    prev = v;
  }
  addTri(m, center, prev, to);
}

/**
 * Join at P between the incoming direction (d0x, d0y) and the outgoing one
 * (d1x, d1y), segment lengths l0 / l1. Sets eL, eR, sL, sR.
 */
function joinAt(
  px: number,
  py: number,
  d0x: number,
  d0y: number,
  d1x: number,
  d1y: number,
  l0: number,
  l1: number,
): void {
  const n0x = -d0y;
  const n0y = d0x;
  const n1x = -d1y;
  const n1y = d1x;
  const cross = d0x * d1y - d0y * d1x;
  const k = 1 + n0x * n1x + n0y * n1y; // 1 + cos θ
  if (Math.abs(cross) < EPS && k > 1) {
    // Straight on: one pair serves both segments.
    eL = sL = addVertex(m, px + n0x * lw, py + n0y * lw, color);
    eR = sR = addVertex(m, px - n0x * rw, py - n0y * rw, color);
    return;
  }
  // Turning toward +n: the left side is inside the turn.
  const left = cross > 0;
  const wi = left ? lw : rw;
  const wo = left ? rw : lw;
  const si = left ? 1 : -1; // inner side along n
  // Miter direction (n0 + n1) / (1 + cos θ): |m| = 1 / cos(θ/2).
  const mx = k > EPS ? (n0x + n1x) / k : 0;
  const my = k > EPS ? (n0y + n1y) / k : 0;
  const ix = px + si * mx * wi;
  const iy = py + si * my * wi;
  // The inner intersection is usable when it lies within both segments.
  const back = (px - ix) * d0x + (py - iy) * d0y;
  const ahead = (ix - px) * d1x + (iy - py) * d1y;
  let iE: number;
  let iS: number;
  let center: number;
  if (k > EPS && back <= l0 && ahead <= l1) {
    iE = iS = center = addVertex(m, ix, iy, color);
  } else {
    iE = addVertex(m, px + si * n0x * wi, py + si * n0y * wi, color);
    iS = addVertex(m, px + si * n1x * wi, py + si * n1y * wi, color);
    center = addVertex(m, px, py, color);
  }
  const so = -si;
  const ax = px + so * n0x * wo;
  const ay = py + so * n0y * wo;
  const bx = px + so * n1x * wo;
  const by = py + so * n1y * wo;
  const A = addVertex(m, ax, ay, color);
  const B = addVertex(m, bx, by, color);
  if (wo > 0) {
    if (join === JOIN_ROUND) {
      const a0 = Math.atan2(ay - py, ax - px);
      let sweep = Math.atan2(by - py, bx - px) - a0;
      if (sweep > Math.PI) sweep -= 2 * Math.PI;
      if (sweep < -Math.PI) sweep += 2 * Math.PI;
      fan(center, px, py, wo, a0, sweep, A, B);
    } else if (
      join !== JOIN_BEVEL &&
      k > EPS &&
      k * miterLimit * miterLimit >= 2
    ) {
      const T = addVertex(m, px + so * mx * wo, py + so * my * wo, color);
      addTri(m, center, A, T);
      addTri(m, center, T, B);
    } else {
      addTri(m, center, A, B);
    }
  }
  if (left) {
    eL = iE;
    sL = iS;
    eR = A;
    sR = B;
  } else {
    eR = iE;
    sR = iS;
    eL = A;
    sL = B;
  }
}

/** Cap at P (direction d points away from the line); sets the pair in eL/eR. */
function capAt(
  px: number,
  py: number,
  dx: number,
  dy: number,
  cap: number,
  w: number,
): void {
  const nx = -dy;
  const ny = dx;
  if (cap === CAP_SQUARE) {
    px += dx * w;
    py += dy * w;
  }
  eL = addVertex(m, px + nx * w, py + ny * w, color);
  eR = addVertex(m, px - nx * w, py - ny * w, color);
  if (cap === CAP_ROUND) {
    const c = addVertex(m, px, py, color);
    // From +n through d to −n.
    fan(c, px, py, w, Math.atan2(ny, nx), -Math.PI, eL, eR);
  }
}

/**
 * Strokes points [first, first + count) of `p` (x, y pairs). `w` total
 * width (context units), `align` per the file header (closed only).
 */
export function strokePolyline(
  p: Float64Array,
  first: number,
  count: number,
  closed: boolean,
  w: number,
  align: number,
  joinStyle: number,
  cap: number,
  limit: number,
  rgba: number,
  scale: number,
  tol: number,
  out: MeshOut,
): void {
  if (count < 2 || !(w > 0)) return;
  if (count < 3) closed = false;
  m = out;
  color = rgba;
  S = scale;
  TOL = tol;
  join = joinStyle;
  miterLimit = limit;
  lw = rw = w / 2;
  if (closed) {
    let area = 0;
    for (let i = 0, j = count - 1; i < count; j = i++) {
      const a = 2 * (first + j);
      const b = 2 * (first + i);
      area += p[a] * p[b + 1] - p[b] * p[a + 1];
    }
    // area > 0: the left normal points into the ring.
    const inner = w * align;
    lw = area > 0 ? inner : w - inner;
    rw = w - lw;
  }
  const segs = closed ? count : count - 1;
  const last = first + count - 1;
  // Start pair of segment 0 (and, closed, the end pair of the last one).
  let firstL: number;
  let firstR: number;
  let pL: number;
  let pR: number;
  let px = p[2 * first];
  let py = p[2 * first + 1];
  let dx = p[2 * first + 2] - px;
  let dy = p[2 * first + 3] - py;
  let len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;
  if (closed) {
    const qx = p[2 * last];
    const qy = p[2 * last + 1];
    const ex = px - qx;
    const ey = py - qy;
    const el = Math.hypot(ex, ey);
    joinAt(px, py, ex / el, ey / el, dx, dy, el, len);
    firstL = eL;
    firstR = eR;
    pL = sL;
    pR = sR;
  } else {
    capAt(px, py, -dx, -dy, cap, lw);
    // capAt walks +n → −n of the reversed direction: swap to this side.
    pL = eR;
    pR = eL;
    firstL = firstR = 0;
  }
  for (let s = 1; s <= segs; s++) {
    const i = first + (s % count);
    const qx = p[2 * i];
    const qy = p[2 * i + 1];
    if (s === segs) {
      if (closed) {
        eL = firstL;
        eR = firstR;
      } else {
        capAt(qx, qy, dx, dy, cap, lw);
      }
    } else {
      const j = first + ((s + 1) % count);
      let ex = p[2 * j] - qx;
      let ey = p[2 * j + 1] - qy;
      const el = Math.hypot(ex, ey);
      ex /= el;
      ey /= el;
      joinAt(qx, qy, dx, dy, ex, ey, len, el);
      dx = ex;
      dy = ey;
      len = el;
    }
    addTri(m, pL, pR, eR);
    addTri(m, pL, eR, eL);
    pL = sL;
    pR = sR;
  }
}
