/**
 * SpriteLayer GPU memory layouts (M5, ARCHITECTURE §28). Kept out of
 * `layouts.ts` because only SpriteLayer code reads them (a constant a lazy
 * chunk imports from a minimal-path module lands on the minimal path,
 * §26.9). Public as `GPU.layerLayouts`, for code that fills layer streams
 * itself (an ECS writing columns, a compute pass writing an external
 * buffer). The shaders in src/layer/** must match these exactly.
 *
 * A layer stores each per-instance field group in its own stream (its own
 * GPU buffer), so a commit that only moved sprites uploads positions only,
 * and a layer that never sets colors or user ids carries no such streams:
 *
 *   stream     bytes  contents                                   absent →
 *   POSITION   8      f32 x, f32 y (layer space, the quad anchor)  required
 *   XFORM      8      f16 scaleX, f16 scaleY, u16 rotation, u16 frame
 *                                                          scale 1, rot 0, frame 0
 *   COLOR      4      u32 RGBA8 straight (tint × alpha)      opaque white
 *   USER       4      u32 user id (PickHit.userId)           0
 *
 * 1M sprites are 8 MB with positions only and 24 MB with every stream.
 * Instance index = draw order inside the layer. COLOR alpha 0 hides an
 * instance (culling drops it).
 */

/** Stream indices (LAYER_UPLOAD.stream). */
export const LayerStream = {
  POSITION: 0,
  XFORM: 1,
  COLOR: 2,
  USER: 3,
} as const;
/** LAYER_CREATE.streams bits: `1 << LayerStream.*`. POSITION is always set. */
export const LayerStreamBit = {
  POSITION: 1 << 0,
  XFORM: 1 << 1,
  COLOR: 1 << 2,
  USER: 1 << 3,
} as const;
export const LAYER_STREAM_COUNT = 4;

// ─── POSITION — 8 B (WebGL2 attribute: float32x2) ─────────────────────────────
export const LAYER_POSITION_BYTES = 8;
export const LP_X = 0; // f32
export const LP_Y = 4; // f32

// ─── XFORM — 8 B (WebGL2 attribute: uint16x4, decoded in the shader) ─────────
export const LAYER_XFORM_BYTES = 8;
/** f16 scale x (multiplies the frame width; negative mirrors). */
export const LX_SCALE_X = 0;
/** f16 scale y. */
export const LX_SCALE_Y = 2;
/** u16 rotation in turns × LAYER_ROTATION_UNITS (clockwise, y down). */
export const LX_ROTATION = 4;
/** u16 index into the layer's frame table. */
export const LX_FRAME = 6;
/** u16 rotation units per full turn (one unit ≈ 0.0055°). */
export const LAYER_ROTATION_UNITS = 65536;

// ─── COLOR — 4 B (WebGL2 attribute: unorm8x4) ─────────────────────────────────
export const LAYER_COLOR_BYTES = 4;

// ─── USER — 4 B (WebGL2 attribute: uint32) ────────────────────────────────────
export const LAYER_USER_BYTES = 4;

// ─── Frame record — 32 B (LAYER_SET_FRAMES; storage / data texture) ──────────
export const LAYER_FRAME_BYTES = 32;
/** f32 uv rect in the slot's texture, 0..1. */
export const LF_U0 = 0;
export const LF_V0 = 4;
export const LF_U1 = 8;
export const LF_V1 = 12;
/** f32 frame size in px (the quad size at scale 1). */
export const LF_WIDTH = 16;
export const LF_HEIGHT = 20;
/** u32 anchor: unorm16 x | unorm16 y << 16 (0..1 of the frame). */
export const LF_ANCHOR = 24;
/** u32 texture slot (index into LAYER_SET_TEXTURES). */
export const LF_SLOT = 28;
/** Frames per layer (LX_FRAME is a u16). */
export const LAYER_MAX_FRAMES = 65536;
/** Texture slots per layer: all of them stay in one draw. */
export const LAYER_MAX_TEXTURES = 8;

// ─── Culling (WebGPU) ─────────────────────────────────────────────────────────
/**
 * Indirect draw arguments — 16 B: u32 vertexCount, instanceCount,
 * firstVertex, firstInstance (the WebGPU drawIndirect layout). Written by
 * LAYER_CULL, or supplied by the caller as an external 'draw-indirect'
 * buffer so a GPU-side count never needs a readback.
 */
export const LAYER_INDIRECT_BYTES = 16;
/** u32 visible instance index per culled instance (the cull output list). */
export const LAYER_VISIBLE_BYTES = 4;
/** Cull workgroup size (instances per workgroup). */
export const LAYER_CULL_WORKGROUP = 256;
