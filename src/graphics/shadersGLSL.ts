/**
 * Graphics GLSL (ARCHITECTURE §13.3, §26.5), loaded by core.ts with a dynamic
 * import on WebGL2 only, so WebGPU programs do not carry it. Pairs of
 * (vertex, fragment) by draw kind: [shape vs, shape fs, mesh vs, mesh fs].
 * The fragment sources become the pick and mask programs with a `#define`.
 */
import meshFragGLSL from '../shaders/graphics/mesh.frag.glsl';
import meshVertGLSL from '../shaders/graphics/mesh.vert.glsl';
import shapeFragGLSL from '../shaders/graphics/shape.frag.glsl';
import shapeVertGLSL from '../shaders/graphics/shape.vert.glsl';

export const glsl: readonly string[] = [
  shapeVertGLSL as string,
  shapeFragGLSL as string,
  meshVertGLSL as string,
  meshFragGLSL as string,
];
