/**
 * SpriteLayer WGSL (ARCHITECTURE §28.3), chunk `layer-wgsl`, loaded by
 * core.ts on WebGPU only: [render, cull]. The core prepends the STREAMS
 * constant per pipeline.
 */
import cullWGSL from '../shaders/layer/cull.wgsl';
import layerWGSL from '../shaders/layer/layer.wgsl';

export const wgsl: readonly string[] = [
  layerWGSL as string,
  cullWGSL as string,
];
