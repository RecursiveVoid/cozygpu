/**
 * Path flattening (ARCHITECTURE §26.4), chunk `graphics-tess`. Turns a
 * recorded path (an op range of a GraphicsContext) into polylines in context
 * space, with the segment counts of §26.4 at device scale `s` and tolerance
 * `tol` (device px):
 *
 *   quadratic  n = ceil(sqrt(|p0 − 2p1 + p2| · s / (4·tol)))
 *   cubic      n = ceil(sqrt(0.75 · max(|p0 − 2p1 + p2|, |p1 − 2p2 + p3|) · s / tol))
 *   arc        n = ceil(|θ| / (2·acos(1 − tol / (r·s))))
 *
 * at least 1, at most 512. (The chord error of a quadratic split into n
 * equal steps is |p0 − 2p1 + p2| / (4n²), hence 4·tol where §26.4 says
 * 8·tol.) A full turn ends exactly on its first point. Curves are flattened after the recording
 * transform (an affine image of a Bézier is the Bézier of the images), arcs
 * before it with the transform's largest scale folded into `s`.
 */
import {
  G_ARC,
  G_ARC_TO,
  G_CLOSE,
  G_CUBIC,
  G_ELLIPSE,
  G_LINE,
  G_MOVE,
  G_POLY,
  G_QUAD,
  G_RECT,
  G_RRECT,
  G_XFORM,
  G_ARGS,
} from './compileFormat';

const MAX_SEGMENTS = 512;
const TAU = Math.PI * 2;

/** Growable polyline buffer: points, sub-path starts and closed flags. */
export interface PathBuf {
  /** x, y per point. */
  p: Float64Array;
  /** Point count. */
  n: number;
  /** First point of each sub-path; sub-path k ends at sub[k + 1] (or n). */
  sub: Int32Array;
  closed: Uint8Array;
  /** Sub-path count. */
  sn: number;
  /** A curve was flattened: the result depends on the scale. */
  curved: boolean;
}

export function createPathBuf(): PathBuf {
  return {
    p: new Float64Array(256),
    n: 0,
    sub: new Int32Array(16),
    closed: new Uint8Array(16),
    sn: 0,
    curved: false,
  };
}

/** Segments for an arc of radius r (device px after × s) and sweep θ. */
export function arcSegments(
  r: number,
  sweep: number,
  s: number,
  tol: number,
): number {
  const rs = Math.abs(r) * s;
  const a = rs > tol ? 2 * Math.acos(1 - tol / rs) : Math.PI;
  return Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.abs(sweep) / a)));
}

function segments(v: number): number {
  return Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.sqrt(v))));
}

// Flattening state (module level: one path at a time).
let B: PathBuf;
/** Transform a, b, c, d, tx, ty. */
const M = new Float64Array(6);
/** A sub-path is open (points are being added to it). */
let open = false;
/** After closePath: the next segment starts a sub-path at the closed one's start. */
let hasCur = false;
let curX = 0;
let curY = 0;
let S = 1;
let TOL = 0.25;

function push(x: number, y: number): void {
  const b = B;
  const n = b.n;
  const start = b.sub[b.sn - 1];
  if (n > start && b.p[2 * n - 2] === x && b.p[2 * n - 1] === y) return;
  if (2 * n + 2 > b.p.length) {
    const p = new Float64Array(b.p.length * 2);
    p.set(b.p);
    b.p = p;
  }
  b.p[2 * n] = x;
  b.p[2 * n + 1] = y;
  b.n = n + 1;
  curX = x;
  curY = y;
}

/** Ends the open sub-path: drops a closing duplicate, discards < 2 points. */
function end(): void {
  if (!open) return;
  open = false;
  const b = B;
  const k = b.sn - 1;
  const start = b.sub[k];
  if (
    b.closed[k] &&
    b.n - start > 1 &&
    b.p[2 * start] === b.p[2 * b.n - 2] &&
    b.p[2 * start + 1] === b.p[2 * b.n - 1]
  ) {
    b.n--;
  }
  if (b.n - start < 2) {
    b.n = start;
    b.sn--;
  }
}

