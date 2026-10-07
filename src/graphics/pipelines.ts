/**
 * Graphics pipeline descriptors (ARCHITECTURE §26.5). The vertex layouts
 * mirror layouts.ts: the SDF shape instance (GS_*), the mesh vertex (GMV_*)
 * and the node record (GN_*). Locations match src/shaders/graphics/*.
 */
import type {
  BlendMode,
  StencilState,
  VertexBufferLayout,
} from '../backend/types';
import {
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GMV_COLOR,
  GMV_X,
  GN_A,
  GN_COLOR,
  GN_FLAGS,
  GN_TX,
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_W,
  GS_STROKE,
  GS_STROKE_IN,
  GS_TX,
} from '../types/gfxLayouts';

/** One instance per SDF shape (triangle-strip quad from the vertex index). */
export const GFX_SHAPE_LAYOUT: VertexBufferLayout = {
  stride: GFX_SHAPE_BYTES,
  stepMode: 'instance',
  attributes: [
    { location: 0, format: 'float32x4', offset: GS_A },
    { location: 1, format: 'float32x2', offset: GS_TX },
    // halfW, halfH, p0, p1
    { location: 2, format: 'float32x4', offset: GS_HALF_W },
    // strokeIn, strokeOut
    { location: 3, format: 'float32x2', offset: GS_STROKE_IN },
    { location: 4, format: 'unorm8x4', offset: GS_FILL },
    { location: 5, format: 'unorm8x4', offset: GS_STROKE },
    { location: 6, format: 'uint32', offset: GS_FLAGS },
  ],
};

/** Buffer 0: mesh vertices; buffer 1: node records (one per instance). */
export const GFX_MESH_LAYOUTS: VertexBufferLayout[] = [
  {
    stride: GFX_MESH_VERTEX_BYTES,
    stepMode: 'vertex',
    attributes: [
      { location: 0, format: 'float32x2', offset: GMV_X },
      { location: 1, format: 'unorm8x4', offset: GMV_COLOR },
    ],
  },
  {
    stride: GFX_NODE_BYTES,
    stepMode: 'instance',
    attributes: [
      { location: 2, format: 'float32x4', offset: GN_A },
      { location: 3, format: 'float32x2', offset: GN_TX },
      { location: 4, format: 'unorm8x4', offset: GN_COLOR },
      { location: 5, format: 'uint32', offset: GN_FLAGS },
    ],
  },
];

/** Index = BlendModeId. */
export const GFX_BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'add',
  'multiply',
  'screen',
  'none',
];

/**
 * Stencil mask geometry (GfxDrawFlag.MASK_WRITE, ARCHITECTURE §26.8): where
 * the buffer equals the current level, raise it by one.
 */
export const GFX_MASK_STENCIL: StencilState = {
  compare: 'equal',
  passOp: 'increment-clamp',
};

/** Pipeline variants per draw kind: 0–4 = BlendModeId, then these two. */
export const GFX_VARIANT_MASK = 5;
export const GFX_VARIANT_PICK = 6;
export const GFX_VARIANTS = 7;

/** Draw kinds. */
export const GFX_KIND_SHAPES = 0;
export const GFX_KIND_MESH = 1;

/**
 * The pipeline variant a draw uses: the pick variant in the pick pass, the
 * stencil-write variant for mask geometry, otherwise its blend mode (an
 * unknown id draws 'normal'). -1: the draw is not drawn in this pass (mask
 * geometry is invisible to picking).
 */
export function gfxVariant(
  blendModeId: number,
  maskWrite: boolean,
  pick: boolean,
): number {
  if (pick) return maskWrite ? -1 : GFX_VARIANT_PICK;
  if (maskWrite) return GFX_VARIANT_MASK;
  return blendModeId >= 0 && blendModeId < GFX_BLEND_MODES.length
    ? blendModeId
    : 0;
}
