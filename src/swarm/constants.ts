/**
 * Swarm-internal constants. Not part of the public API.
 * Normative layouts live in src/types/layouts.ts; these are implementation
 * details shared by the front (Swarm.ts), the composer and the core.
 */

/**
 * Render flags beyond the public `SwarmRenderFlag` bits 0-3. Bits 8+ are
 * reserved for internal use in the SWARM_CREATE renderFlags field.
 */
export const SwarmInternalRenderFlag = {
  /** Compute-cull alive, on-screen objects into an indirect draw. */
  CULL: 1 << 8,
  /**
   * allocation 'gpu' (ARCHITECTURE §14.3): GPU free list, alive compaction
   * into `visible` + drawIndirect. WebGPU only.
   */
  GPU_ALLOC: 1 << 9,
} as const;

/** Compute workgroup size (x). Must match `@workgroup_size` in compute.wgsl. */
export const SWARM_WORKGROUP_SIZE = 256;
/** Max workgroups per dispatch dimension (WebGPU default limit). */
export const SWARM_MAX_WORKGROUPS = 65535;
/**
 * Dynamic uniform offset stride. 256 is the largest allowed value of
 * `minUniformBufferOffsetAlignment`, so it is valid on every device.
 */
export const SWARM_UNIFORM_STRIDE = 256;
/** Vertices per instance (triangle strip, geometry from vertex_index). */
export const SWARM_QUAD_VERTICES = 4;
/**
 * Hot + cold bytes above which SWARM_CREATE logs a one-time warning. The
 * core only refuses capacities past the device's buffer limits (about 4 GiB
 * per buffer with limits: 'max'), and allocations that large still succeed
 * on unified-memory machines while frames and readbacks take seconds.
 */
export const SWARM_LARGE_ALLOCATION_BYTES = 1 << 30;
/** Default object size for circles when SpawnOptions sets no size. */
export const SWARM_DEFAULT_CIRCLE_SIZE = 8;

/** READBACK srcKind values (ARCHITECTURE §3.4). */
export const SwarmReadbackKind = {
  HOT: 1,
  COLD: 2,
} as const;
// Alive counts use ReadbackSource.SWARM_ALIVE (3) from src/commands/opcodes.ts;
// `count` carries the front's activeCount.

/**
 * SwarmCounters storage struct (16 B): freeTop (atomic), alive (atomic),
 * spawnTop, spawnTake. Byte offsets.
 */
export const SWARM_COUNTERS_BYTES = 16;
export const SWARM_COUNTER_FREE_TOP = 0;
export const SWARM_COUNTER_ALIVE = 4;

/** Pick uniform (16 B): u32 pickId + padding. */
export const SWARM_PICK_UNIFORM_BYTES = 16;

/**
 * WebGL2: the frames table is a std140 uniform block
 * `{ uint count; 3 × pad; vec4 rects[N]; }` (4096 B, within the WebGL2
 * minimum MAX_UNIFORM_BLOCK_SIZE of 16 KB). Frame indices clamp to the last
 * entry, as on WebGPU.
 */
export const SWARM_GL_MAX_FRAMES = 255;
export const SWARM_GL_FRAMES_BYTES = 16 + SWARM_GL_MAX_FRAMES * 16;

/**
 * WebGL2 kills write zeroed hot records in chunks of this many objects, so
 * `clear()` of a multi-million swarm never allocates a capacity-sized array.
 */
export const SWARM_GL_ZERO_CHUNK = 4096;

/** Blend ids in the command stream → BlendMode (index = BlendModeId). */
export const BLEND_MODES = [
  'normal',
  'add',
  'multiply',
  'screen',
  'none',
] as const;
