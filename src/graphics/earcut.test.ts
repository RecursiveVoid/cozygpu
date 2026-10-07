/**
 * Triangulation (ARCHITECTURE §26.4): exact area cover for simple polygons
 * with and without holes, both windings, the z-order path above 80
 * vertices, and degenerate input that must not throw.
 */
import { triangulate } from './tess';
import {
  insideRing,
  ringArea,
  tri,
  triArea2,
  trianglesArea,
} from './frame.testutil';

/** Every triangle's centroid lies inside the outer ring and outside every hole. */
function expectInside(points: number[], holes: number[], idx: number[]): void {
  const n = points.length / 2;
  const outerEnd = holes.length ? holes[0] : n;
  for (let t = 0; t < idx.length; t += 3) {
    const cx =
      (points[2 * idx[t]] + points[2 * idx[t + 1]] + points[2 * idx[t + 2]]) /
      3;
    const cy =
      (points[2 * idx[t] + 1] +
        points[2 * idx[t + 1] + 1] +
        points[2 * idx[t + 2] + 1]) /
      3;
    expect(insideRing(points, 0, outerEnd, cx, cy)).toBe(true);
    for (let h = 0; h < holes.length; h++) {
      const end = h + 1 < holes.length ? holes[h + 1] : n;
      expect(insideRing(points, holes[h], end, cx, cy)).toBe(false);
    }
  }
}

function circle(
  cx: number,
  cy: number,
  r: number,
  n: number,
  ccw = false,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? -1 : 1) * i * 2 * Math.PI) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

