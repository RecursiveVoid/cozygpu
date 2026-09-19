/**
 * Tester: affine helpers against an independent 3×3 matrix implementation
 * (random, seeded), plus color packing edge cases.
 */
import {
  affineFromTRS,
  affineInvert,
  affineMultiply,
  affineTransformX,
  affineTransformY,
} from './affine';
import { packHex, packRGBA8, toPackedColor } from './color';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type M3 = number[]; // row-major 3×3
const mul = (A: M3, B: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return o;
};
const T = (x: number, y: number): M3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const S = (x: number, y: number): M3 => [x, 0, 0, 0, y, 0, 0, 0, 1];
const R = (r: number): M3 => [
  Math.cos(r),
  -Math.sin(r),
  0,
  Math.sin(r),
  Math.cos(r),
  0,
  0,
  0,
  1,
];
/** Pixi skew: x axis rotated by skewY, y axis rotated by skewX. */
const Sk = (kx: number, ky: number): M3 => [
  Math.cos(ky),
  -Math.sin(-kx),
  0,
  Math.sin(ky),
  Math.cos(-kx),
  0,
  0,
  0,
  1,
];
/** [a, b, c, d, tx, ty] ↔ | a c tx ; b d ty |. */
const toAffine = (m: M3): number[] => [m[0], m[3], m[1], m[4], m[2], m[5]];
const fromAffine = (a: ArrayLike<number>, o = 0): M3 => [
  a[o],
  a[o + 2],
  a[o + 4],
  a[o + 1],
  a[o + 3],
  a[o + 5],
  0,
  0,
  1,
];

function close(
  got: ArrayLike<number>,
  want: number[],
  o = 0,
  eps = 1e-9,
): void {
  for (let i = 0; i < want.length; i++) {
    const tol = eps * Math.max(1, Math.abs(want[i]));
    if (!(Math.abs(got[o + i] - want[i]) <= tol)) {
      throw new Error(`component ${i}: ${got[o + i]} != ${want[i]}`);
    }
  }
}

