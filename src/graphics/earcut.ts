/**
 * Polygon triangulation with holes (ARCHITECTURE §26.4), chunk
 * `graphics-tess`: ear clipping over a doubly linked ring, holes bridged into
 * the outer ring from their leftmost vertex, a z-order curve index for rings
 * above 80 vertices, and the usual fallbacks for bad input (filter
 * duplicates and collinear points, cure local self-intersections, split the
 * ring along a valid diagonal). Written from the published description of
 * the earcut algorithm.
 *
 * The ring nodes live in module-level typed arrays (struct of arrays) that
 * only grow, so triangulating again allocates nothing once warm.
 */

// Node pool: position, source vertex, ring links, z-order links.
let X = new Float64Array(64);
let Y = new Float64Array(64);
let I = new Int32Array(64);
let Z = new Int32Array(64);
let PREV = new Int32Array(64);
let NEXT = new Int32Array(64);
let PZ = new Int32Array(64);
let NZ = new Int32Array(64);
let STEINER = new Uint8Array(64);
let used = 0;
/** Hole queue (leftmost node per hole). */
let queue = new Int32Array(16);

let out: Uint32Array;
let outAt = 0;
let base = 0;
let minX = 0;
let minY = 0;
let invSize = 0;

function grow<T extends Float64Array | Int32Array | Uint8Array>(
  a: T,
  n: number,
): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  b.set(a);
  return b;
}

function node(i: number, x: number, y: number): number {
  if (used === X.length) {
    const n = used * 2;
    X = grow(X, n);
    Y = grow(Y, n);
    I = grow(I, n);
    Z = grow(Z, n);
    PREV = grow(PREV, n);
    NEXT = grow(NEXT, n);
    PZ = grow(PZ, n);
    NZ = grow(NZ, n);
    STEINER = grow(STEINER, n);
  }
  const p = used++;
  X[p] = x;
  Y[p] = y;
  I[p] = i;
  Z[p] = -1;
  PZ[p] = NZ[p] = -1;
  STEINER[p] = 0;
  PREV[p] = NEXT[p] = p;
  return p;
}

/** Inserts a node after `last` (or starts a ring when last < 0). */
function insert(i: number, x: number, y: number, last: number): number {
  const p = node(i, x, y);
  if (last >= 0) {
    NEXT[p] = NEXT[last];
    PREV[p] = last;
    PREV[NEXT[last]] = p;
    NEXT[last] = p;
  }
  return p;
}

function remove(p: number): void {
  NEXT[PREV[p]] = NEXT[p];
  PREV[NEXT[p]] = PREV[p];
  if (PZ[p] >= 0) NZ[PZ[p]] = NZ[p];
  if (NZ[p] >= 0) PZ[NZ[p]] = PZ[p];
}

/** Twice the signed area of triangle p, q, r (negative: convex for the outer ring). */
function area(p: number, q: number, r: number): number {
  return (Y[q] - Y[p]) * (X[r] - X[q]) - (X[q] - X[p]) * (Y[r] - Y[q]);
}

function equals(a: number, b: number): boolean {
  return X[a] === X[b] && Y[a] === Y[b];
}

function inTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

/** Builds a ring from coords [start, end) in the requested winding. */
function ring(
  d: ArrayLike<number>,
  start: number,
  end: number,
  clockwise: boolean,
): number {
  let sum = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) {
    sum += (d[j] - d[i]) * (d[i + 1] + d[j + 1]);
  }
  let last = -1;
  if (clockwise === sum > 0) {
    for (let i = start; i < end; i += 2)
      last = insert(i >> 1, d[i], d[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) {
      last = insert(i >> 1, d[i], d[i + 1], last);
    }
  }
  if (last >= 0 && equals(last, NEXT[last])) {
    remove(last);
    last = NEXT[last];
  }
  return last;
}

/** Drops duplicate and collinear points between start and end. */
function filter(start: number, end: number): number {
  if (start < 0) return start;
  if (end < 0) end = start;
  let p = start;
  let again: boolean;
  do {
    again = false;
    if (
      !STEINER[p] &&
      (equals(p, NEXT[p]) || area(PREV[p], p, NEXT[p]) === 0)
    ) {
      remove(p);
      p = end = PREV[p];
      if (p === NEXT[p]) break;
      again = true;
    } else {
      p = NEXT[p];
    }
  } while (again || p !== end);
  return end;
}

function emit(a: number, b: number, c: number): void {
  out[outAt++] = I[a] + base;
  out[outAt++] = I[b] + base;
  out[outAt++] = I[c] + base;
}

