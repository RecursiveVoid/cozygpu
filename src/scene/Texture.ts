/**
 * Texture — owner: "sprites". A (source, frame) pair. Frames of one source
 * share a texId, so sprites using frames of one atlas batch together.
 * Uploads happen lazily through the command stream (ensureTextureUploaded).
 */
import { Op, TextureFlag, TextureFormatId } from '../commands/opcodes';
import { CozyGPUError } from '../types/errors';
import { NO_ID, ids } from '../types/ids';
import type { FrontFrame } from '../types/core';
import type {
  TextureFrame,
  TextureHandle,
  TextureInput,
  TextureOptions,
  TextureProvider,
} from './types';

/** @internal Shared by every frame (Texture handle) of one image. */
export class TextureSource {
  /** texId in the command stream; NO_ID for the built-in white texture. */
  readonly id: number;
  private readonly _width: number;
  private readonly _height: number;
  /** M2: asset-managed GPU-only source (ARCHITECTURE §15.6). */
  provider: TextureProvider | null = null;
  readonly texFlags: number;
  bitmap: ImageBitmap | null;
  /** RGBA8, premultiplied (converted once at creation). */
  pixels: Uint8Array | null;
  destroyed = false;
  /** rendererId → generation last uploaded. */
  readonly uploads = new Map<number, number>();
  lastRendererId = -1;
  lastGeneration = -1;

  constructor(
    id: number,
    width: number,
    height: number,
    texFlags: number,
    bitmap: ImageBitmap | null,
    pixels: Uint8Array | null,
  ) {
    this.id = id;
    this._width = width;
    this._height = height;
    this.texFlags = texFlags;
    this.bitmap = bitmap;
    this.pixels = pixels;
  }

  /** Providers may learn their size late (while loading), so read it live. */
  get width(): number {
    const p = this.provider;
    return p ? p.width : this._width;
  }
  get height(): number {
    const p = this.provider;
    return p ? p.height : this._height;
  }
}

/** One shared source per provider, so every handle of it batches together. */
const providerSources = new WeakMap<TextureProvider, TextureSource>();

function flagsFrom(options: TextureOptions | undefined): number {
  let f = TextureFlag.RETAIN_SOURCE;
  if (options?.nearest) f |= TextureFlag.NEAREST;
  if (options?.repeat) f |= TextureFlag.REPEAT;
  if (options?.mipmaps) f |= TextureFlag.MIPMAPS;
  if (options?.premultiplied) f |= TextureFlag.PREMULTIPLIED;
  return f;
}

/** Copies RGBA8 pixels, premultiplying straight alpha. */
function premultipliedCopy(
  src: Uint8Array | Uint8ClampedArray,
  byteLength: number,
  alreadyPremultiplied: boolean,
): Uint8Array {
  const out = new Uint8Array(byteLength);
  out.set(src.subarray(0, byteLength));
  if (alreadyPremultiplied) return out;
  for (let i = 0; i < byteLength; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    out[i] = Math.round(out[i] * k);
    out[i + 1] = Math.round(out[i + 1] * k);
    out[i + 2] = Math.round(out[i + 2] * k);
  }
  return out;
}

let white: Texture | null = null;
const createToken = {};

/** Sources destroyed while uploaded somewhere; flushed by each ScenePacker. */
const pendingDestroys: TextureSource[] = [];

/**
 * Renderers that were destroyed (renderer ids are never reused). Their cores
 * freed every GPU texture, so their entries in `TextureSource.uploads` must
 * not keep a destroyed source (and its id) pending forever.
 */
const deadRenderers = new Set<number>();

function forgetDeadRenderers(s: TextureSource): void {
  if (deadRenderers.size === 0) return;
  s.uploads.forEach((_generation, rid) => {
    if (deadRenderers.has(rid)) s.uploads.delete(rid);
  });
}

export class Texture implements TextureHandle {
  /** @internal */
  readonly _source: TextureSource;
  readonly frame: TextureFrame;

