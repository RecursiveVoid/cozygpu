/**
 * `GPU.Text` (ARCHITECTURE §23).
 *
 * This shell holds the public surface and nothing else; layout
 * (`text-core`), MSDF glyph emission (`text-msdf`) and Canvas2D
 * rasterisation (`text-canvas`) are separate chunks loaded on first use, so
 * importing `Text` costs about a kilobyte until text is actually laid out.
 *
 * A Text IS a Container whose children are the glyph Sprites it owns, so
 * glyph quads travel the normal sprite instance path and batch with the
 * sprites around them (§23.2).
 *
 * The chunks are cached per process: the first `Text` waits one microtask for
 * them, every later layout (a changed string, a new style) runs synchronously
 * in the same turn. `ready` resolves after the layout that is current when it
 * is read — including the re-layout a Canvas2D font schedules once it has
 * rasterised the glyphs a new string needs.
 */
import { Container } from '../scene/Container';
import type { Sprite } from '../scene/Sprite';
import type { DestroyOptions } from '../scene/types';
import type { LayoutBuffers } from './layout';
import type {
  GlyphSource,
  SystemFont,
  TextMetrics,
  TextNode,
  TextOptions,
  TextStyle,
} from './types';

type LayoutModule = typeof import('./layout');
type GlyphModule = { createGlyphSource(style: TextStyle): GlyphSource };

const EMPTY_METRICS: TextMetrics = {
  width: 0,
  height: 0,
  lines: 0,
  firstBaseline: 0,
  glyphs: 0,
};

/** Loaded once per process; every Text after the first lays out synchronously. */
let layoutModule: LayoutModule | null = null;
let msdfModule: GlyphModule | null = null;
let canvasModule: GlyphModule | null = null;

function isSystemFont(font: TextStyle['font']): font is SystemFont {
  return !('glyph' in font);
}

export class Text extends Container implements TextNode {
  /** @internal */
  _text = '';
  /** @internal */
  _style: TextStyle;
  /** @internal */
  _metrics: TextMetrics = EMPTY_METRICS;
  /** @internal */
  _ready: Promise<void> = Promise.resolve();
  /** @internal The glyph children, in reading order. Written by ./layout. */
  _glyphs: Sprite[] = [];
  /** @internal Reused shaping buffers (./layout owns them). */
  _buffers: LayoutBuffers | null = null;
  /** @internal Drops the result of a layout the next one already replaced. */
  private _seq = 0;
  /** @internal Cached per font/style; recreated only when the font changes. */
  private _source: GlyphSource | null = null;
  private _sourceFont: TextStyle['font'] | null = null;
  private _sourceKey = '';

  constructor(text: string, style: TextStyle);
  constructor(options: TextOptions);
  constructor(textOrOptions: string | TextOptions, style?: TextStyle) {
    const options =
      typeof textOrOptions === 'string'
        ? { text: textOrOptions, style: style! }
        : textOrOptions;
    super(options);
    this._style = options.style;
    this._text = options.text ?? '';
    this._layout();
  }

  override get kind(): 'container' {
    return 'container';
  }

  get text(): string {
    return this._text;
  }

  set text(value: string) {
    if (value === this._text) return;
    this._text = value;
    this._layout();
  }

  get style(): TextStyle {
    return this._style;
  }

  set style(value: TextStyle) {
    this._style = value;
    this._layout();
  }

  setStyle(style: Partial<TextStyle>): this {
    this._style = { ...this._style, ...style };
    this._layout();
    return this;
  }

  get metrics(): TextMetrics {
    return this._metrics;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  override destroy(options?: DestroyOptions): void {
    if (this.destroyed) return;
    this._glyphs.length = 0;
    this._buffers = null;
    this._source = null;
    this._sourceFont = null;
    super.destroy(options);
  }

  /**
   * @internal Loads the layout chunk plus the glyph source the style asks
   * for, then re-lays out (§23.4).
   */
  private _layout(): void {
    if (this.destroyed) return;
    const seq = ++this._seq;
    const system = isSystemFont(this._style.font);
    const glyphs = system ? canvasModule : msdfModule;
    if (layoutModule !== null && glyphs !== null) {
      const pending = this._run(layoutModule, glyphs, seq);
      this._ready = pending ?? Promise.resolve();
      this._ready.catch(() => {});
      return;
    }
    const loadLayout: Promise<LayoutModule> =
      layoutModule !== null
        ? Promise.resolve(layoutModule)
        : import('./layout');
    const loadGlyphs: Promise<GlyphModule> =
      glyphs !== null
        ? Promise.resolve(glyphs)
        : system
          ? import('./canvas')
          : import('./msdf');
    this._ready = Promise.all([loadLayout, loadGlyphs]).then(
      ([layout, source]) => {
        layoutModule = layout;
        if (system) canvasModule = source;
        else msdfModule = source;
        if (seq !== this._seq || this.destroyed) return;
        return this._run(layout, source, seq);
      },
    );
    // Keeps Node/browser from reporting an unhandled rejection before the
    // caller awaits `ready`.
    this._ready.catch(() => {});
  }

  /** @internal Shapes now; re-shapes later when a canvas font adds glyphs. */
  private _run(
    layout: LayoutModule,
    glyphs: GlyphModule,
    seq: number,
  ): Promise<void> | void {
    const font = this._style.font;
    const key = sourceKey(this._style);
    if (
      this._source === null ||
      font !== this._sourceFont ||
      key !== this._sourceKey
    ) {
      this._source = glyphs.createGlyphSource(this._style);
      this._sourceFont = font;
      this._sourceKey = key;
    }
    const source = this._source;
    this._metrics = layout.layoutText(this, source);
    const pending = source.ensure(this._text);
    if (pending === null) return;
    return pending.then(() => {
      if (seq !== this._seq || this.destroyed) return;
      this._metrics = layout.layoutText(this, source);
    });
  }
}

/** Fonts compare by identity; system fonts by the descriptor that names them. */
function sourceKey(style: TextStyle): string {
  const font = style.font;
  if (!isSystemFont(font)) return '';
  return `${font.family}|${font.weight ?? 400}|${font.style ?? 'normal'}|${
    font.atlasSize ?? 0
  }`;
}
