/**
 * Canvas2D glyph atlas (ARCHITECTURE §23.5): rasterisation metrics, skyline
 * packing across pages, and the texture provider that hands the page to a
 * renderer. Node has no canvas, so the module's own seam is faked here.
 */
import { Op } from '../commands/opcodes';
import type { Texture } from '../scene/Texture';
import type { FrontFrame } from '../types/core';
import { canvas2d, createGlyphSource } from './canvas';
import type { TextureProvider } from '../scene/types';

interface FakeMetrics {
  width: number;
  actualBoundingBoxLeft: number;
  actualBoundingBoxRight: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
}

const draws: { text: string; x: number; y: number }[] = [];
const snapshots: { x: number; y: number; width: number; height: number }[] = [];
let surfaces = 0;

function fakeContext(): unknown {
  return {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    clearRect(): void {},
    fillText(text: string, x: number, y: number): void {
      draws.push({ text, x, y });
    },
    measureText(text: string): FakeMetrics {
      // A 10 px monospace-ish font: ink is 8 px wide, 12 px tall, 2 px in.
      const blank = text === ' ';
      return {
        width: 10,
        actualBoundingBoxLeft: -2,
        actualBoundingBoxRight: blank ? -2 : 10,
        actualBoundingBoxAscent: blank ? 0 : 12,
        actualBoundingBoxDescent: blank ? 0 : 0,
        fontBoundingBoxAscent: 16,
        fontBoundingBoxDescent: 4,
      };
    },
  };
}

function fakeFrame(): {
  frame: FrontFrame;
  ops: { op: number; words: number[] }[];
} {
  const ops: { op: number; words: number[] }[] = [];
  let current: { op: number; words: number[] } | null = null;
  const encoder = {
    begin(op: number): number {
      current = { op, words: [] };
      return 0;
    },
    u32(value: number): void {
      current?.words.push(value);
    },
    end(): void {
      if (current !== null) ops.push(current);
      current = null;
    },
    addObject(): number {
      return 7;
    },
  };
  const frame = {
    rendererId: 1,
    generation: 1,
    frameId: 1,
    encoder,
  } as unknown as FrontFrame;
  return { frame, ops };
}

function providerOf(source: { font: { texture: unknown } }): TextureProvider {
  const provider = (source.font.texture as Texture)._source.provider;
  if (provider === null) throw new Error('no provider');
  return provider;
}

beforeEach(() => {
  draws.length = 0;
  snapshots.length = 0;
  surfaces = 0;
  canvas2d.create = (size: number): never => {
    surfaces++;
    return {
      width: size,
      height: size,
      getContext: () => fakeContext(),
    } as never;
  };
  canvas2d.snapshot = (
    _surface: never,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<ImageBitmap> => {
    snapshots.push({ x, y, width, height });
    return Promise.resolve({ width, height, close(): void {} } as ImageBitmap);
  };
});

let family = 0;
function uniqueFamily(): string {
  return `Fake${family++}`;
}

describe('the Canvas2D glyph source', () => {
  it('reads the font box from the context and needs no flag', () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    expect(source.instanceFlags).toBe(0);
    expect(source.font.kind).toBe('canvas');
    expect(source.font.ascender).toBe(16);
    expect(source.font.descender).toBe(-4);
    expect(source.font.lineHeight).toBe(20);
    expect(source.font.size).toBe(64);
    expect(surfaces).toBe(1);
  });

  it('rasterises a glyph once and hands back its quad', async () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    expect(source.glyph(65)).toBeUndefined();
    await source.ensure('AA');
    const glyph = source.glyph(65);
    expect(glyph?.advance).toBe(10);
    // ink: left -(-2) = 2 right of the pen, 12 px above the baseline.
    expect(glyph?.offsetX).toBe(2);
    expect(glyph?.offsetY).toBe(-12);
    expect(glyph?.width).toBe(8);
    expect(glyph?.height).toBe(12);
    expect(glyph?.texture?.frame.width).toBe(8);
    // 'A' twice draws once.
    expect(draws).toHaveLength(1);
    expect(draws[0].text).toBe('A');
    expect(snapshots).toHaveLength(1);
  });

  it('packs glyphs side by side and never returns pending work twice', async () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    await source.ensure('AB');
    const a = source.glyph(65)?.texture?.frame;
    const b = source.glyph(66)?.texture?.frame;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toEqual(b);
    // The skyline packer keeps a one-texel gutter between neighbours.
    expect(Math.abs((b?.x ?? 0) - (a?.x ?? 0))).toBeGreaterThanOrEqual(
      (a?.width ?? 0) + 2,
    );
    draws.length = 0;
    await source.ensure('AB');
    expect(draws).toHaveLength(0);
  });

  it('records whitespace as an advance with no quad', async () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    await source.ensure(' ');
    expect(source.glyph(32)?.texture).toBeNull();
    expect(source.glyph(32)?.advance).toBe(10);
    expect(draws).toHaveLength(0);
  });

  it('handles astral code points as one glyph', async () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    await source.ensure('\u{1f389}');
    expect(draws).toHaveLength(1);
    expect(draws[0].text).toBe('\u{1f389}');
    expect(source.glyph(0x1f389)).toBeDefined();
  });

  it('shares one source per descriptor and one per atlas size', () => {
    const name = uniqueFamily();
    expect(createGlyphSource({ font: { family: name } })).toBe(
      createGlyphSource({ font: { family: name } }),
    );
    expect(
      createGlyphSource({ font: { family: name, atlasSize: 32 } }),
    ).not.toBe(createGlyphSource({ font: { family: name } }));
  });

  it('refuses a loaded font asset', () => {
    const asset = {
      glyph: () => undefined,
      kerning: () => 0,
    } as never;
    expect(() => createGlyphSource({ font: asset })).toThrow(/MSDF/);
  });

  it('creates the page and uploads it whole before serving regions', async () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    await source.ensure('A');
    const provider = providerOf(source);

    // First frame: the page snapshot is not ready yet, so nothing is drawn.
    const first = fakeFrame();
    expect(provider.upload(first.frame)).toBe(false);
    expect(first.ops).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();

    const second = fakeFrame();
    expect(provider.upload(second.frame)).toBe(true);
    expect(second.ops.map(o => o.op)).toEqual([
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
    ]);
    expect(second.ops[0].words[1]).toBe(1024);

    // A new glyph afterwards travels as a region at its packed position.
    await source.ensure('B');
    const third = fakeFrame();
    expect(provider.upload(third.frame)).toBe(true);
    expect(third.ops.map(o => o.op)).toEqual([Op.TEXTURE_UPLOAD_BITMAP_REGION]);
    const frame = source.glyph(66)?.texture?.frame;
    expect(third.ops[0].words[2]).toBe(frame?.x);
    expect(third.ops[0].words[3]).toBe(frame?.y);
  });

  it('re-uploads the whole page after a device restore', async () => {
    const source = createGlyphSource({ font: { family: uniqueFamily() } });
    await source.ensure('A');
    const provider = providerOf(source);
    provider.upload(fakeFrame().frame);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.upload(fakeFrame().frame)).toBe(true);

    const restored = fakeFrame();
    (restored.frame as { generation: number }).generation = 2;
    expect(provider.upload(restored.frame)).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    const again = fakeFrame();
    (again.frame as { generation: number }).generation = 2;
    expect(provider.upload(again.frame)).toBe(true);
    expect(again.ops.map(o => o.op)).toEqual([
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
    ]);
  });
});
