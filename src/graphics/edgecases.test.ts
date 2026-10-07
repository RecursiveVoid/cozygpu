/**
 * Edge cases across the Graphics pipeline: triangulation corner cases,
 * stroke geometry on concave rings and open paths, SDF instance packing,
 * per-node change tracking and contexts shared between nodes and renderers.
 *
 * `it.failing` marks known defects: each documents the expected behaviour
 * and starts failing (so it can become a plain `it`) once the defect is
 * fixed.
 */
import { BlendModeId } from '../backend/types';
import { GfxOp } from '../commands/gfxOpcodes';
import { toPackedColor } from '../math/color';
import {
  GFX_SHAPE_F32_PER,
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_H,
  GS_HALF_W,
  GS_P0,
  GS_P1,
  GS_STROKE,
  GS_STROKE_IN,
  GS_STROKE_OUT,
  GfxShapeFlag,
  GfxShapeKind,
} from '../types/gfxLayouts';
import { SI_PICK_SHIFT } from '../types/layouts';
import type { Compiled } from './compile';
import { PART, PT_INDICES, compile } from './compile';
import { createGraphicsBinding, loadTess } from './emit';
import type { PathBuf } from './flatten';
import { createPathBuf, flattenPath } from './flatten';
import type { Recorded } from './frame.testutil';
import {
  TestFrame,
  insideRing,
  ringArea,
  tri,
  trianglesArea,
} from './frame.testutil';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import { Graphics } from './Graphics';
import { GraphicsContext } from './GraphicsContext';
import type { MeshOut } from './stroke';
import {
  CAP_SQUARE,
  JOIN_MITER,
  createMeshOut,
  strokePolyline,
} from './stroke';
import { tessellate } from './tess';
import type { GraphicsBinding } from './types';

beforeAll(async () => {
  await loadTess();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function circle(cx: number, cy: number, r: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Every triangle centroid inside the outer ring and outside each hole. */
function expectInside(points: number[], holes: number[], idx: number[]): void {
  const n = points.length / 2;
  const outerEnd = holes.length ? holes[0] : n;
  for (let t = 0; t < idx.length; t += 3) {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < 3; k++) {
      cx += points[2 * idx[t + k]] / 3;
      cy += points[2 * idx[t + k] + 1] / 3;
    }
    expect(insideRing(points, 0, outerEnd, cx, cy)).toBe(true);
    for (let h = 0; h < holes.length; h++) {
      const end = h + 1 < holes.length ? holes[h + 1] : n;
      expect(insideRing(points, holes[h], end, cx, cy)).toBe(false);
    }
  }
}

function flatten(ctx: GraphicsContext, scale = 1): PathBuf {
  const b = createPathBuf();
  flattenPath(ctx._o, ctx._a, 0, 0, ctx._on, -1, scale, 0.25, b);
  return b;
}

function points(b: PathBuf, k: number): number[][] {
  const end = k + 1 < b.sn ? b.sub[k + 1] : b.n;
  const out: number[][] = [];
  for (let i = b.sub[k]; i < end; i++) out.push([b.p[2 * i], b.p[2 * i + 1]]);
  return out;
}

function strokeMesh(
  pts: number[],
  closed: boolean,
  w: number,
  align = 0.5,
  cap = 0,
): MeshOut {
  const m = createMeshOut();
  strokePolyline(
    new Float64Array(pts),
    0,
    pts.length / 2,
    closed,
    w,
    align,
    JOIN_MITER,
    cap,
    10,
    0xffffffff,
    1,
    0.25,
    m,
  );
  return m;
}

function meshXY(m: MeshOut): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.vn; i++) out.push(m.vf[3 * i], m.vf[3 * i + 1]);
  return out;
}

function meshArea(m: MeshOut): number {
  return trianglesArea(meshXY(m), m.i, m.in);
}

function meshBounds(m: MeshOut): number[] {
  const p = meshXY(m);
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 2) {
    b[0] = Math.min(b[0], p[i]);
    b[1] = Math.min(b[1], p[i + 1]);
    b[2] = Math.max(b[2], p[i]);
    b[3] = Math.max(b[3], p[i + 1]);
  }
  return b;
}