function begin(x: number, y: number): void {
  end();
  const b = B;
  if (b.sn === b.sub.length) {
    const s = new Int32Array(b.sn * 2);
    s.set(b.sub);
    b.sub = s;
    const c = new Uint8Array(b.sn * 2);
    c.set(b.closed);
    b.closed = c;
  }
  b.sub[b.sn] = b.n;
  b.closed[b.sn] = 0;
  b.sn++;
  open = true;
  hasCur = false;
  push(x, y);
}

/** lineTo in context space (starts a sub-path when none is open). */
function to(x: number, y: number): void {
  if (open) push(x, y);
  else if (hasCur) {
    begin(curX, curY);
    push(x, y);
  } else begin(x, y);
}

function tx(x: number, y: number): number {
  return M[0] * x + M[2] * y + M[4];
}

function ty(x: number, y: number): number {
  return M[1] * x + M[3] * y + M[5];
}

/** Arc of an ellipse in recording space, transformed; first point joined by a line. */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start: number,
  sweep: number,
  scale: number,
): void {
  const n = arcSegments(
    Math.max(Math.abs(rx), Math.abs(ry)),
    sweep,
    scale,
    TOL,
  );
  // A full turn ends exactly on its first point: end() drops it again for
  // closed rings, an open path keeps its last segment.
  const full = Math.abs(sweep) >= TAU;
  const x0 = tx(cx + rx * Math.cos(start), cy + ry * Math.sin(start));
  const y0 = ty(cx + rx * Math.cos(start), cy + ry * Math.sin(start));
  for (let i = 0; i <= n; i++) {
    if (full && (i === 0 || i === n)) {
      to(x0, y0);
      continue;
    }
    const t = start + (sweep * i) / n;
    const x = cx + rx * Math.cos(t);
    const y = cy + ry * Math.sin(t);
    to(tx(x, y), ty(x, y));
  }
  B.curved = true;
}

/**
 * Flattens ops [op0, op1) of a context (numbers from `arg0`; transform from
 * `args[xf ..]`, identity when xf < 0) into `b` (appended).
 */