describe('affine (random, vs 3×3 reference)', () => {
  const r = rng(11);
  const rnd = (s = 10) => (r() - 0.5) * 2 * s;

  it('fromTRS = T(x,y)·R(rot)·Sk(skx,sky)·S(sx,sy)·T(-px,-py)', () => {
    const out = new Float64Array(12);
    for (let i = 0; i < 500; i++) {
      const [x, y, rot, sx, sy, px, py] = [
        rnd(100),
        rnd(100),
        rnd(7),
        rnd(3),
        rnd(3),
        rnd(50),
        rnd(50),
      ];
      const skew = i % 3 !== 0;
      const kx = skew ? rnd(1) : 0;
      const ky = skew ? rnd(1) : 0;
      affineFromTRS(out, 6, x, y, rot, sx, sy, kx, ky, px, py);
      const ref = mul(
        mul(mul(mul(T(x, y), R(rot)), Sk(kx, ky)), S(sx, sy)),
        T(-px, -py),
      );
      close(out, toAffine(ref), 6, 1e-9);
    }
  });

  it('multiply matches matrix product for every aliasing pattern', () => {
    const buf = new Float64Array(18);
    for (let i = 0; i < 300; i++) {
      const A = [rnd(), rnd(), rnd(), rnd(), rnd(100), rnd(100)];
      const B = [rnd(), rnd(), rnd(), rnd(), rnd(100), rnd(100)];
      const want = toAffine(mul(fromAffine(A), fromAffine(B)));
      for (const [ao, bo, oo] of [
        [0, 6, 12],
        [0, 6, 0],
        [0, 6, 6],
        [0, 0, 0],
      ] as const) {
        buf.set(A, ao);
        if (bo !== ao) buf.set(B, bo);
        const w =
          bo === ao ? toAffine(mul(fromAffine(A), fromAffine(A))) : want;
        affineMultiply(buf, oo, buf, ao, buf, bo);
        close(buf, w, oo, 1e-9);
      }
    }
  });

  it('invert: M·M⁻¹ = I, transforms round-trip, aliasing allowed', () => {
    const m = new Float64Array(12);
    for (let i = 0; i < 300; i++) {
      const A = [rnd(), rnd(), rnd(), rnd(), rnd(1000), rnd(1000)];
      if (Math.abs(A[0] * A[3] - A[1] * A[2]) < 1e-3) continue;
      m.set(A, 0);
      expect(affineInvert(m, 6, m, 0)).toBe(true);
      close(
        toAffine(mul(fromAffine(m, 0), fromAffine(m, 6))),
        [1, 0, 0, 1, 0, 0],
        0,
        1e-7,
      );
      const px = rnd(500);
      const py = rnd(500);
      const qx = affineTransformX(m, 0, px, py);
      const qy = affineTransformY(m, 0, px, py);
      expect(affineTransformX(m, 6, qx, qy)).toBeCloseTo(px, 5);
      expect(affineTransformY(m, 6, qx, qy)).toBeCloseTo(py, 5);
      affineInvert(m, 0, m, 0); // in place
      close(m, Array.from(m.subarray(6, 12)), 0, 1e-12);
    }
  });

  it('invert rejects non-finite matrices', () => {
    const out = new Float32Array(6).fill(3);
    expect(
      affineInvert(out, 0, new Float32Array([NaN, 0, 0, 1, 0, 0]), 0),
    ).toBe(false);
    expect(
      affineInvert(out, 0, new Float64Array([1e200, 0, 0, 1e200, 0, 0]), 0),
    ).toBe(false);
    expect(Array.from(out)).toEqual([3, 3, 3, 3, 3, 3]);
  });

  it('Float32 stores stay within f32 precision of the f64 result', () => {
    const f32 = new Float32Array(6);
    const f64 = new Float64Array(6);
    for (let i = 0; i < 200; i++) {
      const args = [
        rnd(2000),
        rnd(2000),
        rnd(7),
        rnd(4),
        rnd(4),
        rnd(1),
        rnd(1),
        rnd(64),
        rnd(64),
      ] as const;
      affineFromTRS(f32, 0, ...args);
      affineFromTRS(f64, 0, ...args);
      for (let k = 0; k < 6; k++) expect(f32[k]).toBe(Math.fround(f64[k]));
    }
  });
});

describe('color packing edge cases', () => {
  it('rounds and clamps channels; result is always an unsigned u32', () => {
    expect(packRGBA8(254.5, 0.49, 0.5, 255.4)).toBe(0xff0100ff);
    expect(packRGBA8(NaN, 0, 0, 255)).toBe(0xff000000);
    expect(packHex(0xffffff, 1)).toBe(0xffffffff);
    expect(packHex(0xffffff, 1)).toBeGreaterThan(0);
    expect(packHex(0x1abcdef, 1)).toBe(packHex(0xabcdef, 1)); // extra bits ignored
    expect(packHex(0x000000, 0.5)).toBe(0x80000000);
  });

  it('string forms agree with numeric forms', () => {
    expect(toPackedColor('#abcdef')).toBe(packHex(0xabcdef, 1));
    expect(toPackedColor('abcdef')).toBe(packHex(0xabcdef, 1));
    expect(toPackedColor('  #ABCDEF  ')).toBe(packHex(0xabcdef, 1));
    expect(toPackedColor('#abc8')).toBe(toPackedColor('#aabbcc88'));
    expect(toPackedColor('#aabbcc80', 0.5)).toBe(
      packHex(0xaabbcc, (0x80 / 255) * 0.5),
    );
    for (const bad of [
      '',
      '#',
      '#ab',
      '#abcde',
      '#abcdefa',
      '#abcdefabc',
      'red',
      '#gg0000',
    ]) {
      expect(() => toPackedColor(bad)).toThrow();
    }
  });
});