function tess(ctx: GraphicsContext, scale = 1): Compiled {
  const c = compile(ctx);
  tessellate(ctx, c, scale);
  return c;
}

function fv(c: Compiled, i: number, byteOffset: number): number {
  return c.sf[i * GFX_SHAPE_F32_PER + (byteOffset >> 2)];
}
function uv(c: Compiled, i: number, byteOffset: number): number {
  return c.su[i * GFX_SHAPE_F32_PER + (byteOffset >> 2)];
}

let nextRenderer = 5000;
/** The M4 split path (no vertex storage); unified.test.ts covers the batch. */
function frame(): TestFrame {
  const f = new TestFrame();
  f.caps = { ...FAKE_CAPS, vertexStorage: false };
  f.rendererId = nextRenderer++;
  return f;
}

const W = new Float32Array(6 * 16);
function at(i: number, tx: number, ty: number, s = 1): number {
  W.set([s, 0, 0, s, tx, ty], i * 6);
  return i * 6;
}

interface Item {
  node: Graphics;
  binding: GraphicsBinding;
}
function node(ctx?: GraphicsContext, opts: Record<string, unknown> = {}): Item {
  const n = new Graphics({ context: ctx, ...opts });
  return { node: n, binding: createGraphicsBinding(n) };
}

function only(list: Recorded[], opcode: number): Recorded[] {
  return list.filter(c => c.opcode === opcode);
}

/** f32 / u32 views of the instances carried by a GFX_SHAPE_UPLOAD. */
function instances(up: Recorded): { f: Float32Array; u: Uint32Array } {
  const n = up.words[2] * GFX_SHAPE_F32_PER;
  return {
    f: new Float32Array(up.bytes.buffer, up.bytes.byteOffset + 12, n),
    u: new Uint32Array(up.bytes.buffer, up.bytes.byteOffset + 12, n),
  };
}

// ─── triangulation ───────────────────────────────────────────────────────────

describe('triangulation edge cases', () => {
  it('a hole touching the outer ring at a vertex', () => {
    const pts = [0, 0, 100, 0, 100, 100, 0, 100, 0, 0, 30, 10, 10, 30];
    const idx = tri(pts, [4]);
    expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(10000 - 400, 6);
  });

  it('holes with the same leftmost x are both bridged', () => {
    const pts = [
      0, 0, 100, 0, 100, 100, 0, 100, 20, 10, 40, 10, 40, 30, 20, 30, 20, 60,
      40, 60, 40, 80, 20, 80,
    ];
    const holes = [4, 8];
    const idx = tri(pts, holes);
    expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(10000 - 800, 6);
    expectInside(pts, holes, idx);
  });

  it('z-order path with a hole far from the origin stays exact', () => {
    const outer = circle(1000, -2000, 100, 200);
    const hole = circle(1000, -2000, 40, 48);
    const pts = [...outer, ...hole];
    const idx = tri(pts, [200]);
    const expected = ringArea(outer, 0, 200) - ringArea(hole, 0, 48);
    expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(expected, 3);
    expectInside(pts, [200], idx);
  });

  it('a comb (many reflex vertices) is covered exactly with n − 2 triangles', () => {
    const pts: number[] = [0, 0];
    const teeth = 20;
    for (let t = 0; t < teeth; t++) {
      pts.push(4 * t, 50, 4 * t + 2, 50, 4 * t + 2, 10, 4 * t + 4, 10);
    }
    pts.push(4 * teeth, 0);
    const n = pts.length / 2;
    const idx = tri(pts);
    expect(idx.length / 3).toBe(n - 2);
    expect(trianglesArea(pts, idx, idx.length)).toBeCloseTo(
      ringArea(pts, 0, n),
      6,
    );
    expectInside(pts, [], idx);
  });

  it('resets its node pool between calls (big ring, then a square)', () => {
    tri(circle(0, 0, 50, 600));
    const sq = [0, 0, 1, 0, 1, 1, 0, 1];
    const idx = tri(sq);
    expect(idx.length).toBe(6);
    expect(Math.max(...idx)).toBeLessThan(4);
    expect(trianglesArea(sq, idx, idx.length)).toBeCloseTo(1, 12);
  });

  it('fills every sub-path of one path, each cut only by overlapping holes', () => {
    const ctx = new GraphicsContext()
      .rect(0, 0, 10, 10)
      .rect(100, 0, 10, 10)
      .fill(0)
      .rect(2, 2, 2, 2)
      .cut();
    const c = tess(ctx);
    const m = c.mesh!;
    expect(trianglesArea(meshXY(m), m.i, m.in)).toBeCloseTo(200 - 4, 6);
  });
});

