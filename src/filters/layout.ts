/**
 * Uniform layout for filter programs (ARCHITECTURE §22.2, §22.3), and the
 * packing of the cheap in-batch effect block (§22.7). Pure, DOM-free and
 * allocation-free once a layout exists, so it is unit-testable in Node.
 *
 * A filter's uniform block is the fixed prelude (layouts.ts FILTER_PASS_BYTES
 * / FP_*) followed by the filter's own params, laid out with WGSL uniform
 * rules — which are std140's rules for the types cozygpu allows, so the WGSL
 * struct and the GLSL `layout(std140)` block agree byte for byte.
 */
import { CozyGPUError } from '../types/errors';
import {
  FILTER_MAX_UNIFORM_BYTES,
  FILTER_UNIFORM_OFFSET,
  SE_FLAGS,
  SE_GLOW,
  SE_MATRIX,
  SE_OFFSET,
  SE_OUTLINE_COLOR,
  SE_OUTLINE_WIDTH,
  SpriteEffectFlag,
} from '../types/layouts';
import type { FilterParamSpec, FilterParamType } from './types';

/** Size and alignment in bytes, by param type. */
const SIZE: Record<FilterParamType, number> = {
  f32: 4,
  i32: 4,
  u32: 4,
  vec2f: 8,
  vec3f: 12,
  vec4f: 16,
  mat4x4f: 64,
};
const ALIGN: Record<FilterParamType, number> = {
  f32: 4,
  i32: 4,
  u32: 4,
  vec2f: 8,
  vec3f: 16,
  vec4f: 16,
  mat4x4f: 16,
};
const WGSL_TYPE: Record<FilterParamType, string> = {
  f32: 'f32',
  i32: 'i32',
  u32: 'u32',
  vec2f: 'vec2f',
  vec3f: 'vec3f',
  vec4f: 'vec4f',
  mat4x4f: 'mat4x4f',
};
const GLSL_TYPE: Record<FilterParamType, string> = {
  f32: 'float',
  i32: 'int',
  u32: 'uint',
  vec2f: 'vec2',
  vec3f: 'vec3',
  vec4f: 'vec4',
  mat4x4f: 'mat4',
};

const NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;

/** Prelude member names (layouts.ts FP_*): a param may not shadow one. */
const RESERVED = ['texel', 'size', 'area', 'time', 'passIndex', 'unit'];

/**
 * FILTER_DEFINE.flags bits 16–23 carry `(word index of the program's `map`
 * param) + 1`, or 0 when the program samples nothing at group 3. It lets the
 * core bind a texture chosen per frame (the displacement map) without a
 * second opcode; bits 0–15 stay the documented FilterFlag bits.
 */

export interface FilterParamLayout {
  readonly names: readonly string[];
  readonly types: readonly FilterParamType[];
  /** Byte offset of each param inside the pass uniform block. */
  readonly offsets: Int32Array;
  /** Whole block (prelude + params), rounded up to 16 B. */
  readonly bytes: number;
}

/**
 * Offsets of `spec`'s params inside the pass uniform block. Throws
 * INVALID_ARGUMENT for a bad name, an unknown type, or a block that does not
 * fit FILTER_MAX_UNIFORM_BYTES.
 */
export function filterParamLayout(spec: FilterParamSpec): FilterParamLayout {
  const names: string[] = [];
  const types: FilterParamType[] = [];
  for (const name in spec) {
    if (!NAME_RE.test(name) || RESERVED.indexOf(name) >= 0) {
      throw new CozyGPUError('INVALID_ARGUMENT', `filter param name "${name}"`);
    }
    const type = spec[name];
    if (SIZE[type] === undefined) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `filter param "${name}": unknown type "${String(type)}"`,
      );
    }
    names.push(name);
    types.push(type);
  }
  const offsets = new Int32Array(names.length);
  let at = FILTER_UNIFORM_OFFSET;
  for (let i = 0; i < types.length; i++) {
    const align = ALIGN[types[i]];
    at = Math.ceil(at / align) * align;
    offsets[i] = at;
    at += SIZE[types[i]];
  }
  const bytes = Math.ceil(at / 16) * 16;
  if (bytes > FILTER_MAX_UNIFORM_BYTES) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `filter uniforms are ${bytes} B, limit ${FILTER_MAX_UNIFORM_BYTES} B`,
    );
  }
  return { names, types, offsets, bytes };
}

