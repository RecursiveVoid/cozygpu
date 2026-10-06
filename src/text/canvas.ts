/**
 * Canvas2D glyph rasterisation (ARCHITECTURE §23.5): the
 * fallback for arbitrary installed fonts, emoji and scripts no pre-baked MSDF
 * atlas covers.
 *
 * Glyphs are rasterised on demand at `SystemFont.atlasSize` into shared atlas
 * pages (the same skyline packer the asset loader uses), uploaded through the
 * normal texture path and handed to the layout pass as ordinary
 * sub-textures — so canvas text batches with sprites exactly like MSDF text,
 * it just does not stay crisp when scaled far past its atlas size.
 *
 * Front-side only: it uses OffscreenCanvas when the page has it and a canvas
 * element otherwise. Core code never touches this module, and neither does
 * the worker: in worker mode the front is still the main thread, so the
 * rasteriser runs there and only the packed page travels to the core as an
 * ordinary texture upload.
 *
 * Canvas glyphs carry no instance flag. A glyph is drawn white into a
 * premultiplied page and sampled through the ordinary sprite path, where
 * `texel.rgb * tint` reproduces exactly the tinted coverage; a colour emoji
 * keeps its own colours with the default white tint.
 */
import { Op, TextureFormatId } from '../commands/opcodes';
import { SkylinePacker } from '../assets/packer';
import { Texture } from '../scene/Texture';
import type { TextureHandle, TextureProvider } from '../scene/types';
import type { FrontFrame } from '../types/core';
import { CozyGPUError } from '../types/errors';
import { ids } from '../types/ids';
import type {
  FontAsset,
  GlyphMetrics,
  GlyphSource,
  SystemFont,
  TextStyle,
} from './types';

/** Atlas page edge, px. One page holds a few hundred glyphs at size 64. */
const PAGE_SIZE = 1024;
/** Texels between neighbouring glyphs (bilinear sampling never bleeds). */
const PADDING = 1;
const DEFAULT_ATLAS_SIZE = 64;

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/**
 * @internal Test seam. Node has neither OffscreenCanvas nor a document, so
 * unit tests install a fake here; the browser paths are the defaults.
 */
