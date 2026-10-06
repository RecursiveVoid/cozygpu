/**
 * Text public API (M3), implemented in src/text/**. Spec:
 * docs/ARCHITECTURE.md §23 and docs/API.md "Text".
 *
 * A `Text` is a Container whose children are glyph Sprites it owns. Glyph
 * quads are therefore ordinary sprite instances: they upload through the
 * sprite instance buffer, they batch with neighbouring sprites that use the
 * same atlas page, and picking, masks and filters work on them unchanged.
 *
 * Two glyph sources:
 *   MSDF (default)  a font atlas + metrics loaded through Assets
 *                   (`kind: 'font'`). Crisp at any size and rotation, one
 *                   page for a whole font, `SpriteInstanceFlag.MSDF` in the
 *                   sprite shader (§23.3).
 *   Canvas2D        any installed system font, emoji and scripts the MSDF
 *                   tool cannot pre-bake: glyphs are rasterised on demand
 *                   into an atlas page (§23.5). Front-side only; it uses
 *                   OffscreenCanvas when available, otherwise a canvas
 *                   element — never in core code.
 *
 * Layout (line breaking, alignment, spacing) runs on the front in both
 * renderer modes, so worker mode needs no DOM.
 */
import type { ColorSource } from '../math/types';
import type { ContainerNode, NodeOptions, TextureHandle } from '../scene/types';

// ─── Fonts ────────────────────────────────────────────────────────────────────

/** One glyph of a font, in font units scaled to `FontAsset.size` px. */
export interface GlyphMetrics {
  /** Unicode code point. */
  readonly code: number;
  /** Pen advance, px at the font's own size. */
  readonly advance: number;
  /** Quad offset from the pen position (y down), px. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  /** Atlas sub-texture, or null for whitespace. */
  readonly texture: TextureHandle | null;
}

/**
 * Value of an asset loaded with `kind: 'font'`. MSDF fonts come from the
 * usual msdf-atlas-gen / msdfgen JSON plus its page image; a Canvas2D font is
 * built at runtime and exposes the same interface.
 */
export interface FontAsset {
  readonly kind: 'msdf' | 'canvas';
  readonly family: string;
  /** The size the metrics are expressed in, px. */
  readonly size: number;
  readonly lineHeight: number;
  readonly ascender: number;
  readonly descender: number;
  /**
   * MSDF distance range in texels (from the atlas JSON). The shader needs it
   * to turn the distance field into coverage. 0 for canvas fonts.
   */
  readonly distanceRange: number;
  /** The atlas page (all glyphs of one font share it). */
  readonly texture: TextureHandle;
  /**
   * Metrics for `code`, or undefined when the font has no such glyph. A
   * canvas font rasterises it on first use, so this may return undefined
   * once and a glyph later (the Text re-lays out when that happens).
   */
  glyph(code: number): GlyphMetrics | undefined;
  /** Kerning between two code points, px at `size`. 0 when unknown. */
  kerning(left: number, right: number): number;
}

/** A system font for the Canvas2D path. */
export interface SystemFont {
  family: string;
  /** Default 400. */
  weight?: number | 'normal' | 'bold';
  /** Default 'normal'. */
  style?: 'normal' | 'italic';
  /** Atlas rasterisation size in px. Default 64. Larger = crisper when scaled up. */
  atlasSize?: number;
}

/**
 * @internal What the layout pass reads glyphs from. MSDF fonts answer
 * synchronously; the Canvas2D source rasterises missing glyphs and reports
 * them through `pending` so the Text can re-lay out when they land.
 */
export interface GlyphSource {
  readonly font: FontAsset;
  /** Sprite instance flags every glyph of this source needs (MSDF bit). */
  readonly instanceFlags: number;
  /** Metrics for `code` at the source's own size, or undefined. */
  glyph(code: number): GlyphMetrics | undefined;
  /**
   * Resolves when the glyphs of `text` are in the atlas; null when they all
   * already are (the common case, and the allocation-free one).
   */
  ensure(text: string): Promise<void> | null;
  destroy(): void;
}

// ─── Style ────────────────────────────────────────────────────────────────────

export interface TextStyle {
  /** An MSDF font asset, or a system font for the Canvas2D path. */
  font: FontAsset | SystemFont;
  /** Rendered size in stage px. Default: the font's own size. */
  size?: number;
  /** 0xRRGGBB or a color string; applied as the sprite tint. Default 0xffffff. */
  fill?: ColorSource;
  /** Default 'left'. 'justify' only applies to wrapped lines. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Default 'top'. Where the node's origin sits vertically. */
  baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
  /** Multiplier of the font's line height. Default 1. */
  lineHeight?: number;
  /** Extra px between glyphs. Default 0. */
  letterSpacing?: number;
  /** Extra px added to each space. Default 0. */
  wordSpacing?: number;
  /** Wrap width in stage px. Default 0 (no wrapping). */
  maxWidth?: number;
  /** How `maxWidth` breaks lines. Default 'word'. */
  wrap?: 'word' | 'char' | 'none';
  /**
   * Replace the tail with '…' when the text does not fit `maxWidth` and
   * `maxLines`. Default false.
   */
  ellipsis?: boolean;
  /** Hard limit on lines. Default 0 (unlimited). */
  maxLines?: number;
  /** Round glyph positions to whole physical pixels. Default true for canvas fonts. */
  pixelSnap?: boolean;
}

export interface TextOptions extends NodeOptions {
  text?: string;
  style: TextStyle;
}

/** Measured layout of the current text. Read-only, reused object. */
export interface TextMetrics {
  readonly width: number;
  readonly height: number;
  readonly lines: number;
  /** Baseline y of the first line, relative to the node origin. */
  readonly firstBaseline: number;
  /** Glyph quads actually emitted (whitespace excluded). */
  readonly glyphs: number;
}

/**
 * A text node. It is a Container: its children are the glyph sprites and must
 * not be added to or removed from by callers, but everything else a Container
 * offers (transform, alpha, mask, filters through a `Group`) works.
 */
export interface TextNode extends ContainerNode {
  readonly kind: 'container';
  /** Setting re-lays out only from the first changed glyph (§23.4). */
  text: string;
  /** Replaces the whole style; a full re-layout. Read it to inspect, do not mutate. */
  style: TextStyle;
  /** Changes one style field and re-lays out. */
  setStyle(style: Partial<TextStyle>): this;
  readonly metrics: TextMetrics;
  /**
   * Resolves once the font (and the layout chunk) is loaded and the first
   * layout ran. Until then the node has no glyph children and measures 0×0.
   */
  readonly ready: Promise<void>;
}
