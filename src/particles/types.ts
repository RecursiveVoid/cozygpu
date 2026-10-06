/**
 * Particles public API (M3), implemented in src/particles/**. Spec:
 * docs/ARCHITECTURE.md §24 and docs/API.md "Particles".
 *
 * `Particles` is a thin front over `Swarm`: emitters compile to spawn
 * commands and over-life curves compile to a curve block the render shader
 * evaluates (layouts.ts SWARM_CURVE_BYTES) plus, where a curve drives motion,
 * a generated behavior. The zero-CPU-per-object rule of Swarm holds: per
 * frame the CPU emits at most one SWARM_SPAWN per emitter, whatever the
 * particle count.
 *
 * WebGL2: everything here runs on transform feedback, so allocation is
 * 'ring' (no GPU free list) and particles need a finite `life`
 * (ARCHITECTURE §24.5).
 */
import type { BlendMode } from '../backend/types';
import type { ColorSource } from '../math/types';
import type { NodeOptions, SceneNode, TextureHandle } from '../scene/types';
import type { BehaviorDefinition, Range, SwarmNode } from '../swarm/types';

// ─── Emitters ─────────────────────────────────────────────────────────────────

/**
 * Where particles appear. Every shape maps onto the existing SpawnOptions
 * (disc uses SpawnFlag.DISC_POSITION; the others are a min/max box or a
 * generated spawn behavior), so no new GPU code runs per particle.
 */
export type EmitterShape =
  | { readonly point: true }
  | { readonly disc: { radius: number; inner?: number } }
  | { readonly rect: { width: number; height: number } }
  | { readonly line: { x2: number; y2: number } };

export interface EmitterOptions {
  /** Name for `particles.emitter(name)`. Default 'main' for the first emitter. */
  name?: string;
  /** Particles per second. Fractions accumulate; 0 = bursts only. Default 0. */
  rate?: number;
  /**
   * A one-shot or repeating burst. `at` delays the first one (s), `repeat`
   * is the period in seconds (0 = once).
   */
  burst?: number | { count: number; at?: number; repeat?: number };
  /** Default `{ point: true }`. */
  shape?: EmitterShape;
  /** Emitter position in the Particles node's local space. Default 0, 0. */
  x?: number;
  y?: number;
  /** Emission direction, radians (0 = +x). Default the whole circle. */
  direction?: Range;
  /** Initial speed, stage px/s. Default 0. */
  speed?: Range;
  /** Initial size in stage px. Default 8. */
  size?: Range;
  /** Seconds. Default 1. 'immortal' is refused for rate-based emitters. */
  life?: Range;
  rotation?: Range;
  angularVelocity?: Range;
  /** Initial color, before the over-life color curve multiplies it. */
  color?: ColorSource | readonly [ColorSource, ColorSource];
  alpha?: Range;
  /** Frame index into `ParticlesOptions.frames`, or [first, count]. */
  frame?: number | readonly [number, number];
  /** Behavior group bits 0–7, so one Particles can run several populations. */
  group?: number;
  /** Default true. */
  enabled?: boolean;
}

/** A live emitter. Changing a field takes effect on the next emission. */
export interface Emitter {
  readonly name: string;
  rate: number;
  enabled: boolean;
  /** Emitter position in the node's local space. */
  moveTo(x: number, y: number): void;
  readonly x: number;
  readonly y: number;
  /** Replaces the spawn options (cheap; nothing is uploaded per particle). */
  set(options: Partial<EmitterOptions>): void;
  /** Emits `count` particles now (on the next render). */
  burst(count: number): void;
}

// ─── Over-life curves ─────────────────────────────────────────────────────────

/**
 * Values at up to SWARM_CURVE_STOPS normalized ages. Give the values only and
 * they are spread evenly over [0, 1]; give `stops` to place them.
 * `color`, `alpha` and `size` are evaluated in the render shader (no
 * simulation cost); `rotation` and `drag` compile to generated behaviors.
 */
export interface OverLife {
  readonly color?: readonly ColorSource[];
  readonly alpha?: readonly number[];
  /** Scale multiplier of the spawned size. */
  readonly size?: readonly number[];
  /** Ascending, in [0, 1]. Default: evenly spaced. */
  readonly stops?: readonly number[];
  /** Radians per second at each stop (a generated behavior). */
  readonly rotation?: readonly number[];
  /** Velocity damping per second at each stop (a generated behavior). */
  readonly drag?: readonly number[];
}

/** Ready-made looks (ARCHITECTURE §24.6). Each returns full ParticlesOptions. */
export type ParticlePreset = 'fire' | 'smoke' | 'sparks' | 'rain' | 'confetti';

export interface ParticlePresets {
  fire(options?: Partial<ParticlesOptions>): ParticlesOptions;
  smoke(options?: Partial<ParticlesOptions>): ParticlesOptions;
  sparks(options?: Partial<ParticlesOptions>): ParticlesOptions;
  rain(options?: Partial<ParticlesOptions>): ParticlesOptions;
  confetti(options?: Partial<ParticlesOptions>): ParticlesOptions;
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export interface ParticlesOptions extends NodeOptions {
  /** Slot count of the underlying Swarm. */
  capacity: number;
  texture?: TextureHandle;
  frames?: readonly TextureHandle[];
  shape?: 'quad' | 'circle';
  blendMode?: BlendMode;
  /** One emitter, several, or none (then use `emit()`). */
  emitter?: EmitterOptions | readonly EmitterOptions[];
  over?: OverLife;
  /** Extra behaviors, appended after the generated ones (gravity, wind, …). */
  behaviors?: readonly BehaviorDefinition[];
  /** Step with the renderer's dt on every render(). Default true. */
  autoStep?: boolean;
  substeps?: number;
  timeScale?: number;
  /** Start emitting immediately. Default true. */
  autoPlay?: boolean;
}

export interface ParticlesNode extends SceneNode {
  readonly kind: 'swarm';
  /** The underlying Swarm: behaviors, capacity, readbacks, picking. */
  readonly swarm: SwarmNode;
  readonly emitters: readonly Emitter[];
  emitter(name?: string): Emitter;
  /** Adds an emitter after construction. */
  addEmitter(options: EmitterOptions): Emitter;
  /** One-off emission that belongs to no emitter. */
  emit(count: number, options?: EmitterOptions): void;
  /** Stop/resume every emitter (the simulation keeps running). */
  play(): void;
  pause(): void;
  readonly playing: boolean;
  /** Kills every particle and resets emitter timers. */
  clear(): void;
  /** Replaces the over-life curves (one small upload). */
  setOverLife(over: OverLife): void;
}
