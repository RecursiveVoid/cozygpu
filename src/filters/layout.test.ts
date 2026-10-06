/**
 * Filter uniform packing (ARCHITECTURE §22.2, §22.3) and the cheap in-batch
 * effect block (§22.7). Pure logic: no GPU, no DOM.
 */
import {
  FILTER_MAX_UNIFORM_BYTES,
  FILTER_UNIFORM_OFFSET,
  SE_FLAGS,
  SE_GLOW,
  SE_MATRIX,
  SE_OFFSET,
  SE_OUTLINE_COLOR,
  SE_OUTLINE_WIDTH,
  SPRITE_EFFECT_BYTES,
  SpriteEffectFlag,
} from '../types/layouts';
import {
  concatColorMatrix,
  filterParamLayout,
  glslParamMembers,
  identityColorMatrix,
  packSpriteEffect,
  readFilterParam,
  wgslParamMembers,
  writeFilterParam,
} from './layout';

describe('filterParamLayout', () => {
  it('starts the params after the fixed prelude', () => {
    const l = filterParamLayout({ strength: 'f32' });
    expect(l.offsets[0]).toBe(FILTER_UNIFORM_OFFSET);
    expect(l.bytes).toBe(64);
  });

  it('aligns vec2/vec3/vec4/mat4 like WGSL and std140', () => {
    const l = filterParamLayout({
      a: 'f32',
      b: 'vec2f',
      c: 'vec4f',
      d: 'f32',
      e: 'vec3f',
      f: 'mat4x4f',
    });
    // 48 f32 | 56 vec2f | 64 vec4f (16-aligned) | 80 f32 | 96 vec3f | 112 mat4
    expect(Array.from(l.offsets)).toEqual([48, 56, 64, 80, 96, 112]);
    expect(l.bytes).toBe(176);
    expect(l.bytes).toBeLessThanOrEqual(FILTER_MAX_UNIFORM_BYTES);
  });

  it('keeps declaration order', () => {
    const l = filterParamLayout({ z: 'f32', a: 'f32' });
    expect(l.names).toEqual(['z', 'a']);
  });

  it('rejects a bad name, an unknown type and an oversized block', () => {
    expect(() => filterParamLayout({ Bad: 'f32' })).toThrow(/INVALID_ARGUMENT/);
    expect(() =>
      filterParamLayout({ ok: 'mat3x3f' as unknown as 'f32' }),
    ).toThrow(/INVALID_ARGUMENT/);
    const big: Record<string, 'mat4x4f'> = {};
    for (let i = 0; i < 5; i++) big[`m${i}`] = 'mat4x4f';
    expect(() => filterParamLayout(big)).toThrow(/INVALID_ARGUMENT/);
  });
});

describe('composed struct members', () => {
  it('pins every WGSL member with the size that produces its offset', () => {
    const l = filterParamLayout({ a: 'f32', b: 'vec4f' });
    expect(wgslParamMembers(l)).toBe(
      '  @size(16) a: f32,\n  @size(16) b: vec4f,\n',
    );
  });

  it('emits the GLSL twin with matching types', () => {
    const l = filterParamLayout({ a: 'f32', b: 'vec4f', c: 'mat4x4f' });
    expect(glslParamMembers(l)).toBe('  float a;\n  vec4 b;\n  mat4 c;\n');
  });
});