function isEar(ear: number): boolean {
  const a = PREV[ear];
  const c = NEXT[ear];
  if (area(a, ear, c) >= 0) return false; // reflex
  const ax = X[a];
  const ay = Y[a];
  const bx = X[ear];
  const by = Y[ear];
  const cx = X[c];
  const cy = Y[c];
  const x0 = Math.min(ax, bx, cx);
  const y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx);
  const y1 = Math.max(ay, by, cy);
  for (let p = NEXT[c]; p !== a; p = NEXT[p]) {
    if (blocks(p, a, ax, ay, bx, by, cx, cy, x0, y0, x1, y1)) return false;
  }
  return true;
}

/** True when p lies in the candidate ear and is not a convex vertex. */
function blocks(
  p: number,
  a: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const px = X[p];
  const py = Y[p];
  return (
    px >= x0 &&
    px <= x1 &&
    py >= y0 &&
    py <= y1 &&
    (px !== ax || py !== ay) &&
    inTriangle(ax, ay, bx, by, cx, cy, px, py) &&
    area(PREV[p], p, NEXT[p]) >= 0
  );
}

function zOrder(x: number, y: number): number {
  x = ((x - minX) * invSize) | 0;
  y = ((y - minY) * invSize) | 0;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00ff00ff;
  y = (y | (y << 4)) & 0x0f0f0f0f;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;
  return x | (y << 1);
}

function isEarHashed(ear: number): boolean {
  const a = PREV[ear];
  const c = NEXT[ear];
  if (area(a, ear, c) >= 0) return false;
  const ax = X[a];
  const ay = Y[a];
  const bx = X[ear];
  const by = Y[ear];
  const cx = X[c];
  const cy = Y[c];
  const x0 = Math.min(ax, bx, cx);
  const y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx);
  const y1 = Math.max(ay, by, cy);
  const zMin = zOrder(x0, y0);
  const zMax = zOrder(x1, y1);
  // Walk the z-order list both ways from the ear while inside [zMin, zMax].
  let p = PZ[ear];
  let n = NZ[ear];
  while (p >= 0 && Z[p] >= zMin && n >= 0 && Z[n] <= zMax) {
    if (
      p !== a &&
      p !== c &&
      blocks(p, a, ax, ay, bx, by, cx, cy, x0, y0, x1, y1)
    )
      return false;
    p = PZ[p];
    if (
      n !== a &&
      n !== c &&
      blocks(n, a, ax, ay, bx, by, cx, cy, x0, y0, x1, y1)
    )
      return false;
    n = NZ[n];
  }
  while (p >= 0 && Z[p] >= zMin) {
    if (
      p !== a &&
      p !== c &&
      blocks(p, a, ax, ay, bx, by, cx, cy, x0, y0, x1, y1)
    )
      return false;
    p = PZ[p];
  }
  while (n >= 0 && Z[n] <= zMax) {
    if (
      n !== a &&
      n !== c &&
      blocks(n, a, ax, ay, bx, by, cx, cy, x0, y0, x1, y1)
    )
      return false;
    n = NZ[n];
  }
  return true;
}

