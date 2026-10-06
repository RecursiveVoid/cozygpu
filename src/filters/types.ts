/**
 * Filters public API (M3), implemented in src/filters/**. Spec:
 * docs/ARCHITECTURE.md §22 and docs/API.md "Filters".
 *
 * A filter chain runs on a `Group`: the subtree is drawn into a pooled
 * offscreen target, 1..n full-screen passes run over it, and the result is
 * composited back where the group sat. Targets are pooled by (size, format)
 * and reused across frames and groups, so a steady-state frame allocates
 * nothing.
 *
 * Chains whose every entry is CHEAP (`FilterDescriptor.cheap`) never take a
 * target at all: they compile into the sprite batch's effect block
 * (layouts.ts SPRITE_EFFECT_BYTES), so a tint/saturation/outline costs one
 * uniform, no pass and no allocation (§22.7).
 *
 * No WebGPU/WebGL types here; the core half talks through the FILTER opcode
 * range (0x05).
 */
import type { BlendMode } from '../backend/types';
import type { ColorSource } from '../math/types';
import type { ContainerNode } from '../scene/types';
import type { FrontFrame } from '../types/core';

export type FilterParamType =
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2f'
  | 'vec3f'
  | 'vec4f'
  | 'mat4x4f';

export type FilterParamSpec = Readonly<Record<string, FilterParamType>>;

export type FilterParamValue<T extends FilterParamType> = T extends 'vec2f'
  ? readonly [number, number]
  : T extends 'vec3f'
    ? readonly [number, number, number]
    : T extends 'vec4f'
      ? readonly [number, number, number, number]
      : T extends 'mat4x4f'
        ? ArrayLike<number>
        : number;

export type FilterParamValues<P extends FilterParamSpec> = {
  [K in keyof P]: FilterParamValue<P[K]>;
};

/**
 * A custom filter program. One definition = one fragment shader run over the
 * captured target, repeated `passes` times (the pass index is in the uniform
 * prelude, layouts.ts FP_PASS), ping-ponging between two pooled targets.
 *
 * Both languages are optional but a renderer needs the one its backend speaks
 * (`caps.shaderLanguage`); a filter without it reports UNSUPPORTED once and
 * is skipped (the rest of the chain still runs).
 *
 * Shader contract (normative, ARCHITECTURE §22.3):
 *  - WGSL: `fn fs_main(@builtin(position) pos: vec4f, @location(0) uv: vec2f)
 *    -> @location(0) vec4f`. The vertex stage is supplied by cozygpu (a
 *    full-screen triangle). Bindings: `@group(0) @binding(0) var<uniform>
 *    view: View`, `@group(1) @binding(0) var src: texture_2d<f32>`,
 *    `@group(1) @binding(1) var srcSampler: sampler`,
 *    `@group(2) @binding(0) var<uniform> fpass: FilterPass`.
 *  - GLSL ES 3.0: same bindings under the `G{group}_B{binding}` convention,
 *    `in vec2 vUv;` and `layout(location = 0) out vec4 fragColor;`.
 *  - Input and output are PREMULTIPLIED alpha, in physical pixels.
 *
 * Details that differ from the first draft of §22.3, in both languages:
 *  - the pass uniform is named `fpass`, because `pass` is a WGSL keyword;
 *  - params are flattened into the same block after the prelude, so
 *    `$params.<name>` rewrites to `fpass.<name>`;
 *  - read the source through `cozySample(uv)`, not textureSample/texture:
 *    `uv` is top-left in both languages and the helper does the GL v-flip.
 *    `@group(3)` holds the group's untouched capture (or the displacement
 *    map named by a `map` param, opcodes.ts FILTER_MAP_*) and is read
 *    through `cozySampleAux(uv)`;
 *  - a param may not shadow a prelude member (`texel`, `size`, `area`,
 *    `time`, `passIndex`, `unit`); `defineFilter` throws INVALID_ARGUMENT
 *    for those, and for a definition with neither `wgsl` nor `glsl`;
 *  - `fpass.unit` (layouts.ts FP_UNIT) is the css-px-to-target-px scale, so
 *    a strength or width expressed in stage pixels means the same thing at
 *    any device pixel ratio and any `filterOptions.resolution`.
 */
export interface FilterDefinition<P extends FilterParamSpec = FilterParamSpec> {
  /** Unique per renderer; /^[a-z][a-zA-Z0-9_]*$/. */
  readonly name: string;
  readonly params: P;
  readonly defaults: FilterParamValues<P>;
  /** Fragment body (WGSL). */
  readonly wgsl?: string;
  /** Fragment body (GLSL ES 3.0). */
  readonly glsl?: string;
  /** Passes over the captured target. Default 1, at most FILTER_MAX_PASSES. */
  readonly passes?: number;
  /**
   * Extra pixels kept around the group's bounds, in stage px, so the filter
   * can read outside its own pixels (blur radius, outline width). Default 0.
   */
  readonly padding?: number;
  /** Render the passes at half resolution (cheap blurs). Default false. */
  readonly halfResolution?: boolean;
}

