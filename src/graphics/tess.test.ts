/**
 * Mesh building (ARCHITECTURE §26.4): fills with holes, strokes, textured
 * uv mapping and the scale dependence that drives re-tessellation.
 */
import { toPackedColor } from '../math/color';
import type { TextureHandle } from '../scene/types';
import { PART, PT_INDEX, PT_INDICES, compile } from './compile';
import { GraphicsContext } from './GraphicsContext';
import { tessellate } from './tess';
import { trianglesArea } from './frame.testutil';

function mesh(ctx: GraphicsContext, scale = 1) {
  const c = compile(ctx);
  tessellate(ctx, c, scale);
  const m = c.mesh!;
  const xy: number[] = [];
  for (let i = 0; i < m.vn; i++) xy.push(m.vf[3 * i], m.vf[3 * i + 1]);
  return { c, m, xy, area: trianglesArea(xy, m.i, m.in) };
}

function expectUv(c: { uv: Float32Array }, p: number[], uv: number[]): void {
  const [x, y] = p;
  expect(c.uv[0] * x + c.uv[2] * y + c.uv[4]).toBeCloseTo(uv[0], 6);
  expect(c.uv[1] * x + c.uv[3] * y + c.uv[5]).toBeCloseTo(uv[1], 6);
}

describe('tessellate', () => {
  it('fills a polygon with its colour baked into the vertices', () => {
    const { c, m, area } = mesh(
      new GraphicsContext()
        .poly([0, 0, 100, 0, 100, 50])
        .fill({ color: 0x0000ff, alpha: 0.5 }),
    );
    expect(m.vn).toBe(3);
    expect(m.in).toBe(3);
    expect(area).toBeCloseTo(2500, 6);
    expect(m.vu[2]).toBe(toPackedColor(0x0000ff, 0.5));
    expect(c.parts[PT_INDEX]).toBe(0);
    expect(c.parts[PT_INDICES]).toBe(3);
  });

  it('cuts holes out of the fill of the latest group', () => {
    const ctx = new GraphicsContext()
      .rect(0, 0, 100, 100)
      .fill(0)
      .rect(25, 25, 50, 50)
      .cut();
    const { area } = mesh(ctx);
    expect(area).toBeCloseTo(10000 - 2500, 6);
    expect(ctx.info.meshTriangles).toBe(8);
  });

  it('strokes hole outlines of a stroked group', () => {
    const { area } = mesh(
      new GraphicsContext()
        .rect(0, 0, 100, 100)
        .stroke({ width: 2 })
        .rect(25, 25, 50, 50)
        .cut(),
    );
    expect(area).toBeCloseTo(102 * 102 - 98 * 98 + 52 * 52 - 48 * 48, 6);
  });

  it('puts every mesh part in one buffer with its own index range', () => {
    const ctx = new GraphicsContext()
      .poly([0, 0, 10, 0, 10, 10])
      .fill(0)
      .rect(0, 0, 1, 1)
      .fill(0)
      .poly([0, 0, 10, 0, 10, 10, 0, 10])
      .fill(0);
    const { c } = mesh(ctx);
    expect(c.np).toBe(3);
    expect([c.parts[PT_INDEX], c.parts[PT_INDICES]]).toEqual([0, 3]);
    expect([
      c.parts[2 * PART + PT_INDEX],
      c.parts[2 * PART + PT_INDICES],
    ]).toEqual([3, 6]);
  });

  it('marks curves, round joins and pixel lines as scale dependent; polygons are not', () => {
    expect(
      mesh(new GraphicsContext().poly([0, 0, 10, 0, 5, 5]).fill(0)).c.dep,
    ).toBe(false);
    expect(
      mesh(new GraphicsContext().poly([0, 0, 10, 0, 5, 5]).stroke(0)).c.dep,
    ).toBe(false);
    expect(
      mesh(
        new GraphicsContext()
          .poly([0, 0, 10, 0, 5, 5])
          .stroke({ join: 'round' }),
      ).c.dep,
    ).toBe(true);
    expect(
      mesh(
        new GraphicsContext()
          .poly([0, 0, 10, 0, 5, 5])
          .stroke({ pixelLine: true }),
      ).c.dep,
    ).toBe(true);
    expect(
      mesh(
        new GraphicsContext()
          .moveTo(0, 0)
          .quadraticCurveTo(5, 5, 10, 0)
          .stroke(0),
      ).c.dep,
    ).toBe(true);
  });

  it('gets finer with the scale and resolves pixel lines at it', () => {
    const ctx = new GraphicsContext({ sdf: false }).circle(0, 0, 100).fill(0);
    const coarse = mesh(ctx, 1).m.vn;
    const fine = mesh(ctx, 8).m.vn;
    expect(fine).toBeGreaterThan(coarse);
    const line = new GraphicsContext()
      .poly([0, 0, 100, 0], false)
      .stroke({ width: 1, pixelLine: true });
    expect(mesh(line, 4).area).toBeCloseTo(100 / 4, 6);
  });

  it('keeps a u16 index copy below 65536 vertices', () => {
    const { c, m } = mesh(
      new GraphicsContext().poly([0, 0, 10, 0, 10, 10]).fill(0),
    );
    expect(Array.from(c.i16!.subarray(0, m.in))).toEqual(
      Array.from(m.i.subarray(0, m.in)),
    );
  });

  it('maps a texture over the path bounds (local) or one texel per unit (global)', () => {
    const t = {
      sourceWidth: 256,
      sourceHeight: 128,
      frame: { x: 64, y: 32, width: 64, height: 32 },
    } as unknown as TextureHandle;
    const local = mesh(
      new GraphicsContext()
        .poly([10, 20, 110, 20, 110, 70])
        .fill({ texture: t }),
    ).c;
    expectUv(local, [10, 20], [64 / 256, 32 / 128]);
    expectUv(local, [110, 70], [128 / 256, 64 / 128]);
    const global = mesh(
      new GraphicsContext()
        .poly([10, 20, 110, 20, 110, 70])
        .fill({ texture: t, textureSpace: 'global' }),
    ).c;
    expectUv(global, [0, 0], [64 / 256, 32 / 128]);
    expectUv(global, [16, 8], [80 / 256, 40 / 128]);
    // matrix: the texture is moved by (16, 8) in context space.
    const moved = mesh(
      new GraphicsContext().poly([10, 20, 110, 20, 110, 70]).fill({
        texture: t,
        textureSpace: 'global',
        matrix: [1, 0, 0, 1, 16, 8],
      }),
    ).c;
    expectUv(moved, [16, 8], [64 / 256, 32 / 128]);
  });
});