// ─── stroke geometry ─────────────────────────────────────────────────────────

describe('stroke geometry edge cases', () => {
  // An L: concave corner at (50, 50); area 7500.
  const L = [0, 0, 100, 0, 100, 50, 50, 50, 50, 100, 0, 100];
  const Lrev = (): number[] => {
    const out: number[] = [];
    for (let i = L.length - 2; i >= 0; i -= 2) out.push(L[i], L[i + 1]);
    return out;
  };

  it('alignment 1 keeps the band inside a concave ring (both windings)', () => {
    // Inner offset L by 10: 80·30 + 30·50 = 3900 → band 7500 − 3900.
    for (const ring of [L, Lrev()]) {
      const m = strokeMesh(ring, true, 10, 1);
      expect(meshArea(m)).toBeCloseTo(3600, 6);
      expect(meshBounds(m)).toEqual([0, 0, 100, 100]);
    }
  });

  it('alignment 0 keeps the band outside a concave ring (both windings)', () => {
    // Outer offset L by 10: 120·70 + 70·50 = 11900 → band 11900 − 7500.
    for (const ring of [L, Lrev()]) {
      const m = strokeMesh(ring, true, 10, 0);
      expect(meshArea(m)).toBeCloseTo(4400, 6);
      expect(meshBounds(m)).toEqual([-10, -10, 110, 110]);
    }
  });

  it('open polylines ignore alignment (always centred)', () => {
    const m = strokeMesh([0, 0, 100, 0], false, 10, 1);
    expect(meshBounds(m)).toEqual([0, -5, 100, 5]);
  });

  it('a closed request with two points becomes an open, capped line', () => {
    const m = strokeMesh([0, 0, 100, 0], true, 10, 0.5, CAP_SQUARE);
    expect(meshBounds(m)).toEqual([-5, -5, 105, 5]);
    expect(meshArea(m)).toBeCloseTo(1100, 6);
  });

  it('a 90° miter reaches the corner of the offset square exactly', () => {
    const m = strokeMesh([0, 0, 100, 0, 100, 100], false, 10);
    const p = meshXY(m);
    let tip = false;
    for (let i = 0; i < p.length; i += 2) {
      if (Math.abs(p[i] - 105) < 1e-9 && Math.abs(p[i + 1] + 5) < 1e-9)
        tip = true;
    }
    expect(tip).toBe(true);
    // Band of length 200 (centre line) and width 10, no overlap.
    expect(meshArea(m)).toBeCloseTo(2000, 6);
  });

  it('strokes a hole outline with the hole closed even when recorded open', () => {
    const c = tess(
      new GraphicsContext()
        .rect(0, 0, 100, 100)
        .stroke({ width: 2 })
        .poly([40, 40, 60, 40, 60, 60, 40, 60], false)
        .cut(),
    );
    // Outer frame 102² − 98² plus the hole frame 22² − 18².
    expect(meshArea(c.mesh!)).toBeCloseTo(
      102 * 102 - 98 * 98 + 22 * 22 - 18 * 18,
      4,
    );
  });
});

// ─── SDF instance packing ────────────────────────────────────────────────────

