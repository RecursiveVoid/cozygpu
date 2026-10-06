/**
 * MSDF fonts (ARCHITECTURE §23.3): parsing the atlas JSON
 * (msdf-atlas-gen / msdfgen layout) into a `FontAsset`, and the glyph source
 * that hands the layout pass its metrics and sub-textures.
 *
 * Glyph sprites drawn from an MSDF page set `SpriteInstanceFlag.MSDF`, so the
 * sprite fragment shader turns the distance field into coverage with screen
 * space derivatives. Text therefore batches with ordinary sprites.
 *
 * This module is also what the asset loader's `kind: 'font'` reaches
 * (src/assets/font.ts), so a font is parsed exactly once per page.
 *
 * JSON shape (msdf-atlas-gen `-json`): `atlas` (type, distanceRange, size,
 * width, height, yOrigin), `metrics` (em-relative lineHeight / ascender /
 * descender), `glyphs` (unicode, advance, planeBounds, atlasBounds) and an
 * optional `kerning` list. Plane and metric values are em-relative and are
 * scaled here by `atlas.size` once, so everything a `FontAsset` exposes is in
 * px at that size. An optional `pages` array names the page image.
 */
import type { TextureHandle } from '../scene/types';
import { CozyGPUError } from '../types/errors';
import { SpriteInstanceFlag } from '../types/layouts';
import type { FontAsset, GlyphMetrics, GlyphSource, TextStyle } from './types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(message: string): never {
  throw new CozyGPUError('LOAD_FAILED', `msdf font: ${message}`);
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Page image URL named by the JSON, if any. `kind: 'font'` falls back to the
 * JSON's own URL with a `.png` extension when this returns null.
 */
export function msdfPageUrl(json: unknown): string | null {
  if (!isObject(json)) return null;
  const pages = json.pages;
  if (Array.isArray(pages) && typeof pages[0] === 'string') return pages[0];
  const atlas = json.atlas;
  if (isObject(atlas) && typeof atlas.image === 'string') return atlas.image;
  return null;
}

/** Kerning pairs pack into one safe integer (code points are < 0x110000). */
function kernKey(left: number, right: number): number {
  return left * 0x110000 + right;
}

class MsdfFont implements FontAsset {
  readonly kind = 'msdf';
  private readonly glyphs = new Map<number, GlyphMetrics>();
  private readonly kernings = new Map<number, number>();

  constructor(
    readonly family: string,
    readonly size: number,
    readonly lineHeight: number,
    readonly ascender: number,
    readonly descender: number,
    readonly distanceRange: number,
    readonly texture: TextureHandle,
  ) {}

  /** @internal */
  add(metrics: GlyphMetrics): void {
    this.glyphs.set(metrics.code, metrics);
  }

  /** @internal */
  addKerning(left: number, right: number, advance: number): void {
    this.kernings.set(kernKey(left, right), advance);
  }

  /** @internal Code points with a glyph (tests and tooling). */
  get glyphCount(): number {
    return this.glyphs.size;
  }

  glyph(code: number): GlyphMetrics | undefined {
    return this.glyphs.get(code);
  }

  kerning(left: number, right: number): number {
    return this.kernings.get(kernKey(left, right)) ?? 0;
  }
}

/** Parses an MSDF atlas JSON plus its already-loaded page texture. */
export function parseMsdfFont(json: unknown, page: TextureHandle): FontAsset {
  if (!isObject(json)) bad('not an object');
  const atlas = isObject(json.atlas) ? json.atlas : null;
  if (!atlas) bad('no "atlas" block');
  const size = num(atlas.size, 0);
  if (!(size > 0)) bad('atlas.size must be > 0');
  const pageHeight = num(atlas.height, page.height);
  const fromBottom = atlas.yOrigin !== 'top';
  const metrics = isObject(json.metrics) ? json.metrics : {};
  const emSize = num(metrics.emSize, 1) || 1;
  const k = size / emSize;

  const font = new MsdfFont(
    typeof json.name === 'string' ? json.name : 'msdf',
    size,
    num(metrics.lineHeight, 1.2) * k,
    num(metrics.ascender, 0.8) * k,
    num(metrics.descender, -0.2) * k,
    num(atlas.distanceRange, 2),
    page,
  );

  const list = json.glyphs;
  if (!Array.isArray(list)) bad('no "glyphs" array');
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (!isObject(g)) bad(`glyph ${i} is not an object`);
    const code = num(g.unicode ?? g.codepoint, -1);
    if (code < 0) bad(`glyph ${i} has no unicode`);
    const advance = num(g.advance, 0) * k;
    const plane = isObject(g.planeBounds) ? g.planeBounds : null;
    const rect = isObject(g.atlasBounds) ? g.atlasBounds : null;
    if (!plane || !rect) {
      // Whitespace: an advance and no quad.
      font.add({
        code,
        advance,
        offsetX: 0,
        offsetY: 0,
        width: 0,
        height: 0,
        texture: null,
      });
      continue;
    }
    const left = num(plane.left, 0);
    const right = num(plane.right, 0);
    const top = num(plane.top, 0);
    const bottom = num(plane.bottom, 0);
    const ax = num(rect.left, 0);
    const ay0 = num(rect.bottom, 0);
    const ay1 = num(rect.top, 0);
    const aw = num(rect.right, 0) - ax;
    const ah = Math.abs(ay1 - ay0);
    // planeBounds is y-up from the baseline; the scene is y-down.
    const y = fromBottom ? pageHeight - Math.max(ay0, ay1) : Math.min(ay0, ay1);
    if (!(aw > 0 && ah > 0)) bad(`glyph ${code} has an empty atlas rect`);
    font.add({
      code,
      advance,
      offsetX: left * k,
      offsetY: -top * k,
      width: (right - left) * k,
      height: (top - bottom) * k,
      texture: page.sub(ax, y, aw, ah),
    });
  }

  const kerning = json.kerning;
  if (Array.isArray(kerning)) {
    for (let i = 0; i < kerning.length; i++) {
      const entry = kerning[i];
      if (!isObject(entry)) continue;
      font.addKerning(
        num(entry.unicode1, -1),
        num(entry.unicode2, -1),
        num(entry.advance, 0) * k,
      );
    }
  }
  return font;
}

/**
 * One source per font asset: the metrics are immutable, so every `Text` using
 * the same font shares it and laying out allocates nothing here.
 */
const sources = new WeakMap<FontAsset, GlyphSource>();

export function createGlyphSource(style: TextStyle): GlyphSource {
  const font = style.font;
  if (!('glyph' in font)) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      'style.font is a system font descriptor; it needs the Canvas2D source',
    );
  }
  let source = sources.get(font);
  if (source === undefined) {
    source = {
      font,
      instanceFlags: SpriteInstanceFlag.MSDF,
      glyph: (code: number) => font.glyph(code),
      ensure: () => null,
      destroy: () => {},
    };
    sources.set(font, source);
  }
  return source;
}
