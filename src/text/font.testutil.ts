/**
 * A tiny monospaced font for the text unit tests: every metric is a round
 * number, so a layout assertion reads as arithmetic rather than as a golden
 * value. Node only; it never ships.
 */
import { Texture } from '../scene/Texture';
import type { TextureHandle } from '../scene/types';
import type { FontAsset, GlyphMetrics, GlyphSource, TextStyle } from './types';

export const FAKE_SIZE = 10;
export const FAKE_ADVANCE = 6;
export const FAKE_ASCENDER = 8;
export const FAKE_DESCENDER = -2;
export const FAKE_LINE_HEIGHT = 12;

/** Space and tab have an advance and no quad; everything else is a 6×10 box. */
export function fakeFont(kerning?: Map<string, number>): FontAsset {
  const page = Texture.fromPixels(64, 64, new Uint8Array(64 * 64 * 4));
  const cache = new Map<number, GlyphMetrics>();
  let next = 0;
  return {
    kind: 'msdf',
    family: 'fake',
    size: FAKE_SIZE,
    lineHeight: FAKE_LINE_HEIGHT,
    ascender: FAKE_ASCENDER,
    descender: FAKE_DESCENDER,
    distanceRange: 2,
    texture: page,
    glyph(code: number): GlyphMetrics | undefined {
      let metrics = cache.get(code);
      if (metrics !== undefined) return metrics;
      if (code === 10 || code === 13) return undefined;
      const blank = code === 32 || code === 9;
      let texture: TextureHandle | null = null;
      if (!blank) {
        const column = next++ % 10;
        const row = ((next - 1) / 10) | 0;
        texture = page.sub(column * 6, row * 10, 6, 10);
      }
      metrics = {
        code,
        advance: FAKE_ADVANCE,
        offsetX: 0,
        offsetY: -FAKE_ASCENDER,
        width: blank ? 0 : FAKE_ADVANCE,
        height: blank ? 0 : FAKE_SIZE,
        texture,
      };
      cache.set(code, metrics);
      return metrics;
    },
    kerning(left: number, right: number): number {
      return kerning?.get(`${left},${right}`) ?? 0;
    },
  };
}

export function fakeSource(font: FontAsset, instanceFlags = 0): GlyphSource {
  return {
    font,
    instanceFlags,
    glyph: code => font.glyph(code),
    ensure: () => null,
    destroy: () => {},
  };
}

export function fakeStyle(
  font: FontAsset,
  style?: Partial<TextStyle>,
): TextStyle {
  return { font, ...style };
}