describe('triangulate', () => {
  it('splits a square into two triangles covering it', () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    const idx = tri(sq);
    expect(idx.length).toBe(6);
    expect(trianglesArea(sq, idx, idx.length)).toBeCloseTo(100, 9);
  });

  it('handles both windings with the same result area', () => {
    const cw = [0, 0, 0, 10, 10, 10, 10, 0];
    const ccw = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(trianglesArea(cw, tri(cw), 6)).toBeCloseTo(100, 9);
    expect(trianglesArea(ccw, tri(ccw), 6)).toBeCloseTo(100, 9);
  });

  it('covers concave polygons exactly (L shape, star)', () => {
    const l = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
    const li = tri(l);
    expect(li.length).toBe(3 * (6 - 2));
    expect(trianglesArea(l, li, li.length)).toBeCloseTo(ringArea(l, 0, 6), 9);
    expectInside(l, [], li);

    const star: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4 : 10;
      const a = (i * Math.PI) / 5;
      star.push(r * Math.cos(a), r * Math.sin(a));
    }
    const si = tri(star);
    expect(si.length).toBe(3 * 8);
    expect(trianglesArea(star, si, si.length)).toBeCloseTo(
      ringArea(star, 0, 10),
      9,
    );
    expectInside(star, [], si);
  });

  it('cuts holes: area = outer − holes, nothing inside a hole', () => {
    const pts = [
      0, 0, 100, 0, 100, 100, 0, 100, 20, 20, 40, 20, 40, 40, 20, 40, 60, 60,
      80, 60, 80, 80, 60, 80,
    ];
    const holes = [4, 8];
    const idx = tri(pts, holes);
    expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(
      10000 - 400 - 400,
      6,
    );
    expectInside(pts, holes, idx);
    // n + 2h - 2 triangles for a simple polygon with h holes.
    expect(idx.length / 3).toBe(12 + 4 - 2);
  });

  it('accepts a hole of either winding', () => {
    const hole = circle(50, 50, 20, 32, true);
    const pts = [0, 0, 100, 0, 100, 100, 0, 100, ...hole];
    const idx = tri(pts, [4]);
    const expected = 10000 - ringArea(hole, 0, 32);
    expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(expected, 6);
    const pts2 = [0, 0, 100, 0, 100, 100, 0, 100, ...circle(50, 50, 20, 32)];
    const idx2 = tri(pts2, [4]);
    expect(trianglesArea(pts2, idx2, idx2.length)).toBeCloseTo(expected, 6);
  });

  it('uses the z-order path above 80 vertices and stays exact', () => {
    const ring = circle(0, 0, 100, 400);
    const idx = tri(ring);
    expect(idx.length).toBe(3 * 398);
    expect(trianglesArea(ring, idx, idx.length)).toBeCloseTo(
      ringArea(ring, 0, 400),
      6,
    );
    // A large ring with many holes.
    const pts = [-200, -200, 200, -200, 200, 200, -200, 200];
    const holes: number[] = [];
    let holeArea = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        holes.push(pts.length / 2);
        const h = circle(-150 + i * 100, -150 + j * 100, 30, 24);
        holeArea += ringArea(h, 0, 24);
        pts.push(...h);
      }
    }
    const hi = tri(pts, holes);
    expect(trianglesArea(pts, hi, hi.length)).toBeCloseTo(160000 - holeArea, 4);
    expectInside(pts, holes, hi);
  });

  it('writes from outOffset with baseVertex added', () => {
    const coords = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const out = new Uint32Array(20).fill(7);
    const n = triangulate(coords, 8, null, 0, out, 5, 100);
    expect(n).toBe(6);
    expect(Array.from(out.subarray(0, 5))).toEqual([7, 7, 7, 7, 7]);
    for (let i = 5; i < 11; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(100);
      expect(out[i]).toBeLessThan(104);
    }
    expect(out[11]).toBe(7);
  });

  it('reads Float32Array coordinates', () => {
    const coords = new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]);
    const out = new Uint32Array(12);
    expect(triangulate(coords, 8, null, 0, out, 0, 0)).toBe(6);
  });

  describe('degenerate input', () => {
    it('returns 0 for fewer than 3 points and for collinear points', () => {
      expect(tri([])).toEqual([]);
      expect(tri([0, 0, 1, 1])).toEqual([]);
      expect(
        trianglesArea(
          [0, 0, 1, 1, 2, 2, 3, 3],
          tri([0, 0, 1, 1, 2, 2, 3, 3]),
          0,
        ),
      ).toBe(0);
      const line = tri([0, 0, 1, 1, 2, 2, 3, 3]);
      for (let i = 0; i < line.length; i += 3) {
        expect(
          triArea2([0, 0, 1, 1, 2, 2, 3, 3], line[i], line[i + 1], line[i + 2]),
        ).toBe(0);
      }
    });

    it('drops duplicate and collinear points', () => {
      const pts = [0, 0, 0, 0, 5, 0, 10, 0, 10, 10, 10, 10, 0, 10, 0, 0];
      const idx = tri(pts);
      expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(100, 9);
      expect(idx.length).toBe(6);
    });

    it('survives a self-intersecting ring (bow tie)', () => {
      const bow = [0, 0, 10, 10, 10, 0, 0, 10];
      expect(() => tri(bow)).not.toThrow();
      const idx = tri(bow);
      expect(idx.length % 3).toBe(0);
      for (const i of idx) expect(i).toBeLessThan(4);
    });

    it('survives a hole outside the outer ring and a zero-area hole', () => {
      const pts = [
        0, 0, 10, 0, 10, 10, 0, 10, 20, 20, 30, 20, 30, 30, 40, 40, 41, 41, 42,
        42,
      ];
      expect(() => tri(pts, [4, 7])).not.toThrow();
    });

    it('survives NaN-free random polygons', () => {
      let seed = 1;
      const rnd = (): number =>
        ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;
      for (let k = 0; k < 50; k++) {
        const pts: number[] = [];
        const n = 3 + (k % 40);
        for (let i = 0; i < n; i++) pts.push(rnd(), rnd());
        const idx = tri(pts);
        expect(idx.length % 3).toBe(0);
        for (const i of idx) expect(i).toBeLessThan(n);
      }
    });
  });
});