/** An instance of a filter in a chain; `set` updates its uniform mirror. */
export interface Filter<P extends FilterParamSpec = FilterParamSpec> {
  readonly name: string;
  /**
   * True when this filter can run inside the sprite batch instead of a
   * render target (§22.7). Built-in color matrix and outline filters set it;
   * custom filters never do.
   */
  readonly cheap: boolean;
  set<K extends keyof P & string>(
    param: K,
    value: FilterParamValue<P[K]>,
  ): void;
  get<K extends keyof P & string>(param: K): FilterParamValue<P[K]>;
  /** Skip this filter without removing it from the chain. Default false. */
  enabled: boolean;
}

/** Built-in color matrix filter: chainable, cheap, no render target. */
export interface ColorMatrixFilter extends Filter<{ matrix: 'mat4x4f' }> {
  /** 0 = grayscale, 1 = unchanged, > 1 = more saturated. */
  saturate(amount: number): this;
  brightness(amount: number): this;
  contrast(amount: number): this;
  /** Degrees. */
  hue(degrees: number): this;
  grayscale(): this;
  sepia(): this;
  /** Multiply by a color. */
  tint(color: ColorSource): this;
  /** Back to the identity matrix. */
  reset(): this;
}

/** `GPU.filters` (src/filters/presets.ts). Every factory returns a Filter. */
export interface BuiltinFilters {
  /**
   * Separable Gaussian blur; `quality: 'fast'` switches to dual Kawase
   * (down/up sampling), which is much cheaper for large radii.
   * `strength` is the radius in stage px. Not cheap: takes a target.
   */
  blur(options?: {
    strength?: number;
    quality?: 'fast' | 'good';
    /** Blur only along x or y. Default both. */
    axis?: 'x' | 'y' | 'both';
  }): Filter<{ strength: 'f32'; direction: 'vec2f' }>;
  /** Cheap: compiles into the sprite batch when it is the whole chain. */
  colorMatrix(): ColorMatrixFilter;
  /** Offsets each texel by a channel of `map`, scaled by `scale` (stage px). */
  displacement(options: {
    map: import('../scene/types').TextureHandle;
    scale?: number;
    channelX?: 'r' | 'g' | 'b' | 'a';
    channelY?: 'r' | 'g' | 'b' | 'a';
  }): Filter<{ scale: 'vec2f'; channels: 'vec2f' }>;
  /**
   * Solid outline around opaque texels. Cheap for MSDF text (it becomes the
   * batch effect's outline, §22.7); otherwise a one-pass filter with padding.
   */
  outline(options?: {
    width?: number;
    color?: ColorSource;
    quality?: number;
  }): Filter<{ width: 'f32'; color: 'vec4f' }>;
  /** Blur + additive composite of the bright parts. */
  glow(options?: {
    strength?: number;
    color?: ColorSource;
    innerStrength?: number;
  }): Filter<{ strength: 'f32'; color: 'vec4f'; inner: 'f32' }>;
}

/** Per-group filter settings (`GroupNode.filterOptions`). */
export interface FilterOptions {
  /**
   * Resolution of the offscreen targets relative to the renderer's
   * resolution (DPR). Default 1. 0.5 halves both dimensions — a common,
   * large win for blurs.
   */
  resolution?: number;
  /**
   * Clip the captured area to this rectangle in the group's parent space
   * (stage px). Default: the group's own bounds grown by the chain's
   * padding, clipped to the canvas.
   */
  area?: { x: number; y: number; width: number; height: number };
  /** Blend mode of the composite draw. Default 'normal'. */
  blendMode?: BlendMode;
  /**
   * Keep the target's contents between frames (feedback effects such as
   * trails). Default false.
   */
  keepTarget?: boolean;
}

/**
 * @internal Front half of a group's filter chain, created by the lazily
 * imported filters chunk (`createFilterBinding`, src/filters/filters.ts).
 */
export interface FilterBinding {
  update(filters: readonly Filter[] | null, options?: FilterOptions): void;
  /** True when the whole chain compiled into the sprite batch effect (§22.7). */
  readonly cheap: boolean;
  emitBegin(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): boolean;
  emitEnd(frame: FrontFrame): void;
  destroy(): void;
}

/** @internal Entry point of the filters chunk. */
export type CreateFilterBinding = (group: ContainerNode) => FilterBinding;