  /** Use the static factories / loadTexture(). */
  private constructor(
    token: object,
    source: TextureSource,
    frame: TextureFrame,
  ) {
    if (token !== createToken) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'use Texture.from / Texture.fromPixels / loadTexture',
      );
    }
    this._source = source;
    this.frame = frame;
  }

  get sourceId(): number {
    return this._source.id;
  }
  get sourceWidth(): number {
    return this._source.width;
  }
  get sourceHeight(): number {
    return this._source.height;
  }
  get width(): number {
    return this.frame.width;
  }
  get height(): number {
    return this.frame.height;
  }
  get destroyed(): boolean {
    return this._source.destroyed;
  }

  /** 1×1 opaque white (default sprite texture). Maps to the core's white texture. */
  static get WHITE(): Texture {
    if (!white) {
      const src = new TextureSource(NO_ID, 1, 1, 0, null, null);
      white = new Texture(createToken, src, {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      });
    }
    return white;
  }

  /**
   * M2 assets seam (ARCHITECTURE §15.6). Wraps an asset-managed, GPU-only
   * source; frames made with `sub()` share it. `ensureTextureUploaded` calls
   * `provider.upload(frame)` instead of emitting bitmap/pixel uploads, and
   * destroying the source (any handle's `destroy()`, which destroys all
   * frames) calls `provider.release()` once. The provider owns the texId and
   * the GPU texture: no TEXTURE_DESTROY is emitted and the id is not freed
   * here. Calling `fromProvider` again for a live provider returns a new
   * handle on the same source.
   */
  static fromProvider(
    provider: TextureProvider,
    frame?: TextureFrame,
  ): Texture {
    let src = providerSources.get(provider);
    if (!src || src.destroyed) {
      src = new TextureSource(provider.id, 0, 0, 0, null, null);
      src.provider = provider;
      providerSources.set(provider, src);
    }
    const f = frame ?? {
      x: 0,
      y: 0,
      width: provider.width,
      height: provider.height,
    };
    return new Texture(createToken, src, {
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
    });
  }

  /** Synchronous for already-decoded sources. */
  static from(
    source: ImageBitmap | ImageData | OffscreenCanvas,
    options?: TextureOptions,
  ): Texture {
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
      return Texture.fromPixels(
        source.width,
        source.height,
        source.data,
        options,
      );
    }
    if (
      typeof OffscreenCanvas !== 'undefined' &&
      source instanceof OffscreenCanvas
    ) {
      const ctx = source.getContext('2d');
      if (ctx) {
        const data = ctx.getImageData(0, 0, source.width, source.height);
        return Texture.fromPixels(data.width, data.height, data.data, options);
      }
      return Texture.from(source.transferToImageBitmap(), options);
    }
    const bitmap = source as ImageBitmap;
    const src = new TextureSource(
      ids.texture.alloc(),
      bitmap.width,
      bitmap.height,
      flagsFrom(options),
      bitmap,
      null,
    );
    return new Texture(createToken, src, {
      x: 0,
      y: 0,
      width: bitmap.width,
      height: bitmap.height,
    });
  }

  /** RGBA8, straight alpha unless options.premultiplied. Pixels are copied. */
  static fromPixels(
    width: number,
    height: number,
    pixels: Uint8Array | Uint8ClampedArray,
    options?: TextureOptions,
  ): Texture {
    const bytes = width * height * 4;
    if (!(width > 0 && height > 0) || pixels.length < bytes) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `fromPixels: need ${bytes} bytes for ${width}×${height}`,
      );
    }
    const data = premultipliedCopy(pixels, bytes, !!options?.premultiplied);
    const src = new TextureSource(
      ids.texture.alloc(),
      width,
      height,
      flagsFrom(options) | TextureFlag.PREMULTIPLIED,
      null,
      data,
    );
    return new Texture(createToken, src, { x: 0, y: 0, width, height });
  }

  sub(x: number, y: number, width: number, height: number): Texture {
    const f = this.frame;
    const fx = f.x + x;
    const fy = f.y + y;
    if (
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      fx + width > f.x + f.width ||
      fy + height > f.y + f.height
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `sub(${x}, ${y}, ${width}, ${height}) outside ${f.width}×${f.height}`,
      );
    }
    return new Texture(createToken, this._source, {
      x: fx,
      y: fy,
      width,
      height,
    });
  }

  /** Destroys the SOURCE (all frames). GPU textures are freed on each renderer's next render(). */
  destroy(): void {
    const s = this._source;
    if (s.destroyed || s.id === NO_ID) return;
    s.destroyed = true;
    const provider = s.provider;
    if (provider) {
      providerSources.delete(provider);
      provider.release();
      return;
    }
    s.bitmap?.close?.();
    s.bitmap = null;
    s.pixels = null;
    forgetDeadRenderers(s);
    if (s.uploads.size > 0) pendingDestroys.push(s);
    else ids.texture.free(s.id);
  }
}

async function toBitmap(input: TextureInput): Promise<ImageBitmap> {
  if (typeof input === 'string' || input instanceof URL) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `loadTexture: ${response.status} ${response.statusText} (${String(input)})`,
      );
    }
    input = await response.blob();
  }
  if (
    typeof HTMLImageElement !== 'undefined' &&
    input instanceof HTMLImageElement
  ) {
    if (!input.complete || input.naturalWidth === 0) await input.decode();
  }
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) {
    return input;
  }
  // Straight alpha in; the core premultiplies on upload.
  return createImageBitmap(input as ImageBitmapSource, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

/** Fetch/decode (createImageBitmap, off the main thread's decode path) and wrap. */
export async function loadTexture(
  input: TextureInput,
  options?: TextureOptions,
): Promise<Texture> {
  if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    return Texture.from(input, options);
  }
  if (
    typeof OffscreenCanvas !== 'undefined' &&
    input instanceof OffscreenCanvas
  ) {
    return Texture.from(input, options);
  }
  return Texture.from(await toBitmap(input), options);
}

