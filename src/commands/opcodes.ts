/**
 * Command stream opcodes & binary constants — owner: "worker".
 * Normative spec: docs/ARCHITECTURE.md §3. Changing any value here is a
 * breaking protocol change: bump PROTOCOL_VERSION.
 *
 * Packet  = PacketHeader (16 B) + Command*
 * Command = CommandHeader (8 B) + payload (padded to a multiple of 4)
 * All values little-endian. Every payload offset is 4-byte aligned so
 * Float32Array / Uint32Array views can be taken without copying.
 */

/** 2 = M2 (new 0x01 texture/pick opcodes, SWARM_SET_PICK). Front and worker bundle must match. */
export const PROTOCOL_VERSION = 2;
/** 'CZG1' read as little-endian u32. */
export const PACKET_MAGIC = 0x3147_5a43;

export const PACKET_HEADER_BYTES = 16;
// PacketHeader offsets
export const PH_MAGIC = 0; // u32
export const PH_BYTE_LENGTH = 4; // u32, total used bytes incl. header
export const PH_FRAME_ID = 8; // u32
export const PH_COMMAND_COUNT = 12; // u32

export const COMMAND_HEADER_BYTES = 8;
// CommandHeader offsets (relative to command start)
export const CH_OPCODE = 0; // u16
export const CH_FLAGS = 2; // u16
export const CH_PAYLOAD_BYTES = 4; // u32, payload length after padding (multiple of 4)

/** CommandHeader.flags bits. */
export const CommandFlag = {
  /** Executed inside the main render pass, in stream order. */
  DRAW: 1 << 0,
  /** Queues compute work, executed in the compute phase in stream order. */
  COMPUTE: 1 << 1,
} as const;

/** Opcode ranges: the high byte selects the owning CoreSystem. */
export const OpcodeRange = {
  CORE: 0x00, // renderer frame state (backend)
  TEXTURE: 0x01, // textures & shared memory (backend)
  SPRITE: 0x02, // sprites (sprites)
  SWARM: 0x03, // swarm (swarm)
  // 0x04–0x7f reserved for future first-party systems (text, masks, filters, M3)
  EXTENSION: 0x80, // 0x80–0xff third-party / experimental
} as const;

export const Op = {
  // ── 0x00 CORE ──────────────────────────────────────────────────────────────
  NOP: 0x0000, // —
  /** f32 time(s), f32 dt(s) */
  FRAME_BEGIN: 0x0001,
  /** f32 cssWidth, f32 cssHeight, f32 resolution(dpr) — core sets canvas size & recreates targets */
  RESIZE: 0x0002,
  /** f32 r, f32 g, f32 b, f32 a (straight, 0..1) */
  SET_CLEAR_COLOR: 0x0003,
  /** f32 a, b, c, d, tx, ty — stage→css-pixel affine (camera). */
  SET_VIEW: 0x0004,
  /** — ; ends the frame: run compute phase, render pass, submit */
  FRAME_END: 0x00ff,

  // ── 0x01 TEXTURE / SHARED MEMORY ───────────────────────────────────────────
  /** u32 texId, u32 width, u32 height, u32 formatId (TextureFormatId), u32 texFlags (TextureFlag) */
  TEXTURE_CREATE: 0x0100,
  /** u32 texId, u32 x, u32 y, u32 width, u32 height, u8[width*height*4] RGBA8 (padded) */
  TEXTURE_UPLOAD_PIXELS: 0x0101,
  /** u32 texId, u32 objectIndex (packet.objects[i] is an ImageBitmap), u32 flipY(0|1) */
  TEXTURE_UPLOAD_BITMAP: 0x0102,
  /** u32 texId */
  TEXTURE_DESTROY: 0x0103,
  /**
   * M2 (assets: atlas pages). u32 texId, u32 objectIndex (ImageBitmap), u32 x, u32 y, u32 flipY(0|1).
   * Copies the whole bitmap to (x, y) of mip 0. Mipmaps are NOT regenerated (see TEXTURE_GENERATE_MIPMAPS).
   */
  TEXTURE_UPLOAD_BITMAP_REGION: 0x0104,
  /**
   * M2 (assets: KTX2 / transcoded). u32 texId, u32 mipLevel, u32 width, u32 height,
   * u32 objectIndex (ArrayBuffer, transferred), u32 byteOffset, u32 byteLength.
   * One whole mip level of a compressed (or rgba8) texture created with the matching formatId.
   */
  TEXTURE_UPLOAD_COMPRESSED: 0x0105,
  /** M2. u32 texId — regenerate mips 1..n from mip 0 (atlas pages after region uploads). */
  TEXTURE_GENERATE_MIPMAPS: 0x0106,
  /** u32 sharedId, u32 objectIndex (ArrayBuffer | SharedArrayBuffer in packet.objects) */
  SHARED_REGISTER: 0x0110,
  /** u32 sharedId */
  SHARED_RELEASE: 0x0111,
  /** u32 requestId, u32 srcKind(0=sprite buffer,1=swarm hot,2=swarm cold), u32 srcId, u32 first, u32 count */
  READBACK: 0x0120,
  /**
   * M2. u32 requestId, f32 x, f32 y (css px, canvas space). Queued; after the
   * main pass of this packet the core renders a 1×1 rg32uint pick pass and
   * answers CoreMessage 'pick' (ARCHITECTURE §16.3).
   */
  PICK: 0x0121,

  // ── 0x02 SPRITE ────────────────────────────────────────────────────────────
  /** u32 bufferId, u32 capacity (instances). (Re)allocates; contents undefined. */
  SPRITE_BUFFER_ALLOC: 0x0200,
  /** u32 bufferId */
  SPRITE_BUFFER_DESTROY: 0x0201,
  /** u32 bufferId, u32 first, u32 count, u8[count*SPRITE_INSTANCE_BYTES] */
  SPRITE_UPLOAD: 0x0202,
  /** u32 bufferId, u32 first, u32 count, u32 sharedId, u32 byteOffset — zero-copy upload */
  SPRITE_UPLOAD_SHARED: 0x0203,
  /** DRAW. u32 bufferId, u32 first, u32 count, u32 texId, u32 blendModeId */
  SPRITE_DRAW: 0x0210,

  // ── 0x03 SWARM ─────────────────────────────────────────────────────────────
  /**
   * u32 swarmId, u32 capacity, u32 texId (NO_ID = none), u32 blendModeId,
   * u32 renderFlags (SwarmRenderFlag), u32 paramsBytes,
   * u32 computeSrcBytes, u32 renderSrcBytes, u8[computeSrc] (pad), u8[renderSrc] (pad)
   * WGSL sources are UTF-8, composed on the front side.
   */
  SWARM_CREATE: 0x0300,
  /** u32 swarmId */
  SWARM_DESTROY: 0x0301,
  /** Same payload as SWARM_CREATE minus capacity; recompiles, keeps buffers. */
  SWARM_SET_PIPELINE: 0x0302,
  /** u32 swarmId, u32 first, u32 count, u8[count*SWARM_HOT_BYTES] */
  SWARM_WRITE_HOT: 0x0303,
  /** u32 swarmId, u32 first, u32 count, u8[count*SWARM_COLD_BYTES] */
  SWARM_WRITE_COLD: 0x0304,
  /** COMPUTE. u32 swarmId, u8[SWARM_SPAWN_BYTES] SpawnParams (includes first/count/seed) */
  SWARM_SPAWN: 0x0305,
  /** COMPUTE. u32 swarmId, u32 first, u32 count */
  SWARM_KILL_RANGE: 0x0306,
  /** COMPUTE. u32 swarmId, u32 n, u32[n] indices */
  SWARM_KILL_LIST: 0x0307,
  /** u32 swarmId, u32 byteOffset, u32 byteLength, u8[byteLength] into the behavior params uniform */
  SWARM_SET_PARAMS: 0x0308,
  /** COMPUTE. u32 swarmId, f32 dt, u32 substeps, u32 activeCount (dispatch range = [0, activeCount)) */
  SWARM_STEP: 0x0309,
  /** DRAW. u32 swarmId, f32 a, b, c, d, tx, ty (world affine), f32 alpha, u32 drawCount */
  SWARM_DRAW: 0x030a,
  /** u32 swarmId, u32 count, f32[count*4] uv rects (u0, v0, u1, v1) */
  SWARM_SET_FRAMES: 0x030b,
  /** M2. u32 swarmId, u32 pickId (the Swarm node id; 0 = not pickable) */
  SWARM_SET_PICK: 0x030c,
} as const;