describe('SDF instance packing edge cases', () => {
  it('normalizes negative rect sizes to a centre and positive half extents', () => {
    const c = compile(new GraphicsContext().rect(10, 10, -4, -6).fill(0));
    expect(fv(c, 0, GS_A + 16)).toBe(8);
    expect(fv(c, 0, GS_A + 20)).toBe(7);
    expect([fv(c, 0, GS_HALF_W), fv(c, 0, GS_HALF_H)]).toEqual([2, 3]);
  });

  it('clamps roundRect radii to [0, min half extent]', () => {
    const big = compile(
      new GraphicsContext().roundRect(0, 0, 10, 4, 100).fill(0),
    );
    expect(fv(big, 0, GS_P0)).toBe(2);
    const neg = compile(
      new GraphicsContext().roundRect(0, 0, 10, 4, -3).fill(0),
    );
    expect(fv(neg, 0, GS_P0)).toBe(0);
    expect(uv(neg, 0, GS_FLAGS) & 0xf).toBe(GfxShapeKind.RECT);
  });

  it('packs a diagonal segment: unit axes along it, centre, half length', () => {
    const c = compile(
      new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(30, 40)
        .stroke({ width: 4, cap: 'square', color: 0x00ff00 }),
    );
    expect(uv(c, 0, GS_FLAGS) & 0xf).toBe(GfxShapeKind.SEGMENT);
    expect(fv(c, 0, GS_A)).toBeCloseTo(0.6, 6);
    expect(fv(c, 0, GS_A + 4)).toBeCloseTo(0.8, 6);
    expect(fv(c, 0, GS_A + 8)).toBeCloseTo(-0.8, 6);
    expect(fv(c, 0, GS_A + 12)).toBeCloseTo(0.6, 6);
    expect([fv(c, 0, GS_A + 16), fv(c, 0, GS_A + 20)]).toEqual([15, 20]);
    expect([fv(c, 0, GS_HALF_W), fv(c, 0, GS_HALF_H)]).toEqual([25, 2]);
    expect(uv(c, 0, GS_FLAGS) & GfxShapeFlag.CAP_SQUARE).toBeTruthy();
    expect(uv(c, 0, GS_FLAGS) & GfxShapeFlag.FILL).toBe(0);
    expect(uv(c, 0, GS_FILL)).toBe(0);
    expect(uv(c, 0, GS_STROKE)).toBe(toPackedColor(0x00ff00));
  });

  it('stores counterclockwise arcs with a negative sweep and full turns as 2π', () => {
    const ccw = compile(
      new GraphicsContext()
        .arc(0, 0, 10, 0, Math.PI / 2, true)
        .stroke({ width: 2, cap: 'round' }),
    );
    expect(uv(ccw, 0, GS_FLAGS) & 0xf).toBe(GfxShapeKind.ARC);
    expect(fv(ccw, 0, GS_P1)).toBeCloseTo(-1.5 * Math.PI, 6);
    expect(uv(ccw, 0, GS_FLAGS) & GfxShapeFlag.CAP_ROUND).toBeTruthy();
    const full = compile(
      new GraphicsContext().arc(0, 0, 10, 1, 1 + 4 * Math.PI).stroke(),
    );
    expect(fv(full, 0, GS_P1)).toBeCloseTo(2 * Math.PI, 6);
    expect([fv(full, 0, GS_HALF_W), fv(full, 0, GS_HALF_H)]).toEqual([10, 10]);
  });

  it('divides stroke widths by the recording scale, except pixel lines', () => {
    const scaled = (pixelLine: boolean): Compiled =>
      compile(
        new GraphicsContext()
          .scale(2, 8)
          .rect(0, 0, 1, 1)
          .stroke({ width: 8, pixelLine }),
      );
    // sqrt(det) = 4.
    expect(fv(scaled(false), 0, GS_STROKE_IN)).toBe(1);
    expect(fv(scaled(false), 0, GS_STROKE_OUT)).toBe(1);
    expect(fv(scaled(true), 0, GS_STROKE_IN)).toBe(4);
    expect(
      uv(scaled(true), 0, GS_FLAGS) & GfxShapeFlag.PIXEL_LINE,
    ).toBeTruthy();
  });

  it('merges fill + outside stroke into one instance with the band outside', () => {
    const c = compile(
      new GraphicsContext()
        .circle(0, 0, 5)
        .fill(0xff0000)
        .stroke({ width: 3, alignment: 0, color: 0x0000ff }),
    );
    expect(c.ns).toBe(1);
    expect([fv(c, 0, GS_STROKE_IN), fv(c, 0, GS_STROKE_OUT)]).toEqual([0, 3]);
    expect(uv(c, 0, GS_FILL)).toBe(toPackedColor(0xff0000));
    expect(uv(c, 0, GS_STROKE)).toBe(toPackedColor(0x0000ff));
    expect(uv(c, 0, GS_FLAGS) & GfxShapeFlag.FILL).toBeTruthy();
  });

  it('composes the node world with the context affine when packing slots', () => {
    const f = frame();
    const { binding } = node(new GraphicsContext().rect(0, 0, 10, 4).fill(0));
    // Rotate 90° then translate (50, 0).
    W.set([0, 1, -1, 0, 50, 0], 0);
    binding.emitDraw(f, W, 0, 1);
    const { f: inst } = instances(only(f.end(), GfxOp.GFX_SHAPE_UPLOAD)[0]);
    const A = GS_A >> 2;
    expect(Array.from(inst.subarray(A, A + 6))).toEqual([0, 1, -1, 0, 48, 5]);
    expect([inst[GS_HALF_W >> 2], inst[GS_HALF_H >> 2]]).toEqual([5, 2]);
  });
});

