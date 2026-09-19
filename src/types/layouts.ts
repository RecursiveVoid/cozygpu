/**
 * Normative GPU memory layouts (byte offsets). SHARED + FROZEN during build.
 * Mirrors docs/ARCHITECTURE.md §4. WGSL structs in src/shaders/** must match
 * these exactly; tests should assert WGSL sizes against these constants.
 * All little-endian. "u8x4 RGBA" colors are packed as
 *   u32 = r | g << 8 | b << 16 | a << 24   (WGSL: unpack4x8unorm)
 */

// ─── Sprite instance (vertex buffer, stepMode 'instance') — 40 bytes ──────────
// Maps the unit quad corner q ∈ [0,1]² to stage space:
//   world = (a·q.x + c·q.y + tx,  b·q.x + d·q.y + ty)
// i.e. the sprite's world transform already multiplied by
// translate(-anchor·size)·scale(size), so the shader needs no anchor/size.
export const SPRITE_INSTANCE_BYTES = 40;
export const SI_A = 0; // f32
export const SI_B = 4; // f32
export const SI_C = 8; // f32
export const SI_D = 12; // f32
export const SI_TX = 16; // f32
export const SI_TY = 20; // f32
export const SI_COLOR = 24; // u8x4 RGBA (tint × worldAlpha), straight alpha → vertex format 'unorm8x4'
export const SI_U0 = 28; // u16 unorm  → 'unorm16x4' covering 28..35
export const SI_V0 = 30; // u16 unorm
export const SI_U1 = 32; // u16 unorm
export const SI_V1 = 34; // u16 unorm
export const SI_FLAGS = 36; // u32: bits 0-7 flags (SpriteInstanceFlag), bits 8-31 pick id (M2)
export const SPRITE_INSTANCE_F32_PER = SPRITE_INSTANCE_BYTES / 4; // 10 slots when viewed as Float32Array/Uint32Array

export const SpriteInstanceFlag = {
  /** Fragment shader applies texture alpha only (tinted glyph/mask look). */
  ALPHA_ONLY: 1 << 0,
} as const;

// ─── Picking (M2, ARCHITECTURE §16.3) ─────────────────────────────────────────
/** SI_FLAGS bits 8–31: pick id = SceneNode.id when pickable, else 0. */
export const SI_PICK_SHIFT = 8;
/** Largest node id that fits the instance pick field; larger ids are not pickable. */
export const SI_PICK_MAX = 0xffffff;
/** Pick target: one texel, `vec2u(objectId, instance + 1)`; (0, 0) = miss. */
export const PICK_TARGET_FORMAT = 'rg32uint';
export const PICK_RESULT_BYTES = 8;
/** Texels with (premultiplied) alpha below this are transparent to picking. */
export const PICK_ALPHA_THRESHOLD = 0.5;

// ─── Swarm hot record (storage, read_write in compute, read in vertex) — 40 B ─
// struct SwarmHot { pos: vec2f, vel: vec2f, scale: vec2f, rot: f32,
//                   angVel: f32, age: f32, life: f32 }
// life <= 0 → slot is dead (vertex shader collapses it, compute skips it).
// Immortal objects use life = SWARM_IMMORTAL.
export const SWARM_HOT_BYTES = 40;
export const SH_POS_X = 0; // f32
export const SH_POS_Y = 4; // f32
export const SH_VEL_X = 8; // f32
export const SH_VEL_Y = 12; // f32
export const SH_SCALE_X = 16; // f32 (size in stage px)
export const SH_SCALE_Y = 20; // f32
export const SH_ROT = 24; // f32 radians
export const SH_ANG_VEL = 28; // f32 radians/s
export const SH_AGE = 32; // f32 seconds since spawn
export const SH_LIFE = 36; // f32 seconds; <= 0 dead
export const SWARM_IMMORTAL = 3.4e38;

