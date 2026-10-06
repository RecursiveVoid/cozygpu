/**
 * Mask GLSL (ARCHITECTURE §13.3), loaded by core.ts with a dynamic import on
 * WebGL2 only, so WebGPU programs do not carry it.
 */
import maskAlphaFragGLSL from '../shaders/mask/mask.alpha.frag.glsl';
import maskFragGLSL from '../shaders/mask/mask.frag.glsl';
import maskVertGLSL from '../shaders/mask/mask.vert.glsl';
import compositeFragGLSL from '../shaders/mask/composite.frag.glsl';
import compositeInvertFragGLSL from '../shaders/mask/composite.invert.frag.glsl';
import compositeVertGLSL from '../shaders/mask/composite.vert.glsl';

export const vertex = maskVertGLSL as string;
export const fragment = maskFragGLSL as string;
export const alphaFragment = maskAlphaFragGLSL as string;
export const compositeVertex = compositeVertGLSL as string;
export const compositeFragment = compositeFragGLSL as string;
export const compositeInvertFragment = compositeInvertFragGLSL as string;
