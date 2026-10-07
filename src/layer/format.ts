/**
 * The `src/types/layerLayouts.ts` values the lazily loaded layer chunks
 * use (front, core, interop). `layerLayouts` is public (`GPU.layerLayouts`),
 * so it sits in every importer's module graph, and a lazy chunk importing it
 * makes the bundler hoist it into a shared chunk that the minimal program
 * loads too. These copies keep it off that path; format.test.ts pins every
 * one to layerLayouts.
 */

/** Record bytes by LayerStream (LAYER_POSITION/XFORM/COLOR/USER_BYTES). */
export const STREAM_BYTES = [8, 8, 4, 4];
export const POSITION = 0;
export const XFORM = 1;
export const COLOR = 2;
export const FRAME_BYTES = 32;
/** LF_WIDTH, LF_HEIGHT, LF_ANCHOR (bytes). */
export const F_WIDTH = 16;
export const F_HEIGHT = 20;
export const F_ANCHOR = 24;
export const MAX_TEXTURES = 8;
export const INDIRECT_BYTES = 16;
export const VISIBLE_BYTES = 4;
export const CULL_WORKGROUP = 256;
