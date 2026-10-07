/**
 * Core-side texture registry
 * (opcodes 0x0100–0x0106).
 *
 * - GPU textures hold **premultiplied** color: straight-alpha pixel uploads
 *   are premultiplied on the CPU, bitmaps via `premultipliedAlpha: true`.
 *   Shaders therefore sample premultiplied texels.
 * - RETAIN_SOURCE keeps a CPU copy (full premultiplied pixels, or the last
 *   uploaded bitmap) so textures survive a device loss.
 * - Samplers are cached by (NEAREST, REPEAT, MIPMAPS) flag combination.
 * DOM-free (worker-safe).
 */
import {
  TEXTURE_MIP_LEVELS_MASK,
  TEXTURE_MIP_LEVELS_SHIFT,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
import type {
  Backend,
  RhiBindGroupLayout,
  RhiSampler,
  RhiTexture,
  TextureFormat,
} from '../backend/types';
import { TextureUsage } from '../backend/types';
import {
  bytesPerTexel,
  compressedBlockBytes,
  fullMipLevelCount,
  textureByteLength,
} from '../backend/utils';
import type { CoreTexture } from '../types/core';

/** TEXTURE_CREATE.formatId → RHI format, indexed by id (built once). */
const FORMATS_BY_ID: (TextureFormat | undefined)[] = [];
{
  const names = Object.keys(
    TextureFormatId,
  ) as (keyof typeof TextureFormatId)[];
  for (let i = 0; i < names.length; i++) {
    FORMATS_BY_ID[TextureFormatId[names[i]]] = names[i];
  }
}

/** TEXTURE_CREATE.formatId → RHI format (undefined when unknown). */
export function textureFormatFromId(
  formatId: number,
): TextureFormat | undefined {
  return formatId >= 0 && formatId < FORMATS_BY_ID.length
    ? FORMATS_BY_ID[formatId]
    : undefined;
}

export type ExternalImage = ImageBitmap | OffscreenCanvas | ImageData;

export class TextureEntry implements CoreTexture {
  texture!: RhiTexture;
  sampler!: RhiSampler;
  bindGroup!: CoreTexture['bindGroup'];
  retainedPixels: Uint8Array | null = null;
  retainedImage: ExternalImage | null = null;
  retainedFlipY = false;

  constructor(
    readonly texId: number,
    readonly width: number,
    readonly height: number,
    readonly format: TextureFormat,
    readonly flags: number,
  ) {}

  get retained(): boolean {
    return (this.flags & TextureFlag.RETAIN_SOURCE) !== 0;
  }
}

export interface TextureRegistryHost {
  readonly backend: Backend;
  readonly textureLayout: RhiBindGroupLayout;
  warn(message: string): void;
}

export class TextureRegistry {
  private readonly entries = new Map<number, TextureEntry>();
  private readonly samplers: (RhiSampler | null)[] = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  private scratch = new Uint8Array(4096);
  private white: TextureEntry | null = null;

  constructor(private readonly host: TextureRegistryHost) {}

  /** 1×1 opaque white; recreated by `restore()`. */
  get whiteTexture(): TextureEntry {
    if (!this.white) {
      const white = this.build(
        0,
        1,
        1,
        'rgba8unorm',
        TextureFlag.RETAIN_SOURCE | TextureFlag.PREMULTIPLIED,
      );
      white.retainedPixels = new Uint8Array([255, 255, 255, 255]);
      this.host.backend.writeTexture(
        white.texture,
        white.retainedPixels,
        0,
        0,
        1,
        1,
      );
      this.white = white;
    }
    return this.white;
  }

  get size(): number {
    return this.entries.size;
  }

  get(texId: number): CoreTexture {
    const entry = this.entries.get(texId);
    return entry !== undefined ? entry : this.whiteTexture;
  }

  has(texId: number): boolean {
    return this.entries.has(texId);
  }

  create(
    texId: number,
    width: number,
    height: number,
    formatId: number,
    flags: number,
  ): void {
    let format = textureFormatFromId(formatId);
    if (format === undefined) {
      this.host.warn(
        `TEXTURE_CREATE ${texId}: unknown formatId ${formatId}, using rgba8unorm`,
      );
      format = 'rgba8unorm';
    }
    this.destroy(texId);
    this.entries.set(texId, this.build(texId, width, height, format, flags));
  }

  /** `data[at .. at + w·h·4)` holds RGBA8 rows (straight unless PREMULTIPLIED). */
  uploadPixels(
    texId: number,
    x: number,
    y: number,
    w: number,
    h: number,
    data: Uint8Array,
    at: number,
  ): void {
    const entry = this.find('TEXTURE_UPLOAD_PIXELS', texId);
    if (!entry) return;
    if (w === 0 || h === 0) return;
    if (x + w > entry.width || y + h > entry.height) {
      this.bad(
        'TEXTURE_UPLOAD_PIXELS',
        texId,
        `${x},${y} ${w}×${h} out of bounds`,
      );
      return;
    }
    const bpp = bytesPerTexel(entry.format);
    if (bpp !== 4 && entry.format !== 'r8unorm') {
      this.bad('TEXTURE_UPLOAD_PIXELS', texId, `no RGBA8 into ${entry.format}`);
      return;
    }
    const texels = w * h;
    const out = this.ensureScratch(texels * bpp);
    const premultiplied = (entry.flags & TextureFlag.PREMULTIPLIED) !== 0;
    if (bpp === 1) {
      for (let i = 0; i < texels; i++) out[i] = data[at + i * 4];
    } else if (premultiplied) {
      out.set(data.subarray(at, at + texels * 4));
    } else {
      premultiplyInto(data, at, out, texels);
    }
    const view = out.subarray(0, texels * bpp);
    this.host.backend.writeTexture(entry.texture, view, x, y, w, h);
    if (entry.retained) {
      if (entry.retainedImage) {
        this.bad('TEXTURE_UPLOAD_PIXELS', texId, 'not retained after a bitmap');
      } else {
        if (!entry.retainedPixels) {
          entry.retainedPixels = new Uint8Array(
            entry.width * entry.height * bpp,
          );
        }
        blitRows(view, w, h, bpp, entry.retainedPixels, entry.width, x, y);
      }
    }
    if (entry.texture.mipLevelCount > 1)
      this.host.backend.generateMipmaps(entry.texture);
  }

  uploadImage(texId: number, image: ExternalImage, flipY: boolean): void {
    const entry = this.find('TEXTURE_UPLOAD_BITMAP', texId);
    if (!entry) return;
    if (!image) {
      this.bad('TEXTURE_UPLOAD_BITMAP', texId, 'no image');
      return;
    }
    this.host.backend.copyExternalImage(image, entry.texture, flipY);
    if (entry.retained) {
      entry.retainedImage = image;
      entry.retainedFlipY = flipY;
      entry.retainedPixels = null;
    }
    if (entry.texture.mipLevelCount > 1)
      this.host.backend.generateMipmaps(entry.texture);
  }

  // ─── M2 (ARCHITECTURE §15.5) ──────────────────────────────

  /** TEXTURE_UPLOAD_BITMAP_REGION: copy `image` to (x, y) of mip 0; no mip regeneration. */
  uploadBitmapRegion(
    texId: number,
    image: ExternalImage,
    x: number,
    y: number,
    flipY: boolean,
  ): void {
    const entry = this.find('TEXTURE_UPLOAD_BITMAP_REGION', texId);
    if (!entry) return;
    if (!image) {
      this.bad('TEXTURE_UPLOAD_BITMAP_REGION', texId, 'no image');
      return;
    }
    if (compressedBlockBytes(entry.format) > 0) {
      this.bad('TEXTURE_UPLOAD_BITMAP_REGION', texId, entry.format);
      return;
    }
    if (x + image.width > entry.width || y + image.height > entry.height) {
      this.bad(
        'TEXTURE_UPLOAD_BITMAP_REGION',
        texId,
        `${x},${y} out of bounds`,
      );
      return;
    }
    this.host.backend.copyExternalImage(image, entry.texture, flipY, x, y);
  }

  /**
   * TEXTURE_UPLOAD_COMPRESSED: one whole mip level; `data[byteOffset ..
   * byteOffset + byteLength)` holds blocks (or RGBA8 texels for rgba8unorm).
   * Straight-alpha RGBA8 levels are premultiplied like TEXTURE_UPLOAD_PIXELS.
   * Nothing is retained.
   */
  uploadCompressed(
    texId: number,
    mipLevel: number,
    width: number,
    height: number,
    data: ArrayBuffer,
    byteOffset: number,
    byteLength: number,
  ): void {
    const entry = this.find('TEXTURE_UPLOAD_COMPRESSED', texId);
    if (!entry) return;
    if (
      !data ||
      typeof data.byteLength !== 'number' ||
      byteOffset + byteLength > data.byteLength
    ) {
      this.bad('TEXTURE_UPLOAD_COMPRESSED', texId, 'short data');
      return;
    }
    const tex = entry.texture;
    const expectedW = Math.max(1, entry.width >> mipLevel);
    const expectedH = Math.max(1, entry.height >> mipLevel);
    if (
      mipLevel >= tex.mipLevelCount ||
      width !== expectedW ||
      height !== expectedH
    ) {
      this.bad('TEXTURE_UPLOAD_COMPRESSED', texId, `bad level ${mipLevel}`);
      return;
    }
    const expected = textureByteLength(entry.format, width, height);
    if (byteLength !== expected) {
      this.bad('TEXTURE_UPLOAD_COMPRESSED', texId, `level ${mipLevel} size`);
      return;
    }
    let view: Uint8Array = new Uint8Array(data, byteOffset, byteLength);
    const straightRgba8 =
      (entry.format === 'rgba8unorm' || entry.format === 'rgba8unorm-srgb') &&
      (entry.flags & TextureFlag.PREMULTIPLIED) === 0;
    if (straightRgba8) {
      const out = this.ensureScratch(byteLength);
      premultiplyInto(view, 0, out, byteLength >> 2);
      view = out.subarray(0, byteLength);
    }
    this.host.backend.writeTexture(tex, view, 0, 0, width, height, mipLevel);
  }

  /** TEXTURE_GENERATE_MIPMAPS (uncompressed textures with more than one level). */
  generateMipmaps(texId: number): void {
    const entry = this.find('TEXTURE_GENERATE_MIPMAPS', texId);
    if (!entry) return;
    if (entry.texture.mipLevelCount <= 1) return;
    if (compressedBlockBytes(entry.format) > 0) {
      this.bad('TEXTURE_GENERATE_MIPMAPS', texId, entry.format);
      return;
    }
    this.host.backend.generateMipmaps(entry.texture);
  }

  /** The entry, or undefined after warning `${op}: unknown texId`. */
  private find(op: string, texId: number): TextureEntry | undefined {
    const entry = this.entries.get(texId);
    if (!entry) this.host.warn(`${op}: unknown texId ${texId}`);
    return entry;
  }

  /** Warns `${op} ${texId}: ${detail}` (the command is skipped). */
  private bad(op: string, texId: number, detail: string): void {
    this.host.warn(`${op} ${texId}: ${detail}`);
  }

  destroy(texId: number): void {
    const entry = this.entries.get(texId);
    if (!entry) return;
    this.entries.delete(texId);
    entry.texture.destroy();
    entry.retainedPixels = null;
    entry.retainedImage = null;
  }

  /**
   * After a device restore: recreate GPU objects for retained textures and
   * re-upload their sources. Unretained textures are dropped (their ids fall
   * back to white) and the front re-creates them when it still has a source.
   */
  restore(): void {
    for (let i = 0; i < this.samplers.length; i++) this.samplers[i] = null;
    this.white = null;
    let dropped = 0;
    const old = Array.from(this.entries.values());
    this.entries.clear();
    for (let i = 0; i < old.length; i++) {
      const prev = old[i];
      if (!prev.retained || (!prev.retainedPixels && !prev.retainedImage)) {
        dropped++;
        continue;
      }
      const next = this.build(
        prev.texId,
        prev.width,
        prev.height,
        prev.format,
        prev.flags,
      );
      this.entries.set(prev.texId, next);
      if (prev.retainedImage) {
        this.host.backend.copyExternalImage(
          prev.retainedImage,
          next.texture,
          prev.retainedFlipY,
        );
        next.retainedImage = prev.retainedImage;
        next.retainedFlipY = prev.retainedFlipY;
      } else if (prev.retainedPixels) {
        this.host.backend.writeTexture(
          next.texture,
          prev.retainedPixels,
          0,
          0,
          prev.width,
          prev.height,
        );
        next.retainedPixels = prev.retainedPixels;
      }
      if (next.texture.mipLevelCount > 1)
        this.host.backend.generateMipmaps(next.texture);
    }
    if (dropped > 0) {
      this.host.warn(`restore: ${dropped} texture(s) without RETAIN_SOURCE`);
    }
  }

  destroyAll(): void {
    this.entries.forEach(entry => entry.texture.destroy());
    this.entries.clear();
    if (this.white) this.white.texture.destroy();
    this.white = null;
  }

  private build(
    texId: number,
    width: number,
    height: number,
    format: TextureFormat,
    flags: number,
  ): TextureEntry {
    const backend = this.host.backend;
    const entry = new TextureEntry(texId, width, height, format, flags);
    const full = fullMipLevelCount(width, height);
    const explicit =
      (flags >>> TEXTURE_MIP_LEVELS_SHIFT) & TEXTURE_MIP_LEVELS_MASK;
    const mips =
      explicit > 0
        ? Math.min(explicit, full)
        : (flags & TextureFlag.MIPMAPS) !== 0
          ? full
          : 1;
    entry.texture = backend.createTexture({
      label: `cozygpu texture ${texId}`,
      width,
      height,
      format,
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
      mipLevelCount: mips,
    });
    entry.sampler = this.sampler(flags);
    entry.bindGroup = backend.createBindGroup({
      label: `cozygpu texture ${texId}`,
      layout: this.host.textureLayout,
      entries: [
        { binding: 0, resource: { texture: entry.texture } },
        { binding: 1, resource: { sampler: entry.sampler } },
      ],
    });
    return entry;
  }

  private sampler(flags: number): RhiSampler {
    const nearest = (flags & TextureFlag.NEAREST) !== 0;
    const repeat = (flags & TextureFlag.REPEAT) !== 0;
    const mips = (flags & TextureFlag.MIPMAPS) !== 0;
    const key = (nearest ? 1 : 0) | (repeat ? 2 : 0) | (mips ? 4 : 0);
    let sampler = this.samplers[key];
    if (!sampler) {
      const filter = nearest ? 'nearest' : 'linear';
      const address = repeat ? 'repeat' : 'clamp-to-edge';
      sampler = this.host.backend.createSampler({
        label: `cozygpu sampler ${key}`,
        minFilter: filter,
        magFilter: filter,
        mipmapFilter: mips ? filter : 'nearest',
        addressU: address,
        addressV: address,
      });
      this.samplers[key] = sampler;
    }
    return sampler;
  }

  private ensureScratch(bytes: number): Uint8Array {
    if (this.scratch.byteLength < bytes) {
      let size = this.scratch.byteLength;
      while (size < bytes) size *= 2;
      this.scratch = new Uint8Array(size);
    }
    return this.scratch;
  }
}

/** Straight RGBA8 → premultiplied RGBA8 (rounded). */
export function premultiplyInto(
  src: Uint8Array,
  at: number,
  out: Uint8Array,
  texels: number,
): void {
  for (let i = 0; i < texels; i++) {
    const s = at + i * 4;
    const o = i * 4;
    const a = src[s + 3];
    if (a === 255) {
      out[o] = src[s];
      out[o + 1] = src[s + 1];
      out[o + 2] = src[s + 2];
    } else {
      out[o] = (src[s] * a + 127) / 255;
      out[o + 1] = (src[s + 1] * a + 127) / 255;
      out[o + 2] = (src[s + 2] * a + 127) / 255;
    }
    out[o + 3] = a;
  }
}

function blitRows(
  src: Uint8Array,
  w: number,
  h: number,
  bpp: number,
  dst: Uint8Array,
  dstWidth: number,
  x: number,
  y: number,
): void {
  const rowBytes = w * bpp;
  for (let row = 0; row < h; row++) {
    const from = row * rowBytes;
    dst.set(
      src.subarray(from, from + rowBytes),
      ((y + row) * dstWidth + x) * bpp,
    );
  }
}