export function flattenPath(
  ops: Uint8Array,
  args: Float64Array,
  op0: number,
  arg0: number,
  op1: number,
  xf: number,
  s: number,
  tol: number,
  b: PathBuf,
): void {
  B = b;
  S = s;
  TOL = tol;
  open = hasCur = false;
  if (xf < 0) M.set(IDENTITY);
  else for (let i = 0; i < 6; i++) M[i] = args[xf + i];
  let at = arg0;
  for (let o = op0; o < op1; o++) {
    const op = ops[o];
    const a = at;
    at += op === G_POLY ? 2 + 2 * args[a] : G_ARGS[op];
    // Largest scale of the transform, for arcs flattened before it.
    const ms = S * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3]));
    const x = args[a];
    const y = args[a + 1];
    if (op === G_XFORM) {
      for (let i = 0; i < 6; i++) M[i] = args[a + i];
    } else if (op === G_MOVE) {
      begin(tx(x, y), ty(x, y));
    } else if (op === G_LINE) {
      to(tx(x, y), ty(x, y));
    } else if (op === G_QUAD || op === G_CUBIC) {
      if (!open && !hasCur) begin(tx(x, y), ty(x, y));
      const x0 = curX;
      const y0 = curY;
      const x1 = tx(x, y);
      const y1 = ty(x, y);
      const x2 = tx(args[a + 2], args[a + 3]);
      const y2 = ty(args[a + 2], args[a + 3]);
      const dd1 = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
      if (op === G_QUAD) {
        const n = segments((dd1 * S) / (4 * TOL));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          to(
            u * u * x0 + 2 * u * t * x1 + t * t * x2,
            u * u * y0 + 2 * u * t * y1 + t * t * y2,
          );
        }
      } else {
        const x3 = tx(args[a + 4], args[a + 5]);
        const y3 = ty(args[a + 4], args[a + 5]);
        const dd2 = Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3);
        const n = segments((0.75 * Math.max(dd1, dd2) * S) / TOL);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          const k0 = u * u * u;
          const k1 = 3 * u * u * t;
          const k2 = 3 * u * t * t;
          const k3 = t * t * t;
          to(
            k0 * x0 + k1 * x1 + k2 * x2 + k3 * x3,
            k0 * y0 + k1 * y1 + k2 * y2 + k3 * y3,
          );
        }
      }
      B.curved = true;
    } else if (op === G_ARC) {
      const r = args[a + 2];
      arc(x, y, r, r, args[a + 3], args[a + 4], ms);
    } else if (op === G_ARC_TO) {
      arcTo(
        tx(x, y),
        ty(x, y),
        tx(args[a + 2], args[a + 3]),
        ty(args[a + 2], args[a + 3]),
        args[a + 4] * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])),
      );
    } else if (op === G_CLOSE) {
      if (open) {
        const k = B.sub[B.sn - 1];
        B.closed[B.sn - 1] = 1;
        end();
        hasCur = true;
        curX = B.p[2 * k];
        curY = B.p[2 * k + 1];
      }
    } else {
      // Shapes: closed sub-paths of their own (polygons may be open), not
      // continued from a closed sub-path's start.
      end();
      hasCur = false;
      if (op === G_POLY) {
        const n = args[a];
        for (let i = 0; i < n; i++) {
          const px = args[a + 2 + 2 * i];
          const py = args[a + 3 + 2 * i];
          if (i === 0) begin(tx(px, py), ty(px, py));
          else push(tx(px, py), ty(px, py));
        }
        if (open) B.closed[B.sn - 1] = args[a + 1];
      } else if (op === G_RECT || op === G_RRECT) {
        let w = args[a + 2];
        let h = args[a + 3];
        let x0 = x;
        let y0 = y;
        if (w < 0) {
          x0 += w;
          w = -w;
        }
        if (h < 0) {
          y0 += h;
          h = -h;
        }
        const r =
          op === G_RRECT ? Math.min(Math.max(args[a + 4], 0), w / 2, h / 2) : 0;
        if (r > 0) {
          const q = Math.PI / 2;
          arc(x0 + w - r, y0 + r, r, r, -q, q, ms);
          arc(x0 + w - r, y0 + h - r, r, r, 0, q, ms);
          arc(x0 + r, y0 + h - r, r, r, q, q, ms);
          arc(x0 + r, y0 + r, r, r, 2 * q, q, ms);
        } else {
          to(tx(x0, y0), ty(x0, y0));
          to(tx(x0 + w, y0), ty(x0 + w, y0));
          to(tx(x0 + w, y0 + h), ty(x0 + w, y0 + h));
          to(tx(x0, y0 + h), ty(x0, y0 + h));
        }
      } else if (op === G_ELLIPSE) {
        arc(x, y, args[a + 2], args[a + 3], 0, TAU, ms);
      }
      if (open) B.closed[B.sn - 1] = op === G_POLY ? args[a + 1] : 1;
      end();
      hasCur = false;
    }
  }
  end();
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Canvas arcTo in context space (current point → tangent arc → toward p2). */
function arcTo(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
): void {
  if (!open && !hasCur) {
    begin(x1, y1);
    return;
  }
  const x0 = curX;
  const y0 = curY;
  const ax = x0 - x1;
  const ay = y0 - y1;
  const bx = x2 - x1;
  const by = y2 - y1;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  const cross = ax * by - ay * bx;
  if (la === 0 || lb === 0 || r <= 0 || Math.abs(cross) < 1e-9 * la * lb) {
    to(x1, y1);
    return;
  }
  // Half the angle at p1 between the two legs.
  const half =
    Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) / 2;
  const t = r / Math.tan(half);
  const ux = ax / la;
  const uy = ay / la;
  const vx = bx / lb;
  const vy = by / lb;
  const d = r / Math.sin(half);
  const mx = ux + vx;
  const my = uy + vy;
  const ml = Math.hypot(mx, my);
  const cx = x1 + (mx / ml) * d;
  const cy = y1 + (my / ml) * d;
  const a0 = Math.atan2(y1 + uy * t - cy, x1 + ux * t - cx);
  let sweep = Math.atan2(y1 + vy * t - cy, x1 + vx * t - cx) - a0;
  if (sweep > Math.PI) sweep -= TAU;
  if (sweep < -Math.PI) sweep += TAU;
  const n = arcSegments(r, sweep, S, TOL);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    to(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  B.curved = true;
}