// ─── change tracking ─────────────────────────────────────────────────────────

describe('change tracking', () => {
  const rect = (): GraphicsContext =>
    new GraphicsContext().rect(0, 0, 1, 1).fill(0xffffff);

  it('a tint change rewrites and uploads the slot; a blend change does not', () => {
    const f = frame();
    const a = node(rect());
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.end();
    a.node.blendMode = 'add';
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    let out = f.end();
    expect(only(out, GfxOp.GFX_SHAPE_UPLOAD).length).toBe(0);
    expect(only(out, GfxOp.GFX_DRAW_SHAPES)[0].words[3]).toBe(BlendModeId.add);
    a.node.tint = 0x00ff00;
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    out = f.end();
    const { u } = instances(only(out, GfxOp.GFX_SHAPE_UPLOAD)[0]);
    expect(u[GS_FILL >> 2]).toBe(toPackedColor(0x00ff00));
  });

  it('an alpha change rewrites; an unchanged frame after it does not', () => {
    const f = frame();
    const a = node(rect());
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.end();
    a.binding.emitDraw(f, W, at(0, 0, 0), 0.25);
    const { u } = instances(only(f.end(), GfxOp.GFX_SHAPE_UPLOAD)[0]);
    expect(u[GS_FILL >> 2] >>> 24).toBe(64);
    a.binding.emitDraw(f, W, at(0, 0, 0), 0.25);
    expect(only(f.end(), GfxOp.GFX_SHAPE_UPLOAD).length).toBe(0);
  });

  it('toggling pickable rewrites the pick id', () => {
    const f = frame();
    const a = node(rect());
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.end();
    a.node.pickable = true;
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    const { u } = instances(only(f.end(), GfxOp.GFX_SHAPE_UPLOAD)[0]);
    expect(u[GS_FLAGS >> 2] >>> SI_PICK_SHIFT).toBe(a.node.id);
  });

  it('editing a shared context rewrites every node drawing it', () => {
    const f = frame();
    const ctx = rect();
    const items = [node(ctx), node(ctx)];
    const draw = (): Recorded[] => {
      items.forEach((it, i) => it.binding.emitDraw(f, W, at(i, i * 5, 0), 1));
      return f.end();
    };
    draw();
    expect(only(draw(), GfxOp.GFX_SHAPE_UPLOAD).length).toBe(0);
    ctx.clear().rect(0, 0, 2, 2).fill(0xff0000);
    const up = only(draw(), GfxOp.GFX_SHAPE_UPLOAD);
    expect(up[0].words.slice(1, 3)).toEqual([0, 2]);
    const { u } = instances(up[0]);
    expect(u[GS_FILL >> 2]).toBe(toPackedColor(0xff0000));
    expect(u[GFX_SHAPE_F32_PER + (GS_FILL >> 2)]).toBe(toPackedColor(0xff0000));
  });

  it('records are persistent: hiding a node moves nothing, showing it rewrites nothing', () => {
    const f = frame();
    const a = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0xff0000));
    const b = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0x0000ff));
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 5, 0), 1);
    f.end();
    // a hidden: b keeps its record (1); nothing to upload.
    b.binding.emitDraw(f, W, at(1, 5, 0), 1);
    let out = f.end();
    expect(only(out, GfxOp.GFX_SHAPE_UPLOAD).length).toBe(0);
    expect(only(out, GfxOp.GFX_DRAW_SHAPES)[0].words.slice(1, 3)).toEqual([
      1, 1,
    ]);
    // a back: both draw from their own records, still nothing uploaded.
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 5, 0), 1);
    out = f.end();
    expect(only(out, GfxOp.GFX_SHAPE_UPLOAD).length).toBe(0);
    expect(only(out, GfxOp.GFX_DRAW_SHAPES)[0].words.slice(1, 3)).toEqual([
      0, 2,
    ]);
  });

  it('swapping node.context rewrites the slot with the new content', () => {
    const f = frame();
    const a = node(rect());
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.end();
    a.node.context = new GraphicsContext().circle(0, 0, 3).fill(0x123456);
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    const { u, f: fl } = instances(only(f.end(), GfxOp.GFX_SHAPE_UPLOAD)[0]);
    expect(u[GS_FLAGS >> 2] & 0xf).toBe(GfxShapeKind.ELLIPSE);
    expect(fl[GS_HALF_W >> 2]).toBe(3);
  });
});

