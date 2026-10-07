/**
 * Graphics opcodes and draw-command constants (M4, ARCHITECTURE §26). The
 * range is `OpcodeRange.GRAPHICS` (0x06) in `opcodes.ts`; the values live
 * here because only the lazily loaded graphics chunks use them.
 */

/**
 * M4 graphics opcodes (ARCHITECTURE §26). Own table, see `MaskOp` in `opcodes.ts`. Buffer and
 * mesh ids are private to the graphics core's tables (the front allocates
 * them; they are not in `ids`). Every upload is re-sent by the front after a
 * device loss (`FrontFrame.generation`); the core keeps no CPU copies.
 */
export const GfxOp = {
  /** u32 bufferId, u32 capacity (shape instances, GFX_SHAPE_BYTES each). (Re)allocates; contents undefined. */
  GFX_SHAPE_BUFFER_ALLOC: 0x0600,
  /** u32 bufferId */
  GFX_SHAPE_BUFFER_DESTROY: 0x0601,
  /** u32 bufferId, u32 first, u32 count, u8[count*GFX_SHAPE_BYTES] */
  GFX_SHAPE_UPLOAD: 0x0602,
  /** u32 bufferId, u32 first, u32 count, u32 sharedId, u32 byteOffset — zero-copy upload */
  GFX_SHAPE_UPLOAD_SHARED: 0x0603,
  /** u32 bufferId, u32 capacity (node records, GFX_NODE_BYTES each). (Re)allocates. */
  GFX_NODE_BUFFER_ALLOC: 0x0604,
  /** u32 bufferId */
  GFX_NODE_BUFFER_DESTROY: 0x0605,
  /** u32 bufferId, u32 first, u32 count, u8[count*GFX_NODE_BYTES] */
  GFX_NODE_UPLOAD: 0x0606,
  /** u32 bufferId, u32 first, u32 count, u32 sharedId, u32 byteOffset */
  GFX_NODE_UPLOAD_SHARED: 0x0607,
  /**
   * u32 meshId, u32 vertexCount, u32 indexCount, u32 flags (GfxMeshFlag),
   * u8[vertexCount*GFX_MESH_VERTEX_BYTES], u16|u32[indexCount] (padded to 4).
   * Creates the mesh or replaces its contents; the core grows its buffers
   * when they are too small and never shrinks them in place.
   */
  GFX_MESH_UPLOAD: 0x0610,
  /**
   * u32 meshId, u32 vertexCount, u32 indexCount, u32 flags (GfxMeshFlag),
   * u32 sharedId, u32 vertexByteOffset, u32 indexByteOffset — zero-copy
   * variant for large meshes.
   */
  GFX_MESH_UPLOAD_SHARED: 0x0611,
  /** u32 meshId */
  GFX_MESH_DESTROY: 0x0612,
  /**
   * DRAW. u32 bufferId, u32 first, u32 count, u32 blendModeId,
   * u32 flags (GfxDrawFlag). Instanced SDF shapes (fill + stroke in one
   * instance). The front extends `count` of the previous command in place
   * instead of emitting a new one when the next run is contiguous
   * (GFX_DRAW_SHAPES_COUNT_WORD, ARCHITECTURE §26.6).
   */
  GFX_DRAW_SHAPES: 0x0620,
  /**
   * DRAW. u32 meshId, u32 firstIndex, u32 indexCount, u32 nodeBufferId,
   * u32 firstNode, u32 nodeCount, u32 texId (NO_ID = untextured),
   * u32 blendModeId, u32 flags (GfxDrawFlag), f32[6] uv matrix (local
   * position → uv; read only with GfxDrawFlag.TEXTURED). One instanced
   * draw of an index range per run of node records sharing the mesh.
   */
  GFX_DRAW_MESH: 0x0621,
} as const;

/**
 * M4. Payload word (u32 index after the command header) holding the count the
 * front may grow in place: GFX_DRAW_SHAPES.count and GFX_DRAW_MESH.nodeCount.
 */
export const GFX_DRAW_SHAPES_COUNT_WORD = 2;
export const GFX_DRAW_MESH_COUNT_WORD = 5;
/** M4. Payload sizes (bytes) of the two draw commands. */
export const GFX_DRAW_SHAPES_BYTES = 20;
export const GFX_DRAW_MESH_BYTES = 60;

/** M4. GFX_DRAW_* flags. */
export const GfxDrawFlag = {
  /**
   * The draw is stencil mask geometry (§26.8): the core uses its
   * stencil-write pipeline (no colour write, compare 'equal', pass
   * 'increment-clamp', fragments under coverage 0.5 discarded).
   */
  MASK_WRITE: 1 << 0,
  /** GFX_DRAW_MESH samples texId at uv = uvMatrix × local position. */
  TEXTURED: 1 << 1,
} as const;

/** M4. GFX_MESH_UPLOAD(_SHARED).flags. */
export const GfxMeshFlag = {
  /** Indices are u32 (default u16; the front picks u32 above 65535 vertices). */
  U32_INDEX: 1 << 0,
} as const;

export type GfxOpcode = (typeof GfxOp)[keyof typeof GfxOp];
