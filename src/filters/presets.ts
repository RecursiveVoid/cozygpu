/**
 * `GPU.filters` and `GPU.defineFilter` (ARCHITECTURE
 * §22.6). This module is deliberately tiny: it only creates `Filter` handles
 * (name + uniform mirror). The shader programs live in the lazily loaded
 * `filters-builtin` chunk and are resolved when a chain is first used, so a
 * program that imports `GPU.filters` but draws nothing ships no shaders.
 */
import { toPackedColor } from '../math/color';
import type { ColorSource } from '../math/types';
import type { TextureHandle } from '../scene/types';
import { CozyGPUError } from '../types/errors';
import {
  concatColorMatrix,
  filterParamLayout,
  identityColorMatrix,
  readFilterParam,
  writeFilterParam,
} from './layout';
import type { FilterParamLayout } from './layout';
import type {
  BuiltinFilters,
  ColorMatrixFilter,
  Filter,
  FilterDefinition,
  FilterParamSpec,
  FilterParamType,
  FilterParamValue,
} from './types';

/** Built-in program names; `src/filters/builtin.ts` resolves them to shaders. */
export type BuiltinName =
  | 'blur'
  | 'blurFast'
  | 'colorMatrix'
  | 'displacement'
  | 'outline'
  | 'glow';

/**
 * @internal What `createFilterBinding` reads off a `Filter`. Every filter is
 * a `FilterImpl`; the public `Filter` interface hides all of it.
 */
export interface FilterInternal extends Filter {
  /** Built-in program to resolve lazily, or null for a custom definition. */
  readonly _builtin: BuiltinName | null;
  readonly _definition: FilterDefinition | null;
  readonly _layout: FilterParamLayout;
  /** Uniform mirror: the whole block, prelude included (zeros up to 48 B). */
  readonly _f32: Float32Array;
  readonly _u32: Uint32Array;
  /** Bumped on every `set`; the binding uploads when it moved. */
  _version: number;
  /** Extra stage px the program reads outside the group's bounds. */
  readonly _padding: number;
  /** Texture a program samples at group 3 (displacement), or null. */
  _map: TextureHandle | null;
}

class FilterImpl<P extends FilterParamSpec> implements FilterInternal {
  enabled = true;
  _version = 1;
  _map: FilterInternal['_map'] = null;
  readonly _f32: Float32Array;
  readonly _u32: Uint32Array;
  private readonly scratch = new Float32Array(4);

  constructor(
    readonly name: string,
    readonly cheap: boolean,
    readonly _builtin: BuiltinName | null,
    readonly _definition: FilterDefinition | null,
    readonly _layout: FilterParamLayout,
    readonly _padding: number,
  ) {
    const words = _layout.bytes >> 2;
    this._f32 = new Float32Array(words);
    this._u32 = new Uint32Array(this._f32.buffer);
  }

  private index(param: string): number {
    const at = this._layout.names.indexOf(param);
    if (at < 0) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `filter "${this.name}" has no param "${param}"`,
      );
    }
    return at;
  }

  set<K extends keyof P & string>(
    param: K,
    value: FilterParamValue<P[K]>,
  ): void {
    const i = this.index(param);
    writeFilterParam(
      this._f32,
      this._u32,
      this._layout.offsets[i],
      this._layout.types[i],
      value as number | ArrayLike<number>,
    );
    this._version++;
  }

  get<K extends keyof P & string>(param: K): FilterParamValue<P[K]> {
    const i = this.index(param);
    return readFilterParam(
      this._f32,
      this._u32,
      this._layout.offsets[i],
      this._layout.types[i],
      this.scratch,
    ) as FilterParamValue<P[K]>;
  }

  /** @internal Writes a value without the public type check (built-ins). */
  _write(
    param: string,
    type: FilterParamType,
    value: number | ArrayLike<number>,
  ): void {
    const i = this._layout.names.indexOf(param);
    if (i < 0) return;
    writeFilterParam(
      this._f32,
      this._u32,
      this._layout.offsets[i],
      type,
      value,
    );
    this._version++;
  }
}

/** Luminance weights (Rec. 709), as every 2D engine's saturation matrix uses. */
const LUM_R = 0.2125;
const LUM_G = 0.7154;
const LUM_B = 0.0721;

