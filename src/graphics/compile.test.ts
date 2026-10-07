/**
 * Recording (ARCHITECTURE §26.2) and classification (§26.3): what a context
 * records, and which paints become SDF instances, mesh jobs and parts.
 */
import {
  GFX_DRAW_MESH_BYTES,
  GFX_DRAW_MESH_COUNT_WORD,
  GFX_DRAW_SHAPES_BYTES,
  GFX_DRAW_SHAPES_COUNT_WORD,
} from '../commands/gfxOpcodes';
import { toPackedColor } from '../math/color';
import type { TextureHandle } from '../scene/types';
import {
  GFX_KIND_MASK,
  GFX_SHAPE_F32_PER,
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_H,
  GS_HALF_W,
  GS_P0,
  GS_P1,
  GS_RESERVED,
  GS_STROKE,
  GS_STROKE_IN,
  GS_STROKE_OUT,
  GfxShapeFlag,
  GfxShapeKind,
} from '../types/gfxLayouts';
import type { Compiled } from './compile';
import { JOB, PART, PART_MESH, PART_SDF, PART_TEX, compile } from './compile';
import * as F from './compileFormat';
import { GraphicsContext } from './GraphicsContext';

const tex = {
  sourceId: 3,
  sourceWidth: 64,
  sourceHeight: 64,
  frame: { x: 0, y: 0, width: 64, height: 64 },
  width: 64,
  height: 64,
} as unknown as TextureHandle;

/** Field `byteOffset` of SDF instance `i`. */
function f(c: Compiled, i: number, byteOffset: number): number {
  return c.sf[i * GFX_SHAPE_F32_PER + (byteOffset >> 2)];
}
function u(c: Compiled, i: number, byteOffset: number): number {
  return c.su[i * GFX_SHAPE_F32_PER + (byteOffset >> 2)];
}
function kind(c: Compiled, i: number): number {
  return u(c, i, GS_FLAGS) & 0xf;
}
function partTypes(c: Compiled): number[] {
  const out: number[] = [];
  for (let p = 0; p < c.np; p++) out.push(c.parts[p * PART]);
  return out;
}

describe('format constants', () => {
  it('match gfxLayouts.ts and gfxOpcodes.ts', () => {
    expect(F.SHAPE_WORDS).toBe(GFX_SHAPE_F32_PER);
    expect(F.W_HALF_H).toBe(GS_HALF_H >> 2);
    expect(F.W_P0).toBe(GS_P0 >> 2);
    expect(F.W_P1).toBe(GS_P1 >> 2);
    expect(F.W_STROKE_OUT).toBe(GS_STROKE_OUT >> 2);
    expect(F.W_RESERVED).toBe(GS_RESERVED >> 2);
    expect(F.KIND_MASK).toBe(GFX_KIND_MASK);
    expect([F.K_RECT, F.K_ELLIPSE, F.K_SEGMENT, F.K_ARC]).toEqual([
      GfxShapeKind.RECT,
      GfxShapeKind.ELLIPSE,
      GfxShapeKind.SEGMENT,
      GfxShapeKind.ARC,
    ]);
    expect(F.F_CAP_ROUND).toBe(GfxShapeFlag.CAP_ROUND);
    expect(F.F_CAP_SQUARE).toBe(GfxShapeFlag.CAP_SQUARE);
    expect(F.F_JOIN_ROUND).toBe(GfxShapeFlag.JOIN_ROUND);
    expect(F.F_JOIN_BEVEL).toBe(GfxShapeFlag.JOIN_BEVEL);
    expect(F.F_PIXEL_LINE).toBe(GfxShapeFlag.PIXEL_LINE);
    expect(F.F_FILL).toBe(GfxShapeFlag.FILL);
    expect(F.DRAW_SHAPES_BYTES).toBe(GFX_DRAW_SHAPES_BYTES);
    expect(F.DRAW_MESH_BYTES).toBe(GFX_DRAW_MESH_BYTES);
    expect(F.SHAPES_COUNT_WORD).toBe(GFX_DRAW_SHAPES_COUNT_WORD);
    expect(F.MESH_COUNT_WORD).toBe(GFX_DRAW_MESH_COUNT_WORD);
  });

  it('GraphicsContext writes the opcodes and counts of compileFormat', () => {
    const ctx = new GraphicsContext()
      .moveTo(0, 0)
      .lineTo(1, 1)
      .quadraticCurveTo(1, 2, 3, 4)
      .bezierCurveTo(1, 2, 3, 4, 5, 6)
      .arc(0, 0, 1, 0, 1)
      .arcTo(1, 1, 2, 2, 1)
      .closePath()
      .rect(0, 0, 1, 1)
      .roundRect(0, 0, 1, 1, 0.5)
      .ellipse(0, 0, 1, 2)
      .poly([0, 0, 1, 0, 1, 1])
      .fill(0xff0000)
      .stroke(0x00ff00)
      .cut()
      .beginPath()
      .translate(1, 2)
      .rect(0, 0, 1, 1);
    expect(Array.from(ctx._o.subarray(0, ctx._on))).toEqual([
      F.G_MOVE,
      F.G_LINE,
      F.G_QUAD,
      F.G_CUBIC,
      F.G_ARC,
      F.G_ARC_TO,
      F.G_CLOSE,
      F.G_RECT,
      F.G_RRECT,
      F.G_ELLIPSE,
      F.G_POLY,
      F.G_FILL,
      F.G_STROKE,
      F.G_CUT,
      F.G_BEGIN,
      F.G_XFORM,
      F.G_RECT,
    ]);
    let n = 0;
    for (let i = 0; i < ctx._on; i++) {
      const op = ctx._o[i];
      n += op === F.G_POLY ? 2 + 2 * ctx._a[n] : F.G_ARGS[op];
    }
    expect(n).toBe(ctx._an);
    expect(F.P_SIZE).toBe(16);
  });
});

