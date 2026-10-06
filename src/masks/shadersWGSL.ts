/**
 * Mask WGSL, loaded by core.ts with a dynamic import on WebGPU only, so
 * WebGL2 programs do not carry it (and vice versa).
 */
import maskWGSL from '../shaders/mask/mask.wgsl';
import compositeWGSL from '../shaders/mask/composite.wgsl';

export const wgsl = maskWGSL as string;
export const composite = compositeWGSL as string;
