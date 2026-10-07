/**
 * SpriteLayer GLSL (ARCHITECTURE §13.3, §28.3), chunk `layer-glsl`, loaded
 * by core.ts on WebGL2 only: [vertex, fragment]. The core inserts the
 * stream and PICK `#define`s.
 */
import fragGLSL from '../shaders/layer/layer.frag.glsl';
import vertGLSL from '../shaders/layer/layer.vert.glsl';

export const glsl: readonly string[] = [vertGLSL as string, fragGLSL as string];
