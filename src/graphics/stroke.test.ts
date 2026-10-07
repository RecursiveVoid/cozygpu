/**
 * Stroke geometry (ARCHITECTURE §26.4): band width, caps, the three joins,
 * miterLimit, alignment on closed rings, and no self-overlap at convex
 * corners or gentle bends (so translucent strokes do not darken there).
 */
import type { MeshOut } from './stroke';
import {
  CAP_BUTT,
  CAP_ROUND,
  CAP_SQUARE,
  JOIN_BEVEL,
  JOIN_MITER,
  JOIN_ROUND,
  createMeshOut,
  strokePolyline,
} from './stroke';
import { trianglesArea } from './frame.testutil';

interface Opts {
  closed?: boolean;
  w?: number;
  align?: number;
  join?: number;
  cap?: number;
  limit?: number;
  scale?: number;
}

function stroke(pts: number[], o: Opts = {}): MeshOut {
  const m = createMeshOut();
  strokePolyline(
    new Float64Array(pts),
    0,
    pts.length / 2,
    o.closed ?? false,
    o.w ?? 10,
    o.align ?? 0.5,
    o.join ?? JOIN_MITER,
    o.cap ?? CAP_BUTT,
    o.limit ?? 10,
    0xff0000ff,
    o.scale ?? 1,
    0.25,
    m,
  );
  return m;
}

function xy(m: MeshOut): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.vn; i++) out.push(m.vf[3 * i], m.vf[3 * i + 1]);
  return out;
}

function area(m: MeshOut): number {
  return trianglesArea(xy(m), m.i, m.in);
}

function bounds(m: MeshOut): number[] {
  const p = xy(m);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  return [x0, y0, x1, y1];
}

describe('stroke: lines and caps', () => {
  it('a butt line is a w × length band', () => {
    const m = stroke([0, 0, 100, 0]);
    expect(area(m)).toBeCloseTo(1000, 6);
    expect(bounds(m)).toEqual([0, -5, 100, 5]);
    expect(m.vu[2]).toBe(0xff0000ff); // stroke colour baked in
  });

  it('a square cap extends each end by w/2', () => {
    const m = stroke([0, 0, 100, 0], { cap: CAP_SQUARE });
    expect(area(m)).toBeCloseTo(1100, 6);
    expect(bounds(m)).toEqual([-5, -5, 105, 5]);
  });

  it('a round cap adds a half disc at each end', () => {
    const m = stroke([0, 0, 100, 0], { cap: CAP_ROUND, scale: 8 });
    // Inscribed polygons: slightly under the true disc.
    expect(area(m)).toBeLessThan(1000 + Math.PI * 25);
    expect(area(m)).toBeGreaterThan((1000 + Math.PI * 25) * 0.999);
    const b = bounds(m);
    expect(b[0]).toBeCloseTo(-5, 1);
    expect(b[2]).toBeCloseTo(105, 1);
    // Every cap vertex lies on the circle of radius w/2 (or is the centre).
    const p = xy(m);
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < 0) expect(Math.hypot(p[i], p[i + 1])).toBeCloseTo(5, 5);
    }
  });

  it('ignores zero width and single points', () => {
    expect(stroke([0, 0, 10, 0], { w: 0 }).in).toBe(0);
    expect(stroke([0, 0]).in).toBe(0);
  });
});

