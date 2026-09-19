/**
 * Swarm public API. SHARED + FROZEN during the M2 build; implemented by owner
 * "swarm". M2 additions: GLSL behavior variants (WebGL2 transform feedback),
 * behavior groups, allocation 'gpu' (GPU free list), aliveCount(), picking.
 *
 * Tier 2 of cozygpu, the headline feature: millions of objects whose state
 * lives ONLY in GPU storage buffers (hot: pos/vel/scale/rot/age/life, cold:
 * color/frame/flags/user — layouts in src/types/layouts.ts). Behaviors are
 * WGSL snippets composed into one compute shader; the vertex shader reads the
 * same buffers. The CPU only encodes small commands (spawn ranges, kills,
 * param updates, step) — no per-object per-frame CPU work or upload.
 *
 * WebGPU: compute + storage buffers. WebGL2 (M2): transform feedback, only
 * behaviors that carry a `glsl` variant, capacity ≤ SWARM_GL_MAX_CAPACITY
 * (ARCHITECTURE §14). Constructing works anywhere; GPU resources are created
 * when first rendered.
 */
import type { BlendMode } from '../backend/types';
import type { ColorSource } from '../math/types';
import type { NodeOptions, SceneNode, TextureHandle } from '../scene/types';

/** A scalar or an inclusive random range [min, max]. */
export type Range = number | readonly [number, number];

// ─── Spawning ─────────────────────────────────────────────────────────────────

/**
 * All ranges are sampled per object on the GPU (hash of seed + slot index).
 * Unset fields: position 0, velocity 0, size 1 texture-frame px (or 8px for
 * circles), rotation 0, life immortal, color white.
 */
export interface SpawnOptions {
  x?: Range;
  y?: Range;
  /** Uniform in a disc; overrides x/y. */
  disc?: { x: number; y: number; radius: number };
  vx?: Range;
  vy?: Range;
  /** Polar velocity (px/s, radians); overrides vx/vy when either is set. */
  speed?: Range;
  angle?: Range;
  /** Uniform size in stage px; overrides scaleX/scaleY. */
  size?: Range;
  scaleX?: Range;
  scaleY?: Range;
  rotation?: Range;
  angularVelocity?: Range;
  /** Seconds, or 'immortal' (default). */
  life?: Range | 'immortal';
  /**
   * One color or a [from, to] pair (random point on the A→B gradient for rgb;
   * alpha gets its own random t).
   */
  color?: ColorSource | readonly [ColorSource, ColorSource];
  /** Multiplies color alpha. */
  alpha?: Range;
  /** Frame index (into SwarmOptions.frames) or [first, count] random. */
  frame?: number | readonly [number, number];
  /** Written to cold.user for custom behaviors. */
  user?: number;
  /**
   * M2. Behavior group bits 0–7 (stored in cold.flags bits 8–15). A behavior
   * with `groups` set only updates objects sharing a bit. Default 0 (only
   * group-less behaviors apply).
   */
  group?: number;
  /** Default: auto-incrementing. */
  seed?: number;
}

// ─── Behaviors ────────────────────────────────────────────────────────────────

export type ParamType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f';

export type ParamSpec = Readonly<Record<string, ParamType>>;

export type ParamValue<T extends ParamType> = T extends 'vec2f'
  ? readonly [number, number]
  : T extends 'vec3f'
    ? readonly [number, number, number]
    : T extends 'vec4f'
      ? readonly [number, number, number, number]
      : number;

export type ParamValues<P extends ParamSpec> = {
  [K in keyof P]: ParamValue<P[K]>;
};

/**
 * A behavior = a named WGSL snippet + typed uniform params.
 *
 * `update` is inlined (inside its own `{ }` block) into the per-object compute
 * loop, after the built-in aging step, in array order. In scope:
 *   var p: SwarmHot      read/write, written back after all behaviors
 *   let c: SwarmCold     read-only
 *   let i: u32           slot index
 *   sim: SwarmSim        { dt, time, count, substep }  (dt is per substep)
 *   view: View           canvas size etc. (layouts.ts)
 *   $params.<name>       this behavior's params (the composer rewrites `$params`)
 *   rand01(i, salt) -> f32, hash32(u32) -> u32   prelude helpers
 * Kill an object with `p.life = 0.0;`.
 *
 * `helpers` is top-level WGSL (fns/consts) at column 0; every identifier must
 * start with `<name>_` and must not redeclare a prelude/template name.
 */
