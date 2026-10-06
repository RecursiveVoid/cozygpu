/**
 * The built-in filter programs (ARCHITECTURE §22.6): blur
 * (separable Gaussian and dual Kawase), color matrix, displacement, outline
 * and glow, in WGSL and GLSL ES 3.0. Loaded lazily by the filter front the
 * first time a chain uses a built-in, so a program with only custom filters
 * never ships them.
 *
 * Shaders live in src/shaders/filter/*.wgsl and *.glsl and are imported as
 * strings. They are fragment BODIES: the front prepends the composed prelude
 * (bindings + `FilterPass`) and the core prepends the vertex stage.
 */
import blurGLSL from '../shaders/filter/blur.glsl';
import blurWGSL from '../shaders/filter/blur.wgsl';
import blurFastGLSL from '../shaders/filter/blurFast.glsl';
import blurFastWGSL from '../shaders/filter/blurFast.wgsl';
import colorMatrixGLSL from '../shaders/filter/colorMatrix.glsl';
import colorMatrixWGSL from '../shaders/filter/colorMatrix.wgsl';
import displacementGLSL from '../shaders/filter/displacement.glsl';
import displacementWGSL from '../shaders/filter/displacement.wgsl';
import glowGLSL from '../shaders/filter/glow.glsl';
import glowWGSL from '../shaders/filter/glow.wgsl';
import outlineGLSL from '../shaders/filter/outline.glsl';
import outlineWGSL from '../shaders/filter/outline.wgsl';
import { CozyGPUError } from '../types/errors';
import type { FilterDefinition } from './types';

/** Names `GPU.filters` can resolve here. */
export type BuiltinFilterName =
  | 'blur'
  | 'blurFast'
  | 'colorMatrix'
  | 'displacement'
  | 'outline'
  | 'glow';

const DEFINITIONS: Record<BuiltinFilterName, FilterDefinition> = {
  blur: {
    name: 'blur',
    params: { strength: 'f32', direction: 'vec2f' },
    defaults: { strength: 8, direction: [1, 1] },
    wgsl: blurWGSL as string,
    glsl: blurGLSL as string,
    passes: 2,
  },
  blurFast: {
    name: 'blurFast',
    params: { strength: 'f32', direction: 'vec2f' },
    defaults: { strength: 8, direction: [1, 1] },
    wgsl: blurFastWGSL as string,
    glsl: blurFastGLSL as string,
    passes: 4,
  },
  colorMatrix: {
    name: 'colorMatrix',
    params: { matrix: 'mat4x4f', offset: 'vec4f' },
    defaults: {
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      offset: [0, 0, 0, 0],
    },
    wgsl: colorMatrixWGSL as string,
    glsl: colorMatrixGLSL as string,
    passes: 1,
  },
  displacement: {
    name: 'displacement',
    params: { scale: 'vec2f', channels: 'vec2f', map: 'u32' },
    defaults: { scale: [20, 20], channels: [0, 1], map: 0 },
    wgsl: displacementWGSL as string,
    glsl: displacementGLSL as string,
    passes: 1,
  },
  outline: {
    name: 'outline',
    params: { width: 'f32', color: 'vec4f' },
    defaults: { width: 2, color: [0, 0, 0, 1] },
    wgsl: outlineWGSL as string,
    glsl: outlineGLSL as string,
    passes: 1,
    padding: 3,
  },
  glow: {
    name: 'glow',
    params: { strength: 'f32', color: 'vec4f', inner: 'f32' },
    defaults: { strength: 8, color: [1, 1, 1, 1], inner: 0 },
    wgsl: glowWGSL as string,
    glsl: glowGLSL as string,
    passes: 3,
    padding: 10,
  },
};

export function builtinFilterDefinition(
  name: BuiltinFilterName,
): FilterDefinition {
  const definition = DEFINITIONS[name];
  if (!definition) {
    throw new CozyGPUError('INVALID_ARGUMENT', `unknown filter "${name}"`);
  }
  return definition;
}
