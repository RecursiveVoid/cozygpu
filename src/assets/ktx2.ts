/**
 * KTX2 container parser (ARCHITECTURE §15.3). Pure,
 * DOM-free, Node-tested. Reads the header, the level index and the basic
 * data format descriptor; level bytes are sliced on demand.
 *
 * Spec: https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html
 */
import type { TextureFormat } from '../backend/types';
import { CozyGPUError } from '../types/errors';
import {
  VK_FORMATS,
  VK_FORMAT_UNDEFINED,
  levelByteLength,
  mipSize,
} from './formats';

export const KTX2_IDENTIFIER = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

export const KTX2_HEADER_BYTES = 80;
export const KTX2_LEVEL_INDEX_BYTES = 24;

export const Ktx2Supercompression = {
  NONE: 0,
  BASISLZ: 1,
  ZSTD: 2,
  ZLIB: 3,
} as const;

/** DFD colorModel values that matter here. */
export const KHR_DF_MODEL_UASTC = 166;
export const KHR_DF_MODEL_ETC1S = 163;
export const KHR_DF_FLAG_ALPHA_PREMULTIPLIED = 1;

export interface Ktx2Level {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly uncompressedByteLength: number;
  readonly width: number;
  readonly height: number;
}

export interface Ktx2Info {
  readonly vkFormat: number;
  /** undefined when vkFormat is not one of the RHI formats (or 0 = Basis). */
  readonly format: TextureFormat | undefined;
  readonly width: number;
  readonly height: number;
  /** Levels actually stored (>= 1). */
  readonly levelCount: number;
  /** Header levelCount was 0: the file asks the loader to generate mips. */
  readonly generateMips: boolean;
  readonly supercompression: number;
  readonly colorModel: number;
  readonly premultiplied: boolean;
  readonly srgb: boolean;
  readonly levels: readonly Ktx2Level[];
  /** Needs `AssetsOptions.transcoder` (Basis ETC1S / UASTC, or zstd / zlib). */
  readonly needsTranscoder: boolean;
}

function fail(message: string): never {
  throw new CozyGPUError('LOAD_FAILED', `KTX2: ${message}`);
}

function u64(view: DataView, at: number): number {
  const lo = view.getUint32(at, true);
  const hi = view.getUint32(at + 4, true);
  if (hi > 0x1fffff) fail('64-bit offset out of range');
  return hi * 0x1_0000_0000 + lo;
}

export function isKtx2(data: ArrayBuffer | Uint8Array): boolean {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) {
    if (u8[i] !== KTX2_IDENTIFIER[i]) return false;
  }
  return true;
}

/** Parses and validates a KTX2 file. Throws LOAD_FAILED / UNSUPPORTED. */
export function parseKtx2(data: ArrayBuffer): Ktx2Info {
  const size = data.byteLength;
  if (size < KTX2_HEADER_BYTES || !isKtx2(data)) fail('not a KTX2 file');
  const view = new DataView(data);
  const vkFormat = view.getUint32(12, true);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const depth = view.getUint32(28, true);
  const layers = view.getUint32(32, true);
  const faces = view.getUint32(36, true);
  const headerLevels = view.getUint32(40, true);
  const supercompression = view.getUint32(44, true);
  const dfdOffset = view.getUint32(48, true);
  const dfdLength = view.getUint32(52, true);

  if (width === 0) fail('pixelWidth is 0');
  if (height === 0 || depth > 0 || layers > 0 || faces !== 1) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'KTX2: only 2D textures are supported (no 1D, 3D, arrays or cube maps)',
    );
  }
  if (supercompression > Ktx2Supercompression.ZLIB) {
    fail(`unknown supercompressionScheme ${supercompression}`);
  }
  const levelCount = Math.max(1, headerLevels);
  const maxLevels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  if (levelCount > maxLevels) fail(`levelCount ${levelCount} > ${maxLevels}`);
  if (KTX2_HEADER_BYTES + levelCount * KTX2_LEVEL_INDEX_BYTES > size) {
    fail('truncated level index');
  }

  let colorModel = 0;
  let premultiplied = false;
  let transfer = 0;
  if (dfdLength >= 4 + 24) {
    if (dfdOffset + dfdLength > size) fail('DFD out of range');
    // u32 dfdTotalSize, then the basic descriptor block header (8 B), then
    // colorModel, colorPrimaries, transferFunction, flags.
    colorModel = view.getUint8(dfdOffset + 12);
    transfer = view.getUint8(dfdOffset + 14);
    premultiplied =
      (view.getUint8(dfdOffset + 15) & KHR_DF_FLAG_ALPHA_PREMULTIPLIED) !== 0;
  }

  const format =
    vkFormat === VK_FORMAT_UNDEFINED ? undefined : VK_FORMATS[vkFormat];
  const needsTranscoder =
    vkFormat === VK_FORMAT_UNDEFINED ||
    supercompression !== Ktx2Supercompression.NONE;
  if (!needsTranscoder && format === undefined) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      `KTX2: vkFormat ${vkFormat} is not supported`,
    );
  }

  const levels: Ktx2Level[] = [];
  for (let i = 0; i < levelCount; i++) {
    const at = KTX2_HEADER_BYTES + i * KTX2_LEVEL_INDEX_BYTES;
    const byteOffset = u64(view, at);
    const byteLength = u64(view, at + 8);
    const uncompressedByteLength = u64(view, at + 16);
    if (byteOffset + byteLength > size) fail(`level ${i} out of range`);
    const w = mipSize(width, i);
    const h = mipSize(height, i);
    if (!needsTranscoder && format !== undefined) {
      const expected = levelByteLength(format, w, h);
      if (byteLength !== expected) {
        fail(
          `level ${i} is ${byteLength} B, expected ${expected} B for ${w}×${h} ${format}`,
        );
      }
    }
    levels.push({
      byteOffset,
      byteLength,
      uncompressedByteLength,
      width: w,
      height: h,
    });
  }

  return {
    vkFormat,
    format,
    width,
    height,
    levelCount,
    generateMips: headerLevels === 0,
    supercompression,
    colorModel,
    premultiplied,
    // KHR_DF_TRANSFER_SRGB = 2
    srgb: transfer === 2 || (format !== undefined && format.endsWith('-srgb')),
    levels,
    needsTranscoder,
  };
}

/** Copies each level into its own ArrayBuffer (transferable). */
export function sliceKtx2Levels(
  data: ArrayBuffer,
  info: Ktx2Info,
): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < info.levels.length; i++) {
    const level = info.levels[i];
    out.push(data.slice(level.byteOffset, level.byteOffset + level.byteLength));
  }
  return out;
}
