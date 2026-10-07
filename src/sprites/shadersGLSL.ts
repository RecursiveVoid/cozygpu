/**
 * Sprite GLSL (ARCHITECTURE §13.3), loaded by core.ts with
 * a dynamic import on WebGL2 only, so WebGPU programs do not carry it.
 */
import spriteFragGLSL from '../shaders/sprite/sprite.frag.glsl';
import spritePickGLSL from '../shaders/sprite/sprite.pick.frag.glsl';
import spriteVertGLSL from '../shaders/sprite/sprite.vert.glsl';

export const vertex = spriteVertGLSL as string;
export const fragment = spriteFragGLSL as string;
export const pick = spritePickGLSL as string;
