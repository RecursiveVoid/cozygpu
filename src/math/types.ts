/**
 * Math contracts — owner: "sprites".
 * Zero-allocation, offset-based helpers so matrices can live inside large
 * shared typed arrays (SoA stores, instance buffers).
 *
 * 2D affine layout, 6 f32 at `o`:  [a, b, c, d, tx, ty]
 *   | a c tx |
 *   | b d ty |      x' = a·x + c·y + tx ;  y' = b·x + d·y + ty
 *   | 0 0 1  |
 * Same convention as the sprite instance layout and the View uniform.
 */

/** Any float array large enough for the offsets used. */
export type Mat2DArray = Float32Array | Float64Array;

export const AFFINE_SIZE = 6;

/** Packed RGBA8 color: r | g<<8 | b<<16 | a<<24 (unsigned). */
export type PackedColor = number;

/**
 * Public color input: 0xRRGGBB number (alpha from a separate field) or a
 * CSS-like hex string '#rrggbb' / '#rrggbbaa'. Strings are parsed once, never
 * per frame.
 */
export type ColorSource = number | string;