describe('stroke: joins', () => {
  const corner = [0, 0, 100, 0, 100, 100];
  // Two w × 100 bands overlap in a w/2 × w/2 square at the corner before
  // the join fills the outer gap.
  const bands = 2 * 100 * 10 - 25;

  it('miter: the outer corner is filled to a square tip', () => {
    const m = stroke(corner, { join: JOIN_MITER });
    expect(area(m)).toBeCloseTo(bands + 25, 6);
    const b = bounds(m);
    expect(b[2]).toBeCloseTo(105, 9);
    expect(b[1]).toBeCloseTo(-5, 9);
    // The tip vertex.
    const p = xy(m);
    let tip = false;
    for (let i = 0; i < p.length; i += 2) {
      if (Math.abs(p[i] - 105) < 1e-9 && Math.abs(p[i + 1] + 5) < 1e-9)
        tip = true;
    }
    expect(tip).toBe(true);
  });

  it('bevel: the outer corner is cut by one triangle', () => {
    const m = stroke(corner, { join: JOIN_BEVEL });
    expect(area(m)).toBeCloseTo(bands + 12.5, 6);
  });

  it('round: the outer corner is a quarter disc', () => {
    const m = stroke(corner, { join: JOIN_ROUND, scale: 16 });
    expect(area(m)).toBeLessThan(bands + (Math.PI * 25) / 4);
    expect(area(m)).toBeGreaterThan(bands + (Math.PI * 25) / 4 - 0.1);
    const p = xy(m);
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] > 100 && p[i + 1] < 0) {
        expect(Math.hypot(p[i] - 100, p[i + 1])).toBeCloseTo(5, 5);
      }
    }
  });

  it('miterLimit turns a sharp miter into a bevel', () => {
    // ~11.5° turn back: miter ratio ≈ 10.
    const sharp = [0, 0, 100, 0, 0, 20];
    const long = stroke(sharp, { join: JOIN_MITER, limit: 100 });
    const cut = stroke(sharp, { join: JOIN_MITER, limit: 4 });
    const bevel = stroke(sharp, { join: JOIN_BEVEL });
    expect(bounds(long)[2]).toBeGreaterThan(140);
    expect(bounds(cut)[2]).toBeLessThan(106);
    expect(area(cut)).toBeCloseTo(area(bevel), 9);
  });

  it('a straight run adds no join geometry and does not overlap', () => {
    const m = stroke([0, 0, 50, 0, 100, 0]);
    expect(area(m)).toBeCloseTo(1000, 6);
    expect(m.in).toBe(12);
  });

  it('gentle bends (a flattened curve) do not overlap themselves', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * (Math.PI / 2);
      pts.push(100 * Math.cos(a), 100 * Math.sin(a));
    }
    const m = stroke(pts, { join: JOIN_MITER });
    // Exact annulus sector of the polyline: outer polygon − inner polygon.
    const exact = (Math.PI / 4) * (105 * 105 - 95 * 95);
    expect(Math.abs(area(m) - exact) / exact).toBeLessThan(0.002);
  });

  it('a U-turn falls back to a bevel and stays finite', () => {
    const m = stroke([0, 0, 100, 0, 0, 0.0000001], { join: JOIN_MITER });
    for (const v of xy(m)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('stroke: closed rings and alignment', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  const squareCcw = [0, 0, 0, 100, 100, 100, 100, 0];

  it('centred: a frame of outer (s + w)² − inner (s − w)² with no overlap', () => {
    for (const ring of [square, squareCcw]) {
      const m = stroke(ring, { closed: true });
      expect(area(m)).toBeCloseTo(110 * 110 - 90 * 90, 6);
      expect(bounds(m)).toEqual([-5, -5, 105, 105]);
    }
  });

  it('alignment 1 puts the band inside, 0 outside, whatever the winding', () => {
    for (const ring of [square, squareCcw]) {
      const inside = stroke(ring, { closed: true, align: 1 });
      expect(bounds(inside)).toEqual([0, 0, 100, 100]);
      expect(area(inside)).toBeCloseTo(100 * 100 - 80 * 80, 6);
      const outside = stroke(ring, { closed: true, align: 0 });
      expect(bounds(outside)).toEqual([-10, -10, 110, 110]);
      expect(area(outside)).toBeCloseTo(120 * 120 - 100 * 100, 6);
    }
  });

  it('joins the closing corner like the others (round)', () => {
    const m = stroke(square, { closed: true, join: JOIN_ROUND, scale: 16 });
    const expected = 110 * 110 - 90 * 90 - 4 * 25 + Math.PI * 25;
    expect(area(m)).toBeCloseTo(expected, 0);
  });

  it('closed rings take no caps', () => {
    const butt = stroke(square, { closed: true, cap: CAP_BUTT });
    const round = stroke(square, { closed: true, cap: CAP_ROUND });
    expect(round.in).toBe(butt.in);
  });

  it('strokes a sub-range of a larger buffer', () => {
    const m = createMeshOut();
    const p = new Float64Array([999, 999, 0, 0, 100, 0, 999, 999]);
    strokePolyline(
      p,
      1,
      2,
      false,
      10,
      0.5,
      JOIN_MITER,
      CAP_BUTT,
      10,
      1,
      1,
      0.25,
      m,
    );
    expect(area(m)).toBeCloseTo(1000, 6);
  });
});