// ─── Swarm cold record (storage, read in compute + vertex) — 16 B ─────────────
// struct SwarmCold { color: u32, frame: u32, flags: u32, user: u32 }
export const SWARM_COLD_BYTES = 16;
export const SC_COLOR = 0; // u32 packed RGBA8
export const SC_FRAME = 4; // u32 index into the frames storage buffer (uv rects)
export const SC_FLAGS = 8; // u32 bits 0-7 reserved, 8-15 behavior group bits (M2), 16-31 reserved
/** M2: cold.flags bits 8–15 = behavior groups (see BehaviorDefinition.groups). */
export const SC_GROUP_SHIFT = 8;
export const SC_GROUP_MASK = 0xff;
export const SC_USER = 12; // u32 free for custom behaviors

// ─── Swarm spawn params (uniform w/ dynamic offset) — 112 B ───────────────────
// Spawned values are uniform random in [min, max] using hash(seed, index).
export const SWARM_SPAWN_BYTES = 112;
export const SP_FIRST = 0; // u32 first slot
export const SP_COUNT = 4; // u32
export const SP_SEED = 8; // u32
export const SP_FRAME = 12; // u32 base frame index
export const SP_POS_MIN = 16; // vec2f
export const SP_POS_MAX = 24; // vec2f
export const SP_VEL_MIN = 32; // vec2f
export const SP_VEL_MAX = 40; // vec2f
export const SP_SCALE_MIN = 48; // vec2f
export const SP_SCALE_MAX = 56; // vec2f
export const SP_ROT_MIN = 64; // f32
export const SP_ROT_MAX = 68; // f32
export const SP_ANG_VEL_MIN = 72; // f32
export const SP_ANG_VEL_MAX = 76; // f32
export const SP_LIFE_MIN = 80; // f32
export const SP_LIFE_MAX = 84; // f32
export const SP_COLOR_A = 88; // u32 packed RGBA8
export const SP_COLOR_B = 92; // u32 packed RGBA8; rgb: one random t (A→B gradient), alpha: own t
export const SP_FRAME_COUNT = 96; // u32 random frame in [frame, frame + max(1, frameCount))
export const SP_FLAGS = 100; // u32 SpawnFlag
export const SP_USER = 104; // u32 → cold.user
/** M2: u32 written verbatim to cold.flags (behavior group bits; was `_pad`, always 0 in M1). */
export const SP_COLD_FLAGS = 108;
/** @deprecated M1 name of SP_COLD_FLAGS. */
export const SP_PAD = 108; // u32

export const SpawnFlag = {
  /** scale.y = scale.x (one random draw). */
  UNIFORM_SCALE: 1 << 0,
  /** velocity is polar: vel{Min,Max}.x = speed, vel{Min,Max}.y = angle (rad). */
  POLAR_VELOCITY: 1 << 1,
  /** position in a disc: posMin = center, posMax.x = radius. */
  DISC_POSITION: 1 << 2,
} as const;

// ─── Swarm simulation uniform — 16 B ──────────────────────────────────────────
// struct SwarmSim { dt: f32, time: f32, count: u32, substep: u32 }
export const SWARM_SIM_BYTES = 16;

// ─── Swarm draw uniform — 32 B ────────────────────────────────────────────────
// struct SwarmDraw { col0: vec2f, col1: vec2f, translate: vec2f, alpha: f32, flags: u32 }
export const SWARM_DRAW_BYTES = 32;

export const SwarmRenderFlag = {
  /** alpha *= 1 - age/life */
  FADE_OUT: 1 << 0,
  /** scale *= 1 - age/life */
  SHRINK: 1 << 1,
  /** rotate the quad to face the velocity direction (ignores rot) */
  ALIGN_TO_VELOCITY: 1 << 2,
  /** procedural anti-aliased circle instead of a textured quad */
  CIRCLE: 1 << 3,
} as const;

// ─── View uniform (@group(0) @binding(0) for every 2D pipeline) — 48 B ────────
// struct View { col0: vec2f, col1: vec2f, translate: vec2f,   // stage → css px
//               resolution: vec2f,                           // css px size
//               time: f32, dt: f32, dpr: f32, _pad: f32 }
// clip = vec2(p.x / res.x * 2 - 1, 1 - p.y / res.y * 2)
export const VIEW_UNIFORM_BYTES = 48;
export const VU_COL0 = 0;
export const VU_COL1 = 8;
export const VU_TRANSLATE = 16;
export const VU_RESOLUTION = 24;
export const VU_TIME = 32;
export const VU_DT = 36;
export const VU_DPR = 40;
