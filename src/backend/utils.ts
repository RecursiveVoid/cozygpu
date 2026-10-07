/**
 * Backend-agnostic helpers shared by RHI
 * implementations and the core.
 */
import type { TextureFormat } from './types';

/**
 * Bytes of one block of a compressed format (4×4 texels), or 0 when `format`
 * is not compressed. BC1/BC4/ETC2 RGB8/EAC R11 use 8 bytes, the rest 16.
 */
export function compressedBlockBytes(format: TextureFormat): number {
  switch (format) {
    case 'bc1-rgba-unorm':
    case 'bc1-rgba-unorm-srgb':
    case 'bc4-r-unorm':
    case 'etc2-rgb8unorm':
    case 'etc2-rgb8unorm-srgb':
    case 'eac-r11unorm':
      return 8;
    case 'bc3-rgba-unorm':
    case 'bc3-rgba-unorm-srgb':
    case 'bc5-rg-unorm':
    case 'bc7-rgba-unorm':
    case 'bc7-rgba-unorm-srgb':
    case 'etc2-rgba8unorm':
    case 'etc2-rgba8unorm-srgb':
    case 'eac-rg11unorm':
    case 'astc-4x4-unorm':
    case 'astc-4x4-unorm-srgb':
      return 16;
    default:
      return 0;
  }
}

/** Every compressed format in the RHI union uses 4×4 texel blocks. */
export const COMPRESSED_BLOCK_SIZE = 4;

/**
 * Bytes per texel for `writeTexture` of uncompressed formats. For compressed
 * formats this is the block size in bytes (use `textureBytesPerRow`).
 */
export function bytesPerTexel(format: TextureFormat): number {
  switch (format) {
    case 'r8unorm':
      return 1;
    case 'rgba16float':
    case 'rg32uint':
      return 8;
    case 'rgba32float':
    case 'rgba32uint':
      return 16;
    default:
      return compressedBlockBytes(format) || 4;
  }
}

/**
 * Bytes of one row of `width` texels as `writeTexture` expects them (tight,
 * no padding). Compressed: ceil(width / 4) × block bytes per block row.
 */
export function textureBytesPerRow(
  format: TextureFormat,
  width: number,
): number {
  const block = compressedBlockBytes(format);
  return block > 0
    ? Math.ceil(width / COMPRESSED_BLOCK_SIZE) * block
    : width * bytesPerTexel(format);
}

/** Total bytes of a width × height level (rows of blocks when compressed). */
export function textureByteLength(
  format: TextureFormat,
  width: number,
  height: number,
): number {
  return compressedBlockBytes(format) > 0
    ? textureBytesPerRow(format, width) *
        Math.ceil(height / COMPRESSED_BLOCK_SIZE)
    : textureBytesPerRow(format, width) * height;
}

/** Full mip chain length for a width × height texture. */
export function fullMipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/**
 * Rounds a byte size up to a multiple of 4 (WebGPU copy/write rule).
 * Arithmetic, not bitwise: storage buffers can exceed 2^31 B with
 * limits: 'max', where `& ~3` would wrap to a negative (or tiny) size.
 */
export function align4(bytes: number): number {
  return Math.ceil(bytes / 4) * 4;
}

/** Rounds a byte offset down to a multiple of 4; safe beyond 2^31. */
export function alignDown4(bytes: number): number {
  return Math.floor(bytes / 4) * 4;
}

/**
 * Dev-mode switch (error scopes, shader warnings, debug handles):
 * `options.debug`, else `globalThis.__COZYGPU_DEBUG__ === true`.
 */
export function isDebugEnabled(options: { debug?: boolean }): boolean {
  if (options.debug !== undefined) return options.debug;
  return (
    (globalThis as { __COZYGPU_DEBUG__?: unknown }).__COZYGPU_DEBUG__ === true
  );
}