/** Links the ring in z order (merge sort on the z links). */
function indexCurve(start: number): void {
  let p = start;
  do {
    if (Z[p] < 0) Z[p] = zOrder(X[p], Y[p]);
    PZ[p] = PREV[p];
    NZ[p] = NEXT[p];
    p = NEXT[p];
  } while (p !== start);
  NZ[PZ[p]] = -1;
  PZ[p] = -1;

  let list = p;
  let size = 1;
  let merges: number;
  do {
    p = list;
    list = -1;
    let tail = -1;
    merges = 0;
    while (p >= 0) {
      merges++;
      let q = p;
      let pSize = 0;
      for (let i = 0; i < size; i++) {
        pSize++;
        q = NZ[q];
        if (q < 0) break;
      }
      let qSize = size;
      while (pSize > 0 || (qSize > 0 && q >= 0)) {
        let e: number;
        if (pSize !== 0 && (qSize === 0 || q < 0 || Z[p] <= Z[q])) {
          e = p;
          p = NZ[p];
          pSize--;
        } else {
          e = q;
          q = NZ[q];
          qSize--;
        }
        if (tail >= 0) NZ[tail] = e;
        else list = e;
        PZ[e] = tail;
        tail = e;
      }
      p = q;
    }
    NZ[tail] = -1;
    size *= 2;
  } while (merges > 1);
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** q lies on segment p–r (given collinear). */
function onSegment(p: number, q: number, r: number): boolean {
  return (
    X[q] <= Math.max(X[p], X[r]) &&
    X[q] >= Math.min(X[p], X[r]) &&
    Y[q] <= Math.max(Y[p], Y[r]) &&
    Y[q] >= Math.min(Y[p], Y[r])
  );
}

function intersects(p1: number, q1: number, p2: number, q2: number): boolean {
  const o1 = sign(area(p1, q1, p2));
  const o2 = sign(area(p1, q1, q2));
  const o3 = sign(area(p2, q2, p1));
  const o4 = sign(area(p2, q2, q1));
  return (
    (o1 !== o2 && o3 !== o4) ||
    (o1 === 0 && onSegment(p1, p2, q1)) ||
    (o2 === 0 && onSegment(p1, q2, q1)) ||
    (o3 === 0 && onSegment(p2, p1, q2)) ||
    (o4 === 0 && onSegment(p2, q1, q2))
  );
}

function locallyInside(a: number, b: number): boolean {
  return area(PREV[a], a, NEXT[a]) < 0
    ? area(a, b, NEXT[a]) >= 0 && area(a, PREV[a], b) >= 0
    : area(a, b, PREV[a]) < 0 || area(a, NEXT[a], b) < 0;
}

/** The midpoint of a–b is inside the ring (ray casting). */
function middleInside(a: number, b: number): boolean {
  const px = (X[a] + X[b]) / 2;
  const py = (Y[a] + Y[b]) / 2;
  let inside = false;
  let p = a;
  do {
    const n = NEXT[p];
    if (
      Y[p] > py !== Y[n] > py &&
      Y[n] !== Y[p] &&
      px < ((X[n] - X[p]) * (py - Y[p])) / (Y[n] - Y[p]) + X[p]
    ) {
      inside = !inside;
    }
    p = n;
  } while (p !== a);
  return inside;
}

function intersectsRing(a: number, b: number): boolean {
  let p = a;
  do {
    const n = NEXT[p];
    if (
      I[p] !== I[a] &&
      I[n] !== I[a] &&
      I[p] !== I[b] &&
      I[n] !== I[b] &&
      intersects(p, n, a, b)
    ) {
      return true;
    }
    p = n;
  } while (p !== a);
  return false;
}

function validDiagonal(a: number, b: number): boolean {
  return (
    I[NEXT[a]] !== I[b] &&
    I[PREV[a]] !== I[b] &&
    !intersectsRing(a, b) &&
    ((locallyInside(a, b) &&
      locallyInside(b, a) &&
      middleInside(a, b) &&
      (area(PREV[a], a, PREV[b]) !== 0 || area(a, PREV[b], b) !== 0)) ||
      (equals(a, b) &&
        area(PREV[a], a, NEXT[a]) > 0 &&
        area(PREV[b], b, NEXT[b]) > 0))
  );
}

/** Splits the ring along a–b into two rings; returns the copy of b. */
function split(a: number, b: number): number {
  const a2 = node(I[a], X[a], Y[a]);
  const b2 = node(I[b], X[b], Y[b]);
  const an = NEXT[a];
  const bp = PREV[b];
  NEXT[a] = b;
  PREV[b] = a;
  NEXT[a2] = an;
  PREV[an] = a2;
  NEXT[b2] = a2;
  PREV[a2] = b2;
  NEXT[bp] = b2;
  PREV[b2] = bp;
  return b2;
}

/** Clips the triangle of two crossing edges (a–p, p.next–b). */
function cure(start: number): number {
  let p = start;
  do {
    const a = PREV[p];
    const n = NEXT[p];
    const b = NEXT[n];
    if (
      !equals(a, b) &&
      intersects(a, p, n, b) &&
      locallyInside(a, b) &&
      locallyInside(b, a)
    ) {
      emit(a, p, b);
      remove(p);
      remove(n);
      p = start = b;
    }
    p = NEXT[p];
  } while (p !== start);
  return filter(p, -1);
}

function splitEarcut(start: number): void {
  let a = start;
  do {
    for (let b = NEXT[NEXT[a]]; b !== PREV[a]; b = NEXT[b]) {
      if (I[a] !== I[b] && validDiagonal(a, b)) {
        let c = split(a, b);
        a = filter(a, NEXT[a]);
        c = filter(c, NEXT[c]);
        clip(a, 0);
        clip(c, 0);
        return;
      }
    }
    a = NEXT[a];
  } while (a !== start);
}

/** The ear-clipping loop; pass 1 filters, pass 2 cures, pass 3 splits. */
function clip(ear: number, pass: number): void {
  if (ear < 0) return;
  if (!pass && invSize) indexCurve(ear);
  let stop = ear;
  while (PREV[ear] !== NEXT[ear]) {
    const prev = PREV[ear];
    const next = NEXT[ear];
    if (invSize ? isEarHashed(ear) : isEar(ear)) {
      emit(prev, ear, next);
      remove(ear);
      ear = stop = NEXT[next];
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) clip(filter(ear, -1), 1);
      else if (pass === 1) clip(cure(filter(ear, -1)), 2);
      else splitEarcut(ear);
      break;
    }
  }
}

