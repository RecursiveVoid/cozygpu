/**
 * SpriteLayer opcodes (M5, ARCHITECTURE §28). The range is
 * `OpcodeRange.SPRITE_LAYER` (0x08) in `opcodes.ts`; the values live here
 * because only the lazily loaded layer chunks use them. Layer ids come from
 * `ids.node` (the layer node's id doubles as its pick id). Every upload is
 * re-sent by the front after a device loss; the core keeps no CPU copies.
 * Stream indices, record sizes and the frame record are in
 * `src/types/layerLayouts.ts`.
 */
export const LayerOp = {
  /**
   * u32 layerId, u32 capacity (instances), u32 streams (LayerStreamBit
   * mask: which per-instance streams exist), u32 flags (LayerFlag),
   * u32 blendModeId. Creates the layer, or updates an existing one. With
   * the same capacity and streams the stream buffers and their contents are
   * kept (only blend and cull flags change; the cull outputs are allocated
   * or freed). Otherwise the streams are re-created and their contents are
   * undefined (the front re-uploads).
   */
  LAYER_CREATE: 0x0800,
  /** u32 layerId */
  LAYER_DESTROY: 0x0801,
  /**
   * u32 layerId, u32 stream (LayerStream), u32 first, u32 count,
   * u8[count × stream record bytes] (padded to 4).
   */
  LAYER_UPLOAD: 0x0802,
  /**
   * u32 layerId, u32 stream (LayerStream), u32 first, u32 count,
   * u32 sharedId, u32 byteOffset — zero-copy upload from a registered
   * (Shared)ArrayBuffer: the layer's own stream store or a caller column
   * whose memory already has the stream's record layout (§28.4).
   */
  LAYER_UPLOAD_SHARED: 0x0803,
  /** u32 layerId, u32 count (≤ LAYER_MAX_FRAMES), u8[count × LAYER_FRAME_BYTES] */
  LAYER_SET_FRAMES: 0x0804,
  /**
   * u32 layerId, u32 count (≤ LAYER_MAX_TEXTURES), u32[count] texIds —
   * the texture slot table (`LF_SLOT` indexes it). Re-sent when a texture
   * is re-created (atlas growth, device loss).
   */
  LAYER_SET_TEXTURES: 0x0805,
  /**
   * M5, main-thread mode only (§19.4, §28.5). u32 layerId, u32
   * positionExternalId, u32 xformExternalId, u32 colorExternalId,
   * u32 userExternalId, u32 indirectExternalId. 0 = the layer's own stream
   * (or no indirect count). External ids come from `ids.external`.
   */
  LAYER_SET_SOURCE: 0x0806,
  /**
   * COMPUTE. u32 layerId, u32 count, f32 a, b, c, d, tx, ty (layer world
   * affine), f32 margin (css px). GPU frustum culling with stable
   * (order-preserving) compaction into the layer's visible-index list and
   * indirect draw arguments. Requires LayerFlag.CULL at create, caps.compute
   * and caps.indirectDraw; the front never emits it otherwise.
   */
  LAYER_CULL: 0x0810,
  /**
   * DRAW. u32 layerId, f32 a, b, c, d, tx, ty (layer world affine),
   * f32 alpha (layer world alpha), u32 count, u32 pickId (0 = not
   * pickable), u32 flags (LayerDrawFlag). One instanced draw of the whole
   * layer (or one drawIndirect after LAYER_CULL / with an indirect source).
   */
  LAYER_DRAW: 0x0811,
} as const;

/** M5. LAYER_CREATE.flags. */
export const LayerFlag = {
  /** Allocate the cull outputs (visible indices, indirect arguments). */
  CULL: 1 << 0,
} as const;

/** M5. LAYER_DRAW.flags. */
export const LayerDrawFlag = {
  /** Draw the visible list written by this packet's LAYER_CULL (drawIndirect). */
  CULLED: 1 << 0,
  /**
   * Take the instance count from the external indirect buffer set with
   * LAYER_SET_SOURCE (`count` is then an upper bound for picking only).
   */
  INDIRECT: 1 << 1,
} as const;

/** M5. Payload sizes (bytes) of the fixed-size commands. */
export const LAYER_CREATE_BYTES = 20;
export const LAYER_SET_SOURCE_BYTES = 24;
export const LAYER_CULL_BYTES = 36;
export const LAYER_DRAW_BYTES = 44;

export type LayerOpcode = (typeof LayerOp)[keyof typeof LayerOp];