export const canvas2d = {
  create(size: number): Surface | null {
    if (typeof OffscreenCanvas !== 'undefined')
      return new OffscreenCanvas(size, size);
    if (typeof document !== 'undefined') {
      const element = document.createElement('canvas');
      element.width = size;
      element.height = size;
      return element;
    }
    return null;
  },
  /** Straight-alpha bitmap of a page rectangle (both backends premultiply). */
  snapshot(
    surface: Surface,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<ImageBitmap> {
    return createImageBitmap(surface, x, y, width, height, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  },
};

/**
 * One atlas page: a 2D canvas the rasteriser draws into and a
 * `TextureProvider` that hands the pixels to whichever renderer draws it.
 *
 * A page serves one renderer at a time. When the renderer or its generation
 * changes (a second renderer, or a device restore) the page re-creates its
 * GPU texture and uploads itself whole; in between `upload` returns false and
 * the glyph batch draws with the core's white texture for that frame.
 */
class AtlasPage implements TextureProvider {
  readonly id = ids.texture.alloc();
  readonly width = PAGE_SIZE;
  readonly height = PAGE_SIZE;
  readonly packer = new SkylinePacker(PAGE_SIZE, PAGE_SIZE, PADDING);
  readonly ctx: Ctx;
  readonly handle: TextureHandle;
  private ownerId = -1;
  private ownerGeneration = -1;
  private readonly regions: ImageBitmap[] = [];
  private readonly regionX: number[] = [];
  private readonly regionY: number[] = [];
  private full: ImageBitmap | null = null;
  private fullPending = false;
  /** Bumped by every draw into the page; invalidates an older snapshot. */
  private revision = 0;

  constructor(readonly surface: Surface) {
    const ctx = (surface as HTMLCanvasElement).getContext('2d') as Ctx | null;
    if (ctx === null) {
      throw new CozyGPUError('UNSUPPORTED', 'no 2D context for the text atlas');
    }
    this.ctx = ctx;
    this.handle = Texture.fromProvider(this);
  }

  /** Called right after a glyph is drawn: any page snapshot is now stale. */
  markDrawn(): void {
    this.revision++;
    this.full = null;
  }

  /** A rasterised glyph, already drawn into the page canvas. */
  addRegion(bitmap: ImageBitmap, x: number, y: number): void {
    this.regions.push(bitmap);
    this.regionX.push(x);
    this.regionY.push(y);
  }

  upload(frame: FrontFrame): boolean {
    if (
      frame.rendererId !== this.ownerId ||
      frame.generation !== this.ownerGeneration
    ) {
      const full = this.full;
      if (full === null) {
        this.requestFull();
        return false;
      }
      this.full = null;
      this.create(frame);
      this.region(frame, full, 0, 0);
      this.dropRegions();
      this.ownerId = frame.rendererId;
      this.ownerGeneration = frame.generation;
      return true;
    }
    for (let i = 0; i < this.regions.length; i++) {
      this.region(frame, this.regions[i], this.regionX[i], this.regionY[i]);
    }
    this.dropRegions();
    return true;
  }

  release(): void {
    // The page lives as long as its font source; nothing to free here.
  }

  private create(frame: FrontFrame): void {
    const enc = frame.encoder;
    enc.begin(Op.TEXTURE_CREATE, 20);
    enc.u32(this.id);
    enc.u32(PAGE_SIZE);
    enc.u32(PAGE_SIZE);
    enc.u32(TextureFormatId.rgba8unorm);
    // No RETAIN_SOURCE: the page re-uploads itself from its own canvas after
    // a device loss, so the core needs no CPU copy of 4 MB per page.
    enc.u32(0);
    enc.end();
  }

  private region(
    frame: FrontFrame,
    bitmap: ImageBitmap,
    x: number,
    y: number,
  ): void {
    const enc = frame.encoder;
    const index = enc.addObject(bitmap, true);
    enc.begin(Op.TEXTURE_UPLOAD_BITMAP_REGION, 20);
    enc.u32(this.id);
    enc.u32(index);
    enc.u32(x);
    enc.u32(y);
    enc.u32(0);
    enc.end();
  }

  private dropRegions(): void {
    this.regions.length = 0;
    this.regionX.length = 0;
    this.regionY.length = 0;
  }

  private requestFull(): void {
    if (this.fullPending) return;
    this.fullPending = true;
    const revision = this.revision;
    canvas2d.snapshot(this.surface, 0, 0, PAGE_SIZE, PAGE_SIZE).then(
      bitmap => {
        this.fullPending = false;
        // A glyph drawn while the snapshot was in flight makes it stale.
        if (revision === this.revision) this.full = bitmap;
      },
      () => {
        this.fullPending = false;
      },
    );
  }
}

/** A `FontAsset` whose glyphs are rasterised on demand. */
class CanvasFont implements FontAsset {
  readonly kind = 'canvas';
  readonly distanceRange = 0;
  lineHeight: number;
  ascender: number;
  descender: number;
  readonly pages: AtlasPage[] = [];
  private readonly glyphs = new Map<number, GlyphMetrics>();
  readonly css: string;

  constructor(
    readonly family: string,
    readonly size: number,
    weight: number | 'normal' | 'bold',
    style: 'normal' | 'italic',
  ) {
    this.css = `${style} ${weight} ${size}px ${family}`;
    const page = new AtlasPage(requireSurface());
    this.pages.push(page);
    const ctx = page.ctx;
    ctx.font = this.css;
    const m = ctx.measureText('Hg');
    const ascent = m.fontBoundingBoxAscent || size * 0.8;
    const descent = m.fontBoundingBoxDescent || size * 0.2;
    this.ascender = ascent;
    this.descender = -descent;
    this.lineHeight = ascent + descent;
  }

  get texture(): TextureHandle {
    return this.pages[0].handle;
  }

  glyph(code: number): GlyphMetrics | undefined {
    return this.glyphs.get(code);
  }

  kerning(): number {
    // Canvas2D exposes no pair kerning; measureText already applies the
    // font's own advance, which is all the fallback path can see.
    return 0;
  }

  /** @internal Draws `code` into a page, or records it as advance-only. */
  rasterise(code: number): Promise<void> | null {
    if (this.glyphs.has(code)) return null;
    const text = String.fromCodePoint(code);
    const page0 = this.pages[0];
    const ctx0 = page0.ctx;
    ctx0.font = this.css;
    const m = ctx0.measureText(text);
    const advance = m.width;
    const left = m.actualBoundingBoxLeft ?? 0;
    const right = m.actualBoundingBoxRight ?? advance;
    const ascent = m.actualBoundingBoxAscent ?? this.ascender;
    const descent = m.actualBoundingBoxDescent ?? 0;
    const width = Math.ceil(left + right);
    const height = Math.ceil(ascent + descent);
    if (!(width > 0 && height > 0)) {
      this.glyphs.set(code, {
        code,
        advance,
        offsetX: 0,
        offsetY: 0,
        width: 0,
        height: 0,
        texture: null,
      });
      return null;
    }
    let page: AtlasPage | undefined;
    for (let i = 0; i < this.pages.length; i++) {
      if (this.pages[i].packer.pack(width, height)) {
        page = this.pages[i];
        break;
      }
    }
    if (page === undefined) {
      const next = new AtlasPage(requireSurface());
      this.pages.push(next);
      if (!next.packer.pack(width, height)) {
        // A single glyph larger than a whole page: advance only.
        this.glyphs.set(code, {
          code,
          advance,
          offsetX: 0,
          offsetY: 0,
          width: 0,
          height: 0,
          texture: null,
        });
        return null;
      }
      page = next;
    }
    const x = page.packer.x;
    const y = page.packer.y;
    const ctx = page.ctx;
    ctx.font = this.css;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.clearRect(x, y, width, height);
    ctx.fillText(text, x + left, y + ascent);
    page.markDrawn();
    this.glyphs.set(code, {
      code,
      advance,
      offsetX: -left,
      offsetY: -ascent,
      width,
      height,
      texture: page.handle.sub(x, y, width, height),
    });
    const owner = page;
    return canvas2d
      .snapshot(page.surface, x, y, width, height)
      .then(bitmap => owner.addRegion(bitmap, x, y));
  }
}

function requireSurface(): Surface {
  const surface = canvas2d.create(PAGE_SIZE);
  if (surface === null) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'system fonts need a 2D canvas; use an MSDF font asset instead',
    );
  }
  return surface;
}

