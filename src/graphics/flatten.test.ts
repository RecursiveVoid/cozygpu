/**
 * Adaptive flattening (ARCHITECTURE §26.4): the polyline stays within the
 * tolerance (device px) of the true curve at the tessellation scale, the
 * segment counts follow the §26.4 formulas, and path semantics (sub-paths,
 * closePath, transforms, arcTo) match canvas.
 */
import type { PathBuf } from './flatten';
import { arcSegments, createPathBuf, flattenPath } from './flatten';
import { GraphicsContext } from './GraphicsContext';

function flatten(ctx: GraphicsContext, scale = 1, tol = 0.25): PathBuf {
  const b = createPathBuf();
  flattenPath(ctx._o, ctx._a, 0, 0, ctx._on, -1, scale, tol, b);
  return b;
}

function points(b: PathBuf, k = 0): number[][] {
  const end = k + 1 < b.sn ? b.sub[k + 1] : b.n;
  const out: number[][] = [];
  for (let i = b.sub[k]; i < end; i++) out.push([b.p[2 * i], b.p[2 * i + 1]]);
  return out;
}

function distToSegment(
  px: number,
  py: number,
  a: number[],
  b: number[],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t =
    l2 > 0
      ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2))
      : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}

/** Largest distance from samples of the true curve to the polyline. */
function maxError(poly: number[][], curve: (t: number) => number[]): number {
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const [x, y] = curve(i / 2000);
    let best = Infinity;
    for (let s = 0; s + 1 < poly.length; s++)
      best = Math.min(best, distToSegment(x, y, poly[s], poly[s + 1]));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('flattening tolerance', () => {
  const quad = (t: number): number[] => {
    const u = 1 - t;
    return [2 * u * t * 50 + t * t * 100, 2 * u * t * 100];
  };
  const cubic = (t: number): number[] => {
    const u = 1 - t;
    return [
      3 * u * u * t * 0 + 3 * u * t * t * 100 + t * t * t * 100,
      3 * u * u * t * 100 - 3 * u * t * t * 100,
    ];
  };

  it.each([0.5, 1, 4, 16])('keeps a quadratic within tol at scale %p', s => {
    const ctx = new GraphicsContext()
      .moveTo(0, 0)
      .quadraticCurveTo(50, 100, 100, 0);
    const p = points(flatten(ctx, s));
    expect(maxError(p, quad)).toBeLessThanOrEqual(0.25 / s + 1e-9);
    const dd = Math.hypot(0 - 100 + 100, 0 - 200 + 0);
    expect(p.length - 1).toBe(Math.ceil(Math.sqrt((dd * s) / (4 * 0.25))));
  });

  it.each([0.5, 1, 4, 16])('keeps a cubic within tol at scale %p', s => {
    const ctx = new GraphicsContext()
      .moveTo(0, 0)
      .bezierCurveTo(0, 100, 100, -100, 100, 0);
    const p = points(flatten(ctx, s));
    expect(maxError(p, cubic)).toBeLessThanOrEqual(0.25 / s + 1e-9);
  });

  it.each([0.25, 1, 8])('keeps arcs and circles within tol at scale %p', s => {
    const r = 100;
    const ctx = new GraphicsContext().circle(0, 0, r);
    const p = points(flatten(ctx, s));
    // Closed: the polygon's sagitta is the error.
    const n = p.length;
    expect(n).toBe(arcSegments(r, 2 * Math.PI, s, 0.25));
    const sagitta = r * (1 - Math.cos(Math.PI / n));
    expect(sagitta).toBeLessThanOrEqual(0.25 / s + 1e-9);
    for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(r, 9);
  });

  it('needs more segments at a larger scale and caps at 512', () => {
    const counts = [1, 4, 16].map(
      s =>
        points(
          flatten(
            new GraphicsContext()
              .moveTo(0, 0)
              .quadraticCurveTo(50, 100, 100, 0),
            s,
          ),
        ).length,
    );
    expect(counts[1]).toBeGreaterThan(counts[0]);
    expect(counts[2]).toBeGreaterThan(counts[1]);
    expect(arcSegments(1e9, 2 * Math.PI, 1, 0.25)).toBe(512);
    expect(arcSegments(0.01, Math.PI, 1, 0.25)).toBe(1);
  });

  it('applies the transform scale to arcs flattened before it', () => {
    const plain = points(
      flatten(new GraphicsContext().circle(0, 0, 10), 1),
    ).length;
    const scaled = points(
      flatten(new GraphicsContext().scale(8).circle(0, 0, 10), 1),
    ).length;
    expect(scaled).toBe(
      points(flatten(new GraphicsContext().circle(0, 0, 80), 1)).length,
    );
    expect(scaled).toBeGreaterThan(plain);
  });
});

describe('path semantics', () => {
  it('splits sub-paths on moveTo and marks closePath', () => {
    const ctx = new GraphicsContext()
      .moveTo(0, 0)
      .lineTo(10, 0)
      .lineTo(10, 10)
      .closePath()
      .moveTo(20, 0)
      .lineTo(30, 0);
    const b = flatten(ctx);
    expect(b.sn).toBe(2);
    expect(Array.from(b.closed.subarray(0, 2))).toEqual([1, 0]);
    expect(points(b, 0)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('continues from the closed start after closePath (canvas)', () => {
    const b = flatten(
      new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(10, 0)
        .lineTo(10, 10)
        .closePath()
        .lineTo(0, 10),
    );
    expect(b.sn).toBe(2);
    expect(points(b, 1)).toEqual([
      [0, 0],
      [0, 10],
    ]);
  });

  it('treats lineTo without a current point as moveTo and drops 1-point sub-paths', () => {
    const b = flatten(new GraphicsContext().lineTo(5, 5));
    expect(b.sn).toBe(0);
    const c = flatten(new GraphicsContext().lineTo(5, 5).lineTo(6, 6));
    expect(points(c)).toEqual([
      [5, 5],
      [6, 6],
    ]);
  });

  it('removes duplicate points and the closing duplicate', () => {
    const b = flatten(
      new GraphicsContext().poly([0, 0, 0, 0, 10, 0, 10, 10, 0, 0]),
    );
    expect(points(b)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(b.closed[0]).toBe(1);
  });

  it('records shapes as closed sub-paths of their own; poly(open) stays open', () => {
    const b = flatten(
      new GraphicsContext().rect(0, 0, 10, 5).poly([0, 0, 5, 5, 10, 0], false),
    );
    expect(b.sn).toBe(2);
    expect(Array.from(b.closed.subarray(0, 2))).toEqual([1, 0]);
    expect(points(b, 0)).toEqual([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ]);
  });

  it('normalizes negative rect sizes and clamps round corners', () => {
    const b = flatten(new GraphicsContext().rect(10, 10, -10, -10));
    expect(points(b)[0]).toEqual([0, 0]);
    const r = flatten(new GraphicsContext().roundRect(0, 0, 20, 10, 50), 4);
    for (const [x, y] of points(r)) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(20 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
    expect(r.curved).toBe(true);
  });

  it('applies the recording transform to every point', () => {
    const ctx = new GraphicsContext()
      .translate(100, 0)
      .rotate(Math.PI / 2)
      .moveTo(10, 0)
      .lineTo(20, 0);
    const p = points(flatten(ctx));
    expect(p[0][0]).toBeCloseTo(100, 9);
    expect(p[0][1]).toBeCloseTo(10, 9);
    expect(p[1][1]).toBeCloseTo(20, 9);
    expect(flatten(ctx).curved).toBe(false);
  });

  it('draws arcTo tangent to both legs with the given radius', () => {
    const ctx = new GraphicsContext().moveTo(0, 0).arcTo(100, 0, 100, 100, 20);
    const p = points(flatten(ctx, 4));
    // Starts at the current point, ends at the second tangent point.
    expect(p[0]).toEqual([0, 0]);
    expect(p[1][0]).toBeCloseTo(80, 9);
    expect(p[1][1]).toBeCloseTo(0, 9);
    const last = p[p.length - 1];
    expect(last[0]).toBeCloseTo(100, 9);
    expect(last[1]).toBeCloseTo(20, 9);
    for (let i = 1; i < p.length; i++) {
      expect(Math.hypot(p[i][0] - 80, p[i][1] - 20)).toBeCloseTo(20, 9);
    }
  });

  it('connects an arc to the current point with a line', () => {
    const ctx = new GraphicsContext()
      .moveTo(-50, 0)
      .arc(0, 0, 10, Math.PI, 2 * Math.PI);
    const p = points(flatten(ctx));
    expect(p[0]).toEqual([-50, 0]);
    expect(p[1][0]).toBeCloseTo(-10, 9);
    expect(p[p.length - 1][0]).toBeCloseTo(10, 9);
  });
});
