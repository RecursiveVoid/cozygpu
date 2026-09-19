/**
 * Owner: "assets". Front-side GPU texture units of the asset manager
 * (ARCHITECTURE §15.5–§15.7): standalone textures and atlas pages. Both are
 * `TextureProvider`s (the scene seam), LRU nodes (eviction) and own their
 * texId. Pixels only pass through: a pending ImageBitmap / level buffer is
 * handed to the command stream (transferred in worker mode) and dropped.
 */
import type { TextureFormat } from '../backend/types';
import {
  Op,
  TEXTURE_MIP_LEVELS_SHIFT,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import { Texture } from '../scene/Texture';
import type {
  TextureFrame,
  TextureHandle,
  TextureProvider,
} from '../scene/types';
import type { FrontFrame } from '../types/core';
import { ids } from '../types/ids';
import type { LruNode } from './lru';
import { SkylinePacker } from './packer';

/**
 * @internal Seam for Node tests (no scene implementation needed): how a
 * provider becomes a sprite-ready handle.
 */
export const textureFactory = {
  create(provider: TextureProvider, frame?: TextureFrame): TextureHandle {
    return Texture.fromProvider(provider, frame);
  },
};

/** What units need from the manager. */
export interface UnitHost {
  readonly rendererId: number;
  /** LRU touch (last draw use). */
  touch(unit: GpuUnit): void;
  /** The root handle was destroyed by the user: drop the unit and its entries. */
  unitDestroyedExternally(unit: GpuUnit): void;
  /** Local mode: close bitmaps after the packet that uploads them ran. */
  closeLater(bitmap: ImageBitmap): void;
}

export function formatIdOf(format: TextureFormat): number {
  const id = (TextureFormatId as Record<string, number>)[format];
  return id === undefined ? TextureFormatId.rgba8unorm : id;
}

export function emitCreate(
  enc: CommandEncoder,
  id: number,
  width: number,
  height: number,
  formatId: number,
  texFlags: number,
): void {
  enc.begin(Op.TEXTURE_CREATE, 20);
  enc.u32(id);
  enc.u32(width);
  enc.u32(height);
  enc.u32(formatId);
  enc.u32(texFlags >>> 0);
  enc.end();
}

export function emitDestroy(enc: CommandEncoder, id: number): void {
  enc.begin(Op.TEXTURE_DESTROY, 4);
  enc.u32(id);
  enc.end();
}

export abstract class GpuUnit implements TextureProvider, LruNode {
  lruPrev: LruNode | null = null;
  lruNext: LruNode | null = null;
  lruLinked = false;
  readonly id: number;
  /** Generation whose GPU texture has content (upload() → true). */
  contentGeneration = -1;
  /** Generation whose TEXTURE_CREATE was emitted. */
  createdGeneration = -1;
  lastUsedFrame = -1;
  /** Root sprite-ready handle (created lazily: needs the scene module). */
  private rootHandle: TextureHandle | null = null;
  /** Set while the manager destroys the root handle itself. */
  dropping = false;
  dropped = false;

  constructor(
    readonly host: UnitHost,
    readonly width: number,
    readonly height: number,
    readonly format: TextureFormat,
    /** TEXTURE_CREATE texFlags (incl. explicit mip level count). */
    readonly texFlags: number,
  ) {
    this.id = ids.texture.alloc();
  }

  get handle(): TextureHandle {
    if (this.rootHandle === null) this.rootHandle = textureFactory.create(this);
    return this.rootHandle;
  }

  get hasHandle(): boolean {
    return this.rootHandle !== null;
  }

  /** Estimated GPU bytes. */
  abstract readonly bytes: number;
  /** Data waiting to be encoded. */
  abstract readonly hasPending: boolean;
  /** Emits create + pending uploads; returns the texel bytes encoded. */
  abstract flush(frame: FrontFrame): number;
  /** Drops pending CPU data (closing bitmaps). */
  abstract dropPending(): void;

  upload(frame: FrontFrame): boolean {
    if (this.dropped || frame.rendererId !== this.host.rendererId) return false;
    if (this.lastUsedFrame !== frame.frameId) {
      this.lastUsedFrame = frame.frameId;
      this.host.touch(this);
    }
    if (this.hasPending) this.flush(frame);
    return this.contentGeneration === frame.generation;
  }

  release(): void {
    if (this.dropping || this.dropped) return;
    this.host.unitDestroyedExternally(this);
  }

  /** Marks the unit dropped and destroys its root handle (sprites draw white). */
  markDropped(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.dropPending();
    if (this.rootHandle !== null && !this.rootHandle.destroyed) {
      this.dropping = true;
      try {
        this.rootHandle.destroy();
      } finally {
        this.dropping = false;
      }
    }
  }

  protected ensureCreated(frame: FrontFrame): void {
    if (this.createdGeneration === frame.generation) return;
    emitCreate(
      frame.encoder,
      this.id,
      this.width,
      this.height,
      formatIdOf(this.format),
      this.texFlags,
    );
    this.createdGeneration = frame.generation;
  }
}

/** One texture asset with its own GPU texture. */
export class StandaloneTexture extends GpuUnit {
  bitmap: ImageBitmap | null = null;
  /** Compressed / raw levels, level 0 first. */
  levels: ArrayBuffer[] | null = null;
  /** Emit TEXTURE_GENERATE_MIPMAPS after the level-0 upload (single-level rgba8 KTX2). */
  generateAfterUpload = false;

  constructor(
    host: UnitHost,
    width: number,
    height: number,
    format: TextureFormat,
    texFlags: number,
    readonly bytes: number,
  ) {
    super(host, width, height, format, texFlags);
  }

  get hasPending(): boolean {
    return this.bitmap !== null || this.levels !== null;
  }

  get mipLevelCount(): number {
    return (this.texFlags >>> TEXTURE_MIP_LEVELS_SHIFT) & 0xff;
  }

  flush(frame: FrontFrame): number {
    const enc = frame.encoder;
    let bytes = 0;
    if (this.bitmap !== null) {
      this.ensureCreated(frame);
      const index = enc.addObject(this.bitmap, true);
      enc.begin(Op.TEXTURE_UPLOAD_BITMAP, 12);
      enc.u32(this.id);
      enc.u32(index);
      enc.u32(0);
      enc.end();
      this.host.closeLater(this.bitmap);
      this.bitmap = null;
      bytes = this.bytes;
      this.contentGeneration = frame.generation;
    } else if (this.levels !== null) {
      this.ensureCreated(frame);
      const levels = this.levels;
      for (let level = 0; level < levels.length; level++) {
        const data = levels[level];
        const index = enc.addObject(data, true);
        enc.begin(Op.TEXTURE_UPLOAD_COMPRESSED, 28);
        enc.u32(this.id);
        enc.u32(level);
        enc.u32(Math.max(1, this.width >> level));
        enc.u32(Math.max(1, this.height >> level));
        enc.u32(index);
        enc.u32(0);
        enc.u32(data.byteLength);
        enc.end();
        bytes += data.byteLength;
      }
      if (this.generateAfterUpload) {
        enc.begin(Op.TEXTURE_GENERATE_MIPMAPS, 4);
        enc.u32(this.id);
        enc.end();
      }
      this.levels = null;
      this.contentGeneration = frame.generation;
    }
    return bytes;
  }

  dropPending(): void {
    if (this.bitmap !== null) this.bitmap.close();
    this.bitmap = null;
    this.levels = null;
  }
}

/** Page flags that must match for images to share a page. */
export function pageKey(texFlags: number): number {
  return (
    texFlags &
    (TextureFlag.NEAREST | TextureFlag.MIPMAPS | TextureFlag.PREMULTIPLIED)
  );
}

/** A shared atlas page of small images (region uploads). */
export class AtlasPage extends GpuUnit {
  readonly packer: SkylinePacker;
  /** Packed images still alive on this page (the manager's entries). */
  readonly images: unknown[] = [];
  readonly bytes: number;
  private readonly pendingBitmaps: ImageBitmap[] = [];
  private readonly pendingX: number[] = [];
  private readonly pendingY: number[] = [];

  constructor(host: UnitHost, size: number, padding: number, texFlags: number) {
    super(host, size, size, 'rgba8unorm', texFlags);
    this.packer = new SkylinePacker(size, size, padding);
    const base = size * size * 4;
    this.bytes =
      (texFlags & TextureFlag.MIPMAPS) !== 0 ? Math.ceil((base * 4) / 3) : base;
  }

  get key(): number {
    return pageKey(this.texFlags);
  }

  get hasPending(): boolean {
    return this.pendingBitmaps.length > 0;
  }

  get pendingCount(): number {
    return this.pendingBitmaps.length;
  }

  addRegion(bitmap: ImageBitmap, x: number, y: number): void {
    this.pendingBitmaps.push(bitmap);
    this.pendingX.push(x);
    this.pendingY.push(y);
  }

  flush(frame: FrontFrame): number {
    const n = this.pendingBitmaps.length;
    if (n === 0) return 0;
    this.ensureCreated(frame);
    const enc = frame.encoder;
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      const bitmap = this.pendingBitmaps[i];
      const index = enc.addObject(bitmap, true);
      enc.begin(Op.TEXTURE_UPLOAD_BITMAP_REGION, 20);
      enc.u32(this.id);
      enc.u32(index);
      enc.u32(this.pendingX[i]);
      enc.u32(this.pendingY[i]);
      enc.u32(0);
      enc.end();
      bytes += bitmap.width * bitmap.height * 4;
      this.host.closeLater(bitmap);
    }
    if ((this.texFlags & TextureFlag.MIPMAPS) !== 0) {
      enc.begin(Op.TEXTURE_GENERATE_MIPMAPS, 4);
      enc.u32(this.id);
      enc.end();
    }
    this.pendingBitmaps.length = 0;
    this.pendingX.length = 0;
    this.pendingY.length = 0;
    this.contentGeneration = frame.generation;
    return bytes;
  }

  dropPending(): void {
    for (let i = 0; i < this.pendingBitmaps.length; i++)
      this.pendingBitmaps[i].close();
    this.pendingBitmaps.length = 0;
    this.pendingX.length = 0;
    this.pendingY.length = 0;
  }
}