export type Opcode = (typeof Op)[keyof typeof Op];

export function opcodeRange(opcode: number): number {
  return opcode >>> 8;
}

/** TEXTURE_CREATE.formatId */
export const TextureFormatId = {
  rgba8unorm: 0,
  'rgba8unorm-srgb': 1,
  r8unorm: 2,
  rgba16float: 3,
  // M2 compressed formats (TEXTURE_UPLOAD_COMPRESSED); names match the RHI TextureFormat.
  'bc1-rgba-unorm': 16,
  'bc1-rgba-unorm-srgb': 17,
  'bc3-rgba-unorm': 18,
  'bc3-rgba-unorm-srgb': 19,
  'bc4-r-unorm': 20,
  'bc5-rg-unorm': 21,
  'bc7-rgba-unorm': 22,
  'bc7-rgba-unorm-srgb': 23,
  'etc2-rgb8unorm': 32,
  'etc2-rgb8unorm-srgb': 33,
  'etc2-rgba8unorm': 34,
  'etc2-rgba8unorm-srgb': 35,
  'eac-r11unorm': 36,
  'eac-rg11unorm': 37,
  'astc-4x4-unorm': 48,
  'astc-4x4-unorm-srgb': 49,
} as const;

/** TEXTURE_CREATE.texFlags */
export const TextureFlag = {
  MIPMAPS: 1 << 0,
  NEAREST: 1 << 1, // nearest sampling (pixel art); default linear
  REPEAT: 1 << 2, // repeat addressing; default clamp
  PREMULTIPLIED: 1 << 3, // source already premultiplied
  RETAIN_SOURCE: 1 << 4, // core keeps the source for device-lost restore (default on in front code)
} as const;

/**
 * M2. TEXTURE_CREATE.texFlags bits 24–31 carry an explicit mip level count
 * (0 = automatic: 1, or the full chain when MIPMAPS is set). Compressed
 * textures set it to the number of levels they upload.
 */
export const TEXTURE_MIP_LEVELS_SHIFT = 24;
export const TEXTURE_MIP_LEVELS_MASK = 0xff;

/** READBACK.srcKind values. */
export const ReadbackSource = {
  SPRITE_BUFFER: 0,
  SWARM_HOT: 1,
  SWARM_COLD: 2,
  /** M2. u32 alive count of an allocation: 'gpu' swarm (first/count ignored). */
  SWARM_ALIVE: 3,
} as const;

/** Messages the core sends back to the front (see src/types/transport.ts). */
export const CoreMessageType = {
  READY: 1,
  FRAME_DONE: 2,
  READBACK: 3,
  DEVICE_LOST: 4,
  DEVICE_RESTORED: 5,
  ERROR: 6,
  PICK: 7,
} as const;