export interface BehaviorDefinition<P extends ParamSpec = ParamSpec> {
  /** Unique within a swarm; /^[a-z][a-zA-Z0-9_]*$/. */
  readonly name: string;
  readonly params: P;
  readonly defaults: ParamValues<P>;
  /** WGSL (WebGPU compute). */
  readonly update: string;
  readonly helpers?: string;
  /**
   * M2. GLSL ES 3.0 variant for WebGL2 transform feedback (ARCHITECTURE
   * §14.2). Same contract as `update`/`helpers`: in scope `SwarmHot p`
   * (inout, fields as in WGSL), `SwarmCold c`, `uint i`, `sim`, `view`,
   * `$params.<name>` (std140 block, same byte layout as WGSL),
   * `rand01(uint, uint)`, `hash32(uint)`. Kill with `p.life = 0.0;`.
   * Without it the behavior is WebGPU-only: a Swarm using it on a WebGL2
   * renderer draws nothing and reports UNSUPPORTED once.
   */
  readonly glsl?: { readonly update: string; readonly helpers?: string };
  /**
   * M2. Group bit mask (0–255). 0/undefined = applies to every object;
   * otherwise only to objects whose `(cold.flags >> 8) & groups` is non-zero.
   * Compile-time (part of the composed shader).
   */
  readonly groups?: number;
}

/** A behavior attached to a Swarm; `set` updates the uniform mirror (one SWARM_SET_PARAMS per frame). */
export interface Behavior<P extends ParamSpec = ParamSpec> {
  readonly name: string;
  readonly definition: BehaviorDefinition<P>;
  set<K extends keyof P & string>(param: K, value: ParamValue<P[K]>): void;
  get<K extends keyof P & string>(param: K): ParamValue<P[K]>;
}

/** Built-in behavior factories (src/swarm/behaviors.ts). */
export interface BuiltinBehaviors {
  /** pos += vel·dt; rot += angVel·dt. Almost always first. */
  velocity(options?: { name?: string }): BehaviorDefinition<{}>;
  /** vel += (x, y)·dt  — gravity / wind. */
  acceleration(options?: {
    name?: string;
    x?: number;
    y?: number;
  }): BehaviorDefinition<{ value: 'vec2f' }>;
  /** vel *= exp(-k·dt). */
  drag(options?: {
    name?: string;
    k?: number;
  }): BehaviorDefinition<{ k: 'f32' }>;
  /** Rect in stage space. mode is compile-time; rect/restitution are params. */
  bounds(options: {
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    mode?: 'bounce' | 'wrap' | 'kill';
    restitution?: number;
  }): BehaviorDefinition<{ rect: 'vec4f'; restitution: 'f32' }>;
  /** Pull (strength > 0) or push towards a point, with a radius falloff. */
  attractor(options: {
    name?: string;
    x: number;
    y: number;
    strength?: number;
    radius?: number;
  }): BehaviorDefinition<{ point: 'vec2f'; strength: 'f32'; radius: 'f32' }>;
}

// ─── Swarm ────────────────────────────────────────────────────────────────────

export interface SwarmOptions extends NodeOptions {
  /** Fixed slot count (hot 40 B + cold 16 B per slot). */
  capacity: number;
  /** Omitted → white (or circle shape). All frames must share one source. */
  texture?: TextureHandle;
  /** Atlas frames addressed by cold.frame / SpawnOptions.frame. Default [texture]. */
  frames?: readonly TextureHandle[];
  shape?: 'quad' | 'circle';
  blendMode?: BlendMode;
  behaviors?: readonly BehaviorDefinition[];
  /**
   * 'ring' (default): spawn writes at a wrapping cursor, overwriting the
   * oldest slots — ideal for particles with bounded life.
   * 'manual': spawn returns -1 when full; kill() frees slots on the CPU.
   * Deaths by life/bounds happen on the GPU and are NOT reported back, so use
   * immortal objects with 'manual'.
   * 'gpu' (M2, WebGPU only): a GPU free list. Deaths (life, bounds, kill)
   * push slots on the GPU; spawn pops them, so mortal objects are reused
   * without CPU knowledge. `spawn` returns 0 (slots are chosen on the GPU and
   * spawns beyond the free count are dropped); use `aliveCount()` to observe.
   * Dispatch and draw cover the whole capacity (draw is compacted with
   * drawIndirect). On WebGL2 'gpu' reports UNSUPPORTED; use 'ring'.
   */
  allocation?: 'ring' | 'manual' | 'gpu';
  render?: {
    fadeOut?: boolean;
    shrink?: boolean;
    alignToVelocity?: boolean;
    /**
     * Compute-cull off-screen and dead objects into an indirect draw.
     * Requires `caps.indirectDraw` (ignored otherwise). Default false.
     * M2: allocation 'gpu' always compacts alive objects; `cull` adds the
     * off-screen test.
     */
    cull?: boolean;
  };
  /** Step with the renderer's frame dt on every render() (default true). */
  autoStep?: boolean;
  /** Fixed substeps per step (default 1). */
  substeps?: number;
  timeScale?: number;
  /** After a device loss GPU contents are gone; re-spawn here. */
  onRestore?: (swarm: SwarmNode) => void;
}

