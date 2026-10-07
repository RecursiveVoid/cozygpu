/**
 * Graphics WGSL (ARCHITECTURE §26.5, §27.4), loaded by core.ts with a dynamic
 * import on WebGPU only, so WebGL2 programs do not carry it. Index = draw
 * kind (0 = SDF shapes, 1 = meshes, 2 = unified).
 */
import meshWGSL from '../shaders/graphics/mesh.wgsl';
import shapeWGSL from '../shaders/graphics/shape.wgsl';
import unifiedWGSL from '../shaders/graphics/unified.wgsl';

export const wgsl: readonly string[] = [
  shapeWGSL as string,
  meshWGSL as string,
  unifiedWGSL as string,
];
