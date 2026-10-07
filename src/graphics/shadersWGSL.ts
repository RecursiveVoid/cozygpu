/**
 * Graphics WGSL (ARCHITECTURE §26.5), loaded by core.ts with a dynamic import
 * on WebGPU only, so WebGL2 programs do not carry it. Index = draw kind
 * (0 = SDF shapes, 1 = meshes).
 */
import meshWGSL from '../shaders/graphics/mesh.wgsl';
import shapeWGSL from '../shaders/graphics/shape.wgsl';

export const wgsl: readonly string[] = [
  shapeWGSL as string,
  meshWGSL as string,
];