/** Outer-ring vertex the hole at `hole` connects to, or -1. */
function bridge(hole: number, outer: number): number {
  const hx = X[hole];
  const hy = Y[hole];
  let qx = -Infinity;
  let m = -1;
  // The nearest edge crossed by a ray from the hole point to the left.
  let p = outer;
  do {
    const n = NEXT[p];
    if (hy <= Y[p] && hy >= Y[n] && Y[n] !== Y[p]) {
      const x = X[p] + ((hy - Y[p]) * (X[n] - X[p])) / (Y[n] - Y[p]);
      if (x <= hx && x > qx) {
        qx = x;
        m = X[p] < X[n] ? p : n;
        if (x === hx) return m;
      }
    }
    p = n;
  } while (p !== outer);
  if (m < 0) return -1;
  // A reflex vertex inside the triangle (hole, crossing, m) would make the
  // bridge cross the ring: take the one with the smallest angle instead.
  const stop = m;
  const mx = X[m];
  const my = Y[m];
  let tanMin = Infinity;
  p = m;
  do {
    if (
      hx >= X[p] &&
      X[p] >= mx &&
      hx !== X[p] &&
      inTriangle(
        hy < my ? hx : qx,
        hy,
        mx,
        my,
        hy < my ? qx : hx,
        hy,
        X[p],
        Y[p],
      )
    ) {
      const tan = Math.abs(hy - Y[p]) / (hx - X[p]);
      if (
        locallyInside(p, hole) &&
        (tan < tanMin ||
          (tan === tanMin &&
            (X[p] > X[m] ||
              (X[p] === X[m] &&
                area(PREV[m], m, PREV[p]) < 0 &&
                area(NEXT[p], m, NEXT[m]) < 0))))
      ) {
        m = p;
        tanMin = tan;
      }
    }
    p = NEXT[p];
  } while (p !== stop);
  return m;
}

function leftmost(start: number): number {
  let p = start;
  let l = start;
  do {
    if (X[p] < X[l] || (X[p] === X[l] && Y[p] < Y[l])) l = p;
    p = NEXT[p];
  } while (p !== start);
  return l;
}

/**
 * Triangulates the ring `coords[0 .. coordCount)` (x, y pairs: coordCount
 * is the number of NUMBERS, twice the vertex count; the outer ring first,
 * then each hole starting at the vertex index listed in
 * `holeStarts[0 .. holeCount)`). Writes vertex indices + `baseVertex` to
 * `out` from `outOffset` and returns the number of indices written. `out`
 * must hold at least 3 × (vertices + 2 × holeCount) entries. Degenerate and
 * self-intersecting input never throws; it may miss triangles.
 */
export function triangulate(
  coords: Float64Array | Float32Array,
  coordCount: number,
  holeStarts: Uint32Array | null,
  holeCount: number,
  outArray: Uint32Array,
  outOffset: number,
  baseVertex: number,
): number {
  used = 0;
  out = outArray;
  outAt = outOffset;
  base = baseVertex;
  invSize = 0;
  if (!holeStarts) holeCount = 0;
  const outerEnd = holeCount > 0 ? holeStarts![0] * 2 : coordCount;
  let outer = ring(coords, 0, outerEnd, true);
  if (outer < 0 || NEXT[outer] === PREV[outer]) return 0;

  if (holeCount > 0) {
    if (queue.length < holeCount) queue = new Int32Array(holeCount * 2);
    let q = 0;
    for (let h = 0; h < holeCount; h++) {
      const start = holeStarts![h] * 2;
      const end = h + 1 < holeCount ? holeStarts![h + 1] * 2 : coordCount;
      const list = ring(coords, start, end, false);
      if (list < 0) continue;
      if (list === NEXT[list]) STEINER[list] = 1;
      // Insertion sort by x: holes are bridged from left to right.
      const l = leftmost(list);
      let k = q++;
      while (k > 0 && X[queue[k - 1]] > X[l]) {
        queue[k] = queue[k - 1];
        k--;
      }
      queue[k] = l;
    }
    for (let h = 0; h < q; h++) {
      const hole = queue[h];
      const b = bridge(hole, outer);
      if (b < 0) continue;
      const rev = split(b, hole);
      filter(rev, NEXT[rev]);
      outer = filter(b, NEXT[b]);
    }
  }

  if (coordCount > 160) {
    minX = minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < outerEnd; i += 2) {
      const x = coords[i];
      const y = coords[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const size = Math.max(maxX - minX, maxY - minY);
    invSize = size !== 0 ? 32767 / size : 0;
  }
  clip(outer, 0);
  return outAt - outOffset;
}