class ColorMatrixImpl
  extends FilterImpl<{ matrix: 'mat4x4f' }>
  implements ColorMatrixFilter
{
  /** 4×5 row-major: 16 matrix values then the 4 offsets. */
  private readonly rows = identityColorMatrix(new Float32Array(20));
  private readonly step = new Float32Array(20);
  private readonly scratch20 = new Float32Array(20);

  /** @internal The current 4×5 matrix (row-major); the cheap path packs it. */
  get _rows(): Float32Array {
    return this.rows;
  }

  private apply(): this {
    concatColorMatrix(this.rows, this.step, this.scratch20);
    this.flush();
    return this;
  }

  /** Pushes the 4×5 matrix into the uniform mirror (column-major + offset). */
  private flush(): void {
    const m = this.scratch20;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) m[c * 4 + r] = this.rows[r * 4 + c];
    }
    this._write('matrix', 'mat4x4f', m.subarray(0, 16));
    this._write('offset', 'vec4f', this.rows.subarray(16, 20));
  }

  private begin(): Float32Array {
    return identityColorMatrix(this.step);
  }

  saturate(amount: number): this {
    const s = amount;
    const m = this.begin();
    const ir = LUM_R * (1 - s);
    const ig = LUM_G * (1 - s);
    const ib = LUM_B * (1 - s);
    m[0] = ir + s;
    m[1] = ig;
    m[2] = ib;
    m[4] = ir;
    m[5] = ig + s;
    m[6] = ib;
    m[8] = ir;
    m[9] = ig;
    m[10] = ib + s;
    return this.apply();
  }

  brightness(amount: number): this {
    const m = this.begin();
    m[0] = amount;
    m[5] = amount;
    m[10] = amount;
    return this.apply();
  }

  contrast(amount: number): this {
    const m = this.begin();
    const o = 0.5 * (1 - amount);
    m[0] = amount;
    m[5] = amount;
    m[10] = amount;
    m[16] = o;
    m[17] = o;
    m[18] = o;
    return this.apply();
  }

  hue(degrees: number): this {
    const r = (degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const m = this.begin();
    m[0] = LUM_R + c * (1 - LUM_R) + s * -LUM_R;
    m[1] = LUM_G + c * -LUM_G + s * -LUM_G;
    m[2] = LUM_B + c * -LUM_B + s * (1 - LUM_B);
    m[4] = LUM_R + c * -LUM_R + s * 0.143;
    m[5] = LUM_G + c * (1 - LUM_G) + s * 0.14;
    m[6] = LUM_B + c * -LUM_B + s * -0.283;
    m[8] = LUM_R + c * -LUM_R + s * -(1 - LUM_R);
    m[9] = LUM_G + c * -LUM_G + s * LUM_G;
    m[10] = LUM_B + c * (1 - LUM_B) + s * LUM_B;
    return this.apply();
  }

  grayscale(): this {
    return this.saturate(0);
  }

  sepia(): this {
    const m = this.begin();
    m[0] = 0.393;
    m[1] = 0.769;
    m[2] = 0.189;
    m[4] = 0.349;
    m[5] = 0.686;
    m[6] = 0.168;
    m[8] = 0.272;
    m[9] = 0.534;
    m[10] = 0.131;
    return this.apply();
  }

  tint(color: ColorSource): this {
    const packed = toPackedColor(color);
    const m = this.begin();
    m[0] = (packed & 0xff) / 255;
    m[5] = ((packed >>> 8) & 0xff) / 255;
    m[10] = ((packed >>> 16) & 0xff) / 255;
    m[15] = ((packed >>> 24) & 0xff) / 255;
    return this.apply();
  }

  reset(): this {
    identityColorMatrix(this.rows);
    this.flush();
    return this;
  }
}

/** Unpacks a ColorSource into `out` as straight RGBA 0..1. */
function colorTo(out: Float32Array, color: ColorSource, alpha: number): void {
  const p = toPackedColor(color, alpha);
  out[0] = (p & 0xff) / 255;
  out[1] = ((p >>> 8) & 0xff) / 255;
  out[2] = ((p >>> 16) & 0xff) / 255;
  out[3] = ((p >>> 24) & 0xff) / 255;
}

const rgba = new Float32Array(4);
const vec2 = new Float32Array(2);

const CHANNEL: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };

