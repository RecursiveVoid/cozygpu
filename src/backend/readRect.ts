/**
 * The texel-readback rect check, shared by
 * the two readback-ring chunks (which also serve `readTexture`). A module of
 * its own, not in ./utils: utils is on the minimal program and this is not.
 */
import { CozyGPUError } from '../types/errors';
import type { RhiTexture, TextureFormat } from './types';
import { compressedBlockBytes } from './utils';

/**
 * M2.5. Checks a texel readback (readTexture and the readback ring, both
 * backends): the rect must lie inside mip 0, and compressed, depth and
 * multisampled textures cannot be read. `extra` adds a backend's own
 * unreadable format (WebGL2: rgba16float).
 */
export function checkReadRect(
  tex: RhiTexture,
  x: number,
  y: number,
  width: number,
  height: number,
  extra?: TextureFormat,
): void {
  if (
    x < 0 ||
    y < 0 ||
    width < 0 ||
    height < 0 ||
    x + width > tex.width ||
    y + height > tex.height
  ) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `readTexture rect ${x},${y} ${width}×${height} is outside texture "${tex.label ?? ''}" (${tex.width}×${tex.height})`,
    );
  }
  const format = tex.format;
  if (
    compressedBlockBytes(format) > 0 ||
    format.startsWith('depth') ||
    format === extra ||
    tex.sampleCount > 1
  ) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      `readTexture: ${tex.sampleCount > 1 ? 'multisampled' : format} textures cannot be read back`,
    );
  }
}