// ─── context sharing ─────────────────────────────────────────────────────────

describe('context sharing', () => {
  const star = (): GraphicsContext =>
    new GraphicsContext().star(0, 0, 5, 10).fill(0xffcc00);

  it('one mesh per renderer: each renderer uploads it under its own id', () => {
    const ctx = star();
    const f1 = frame();
    const f2 = frame();
    const a = node(ctx);
    const b = node(ctx);
    a.binding.emitDraw(f1, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f2, W, at(1, 0, 0), 1);
    const u1 = only(f1.end(), GfxOp.GFX_MESH_UPLOAD);
    const u2 = only(f2.end(), GfxOp.GFX_MESH_UPLOAD);
    expect(u1.length).toBe(1);
    expect(u2.length).toBe(1);
    expect(u1[0].words[0]).not.toBe(u2[0].words[0]);
    // Steady state: no re-upload on either renderer.
    a.binding.emitDraw(f1, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f2, W, at(1, 0, 0), 1);
    expect(only(f1.end(), GfxOp.GFX_MESH_UPLOAD).length).toBe(0);
    expect(only(f2.end(), GfxOp.GFX_MESH_UPLOAD).length).toBe(0);
  });

  it('destroying one node leaves the shared context drawing for the others', () => {
    const f = frame();
    const ctx = star();
    const a = node(ctx);
    const b = node(ctx);
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    f.end();
    a.node.destroy();
    expect(ctx.destroyed).toBe(false);
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    const out = f.end();
    expect(only(out, GfxOp.GFX_DRAW_MESH).length).toBe(1);
    expect(only(out, GfxOp.GFX_MESH_DESTROY).length).toBe(0);
  });

  it('destroy({ context: true }) frees the mesh; other nodes then draw nothing', () => {
    const f = frame();
    const ctx = star();
    const a = node(ctx);
    const b = node(ctx);
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    const meshId = only(f.end(), GfxOp.GFX_MESH_UPLOAD)[0].words[0];
    a.node.destroy({ context: true });
    expect(ctx.destroyed).toBe(true);
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    const out = f.end();
    expect(only(out, GfxOp.GFX_DRAW_MESH).length).toBe(0);
    const destroys = only(out, GfxOp.GFX_MESH_DESTROY);
    expect(destroys.map(d => d.words[0])).toEqual([meshId]);
  });

  it('replacing an owned context destroys it; a passed one survives', () => {
    const own = new Graphics();
    const first = own.context;
    own.context = star();
    expect(first.destroyed).toBe(true);
    const shared = star();
    const g = new Graphics(shared);
    g.context = star();
    expect(shared.destroyed).toBe(false);
  });

  it('a recording call on any node records into the shared context', () => {
    const ctx = new GraphicsContext();
    const a = new Graphics(ctx);
    const b = new Graphics(ctx);
    const v = ctx.info.version;
    a.rect(0, 0, 1, 1);
    b.fill(0xff0000);
    expect(ctx.info.version).toBe(v + 2);
    expect(compile(ctx).ns).toBe(1);
  });
});

// ─── regressions ─────────────────────────────────────────────────────────────

