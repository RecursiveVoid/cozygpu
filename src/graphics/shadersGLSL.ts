/**
 * Graphics GLSL (ARCHITECTURE §13.3, §26.5, §27.4), loaded by core.ts with a
 * dynamic import on WebGL2 only, so WebGPU programs do not carry it. Pairs of
 * (vertex, fragment): [mesh vs, mesh fs, unified vs, unified fs]. WebGL2
 * draws SDF shapes through the unified batch only. The fragment sources
 * become the pick and mask programs with a `#define`.
 */
import meshFragGLSL from '../shaders/graphics/mesh.frag.glsl';
import meshVertGLSL from '../shaders/graphics/mesh.vert.glsl';
import unifiedFragGLSL from '../shaders/graphics/unified.frag.glsl';
import unifiedVertGLSL from '../shaders/graphics/unified.vert.glsl';

export const glsl: readonly string[] = [
  meshVertGLSL as string,
  meshFragGLSL as string,
  unifiedVertGLSL as string,
  unifiedFragGLSL as string,
];