describe('GraphicsContext recording', () => {
  it('bumps version on every call, including clear and transforms', () => {
    const ctx = new GraphicsContext();
    const v0 = ctx.info.version;
    ctx.rect(0, 0, 1, 1);
    const v1 = ctx.info.version;
    ctx.fill(0xffffff);
    ctx.translate(1, 1);
    ctx.clear();
    expect(v1).toBeGreaterThan(v0);
    expect(ctx.info.version).toBeGreaterThan(v1 + 2);
  });

  it('resolves colours and styles at record time', () => {
    const ctx = new GraphicsContext()
      .rect(0, 0, 1, 1)
      .fill('#ff000080', 0.5)
      .stroke({
        color: 0x00ff00,
        alpha: 0.5,
        width: 3,
        join: 'round',
        cap: 'square',
        alignment: 1,
        pixelLine: true,
        miterLimit: 4,
      });
    const fill = ctx._an - 32;
    const stroke = ctx._an - 16;
    expect(ctx._a[fill + F.P_COLOR]).toBe(toPackedColor('#ff000080', 0.5));
    expect(ctx._a[fill + F.P_WIDTH]).toBe(1);
    expect(ctx._a[stroke + F.P_COLOR]).toBe(toPackedColor(0x00ff00, 0.5));
    expect(ctx._a[stroke + F.P_WIDTH]).toBe(3);
    expect(ctx._a[stroke + F.P_JOIN]).toBe(1);
    expect(ctx._a[stroke + F.P_CAP]).toBe(2);
    expect(ctx._a[stroke + F.P_ALIGN]).toBe(1);
    expect(ctx._a[stroke + F.P_PIXEL]).toBe(1);
    expect(ctx._a[stroke + F.P_MITER]).toBe(4);
    expect(() => ctx.fill('nope')).toThrow();
  });

  it('fill() / stroke() with no argument use setFillStyle / setStrokeStyle, saved by save/restore', () => {
    const ctx = new GraphicsContext()
      .setFillStyle(0x123456)
      .save()
      .setFillStyle({ color: 0xabcdef, texture: tex });
    ctx.rect(0, 0, 1, 1).fill();
    expect(ctx._a[ctx._an - 16 + F.P_COLOR]).toBe(toPackedColor(0xabcdef));
    expect(ctx._a[ctx._an - 16 + F.P_TEX]).toBe(0);
    expect(ctx._tex[0]).toBe(tex);
    ctx.restore().rect(0, 0, 1, 1).fill();
    expect(ctx._a[ctx._an - 16 + F.P_COLOR]).toBe(toPackedColor(0x123456));
    expect(ctx._a[ctx._an - 16 + F.P_TEX]).toBe(-1);
  });

  it('records the transform lazily, before the next path call', () => {
    const ctx = new GraphicsContext()
      .translate(5, 0)
      .scale(2)
      .rotate(1)
      .translate(1, 1);
    expect(ctx._on).toBe(0);
    ctx.circle(0, 0, 1);
    expect(ctx._o[0]).toBe(F.G_XFORM);
    // Canvas order: translate(5,0) · scale(2) · rotate(1) · translate(1,1).
    const c = Math.cos(1);
    const s = Math.sin(1);
    const expected = [
      2 * c,
      2 * s,
      -2 * s,
      2 * c,
      5 + 2 * (c - s),
      2 * (s + c),
    ];
    for (let i = 0; i < 6; i++) expect(ctx._a[i]).toBeCloseTo(expected[i], 12);
    ctx.circle(0, 0, 1);
    expect(ctx._o[2]).toBe(F.G_ELLIPSE); // no second transform
  });

  it('resolves arc sweeps like canvas', () => {
    const sweep = (a: number, b: number, ccw?: boolean): number =>
      new GraphicsContext().arc(0, 0, 1, a, b, ccw)._a[4];
    expect(sweep(0, Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(sweep(0, -Math.PI / 2)).toBeCloseTo(1.5 * Math.PI, 12);
    expect(sweep(0, Math.PI / 2, true)).toBeCloseTo(-1.5 * Math.PI, 12);
    expect(sweep(0, 7)).toBeCloseTo(2 * Math.PI, 12);
    expect(sweep(0, -7, true)).toBeCloseTo(-2 * Math.PI, 12);
    expect(sweep(1, 1)).toBe(0);
  });

  it('computes bounds from painted paths, strokes included, in context space', () => {
    const ctx = new GraphicsContext();
    expect(ctx.bounds.minX).toBeGreaterThan(ctx.bounds.maxX);
    ctx.rect(10, 20, 30, 40).fill(0);
    expect(ctx.bounds).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
    ctx.circle(100, 0, 10).stroke({ width: 4 });
    expect(ctx.bounds).toEqual({ minX: 10, minY: -12, maxX: 112, maxY: 60 });
    // Unpainted and dropped paths do not count.
    ctx.rect(-500, -500, 1, 1).beginPath().fill();
    expect(ctx.bounds.minX).toBe(10);
    ctx.translate(1000, 0).rect(0, 0, 1, 1).fill();
    expect(ctx.bounds.maxX).toBe(1001);
    ctx.clear();
    expect(ctx.bounds.minX).toBe(Infinity);
  });

  it('builds regular polygons and stars pointing up', () => {
    const ctx = new GraphicsContext()
      .regularPoly(0, 0, 10, 4)
      .star(0, 0, 5, 10, 4, 0);
    expect(ctx._a[0]).toBe(4);
    expect(ctx._a[2]).toBeCloseTo(0, 12);
    expect(ctx._a[3]).toBeCloseTo(-10, 12);
    const s = 2 + 8;
    expect(ctx._a[s]).toBe(10);
    expect(Math.hypot(ctx._a[s + 4], ctx._a[s + 5])).toBeCloseTo(4, 12);
  });

  it('keeps its arrays across clear() (redraw every frame without allocation)', () => {
    const ctx = new GraphicsContext();
    for (let i = 0; i < 200; i++) ctx.circle(i, 0, 1).fill(0xff0000);
    const ops = ctx._o;
    const args = ctx._a;
    ctx.clear();
    for (let i = 0; i < 200; i++) ctx.circle(i, 0, 1).fill(0xff0000);
    expect(ctx._o).toBe(ops);
    expect(ctx._a).toBe(args);
  });

  it('accepts point objects in poly()', () => {
    const ctx = new GraphicsContext().poly([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 0 },
    ]);
    expect(Array.from(ctx._a.subarray(0, 8))).toEqual([3, 1, 1, 2, 3, 4, 5, 0]);
  });
});

describe('classification (§26.3)', () => {
  it('a filled rect is one SDF RECT instance; nothing else', () => {
    const c = compile(
      new GraphicsContext().rect(10, 20, 30, 40).fill(0xff0000),
    );
    expect(c.ns).toBe(1);
    expect(c.nj).toBe(0);
    expect(partTypes(c)).toEqual([PART_SDF]);
    expect(kind(c, 0)).toBe(GfxShapeKind.RECT);
    expect(f(c, 0, GS_HALF_W)).toBe(15);
    expect(f(c, 0, GS_HALF_H)).toBe(20);
    expect(f(c, 0, GS_A + 16)).toBe(25); // tx = centre
    expect(f(c, 0, GS_A + 20)).toBe(40);
    expect(u(c, 0, GS_FILL)).toBe(toPackedColor(0xff0000));
    expect(u(c, 0, GS_STROKE)).toBe(0);
    expect(f(c, 0, GS_STROKE_IN) + f(c, 0, GS_STROKE_OUT)).toBe(0);
  });

  it('fill then stroke of one SDF path is ONE instance with both colours', () => {
    const c = compile(
      new GraphicsContext()
        .roundRect(0, 0, 100, 50, 8)
        .fill(0x111111)
        .stroke({ width: 4, color: 0x222222 }),
    );
    expect(c.ns).toBe(1);
    expect(f(c, 0, GS_P0)).toBe(8);
    expect(u(c, 0, GS_FILL)).toBe(toPackedColor(0x111111));
    expect(u(c, 0, GS_STROKE)).toBe(toPackedColor(0x222222));
    expect(f(c, 0, GS_STROKE_IN)).toBe(2);
    expect(f(c, 0, GS_STROKE_OUT)).toBe(2);
  });

  it('flags the fill region (GfxShapeFlag.FILL), even at alpha 0, for picking and masks', () => {
    const c = compile(
      new GraphicsContext()
        .rect(0, 0, 10, 10)
        .fill({ color: 0xffffff, alpha: 0 })
        .stroke({ width: 2, color: 0x222222 })
        .circle(0, 0, 5)
        .stroke(0x222222)
        .moveTo(0, 0)
        .lineTo(5, 5)
        .stroke(0x222222),
    );
    expect(c.ns).toBe(3);
    expect(u(c, 0, GS_FLAGS) & GfxShapeFlag.FILL).toBeTruthy();
    expect(u(c, 1, GS_FLAGS) & GfxShapeFlag.FILL).toBe(0);
    expect(u(c, 2, GS_FLAGS) & GfxShapeFlag.FILL).toBe(0);
  });

  it('stroke then fill stays two instances (painter order)', () => {
    const c = compile(
      new GraphicsContext().circle(0, 0, 10).stroke(0x222222).fill(0x111111),
    );
    expect(c.ns).toBe(2);
    expect(u(c, 0, GS_FILL)).toBe(0);
    expect(u(c, 1, GS_STROKE)).toBe(0);
    expect(partTypes(c)).toEqual([PART_SDF]);
  });

  it('circles and ellipses are ELLIPSE with their radii', () => {
    const c = compile(
      new GraphicsContext()
        .circle(5, 5, 10)
        .fill(0)
        .ellipse(0, 0, 20, 10)
        .fill(0),
    );
    expect(kind(c, 0)).toBe(GfxShapeKind.ELLIPSE);
    expect([f(c, 0, GS_HALF_W), f(c, 0, GS_HALF_H)]).toEqual([10, 10]);
    expect([f(c, 1, GS_HALF_W), f(c, 1, GS_HALF_H)]).toEqual([20, 10]);
  });

  it('moveTo + lineTo stroke is a SEGMENT along x; its fill is empty', () => {
    const c = compile(
      new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(0, 10)
        .fill(0xffffff)
        .stroke({ width: 2, cap: 'round' }),
    );
    expect(c.ns).toBe(1);
    expect(c.nj).toBe(0);
    expect(kind(c, 0)).toBe(GfxShapeKind.SEGMENT);
    expect(f(c, 0, GS_HALF_W)).toBe(5);
    expect(f(c, 0, GS_HALF_H)).toBe(1);
    // Rotated 90°: shape x axis = context y axis.
    expect(f(c, 0, GS_A)).toBeCloseTo(0, 12);
    expect(f(c, 0, GS_A + 4)).toBeCloseTo(1, 6);
    expect(f(c, 0, GS_A + 16)).toBe(0);
    expect(f(c, 0, GS_A + 20)).toBe(5);
    expect(u(c, 0, GS_FLAGS) & GfxShapeFlag.CAP_ROUND).toBeTruthy();
  });

  it('a lone arc stroke is an ARC; a filled arc is a mesh', () => {
    const c = compile(
      new GraphicsContext().arc(0, 0, 10, 0, Math.PI).stroke({ width: 2 }),
    );
    expect(kind(c, 0)).toBe(GfxShapeKind.ARC);
    expect(f(c, 0, GS_P0)).toBe(0);
    expect(f(c, 0, GS_P1)).toBeCloseTo(Math.PI, 6);
    expect(f(c, 0, GS_STROKE_IN)).toBe(1);
    const m = compile(new GraphicsContext().arc(0, 0, 10, 0, Math.PI).fill(0));
    expect(m.ns).toBe(0);
    expect(m.nj).toBe(1);
  });

  it('polygons, stars, curves, mixed sub-paths and holes take the mesh path', () => {
    const cases = [
      new GraphicsContext().poly([0, 0, 10, 0, 5, 5]).fill(0),
      new GraphicsContext().star(0, 0, 5, 10).fill(0),
      new GraphicsContext()
        .moveTo(0, 0)
        .quadraticCurveTo(5, 5, 10, 0)
        .stroke(0),
      new GraphicsContext().moveTo(0, 0).lineTo(5, 5).lineTo(10, 0).stroke(0),
      new GraphicsContext().rect(0, 0, 5, 5).circle(10, 10, 2).fill(0),
      new GraphicsContext().rect(0, 0, 50, 50).fill(0).circle(25, 25, 5).cut(),
      new GraphicsContext().arc(0, 0, 5, 0, 1).closePath().stroke(0),
    ];
    for (const ctx of cases) {
      const c = compile(ctx);
      expect(c.ns).toBe(0);
      expect(c.nj).toBeGreaterThan(0);
    }
  });

  it('a cut applies to the whole latest paint group (fill and stroke)', () => {
    const c = compile(
      new GraphicsContext()
        .rect(0, 0, 50, 50)
        .fill(0)
        .stroke(0)
        .circle(25, 25, 5)
        .cut()
        .circle(10, 10, 2)
        .cut(),
    );
    expect(c.nj).toBe(2);
    expect(c.nh).toBe(2);
    expect(c.jobs[6]).toBe(0); // first hole
    expect(c.jobs[7]).toBe(2); // hole count
    expect(c.jobs[JOB + 7]).toBe(2);
  });

  it('a cut right after a paint has no path and cuts nothing (Pixi)', () => {
    const c = compile(new GraphicsContext().rect(0, 0, 50, 50).fill(0).cut());
    expect(c.nh).toBe(0);
    expect(c.ns).toBe(1);
    // ...and the painted path cannot be painted again after it.
    expect(
      compile(new GraphicsContext().rect(0, 0, 5, 5).fill(0).cut().fill(0)).ns,
    ).toBe(1);
  });

  it('texture fills are mesh parts of their own; context.sdf=false meshes everything', () => {
    const t = compile(
      new GraphicsContext()
        .rect(0, 0, 10, 10)
        .fill({ texture: tex })
        .rect(20, 0, 10, 10)
        .fill({ texture: tex }),
    );
    expect(partTypes(t)).toEqual([PART_TEX, PART_TEX]);
    const m = compile(
      new GraphicsContext({ sdf: false })
        .rect(0, 0, 10, 10)
        .fill(0)
        .circle(0, 0, 5)
        .fill(0),
    );
    expect(m.ns).toBe(0);
    expect(partTypes(m)).toEqual([PART_MESH]);
    expect(m.parts[2]).toBe(2); // two jobs share the part
  });

  it('keeps painter order: SDF, mesh, SDF are three parts', () => {
    const c = compile(
      new GraphicsContext()
        .rect(0, 0, 10, 10)
        .fill(0)
        .circle(5, 5, 2)
        .fill(0)
        .poly([0, 0, 5, 0, 5, 5])
        .fill(0)
        .star(0, 0, 5, 5)
        .stroke(0)
        .rect(0, 0, 1, 1)
        .fill(0),
    );
    expect(partTypes(c)).toEqual([PART_SDF, PART_MESH, PART_SDF]);
    expect(Array.from(c.parts.subarray(0, 3))).toEqual([PART_SDF, 0, 2]);
    expect(Array.from(c.parts.subarray(PART, PART + 3))).toEqual([
      PART_MESH,
      0,
      2,
    ]);
    expect(Array.from(c.parts.subarray(2 * PART, 2 * PART + 3))).toEqual([
      PART_SDF,
      2,
      1,
    ]);
  });

  it('keeps transformed shapes SDF: the affine carries rotation and scale', () => {
    const c = compile(
      new GraphicsContext()
        .translate(100, 0)
        .rotate(Math.PI / 2)
        .scale(2)
        .rect(0, 0, 10, 4)
        .stroke({ width: 2 }),
    );
    expect(c.ns).toBe(1);
    expect(f(c, 0, GS_A)).toBeCloseTo(0, 6);
    expect(f(c, 0, GS_A + 4)).toBeCloseTo(2, 6);
    // Centre (5, 2) → scale 2 → rotate 90° → translate 100.
    expect(f(c, 0, GS_A + 16)).toBeCloseTo(100 - 4, 5);
    expect(f(c, 0, GS_A + 20)).toBeCloseTo(10, 5);
    // The stroke width does not scale with the recording transform.
    expect(f(c, 0, GS_STROKE_IN) * 2).toBeCloseTo(1, 6);
  });

  it('sets join, alignment and pixel-line flags', () => {
    const flags = (style: object): number =>
      u(
        compile(new GraphicsContext().rect(0, 0, 1, 1).stroke(style)),
        0,
        GS_FLAGS,
      );
    expect(flags({ join: 'round' }) & GfxShapeFlag.JOIN_ROUND).toBeTruthy();
    expect(flags({ join: 'bevel' }) & GfxShapeFlag.JOIN_BEVEL).toBeTruthy();
    expect(flags({ join: 'miter' }) & 0xf0).toBe(0);
    expect(
      flags({ join: 'miter', miterLimit: 1.2 }) & GfxShapeFlag.JOIN_BEVEL,
    ).toBeTruthy();
    expect(flags({ pixelLine: true }) & GfxShapeFlag.PIXEL_LINE).toBeTruthy();
    const inside = compile(
      new GraphicsContext().rect(0, 0, 1, 1).stroke({ width: 4, alignment: 1 }),
    );
    expect([f(inside, 0, GS_STROKE_IN), f(inside, 0, GS_STROKE_OUT)]).toEqual([
      4, 0,
    ]);
  });

  it('recompiles only when the version changed', () => {
    const ctx = new GraphicsContext().rect(0, 0, 1, 1).fill(0);
    const c = compile(ctx);
    const v = c.version;
    expect(compile(ctx)).toBe(c);
    expect(c.version).toBe(v);
    ctx.circle(0, 0, 1).fill(0);
    expect(compile(ctx).ns).toBe(2);
    expect(ctx.info.sdfShapes).toBe(2);
  });

  it('clear + redraw reuses the compiled arrays', () => {
    const ctx = new GraphicsContext();
    for (let i = 0; i < 300; i++) ctx.circle(i, 0, 1).fill(0);
    const c = compile(ctx);
    const sf = c.sf;
    ctx.clear();
    for (let i = 0; i < 300; i++) ctx.circle(i, 0, 1).fill(0);
    compile(ctx);
    expect(c.sf).toBe(sf);
    expect(c.ns).toBe(300);
  });

  it('maskRect: only one filled, sharp, unstroked, axis-aligned rect', () => {
    const out = new Float32Array(4);
    expect(
      compile(new GraphicsContext().rect(10, 20, 30, 40).fill(0)).rect(out),
    ).toBe(true);
    expect(Array.from(out)).toEqual([10, 20, 30, 40]);
    expect(
      compile(new GraphicsContext().scale(2).rect(10, 20, 30, 40).fill(0)).rect(
        out,
      ),
    ).toBe(true);
    expect(Array.from(out)).toEqual([20, 40, 60, 80]);
    const no = [
      new GraphicsContext().roundRect(0, 0, 1, 1, 0.2).fill(0),
      new GraphicsContext().rect(0, 0, 1, 1).fill(0).stroke(0),
      // Stroked only, in transparent black (packed colour 0).
      new GraphicsContext().rect(0, 0, 1, 1).stroke({ color: 0, alpha: 0 }),
      new GraphicsContext().rotate(0.3).rect(0, 0, 1, 1).fill(0),
      new GraphicsContext().rect(0, 0, 1, 1).fill(0).rect(2, 2, 1, 1).fill(0),
      new GraphicsContext().circle(0, 0, 1).fill(0),
      new GraphicsContext(),
    ];
    for (const ctx of no) expect(compile(ctx).rect(out)).toBe(false);
  });
});
