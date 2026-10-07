/**
 * WebGL2 mirror of a record buffer for the unified graphics batch
 * (ARCHITECTURE §27.4), chunk `graphics-core`. WebGL2 has no storage buffers,
 * so the vertex shader reads records with `texelFetch` from an `rgba32uint`
 * texture, DATA_TEXTURE_WIDTH texels (16 bytes each) per row. Records do not
 * have to be a multiple of 16 bytes (a baked sprite is 40): the texture is a
 * flat array of words, and an upload of a byte range rewrites the texels it
 * covers. A CPU copy of the words supplies the bytes of partly covered
 * texels, so the wire format stays the one WebGPU uploads.
 */
import { TextureUsage } from '../backend/types';
import type { Backend, RhiTexture } from '../backend/types';

/** Texels per row; the GLSL shaders use `& 1023u` and `>> 10u`. */
export const DATA_TEXTURE_WIDTH = 1024;
const TEXEL_WORDS = 4;

export class DataTexture {
  readonly texture: RhiTexture;
  readonly words: Uint32Array;
  private readonly bytes: Uint8Array;

  /** Holds at least `byteLength` bytes. */
  constructor(backend: Backend, byteLength: number, label: string) {
    const texels = Math.max(1, Math.ceil(byteLength / (4 * TEXEL_WORDS)));
    const rows = Math.ceil(texels / DATA_TEXTURE_WIDTH);
    const width = rows > 1 ? DATA_TEXTURE_WIDTH : texels;
    this.texture = backend.createTexture({
      label,
      width,
      height: rows,
      format: 'rgba32uint',
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
    });
    this.words = new Uint32Array(width * rows * TEXEL_WORDS);
    this.bytes = new Uint8Array(this.words.buffer);
  }

  get byteLength(): number {
    return this.bytes.byteLength;
  }

  /** Copies `n` bytes of `src` at `at` to byte `dst`, then uploads the texels. */
  write(
    backend: Backend,
    dst: number,
    src: Uint8Array,
    at: number,
    n: number,
  ): void {
    if (n <= 0 || dst + n > this.bytes.byteLength) return;
    this.bytes.set(src.subarray(at, at + n), dst);
    const width = this.texture.width;
    const t0 = dst >> 4;
    const t1 = (dst + n + 15) >> 4;
    const row0 = (t0 / width) | 0;
    const row1 = ((t1 - 1) / width) | 0;
    const words = this.words;
    if (row0 === row1) {
      backend.writeTexture(
        this.texture,
        words.subarray(t0 * TEXEL_WORDS, t1 * TEXEL_WORDS),
        t0 - row0 * width,
        row0,
        t1 - t0,
        1,
      );
    } else {
      backend.writeTexture(
        this.texture,
        words.subarray(row0 * width * TEXEL_WORDS, (row1 + 1) * width * 4),
        0,
        row0,
        width,
        row1 - row0 + 1,
      );
    }
  }

  destroy(): void {
    this.texture.destroy();
  }
}