class CanvasGlyphSource implements GlyphSource {
  readonly instanceFlags = 0;
  private pending: Promise<void> | null = null;

  constructor(readonly font: CanvasFont) {}

  glyph(code: number): GlyphMetrics | undefined {
    return this.font.glyph(code);
  }

  ensure(text: string): Promise<void> | null {
    let jobs: Promise<void>[] | null = null;
    for (let i = 0; i < text.length; ) {
      const code = text.codePointAt(i) as number;
      i += code > 0xffff ? 2 : 1;
      const job = this.font.rasterise(code);
      if (job !== null) (jobs ??= []).push(job);
    }
    if (jobs === null) return this.pending;
    const all = Promise.all(jobs).then(() => {});
    this.pending = all;
    return all;
  }

  destroy(): void {
    // Sources are shared per font descriptor and live for the process.
  }
}

/** One source per font descriptor; every Text with the same style shares it. */
const sources = new Map<string, GlyphSource>();

export function createGlyphSource(style: TextStyle): GlyphSource {
  const font = style.font;
  if ('glyph' in font) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      'style.font is a loaded FontAsset; it needs the MSDF source',
    );
  }
  const descriptor = font as SystemFont;
  const size = descriptor.atlasSize ?? DEFAULT_ATLAS_SIZE;
  const weight = descriptor.weight ?? 400;
  const slant = descriptor.style ?? 'normal';
  const key = `${descriptor.family}|${weight}|${slant}|${size}`;
  let source = sources.get(key);
  if (source === undefined) {
    source = new CanvasGlyphSource(
      new CanvasFont(descriptor.family, size, weight, slant),
    );
    sources.set(key, source);
  }
  return source;
}
