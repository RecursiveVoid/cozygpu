import {
  affineCopy,
  affineFromTRS,
  affineIdentity,
  affineInvert,
  affineMultiply,
  affineTransformX,
  affineTransformY,
} from './affine';
import { packHex, packRGBA8, toPackedColor } from './color';

function close(actual: ArrayLike<number>, expected: number[], o = 0): void {
  for (let i = 0; i < expected.length; i++) {
    expect(actual[o + i]).toBeCloseTo(expected[i], 5);
  }
}

describe('affine', () => {
  it('identity and copy honour offsets', () => {
    const m = new Float64Array(12).fill(9);
    affineIdentity(m, 6);
    expect(Array.from(m)).toEqual([9, 9, 9, 9, 9, 9, 1, 0, 0, 1, 0, 0]);
    affineCopy(m, 0, m, 6);
    close(m, [1, 0, 0, 1, 0, 0]);
  });

  it('fromTRS: translation, scale and pivot', () => {
    const m = new Float64Array(6);
    affineFromTRS(m, 0, 10, 20, 0, 2, 3, 0, 0, 1, 1);
    close(m, [2, 0, 0, 3, 8, 17]);
    expect(affineTransformX(m, 0, 1, 1)).toBeCloseTo(10);
    expect(affineTransformY(m, 0, 1, 1)).toBeCloseTo(20);
  });

  it('fromTRS: rotation maps +x to +y (y down)', () => {
    const m = new Float64Array(6);
    affineFromTRS(m, 0, 0, 0, Math.PI / 2, 1, 1, 0, 0, 0, 0);
    expect(affineTransformX(m, 0, 1, 0)).toBeCloseTo(0);
    expect(affineTransformY(m, 0, 1, 0)).toBeCloseTo(1);
  });

  it('fromTRS: no-skew fast path equals the general skew formula', () => {
    const fast = new Float64Array(6);
    const general = new Float64Array(6);
    affineFromTRS(fast, 0, 3, 4, 1.1, 2, -0.5, 0, 0, 5, 6);
    affineFromTRS(general, 0, 3, 4, 1.1, 2, -0.5, 1e-300, 0, 5, 6);
    close(fast, Array.from(general));
  });

  it('multiply applies B first, and may alias', () => {
    const buf = new Float64Array(18);
    affineFromTRS(buf, 0, 100, 0, 0, 1, 1, 0, 0, 0, 0); // parent: translate
    affineFromTRS(buf, 6, 0, 0, 0, 2, 2, 0, 0, 0, 0); // child: scale
    affineMultiply(buf, 12, buf, 0, buf, 6);
    expect(affineTransformX(buf, 12, 1, 0)).toBeCloseTo(102);
    affineMultiply(buf, 0, buf, 0, buf, 6); // aliasing out === a
    close(buf, [2, 0, 0, 2, 100, 0]);
  });

  it('invert round-trips and rejects singular matrices', () => {
    const m = new Float32Array(18);
    affineFromTRS(m, 0, 5, -3, 0.7, 2, 0.5, 0.1, -0.2, 3, 4);
    expect(affineInvert(m, 6, m, 0)).toBe(true);
    affineMultiply(m, 12, m, 0, m, 6);
    close(m, [1, 0, 0, 1, 0, 0], 12);
    const s = new Float32Array([1, 2, 2, 4, 0, 0]);
    const out = new Float32Array(6).fill(7);
    expect(affineInvert(out, 0, s, 0)).toBe(false);
    expect(Array.from(out)).toEqual([7, 7, 7, 7, 7, 7]);
  });
});

describe('color', () => {
  it('packs r | g<<8 | b<<16 | a<<24 unsigned', () => {
    expect(packRGBA8(0x11, 0x22, 0x33, 0xff)).toBe(0xff332211);
    expect(packHex(0x112233, 1)).toBe(0xff332211);
    expect(packHex(0xff8800, 0.5)).toBe(0x800088ff);
    expect(packRGBA8(300, -5, 0, 0)).toBe(0x000000ff);
  });

  it('parses strings', () => {
    expect(toPackedColor('#112233')).toBe(0xff332211);
    expect(toPackedColor('#11223380')).toBe(0x80332211);
    expect(toPackedColor('#fff')).toBe(0xffffffff);
    expect(toPackedColor(0x112233, 0)).toBe(0x00332211);
    expect(() => toPackedColor('#zzzzzz')).toThrow();
    // bytes on disk are R G B A
    const u8 = new Uint8Array(
      new Uint32Array([toPackedColor('#01020304')]).buffer,
    );
    expect(Array.from(u8)).toEqual([1, 2, 3, 4]);
  });
});