function emitUpload(frame: FrontFrame, s: TextureSource): void {
  const enc = frame.encoder;
  enc.begin(Op.TEXTURE_CREATE, 20);
  enc.u32(s.id);
  enc.u32(s.width);
  enc.u32(s.height);
  enc.u32(TextureFormatId.rgba8unorm);
  enc.u32(s.texFlags);
  enc.end();
  if (s.pixels) {
    const n = s.width * s.height * 4;
    enc.begin(Op.TEXTURE_UPLOAD_PIXELS, 20 + n);
    enc.u32(s.id);
    enc.u32(0);
    enc.u32(0);
    enc.u32(s.width);
    enc.u32(s.height);
    enc.bytes(s.pixels, 0, n);
    enc.end();
  } else if (s.bitmap) {
    // Cloned, not transferred: the front keeps the bitmap for other renderers
    // and for re-upload after a device loss.
    const index = enc.addObject(s.bitmap, false);
    enc.begin(Op.TEXTURE_UPLOAD_BITMAP, 12);
    enc.u32(s.id);
    enc.u32(index);
    enc.u32(0);
    enc.end();
  }
}

/**
 * @internal Batch key equality: true when both handles draw from the same
 * source. Compares source objects, not ids, because a destroyed source's id
 * can be reused by a new texture while sprites still hold the old handle.
 */
export function sameTextureSource(a: TextureHandle, b: TextureHandle): boolean {
  if (a === b) return true;
  if (a instanceof Texture && b instanceof Texture) {
    return a._source === b._source;
  }
  if (a instanceof Texture || b instanceof Texture) {
    // A destroyed Texture draws white; never merge it with a foreign handle.
    const t = (a instanceof Texture ? a : b) as Texture;
    if (t._source.destroyed) return false;
  }
  return a.sourceId === b.sourceId;
}

/**
 * @internal Front-side upload tracking, used by the ScenePacker and Swarm.
 * Emits TEXTURE_CREATE + TEXTURE_UPLOAD_* the first time a source is used in
 * `frame.generation` for `frame.rendererId`; returns the texId (sourceId).
 * Returns NO_ID (the core's white texture) for WHITE and destroyed sources.
 */
export function ensureTextureUploaded(
  frame: FrontFrame,
  texture: TextureHandle,
): number {
  if (!(texture instanceof Texture)) return texture.sourceId;
  const s = texture._source;
  if (s.id === NO_ID || s.destroyed) return NO_ID;
  const provider = s.provider;
  if (provider) return provider.upload(frame) ? s.id : NO_ID;
  const rid = frame.rendererId;
  const gen = frame.generation;
  if (s.lastRendererId === rid && s.lastGeneration === gen) return s.id;
  if (s.uploads.get(rid) !== gen) {
    emitUpload(frame, s);
    s.uploads.set(rid, gen);
  }
  s.lastRendererId = rid;
  s.lastGeneration = gen;
  return s.id;
}

/**
 * @internal Emits TEXTURE_DESTROY for sources destroyed since the last frame
 * that were uploaded to this renderer. Frees the texId once no renderer holds
 * it. Called by the ScenePacker at the start of pack().
 */
export function flushTextureDestroys(frame: FrontFrame): void {
  const rid = frame.rendererId;
  for (let i = pendingDestroys.length - 1; i >= 0; i--) {
    const s = pendingDestroys[i];
    if (s.uploads.has(rid)) {
      const enc = frame.encoder;
      enc.begin(Op.TEXTURE_DESTROY, 4);
      enc.u32(s.id);
      enc.end();
      s.uploads.delete(rid);
    }
    if (s.uploads.size === 0) {
      pendingDestroys[i] = pendingDestroys[pendingDestroys.length - 1];
      pendingDestroys.pop();
      ids.texture.free(s.id);
    }
  }
}

/**
 * @internal Called by Renderer.destroy(). The renderer's core releases its GPU
 * textures itself, so this only forgets that renderer on the front side:
 * destroyed sources still waiting for that renderer's TEXTURE_DESTROY free
 * their id now (if no other renderer holds them), and sources destroyed later
 * no longer wait for it.
 */
export function dropTextureUploads(rendererId: number): void {
  deadRenderers.add(rendererId);
  for (let i = pendingDestroys.length - 1; i >= 0; i--) {
    const s = pendingDestroys[i];
    s.uploads.delete(rendererId);
    if (s.uploads.size === 0) {
      pendingDestroys[i] = pendingDestroys[pendingDestroys.length - 1];
      pendingDestroys.pop();
      ids.texture.free(s.id);
    }
  }
}