describe('regressions', () => {
  it('a shape after closePath gets no point from the closed sub-path', () => {
    const b = flatten(
      new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(10, 0)
        .lineTo(10, 10)
        .closePath()
        .rect(20, 20, 5, 5),
    );
    expect(b.sn).toBe(2);
    expect(points(b, 1)).toEqual([
      [20, 20],
      [25, 20],
      [25, 25],
      [20, 25],
    ]);
    // A line after the shape still starts at its own point.
    const c = flatten(
      new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(10, 0)
        .closePath()
        .circle(50, 50, 5)
        .lineTo(70, 70)
        .lineTo(80, 70),
    );
    expect(points(c, c.sn - 1)).toEqual([
      [70, 70],
      [80, 70],
    ]);
  });

  it('a full-turn arc after moveTo strokes the whole ring (no gap)', () => {
    const style = { width: 2 };
    const ring = tess(
      new GraphicsContext({ sdf: false }).circle(0, 0, 10).stroke(style),
    );
    const arc = tess(
      new GraphicsContext()
        .moveTo(10, 0)
        .arc(0, 0, 10, 0, 2 * Math.PI)
        .stroke(style),
    );
    expect(meshArea(arc.mesh!)).toBeCloseTo(meshArea(ring.mesh!), 1);
    // The open arc ends exactly on its first point; a closed ring has no
    // duplicate closing point.
    const open = flatten(new GraphicsContext().arc(0, 0, 10, 0, -2 * Math.PI));
    const p = points(open, 0);
    expect(p[p.length - 1]).toEqual(p[0]);
    const closed = flatten(new GraphicsContext().circle(0, 0, 10));
    const q = points(closed, 0);
    expect(q[q.length - 1]).not.toEqual(q[0]);
    expect(closed.closed[0]).toBe(1);
  });

  it('nodes sharing a context at two scale buckets in one frame draw the final mesh ranges', () => {
    const f = frame();
    const ctx = new GraphicsContext()
      .moveTo(0, 0)
      .quadraticCurveTo(50, 80, 100, 0)
      .stroke({ width: 2 });
    const a = node(ctx);
    const b = node(ctx);
    const run = (): Recorded[] => {
      a.binding.emitDraw(f, W, at(0, 0, 0, 1), 1);
      b.binding.emitDraw(f, W, at(1, 0, 0, 8), 1);
      return f.end();
    };
    let out = run();
    const c = compile(ctx);
    // The core runs every upload before any draw, so every draw of the
    // frame reads the mesh uploaded last.
    const check = (list: Recorded[]): void => {
      expect(only(list, GfxOp.GFX_MESH_UPLOAD)).toHaveLength(1);
      const draws = only(list, GfxOp.GFX_DRAW_MESH);
      expect(draws.length).toBeGreaterThan(0);
      for (const d of draws) {
        expect(d.words[2]).toBe(c.parts[0 * PART + PT_INDICES]);
      }
    };
    check(out);
    const coarse = c.parts[0 * PART + PT_INDICES];
    // The larger bucket is tessellated on the next frame, once.
    out = run();
    check(out);
    expect(c.meshScale).toBe(8);
    expect(c.parts[0 * PART + PT_INDICES]).toBeGreaterThan(coarse);
    out = run();
    expect(only(out, GfxOp.GFX_MESH_UPLOAD)).toHaveLength(0);
  });

  it('a paint with no current path does not grow the bounds', () => {
    const ctx = new GraphicsContext().rect(0, 0, 10, 10).fill(0).clear();
    ctx.fill(0);
    expect(ctx.bounds.minX).toBeGreaterThan(ctx.bounds.maxX);
    const cut = new GraphicsContext()
      .rect(0, 0, 10, 10)
      .fill(0)
      .circle(500, 500, 5)
      .cut()
      .fill(0);
    expect(cut.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });
});

// ─── known defects ───────────────────────────────────────────────────────────

describe('known defects', () => {
  it.failing('bounds include miter tips of a stroke', () => {
    const ctx = new GraphicsContext()
      .poly([0, 0, 100, 0, 50, 20])
      .stroke({ width: 10 });
    const m = meshBounds(tess(ctx).mesh!);
    const b = ctx.bounds;
    expect(b.minX).toBeLessThanOrEqual(m[0]);
    expect(b.maxX).toBeGreaterThanOrEqual(m[2]);
  });
});