/** Built-in filters. Each call returns a new, independent filter instance. */
export const filters: BuiltinFilters = {
  blur(options) {
    const strength = options?.strength ?? 8;
    const fast = options?.quality === 'fast';
    const axis = options?.axis ?? 'both';
    const f = new FilterImpl<{ strength: 'f32'; direction: 'vec2f' }>(
      'blur',
      false,
      fast ? 'blurFast' : 'blur',
      null,
      filterParamLayout({ strength: 'f32', direction: 'vec2f' }),
      Math.ceil(strength) + 2,
    );
    vec2[0] = axis === 'y' ? 0 : 1;
    vec2[1] = axis === 'x' ? 0 : 1;
    f.set('strength', strength);
    f.set('direction', vec2 as unknown as readonly [number, number]);
    return f;
  },

  colorMatrix(): ColorMatrixFilter {
    const f = new ColorMatrixImpl(
      'colorMatrix',
      true,
      'colorMatrix',
      null,
      filterParamLayout({ matrix: 'mat4x4f', offset: 'vec4f' }),
      0,
    );
    return f.reset();
  },

  displacement(options) {
    const f = new FilterImpl<{ scale: 'vec2f'; channels: 'vec2f' }>(
      'displacement',
      false,
      'displacement',
      null,
      filterParamLayout({ scale: 'vec2f', channels: 'vec2f', map: 'u32' }),
      0,
    );
    const scale = options.scale ?? 20;
    vec2[0] = scale;
    vec2[1] = scale;
    f.set('scale', vec2 as unknown as readonly [number, number]);
    vec2[0] = CHANNEL[options.channelX ?? 'r'] ?? 0;
    vec2[1] = CHANNEL[options.channelY ?? 'g'] ?? 1;
    f.set('channels', vec2 as unknown as readonly [number, number]);
    f._map = options.map;
    return f;
  },

  outline(options) {
    const f = new FilterImpl<{ width: 'f32'; color: 'vec4f' }>(
      'outline',
      false,
      'outline',
      null,
      filterParamLayout({ width: 'f32', color: 'vec4f' }),
      Math.ceil(options?.width ?? 2) + 1,
    );
    f.set('width', options?.width ?? 2);
    colorTo(rgba, options?.color ?? 0x000000, 1);
    f.set(
      'color',
      rgba as unknown as readonly [number, number, number, number],
    );
    return f;
  },

  glow(options) {
    const strength = options?.strength ?? 8;
    const f = new FilterImpl<{
      strength: 'f32';
      color: 'vec4f';
      inner: 'f32';
    }>(
      'glow',
      false,
      'glow',
      null,
      filterParamLayout({ strength: 'f32', color: 'vec4f', inner: 'f32' }),
      Math.ceil(strength) + 2,
    );
    f.set('strength', strength);
    colorTo(rgba, options?.color ?? 0xffffff, 1);
    f.set(
      'color',
      rgba as unknown as readonly [number, number, number, number],
    );
    f.set('inner', options?.innerStrength ?? 0);
    return f;
  },
};

const NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;

/**
 * Turns a custom filter program into a factory, the same way
 * `defineBehavior` does for Swarm. The definition is validated here (names,
 * param layout); the shader for the renderer's language is checked on first
 * use, and a filter without one is skipped with one UNSUPPORTED report.
 */
export function defineFilter<P extends FilterParamSpec>(
  definition: FilterDefinition<P>,
): () => Filter<P> {
  if (!NAME_RE.test(definition.name)) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `filter name "${definition.name}"`,
    );
  }
  if (!definition.wgsl && !definition.glsl) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `filter "${definition.name}" has neither wgsl nor glsl`,
    );
  }
  const layout = filterParamLayout(definition.params);
  return () => {
    const f = new FilterImpl<P>(
      definition.name,
      false,
      null,
      definition as FilterDefinition,
      layout,
      definition.padding ?? 0,
    );
    const defaults = definition.defaults as Record<string, never>;
    for (let i = 0; i < layout.names.length; i++) {
      const name = layout.names[i];
      const value = defaults[name];
      if (value !== undefined) {
        writeFilterParam(
          f._f32,
          f._u32,
          layout.offsets[i],
          layout.types[i],
          value as number | ArrayLike<number>,
        );
      }
    }
    return f;
  };
}