describe('writeFilterParam / readFilterParam', () => {
  const l = filterParamLayout({
    s: 'f32',
    n: 'u32',
    v: 'vec2f',
    c: 'vec4f',
  });
  const f32 = new Float32Array(l.bytes >> 2);
  const u32 = new Uint32Array(f32.buffer);
  const out = new Float32Array(4);

  it('round-trips scalars and vectors at their own offsets', () => {
    writeFilterParam(f32, u32, l.offsets[0], 'f32', 2.5);
    writeFilterParam(f32, u32, l.offsets[1], 'u32', 7);
    writeFilterParam(f32, u32, l.offsets[2], 'vec2f', [1, -1]);
    writeFilterParam(f32, u32, l.offsets[3], 'vec4f', [0.1, 0.2, 0.3, 0.4]);
    expect(readFilterParam(f32, u32, l.offsets[0], 'f32', out)).toBeCloseTo(
      2.5,
    );
    expect(readFilterParam(f32, u32, l.offsets[1], 'u32', out)).toBe(7);
    expect(
      Array.from(
        readFilterParam(f32, u32, l.offsets[2], 'vec2f', out) as Float32Array,
      ),
    ).toEqual([1, -1]);
    const c = readFilterParam(
      f32,
      u32,
      l.offsets[3],
      'vec4f',
      out,
    ) as Float32Array;
    expect(c.length).toBe(4);
    expect(c[3]).toBeCloseTo(0.4);
  });

  it('leaves the prelude words untouched', () => {
    for (let i = 0; i < FILTER_UNIFORM_OFFSET >> 2; i++) expect(f32[i]).toBe(0);
  });

  it('zero-fills a short vector instead of leaving stale values', () => {
    writeFilterParam(f32, u32, l.offsets[3], 'vec4f', [9, 9, 9, 9]);
    writeFilterParam(f32, u32, l.offsets[3], 'vec4f', [1, 2]);
    const c = readFilterParam(
      f32,
      u32,
      l.offsets[3],
      'vec4f',
      out,
    ) as Float32Array;
    expect(Array.from(c)).toEqual([1, 2, 0, 0]);
  });
});

describe('color matrices', () => {
  it('concatenates in "m applied after dst" order', () => {
    const dst = identityColorMatrix(new Float32Array(20));
    const scratch = new Float32Array(20);
    // First halve red, then add 0.25 to red.
    const half = identityColorMatrix(new Float32Array(20));
    half[0] = 0.5;
    concatColorMatrix(dst, half, scratch);
    const bias = identityColorMatrix(new Float32Array(20));
    bias[16] = 0.25;
    concatColorMatrix(dst, bias, scratch);
    // r' = 0.5 r + 0.25
    expect(dst[0]).toBeCloseTo(0.5);
    expect(dst[16]).toBeCloseTo(0.25);
  });
});

describe('packSpriteEffect', () => {
  const f32 = new Float32Array(SPRITE_EFFECT_BYTES >> 2);
  const u32 = new Uint32Array(f32.buffer);

  it('transposes the 4x5 matrix into the column-major GPU struct', () => {
    const rows = new Float32Array(20);
    for (let i = 0; i < 20; i++) rows[i] = i + 1;
    packSpriteEffect(f32, u32, 0, rows, 0x8040_2010, 1.5, 0.25);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(f32[(SE_MATRIX >> 2) + c * 4 + r]).toBe(rows[r * 4 + c]);
      }
      expect(f32[(SE_OFFSET >> 2) + r]).toBe(rows[16 + r]);
    }
    expect(u32[SE_OUTLINE_COLOR >> 2]).toBe(0x8040_2010);
    expect(f32[SE_OUTLINE_WIDTH >> 2]).toBeCloseTo(1.5);
    expect(f32[SE_GLOW >> 2]).toBeCloseTo(0.25);
    expect(u32[SE_FLAGS >> 2]).toBe(0);
  });

  it('sets NO_MATRIX when there is no color matrix', () => {
    packSpriteEffect(f32, u32, 0, null, 0, 2, 0);
    expect(u32[SE_FLAGS >> 2]).toBe(SpriteEffectFlag.NO_MATRIX);
    for (let i = 0; i < 16; i++) expect(f32[(SE_MATRIX >> 2) + i]).toBe(0);
  });

  it('fits the block cozygpu reserves for it', () => {
    expect(f32.byteLength).toBe(SPRITE_EFFECT_BYTES);
  });
});
