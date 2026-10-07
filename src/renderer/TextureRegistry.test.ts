/** M2 texture ops of the core registry. */
import type { RhiBindGroupLayout, RhiTexture } from '../backend/types';
import {
  TEXTURE_MIP_LEVELS_SHIFT,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
import { FakeBackend, type FakeTexture } from './testing/fakeBackend';
import { TextureRegistry, textureFormatFromId } from './TextureRegistry';

class MipBackend extends FakeBackend {
  writes: {
    texture: RhiTexture;
    bytes: number[];
    w: number;
    h: number;
    mip: number;
  }[] = [];
  copies: { x: number; y: number; flipY: boolean }[] = [];
  mipGens = 0;
  writeTexture(
    texture: RhiTexture,
    data: ArrayBufferView,
    _x: number,
    _y: number,
    w: number,
    h: number,
    mip = 0,
  ): void {
    this.writes.push({
      texture,
      bytes: Array.from(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
      w,
      h,
      mip,
    });
  }
  copyExternalImage(
    _s: ImageBitmap | OffscreenCanvas | ImageData,
    _t: RhiTexture,
    flipY = false,
    x = 0,
    y = 0,
  ): void {
    this.copies.push({ x, y, flipY });
  }
  generateMipmaps(): void {
    this.mipGens++;
  }
}

function setup() {
  const backend = new MipBackend();
  const warnings: string[] = [];
  const registry = new TextureRegistry({
    backend,
    textureLayout: {} as RhiBindGroupLayout,
    warn: m => warnings.push(m),
  });
  const texture = (id: number) =>
    backend.textures.find(
      t => t.desc.label === `cozygpu texture ${id}`,
    ) as FakeTexture;
  return { backend, registry, warnings, texture };
}

const image = (width: number, height: number) =>
  ({ width, height }) as unknown as ImageBitmap;

describe('TextureRegistry M2 ops', () => {
  it('maps every TextureFormatId back to its format', () => {
    for (const [name, id] of Object.entries(TextureFormatId)) {
      expect(textureFormatFromId(id)).toBe(name);
    }
    expect(textureFormatFromId(4)).toBeUndefined();
    expect(textureFormatFromId(999)).toBeUndefined();
  });

  it('honours explicit mip level counts and the MIPMAPS default', () => {
    const { registry, texture } = setup();
    registry.create(
      1,
      64,
      32,
      TextureFormatId['bc7-rgba-unorm'],
      TextureFlag.MIPMAPS | (3 << TEXTURE_MIP_LEVELS_SHIFT),
    );
    registry.create(2, 64, 32, TextureFormatId.rgba8unorm, TextureFlag.MIPMAPS);
    registry.create(3, 64, 32, TextureFormatId.rgba8unorm, 0);
    registry.create(
      4,
      4,
      4,
      TextureFormatId.rgba8unorm,
      (200 << TEXTURE_MIP_LEVELS_SHIFT) >>> 0,
    );
    expect(texture(1).mipLevelCount).toBe(3);
    expect(texture(1).format).toBe('bc7-rgba-unorm');
    expect(texture(2).mipLevelCount).toBe(7);
    expect(texture(3).mipLevelCount).toBe(1);
    expect(texture(4).mipLevelCount).toBe(3);
  });

  it('uploads compressed levels as-is and validates sizes', () => {
    const { backend, registry, warnings } = setup();
    registry.create(
      1,
      8,
      4,
      TextureFormatId['bc1-rgba-unorm'],
      TextureFlag.MIPMAPS | (4 << TEXTURE_MIP_LEVELS_SHIFT),
    );
    const data = new ArrayBuffer(24);
    new Uint8Array(data).set([9, 9, 9, 9, 9, 9, 9, 9], 8);
    registry.uploadCompressed(1, 0, 8, 4, data, 0, 16);
    registry.uploadCompressed(1, 2, 2, 1, data, 8, 8);
    expect(backend.writes.map(w => [w.w, w.h, w.mip, w.bytes.length])).toEqual([
      [8, 4, 0, 16],
      [2, 1, 2, 8],
    ]);
    expect(backend.writes[1].bytes).toEqual([9, 9, 9, 9, 9, 9, 9, 9]);
    registry.uploadCompressed(1, 1, 4, 2, data, 0, 16); // needs 8
    registry.uploadCompressed(1, 4, 1, 1, data, 0, 8); // no level 4
    registry.uploadCompressed(1, 0, 8, 4, data, 16, 16); // out of range
    registry.uploadCompressed(99, 0, 1, 1, data, 0, 8);
    expect(backend.writes.length).toBe(2);
    expect(warnings.length).toBe(4);
  });

  it('premultiplies straight RGBA8 levels, keeps premultiplied ones', () => {
    const { backend, registry } = setup();
    registry.create(1, 1, 1, TextureFormatId.rgba8unorm, 0);
    registry.create(
      2,
      1,
      1,
      TextureFormatId.rgba8unorm,
      TextureFlag.PREMULTIPLIED,
    );
    const data = new Uint8Array([200, 100, 50, 128]).buffer;
    registry.uploadCompressed(1, 0, 1, 1, data, 0, 4);
    registry.uploadCompressed(2, 0, 1, 1, data, 0, 4);
    expect(backend.writes[0].bytes).toEqual([100, 50, 25, 128]);
    expect(backend.writes[1].bytes).toEqual([200, 100, 50, 128]);
    expect(new Uint8Array(data)[0]).toBe(200); // source untouched
  });

  it('copies bitmap regions without regenerating mips, and generates on request', () => {
    const { backend, registry, warnings } = setup();
    registry.create(1, 64, 64, TextureFormatId.rgba8unorm, TextureFlag.MIPMAPS);
    registry.uploadBitmapRegion(1, image(16, 16), 10, 20, false);
    expect(backend.copies).toEqual([{ x: 10, y: 20, flipY: false }]);
    expect(backend.mipGens).toBe(0);
    registry.uploadBitmapRegion(1, image(16, 16), 50, 0, false); // exceeds
    expect(backend.copies.length).toBe(1);
    registry.generateMipmaps(1);
    expect(backend.mipGens).toBe(1);
    registry.create(2, 8, 8, TextureFormatId.rgba8unorm, 0);
    registry.generateMipmaps(2); // single level: no-op
    registry.create(
      3,
      8,
      8,
      TextureFormatId['bc3-rgba-unorm'],
      TextureFlag.MIPMAPS | (4 << TEXTURE_MIP_LEVELS_SHIFT),
    );
    registry.generateMipmaps(3);
    registry.uploadBitmapRegion(3, image(4, 4), 0, 0, false);
    expect(backend.mipGens).toBe(1);
    expect(backend.copies.length).toBe(1);
    expect(warnings.length).toBe(3);
  });
});