/** Scene leaf. Draws where it sits in the tree, using its world transform. */
export interface SwarmNode extends SceneNode {
  readonly kind: 'swarm';
  readonly capacity: number;
  /** Highest used slot + 1: compute dispatch and draw instance count. */
  readonly activeCount: number;
  readonly allocation: 'ring' | 'manual' | 'gpu';
  blendMode: BlendMode;
  autoStep: boolean;
  substeps: number;
  timeScale: number;

  /** Returns the first slot (contiguous; wraps for 'ring'), or -1 ('manual' and full). */
  spawn(count: number, options?: SpawnOptions): number;
  /**
   * Exact bulk writes starting at `first`. `hot` length must be a multiple of
   * 10 f32 (SWARM_HOT_BYTES/4), `cold` a multiple of 4 u32. Bytes are copied
   * into the stream at call time.
   */
  write(first: number, hot?: Float32Array, cold?: Uint32Array): void;
  kill(first: number, count?: number): void;
  killList(indices: Uint32Array, count?: number): void;
  /** Kills everything and resets the ring cursor. */
  clear(): void;
  /** Manual step (use with autoStep = false). Accumulates until the next render(). */
  step(dt: number): void;

  behavior<P extends ParamSpec = ParamSpec>(name: string): Behavior<P>;
  readonly behaviors: readonly Behavior[];
  /** Recompiles asynchronously; the previous pipeline keeps running until ready. */
  setBehaviors(definitions: readonly BehaviorDefinition[]): void;

  /** Async GPU readback (debug/tools; never per frame). */
  readHot(first: number, count: number): Promise<Float32Array>;
  readCold(first: number, count: number): Promise<Uint32Array>;
  /**
   * M2. Alive objects as of the last submitted frame (async readback).
   * 'gpu': the free-list counter; 'ring'/'manual': counts life > 0 over
   * [0, activeCount) on the GPU (WebGPU) or CPU after readHot (WebGL2).
   */
  aliveCount(): Promise<number>;
}

/** M2. Hard capacity ceiling on WebGL2 (transform feedback per frame over every slot). */
export const SWARM_GL_MAX_CAPACITY = 4_000_000;
/** M2. Capacity above which WebGL2 swarms warn once (typical 60 fps limit on integrated GPUs). */
export const SWARM_GL_WARN_CAPACITY = 1_000_000;

// ─── Composer (pure, testable in Node) ────────────────────────────────────────

export interface ParamLayoutEntry {
  readonly behavior: string;
  readonly param: string;
  readonly type: ParamType;
  /** Byte offset inside the params uniform. */
  readonly offset: number;
}

export interface ComposedSwarmShaders {
  /** M2. Language of `compute` and `render`. */
  readonly language: 'wgsl' | 'glsl300es';
  /**
   * WGSL: compute module, entries 'cs_step' (+ 'cs_spawn', 'cs_kill', ...).
   * GLSL (M2): transform-feedback vertex programs as `//@STAGE step` and
   * `//@STAGE spawn` sections of one string (swarm-internal format).
   */
  readonly compute: string;
  /**
   * WGSL: render module, entries 'vs_main' / 'fs_main' (+ M2 pick entries).
   * GLSL (M2): `//@STAGE vertex`, `//@STAGE fragment`, `//@STAGE pickFragment` sections.
   */
  readonly render: string;
  /** Uniform-aligned size of the params block (≥ 16). */
  readonly paramsBytes: number;
  readonly params: readonly ParamLayoutEntry[];
}

/**
 * `language` defaults to 'wgsl'. With 'glsl300es' every behavior needs `glsl`
 * or the composer throws CozyGPUError('UNSUPPORTED') naming the behavior.
 */
export type SwarmShaderComposer = (
  behaviors: readonly BehaviorDefinition[],
  renderFlags: number,
  language?: 'wgsl' | 'glsl300es',
) => ComposedSwarmShaders;
