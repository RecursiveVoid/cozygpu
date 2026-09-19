/** Color packing helpers. Packed = r | g<<8 | b<<16 | a<<24. */
import { CozyGPUError } from '../types/errors';
import type { ColorSource, PackedColor } from './types';

function byte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** r, g, b, a in 0..255 → r | g<<8 | b<<16 | a<<24 (as unsigned u32). */
export function packRGBA8(
  r: number,
  g: number,
  b: number,
  a: number,
): PackedColor {
  return (byte(r) | (byte(g) << 8) | (byte(b) << 16) | (byte(a) << 24)) >>> 0;
}

/** 0xRRGGBB + alpha 0..1 → PackedColor. */
export function packHex(rgb: number, alpha: number): PackedColor {
  return (
    (((rgb >>> 16) & 0xff) |
      (((rgb >>> 8) & 0xff) << 8) |
      ((rgb & 0xff) << 16) |
      (byte(alpha * 255) << 24)) >>>
    0
  );
}

/**
 * Parses once (not for hot paths when given a string). Accepts 0xRRGGBB
 * numbers and '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' strings. `alpha`
 * (default 1) multiplies any alpha found in the string.
 */
export function toPackedColor(color: ColorSource, alpha = 1): PackedColor {
  if (typeof color === 'number') return packHex(color, alpha);
  let hex = color.trim();
  if (hex.charCodeAt(0) === 35 /* # */) hex = hex.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    let long = '';
    for (let i = 0; i < hex.length; i++) long += hex[i] + hex[i];
    hex = long;
  }
  if ((hex.length !== 6 && hex.length !== 8) || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new CozyGPUError('INVALID_ARGUMENT', `invalid color "${color}"`);
  }
  const rgb = parseInt(hex.slice(0, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return packHex(rgb, a * alpha);
}