/** Members of the composed WGSL `FilterPass` struct, `@size`-pinned. */
export function wgslParamMembers(layout: FilterParamLayout): string {
  let out = '';
  for (let i = 0; i < layout.names.length; i++) {
    const next =
      i + 1 < layout.names.length ? layout.offsets[i + 1] : layout.bytes;
    const size = next - layout.offsets[i];
    out += `  @size(${size}) ${layout.names[i]}: ${WGSL_TYPE[layout.types[i]]},\n`;
  }
  return out;
}

/** Members of the composed GLSL `layout(std140)` block (same offsets). */
export function glslParamMembers(layout: FilterParamLayout): string {
  let out = '';
  for (let i = 0; i < layout.names.length; i++) {
    out += `  ${GLSL_TYPE[layout.types[i]]} ${layout.names[i]};\n`;
  }
  return out;
}

/**
 * Writes one param value into the uniform mirror. `f32` and `u32` are views
 * over the same bytes; `offset` is a byte offset. Allocation-free.
 */
export function writeFilterParam(
  f32: Float32Array,
  u32: Uint32Array,
  offset: number,
  type: FilterParamType,
  value: number | ArrayLike<number>,
): void {
  const at = offset >> 2;
  switch (type) {
    case 'f32':
      f32[at] = value as number;
      return;
    case 'i32':
      u32[at] = (value as number) | 0;
      return;
    case 'u32':
      u32[at] = (value as number) >>> 0;
      return;
    default: {
      const n = SIZE[type] >> 2;
      const src = value as ArrayLike<number>;
      const count = Math.min(n, src.length ?? 0);
      for (let i = 0; i < count; i++) f32[at + i] = src[i];
      for (let i = count; i < n; i++) f32[at + i] = 0;
    }
  }
}

/** Reads a param back out of the mirror into `out` (vectors) or as a number. */
export function readFilterParam(
  f32: Float32Array,
  u32: Uint32Array,
  offset: number,
  type: FilterParamType,
  out: Float32Array,
): number | Float32Array {
  const at = offset >> 2;
  if (type === 'f32') return f32[at];
  if (type === 'i32') return u32[at] | 0;
  if (type === 'u32') return u32[at] >>> 0;
  const n = SIZE[type] >> 2;
  for (let i = 0; i < n; i++) out[i] = f32[at + i];
  return out.subarray(0, n);
}

/** Bytes a param type occupies (tests and the mirror sizing use it). */
export function filterParamBytes(type: FilterParamType): number {
  return SIZE[type];
}

// ─── Cheap in-batch effect block (ARCHITECTURE §22.7) ─────────────────────────

/** Identity 4×5 color matrix, row-major: 16 matrix values then 4 offsets. */
export function identityColorMatrix(out: Float32Array): Float32Array {
  out.fill(0, 0, 20);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

/**
 * `dst = m · dst` for two 4×5 row-major color matrices (`m` applied after
 * `dst`). `scratch` is a caller-owned 20-float buffer, so chaining helpers
 * allocates nothing.
 */
export function concatColorMatrix(
  dst: Float32Array,
  m: Float32Array,
  scratch: Float32Array,
): void {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += m[r * 4 + k] * dst[k * 4 + c];
      scratch[r * 4 + c] = v;
    }
    let o = m[16 + r];
    for (let k = 0; k < 4; k++) o += m[r * 4 + k] * dst[16 + k];
    scratch[16 + r] = o;
  }
  dst.set(scratch.subarray(0, 20));
}

/**
 * Packs a 4×5 row-major color matrix plus the outline/glow fields into the
 * SPRITE_EFFECT_BYTES block. The GPU struct is column-major, so the matrix is
 * transposed here and nowhere else.
 */
export function packSpriteEffect(
  f32: Float32Array,
  u32: Uint32Array,
  base: number,
  matrix: Float32Array | null,
  outlineColor: number,
  outlineWidth: number,
  glow: number,
): void {
  const m = (base + SE_MATRIX) >> 2;
  const o = (base + SE_OFFSET) >> 2;
  if (matrix) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) f32[m + c * 4 + r] = matrix[r * 4 + c];
      f32[o + r] = matrix[16 + r];
    }
  } else {
    for (let i = 0; i < 16; i++) f32[m + i] = 0;
    for (let i = 0; i < 4; i++) f32[o + i] = 0;
  }
  u32[(base + SE_OUTLINE_COLOR) >> 2] = outlineColor >>> 0;
  f32[(base + SE_OUTLINE_WIDTH) >> 2] = outlineWidth;
  f32[(base + SE_GLOW) >> 2] = glow;
  u32[(base + SE_FLAGS) >> 2] = matrix ? 0 : SpriteEffectFlag.NO_MATRIX;
}
