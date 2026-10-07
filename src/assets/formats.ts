/**
 * Texture format tables shared by the KTX2 parser, target
 * selection and the GPU byte estimate. Pure (Node-testable).
 */
import type { Capabilities, TextureFormat } from '../backend/types';
import { bytesPerTexel } from '../backend/utils';
import type { TranscodeTarget } from './types';

/** Vulkan VkFormat values found in KTX2 files → RHI formats. */
export const VK_FORMATS: Readonly<Record<number, TextureFormat>> = {
  37: 'rgba8unorm', // R8G8B8A8_UNORM
  43: 'rgba8unorm-srgb', // R8G8B8A8_SRGB
  131: 'bc1-rgba-unorm', // BC1_RGB_UNORM_BLOCK (alpha = 1)
  132: 'bc1-rgba-unorm-srgb',
  133: 'bc1-rgba-unorm',
  134: 'bc1-rgba-unorm-srgb',
  137: 'bc3-rgba-unorm',
  138: 'bc3-rgba-unorm-srgb',
  139: 'bc4-r-unorm',
  141: 'bc5-rg-unorm',
  145: 'bc7-rgba-unorm',
  146: 'bc7-rgba-unorm-srgb',
  147: 'etc2-rgb8unorm',
  148: 'etc2-rgb8unorm-srgb',
  151: 'etc2-rgba8unorm',
  152: 'etc2-rgba8unorm-srgb',
  153: 'eac-r11unorm',
  155: 'eac-rg11unorm',
  157: 'astc-4x4-unorm',
  158: 'astc-4x4-unorm-srgb',
};

export const VK_FORMAT_UNDEFINED = 0;

/** Block family of a format (drives caps checks). */
export type FormatFamily = 'none' | 'bc' | 'bc7' | 'etc2' | 'astc';

export function formatFamily(format: TextureFormat): FormatFamily {
  if (format.startsWith('bc7')) return 'bc7';
  if (format.startsWith('bc')) return 'bc';
  if (format.startsWith('etc2') || format.startsWith('eac')) return 'etc2';
  if (format.startsWith('astc')) return 'astc';
  return 'none';
}

export function isCompressedFormat(format: TextureFormat): boolean {
  return formatFamily(format) !== 'none';
}

/** Bytes per block (compressed: 4×4 blocks) or per texel (uncompressed). */
export function blockBytes(format: TextureFormat): number {
  // One table for the whole library (backend/utils): a private copy here
  // drifted once (rg32uint was 4 B instead of 8).
  return bytesPerTexel(format);
}

/** Exact byte length of one mip level of `width × height` texels. */
export function levelByteLength(
  format: TextureFormat,
  width: number,
  height: number,
): number {
  if (isCompressedFormat(format)) {
    return Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes(format);
  }
  return width * height * blockBytes(format);
}

/** Size of mip `level` (never below 1). */
export function mipSize(size: number, level: number): number {
  return Math.max(1, size >> level);
}

export function supportsFormat(
  caps: Capabilities,
  format: TextureFormat,
): boolean {
  switch (formatFamily(format)) {
    case 'bc':
      return caps.textureCompression.bc;
    case 'bc7':
      return caps.textureCompression.bc7;
    case 'etc2':
      return caps.textureCompression.etc2;
    case 'astc':
      return caps.textureCompression.astc;
    default:
      return true;
  }
}

/**
 * Transcoder targets ordered by preference from caps:
 * astc > bc7 > etc2 > bc3 > bc1 > rgba8 (rgba8 always last and present).
 */
export function transcodeTargets(caps: Capabilities): TranscodeTarget[] {
  const out: TranscodeTarget[] = [];
  const c = caps.textureCompression;
  if (c.astc) out.push('astc-4x4-unorm');
  if (c.bc7) out.push('bc7-rgba-unorm');
  if (c.etc2) out.push('etc2-rgba8unorm', 'etc2-rgb8unorm');
  if (c.bc) out.push('bc3-rgba-unorm', 'bc1-rgba-unorm');
  out.push('rgba8unorm');
  return out;
}

/** Estimated GPU bytes of an uncompressed RGBA8 texture (ARCHITECTURE §15.7). */
export function rgba8Bytes(
  width: number,
  height: number,
  mipmaps: boolean,
): number {
  const base = width * height * 4;
  return mipmaps ? Math.ceil((base * 4) / 3) : base;
}
