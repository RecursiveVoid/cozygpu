/**
 * Owner: "sprites". Sprite WGSL, loaded by core.ts with a dynamic import on
 * WebGPU only, so WebGL2 programs do not carry it (and vice versa).
 */
import spriteWGSL from '../shaders/sprite/sprite.wgsl';

export const wgsl = spriteWGSL as string;
