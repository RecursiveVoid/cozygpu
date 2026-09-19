/**
 * 2D affine helpers. See ./types.ts for the layout.
 * Every function writes into `out` at `o` and returns nothing (no allocation).
 * `out` may alias an input: inputs are read into locals first.
 */
import type { Mat2DArray } from './types';

export function affineIdentity(out: Mat2DArray, o: number): void {
  out[o] = 1;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 1;
  out[o + 4] = 0;
  out[o + 5] = 0;
}

export function affineCopy(
  out: Mat2DArray,
  o: number,
  src: Mat2DArray,
  so: number,
): void {
  out[o] = src[so];
  out[o + 1] = src[so + 1];
  out[o + 2] = src[so + 2];
  out[o + 3] = src[so + 3];
  out[o + 4] = src[so + 4];
  out[o + 5] = src[so + 5];
}

/**
 * Local transform from components (Pixi order):
 *   M = T(x, y) · R(rotation) · Sk(skewX, skewY) · S(scaleX, scaleY) · T(-pivotX, -pivotY)
 */
export function affineFromTRS(
  out: Mat2DArray,
  o: number,
  x: number,
  y: number,
  rotation: number,
  scaleX: number,
  scaleY: number,
  skewX: number,
  skewY: number,
  pivotX: number,
  pivotY: number,
): void {
  let a: number;
  let b: number;
  let c: number;
  let d: number;
  if (skewX === 0 && skewY === 0) {
    if (rotation === 0) {
      a = scaleX;
      b = 0;
      c = 0;
      d = scaleY;
    } else {
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      a = cos * scaleX;
      b = sin * scaleX;
      c = -sin * scaleY;
      d = cos * scaleY;
    }
  } else {
    a = Math.cos(rotation + skewY) * scaleX;
    b = Math.sin(rotation + skewY) * scaleX;
    c = -Math.sin(rotation - skewX) * scaleY;
    d = Math.cos(rotation - skewX) * scaleY;
  }
  out[o] = a;
  out[o + 1] = b;
  out[o + 2] = c;
  out[o + 3] = d;
  out[o + 4] = x - (pivotX * a + pivotY * c);
  out[o + 5] = y - (pivotX * b + pivotY * d);
}

/** out = A · B (apply B first, then A). parentWorld · local = world. */
export function affineMultiply(
  out: Mat2DArray,
  o: number,
  a: Mat2DArray,
  ao: number,
  b: Mat2DArray,
  bo: number,
): void {
  const a0 = a[ao];
  const a1 = a[ao + 1];
  const a2 = a[ao + 2];
  const a3 = a[ao + 3];
  const a4 = a[ao + 4];
  const a5 = a[ao + 5];
  const b0 = b[bo];
  const b1 = b[bo + 1];
  const b2 = b[bo + 2];
  const b3 = b[bo + 3];
  const b4 = b[bo + 4];
  const b5 = b[bo + 5];
  out[o] = a0 * b0 + a2 * b1;
  out[o + 1] = a1 * b0 + a3 * b1;
  out[o + 2] = a0 * b2 + a2 * b3;
  out[o + 3] = a1 * b2 + a3 * b3;
  out[o + 4] = a0 * b4 + a2 * b5 + a4;
  out[o + 5] = a1 * b4 + a3 * b5 + a5;
}

/** Returns false (and leaves out untouched) when the matrix is singular. */
export function affineInvert(
  out: Mat2DArray,
  o: number,
  a: Mat2DArray,
  ao: number,
): boolean {
  const m0 = a[ao];
  const m1 = a[ao + 1];
  const m2 = a[ao + 2];
  const m3 = a[ao + 3];
  const m4 = a[ao + 4];
  const m5 = a[ao + 5];
  const det = m0 * m3 - m1 * m2;
  if (det === 0 || !Number.isFinite(det)) return false;
  const inv = 1 / det;
  out[o] = m3 * inv;
  out[o + 1] = -m1 * inv;
  out[o + 2] = -m2 * inv;
  out[o + 3] = m0 * inv;
  out[o + 4] = (m2 * m5 - m3 * m4) * inv;
  out[o + 5] = (m1 * m4 - m0 * m5) * inv;
  return true;
}

export function affineTransformX(
  m: Mat2DArray,
  o: number,
  x: number,
  y: number,
): number {
  return m[o] * x + m[o + 2] * y + m[o + 4];
}

export function affineTransformY(
  m: Mat2DArray,
  o: number,
  x: number,
  y: number,
): number {
  return m[o + 1] * x + m[o + 3] * y + m[o + 5];
}
