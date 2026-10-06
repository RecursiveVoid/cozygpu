/**
 * `GPU.Particles` and `GPU.particlePresets` (ARCHITECTURE §24).
 *
 * A thin shell over `Swarm`: the node IS the swarm (`fx.swarm` is itself), so
 * particles batch, pick, step and draw exactly like any other swarm. The
 * emitter compiler (shapes, rates, bursts, over-life curves → SpawnOptions,
 * behaviors and a curve block) is the lazily loaded `particles` chunk, so
 * importing the class costs about a kilobyte. Until that chunk resolves the
 * node is a live but idle swarm; the API works immediately because the
 * emitter handles are plain state that the chunk compiles later.
 *
 * The zero-CPU-per-object rule holds: per frame the front advances two
 * numbers per emitter and emits at most one SWARM_SPAWN per emitter,
 * whatever the particle count (§24.3).
 */
import { Op, OpcodeRange } from '../commands/opcodes';
import { Swarm } from '../swarm/Swarm';
import type { SwarmCurveOptions } from '../swarm/Swarm';
import type { SwarmNode } from '../swarm/types';
import type { FrontFrame } from '../types/core';
import { CozyGPUError } from '../types/errors';
import { SWARM_CURVE_BYTES } from '../types/layouts';
import type { EmitterState, ShapePlan } from './emitter';
import type {
  Emitter,
  EmitterOptions,
  OverLife,
  ParticlePresets,
  ParticlesNode,
  ParticlesOptions,
} from './types';

type EmitterModule = typeof import('./emitter');

/**
 * Loads the emitter compiler ahead of time. `new Particles(...)` loads it on
 * its own; preload when the first frame should already emit.
 */
export function loadParticles(): Promise<void> {
  return import('./emitter').then(() => undefined);
}

/**
 * One emitter. Plain state: every method is a field write plus a dirty bit,
 * and the compiler in the `particles` chunk turns it into a spawn block.
 */
class EmitterHandle implements Emitter, EmitterState {
  readonly name: string;
  rate: number;
  enabled: boolean;
  x: number;
  y: number;
  options: EmitterOptions;
  dirty = true;
  moved = false;
  queued = 0;
  carry = 0;
  time = 0;
  burstCount = 0;
  burstRepeat = 0;
  nextBurst = Infinity;
  spawn: EmitterState['spawn'] = null;
  shapeName = '';
  shapeGroup = 0;
  shapeParams: [number, number, number, number] = [0, 0, 0, 0];

  constructor(options: EmitterOptions, fallbackName: string) {
    this.options = options;
    this.name = options.name ?? fallbackName;
    this.rate = options.rate ?? 0;
    this.enabled = options.enabled ?? true;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
  }

  moveTo(x: number, y: number): void {
    if (x === this.x && y === this.y) return;
    this.x = x;
    this.y = y;
    this.moved = true;
  }

  set(options: Partial<EmitterOptions>): void {
    const merged: EmitterOptions = { ...this.options, ...options };
    this.options = merged;
    this.rate = merged.rate ?? 0;
    this.enabled = merged.enabled ?? true;
    this.x = merged.x ?? this.x;
    this.y = merged.y ?? this.y;
    this.dirty = true;
  }

  burst(count: number): void {
    if (count > 0) this.queued += Math.floor(count);
  }
}

export class Particles extends Swarm implements ParticlesNode {
  private readonly particleOptions: ParticlesOptions;
  private readonly handles: EmitterHandle[] = [];
  private module: EmitterModule | null = null;
  private _playing: boolean;
  /** Emission time accumulated by `step()` (autoStep adds the frame dt). */
  private emitDt = 0;
  /** SWARM_SET_CURVES payload; uploaded when dirty. */
  private curves: Float32Array | null = null;
  private curveBytes: Uint8Array | null = null;
  private curvesDirty = false;
  /** Renderer/device the curves were last sent to. */
  private curveRendererId = -1;
  private curveGeneration = -1;
  /** Reused by `emit(count, options)`. */
  private scratch: EmitterHandle | null = null;

  constructor(options: ParticlesOptions) {
    super(toSwarmOptions(options));
    this.particleOptions = { ...options };
    this._playing = options.autoPlay ?? true;
    const list = options.emitter;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        this.handles.push(
          new EmitterHandle(
            list[i] as EmitterOptions,
            i === 0 ? 'main' : `e${i}`,
          ),
        );
      }
    } else if (list) {
      this.handles.push(new EmitterHandle(list as EmitterOptions, 'main'));
    }
    void import('./emitter').then(
      module => {
        if (this._destroyed) return;
        this.module = module;
        this.rebuild();
      },
      (error: unknown) => {
        (globalThis as { console?: Console }).console?.error(
          '[cozygpu:INTERNAL] Particles: loading the emitter compiler failed',
          error,
        );
      },
    );
  }

  // ─── ParticlesNode ────────────────────────────────────────────────────────

  /** The underlying Swarm: behaviors, capacity, readbacks, picking. */
  get swarm(): SwarmNode {
    return this;
  }

  get emitters(): readonly Emitter[] {
    return this.handles;
  }

  emitter(name?: string): Emitter {
    const wanted = name ?? 'main';
    for (let i = 0; i < this.handles.length; i++) {
      if (this.handles[i].name === wanted) return this.handles[i];
    }
    if (name === undefined && this.handles.length > 0) return this.handles[0];
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `Particles has no emitter named "${wanted}"`,
    );
  }

  addEmitter(options: EmitterOptions): Emitter {
    const handle = new EmitterHandle(options, `e${this.handles.length}`);
    this.handles.push(handle);
    if (this.module) this.rebuild();
    return handle;
  }

  /**
   * One-off emission. Without options it is a burst of the default emitter;
   * with options it reuses one scratch emitter, so two calls in the same
   * frame with different options keep the last one. Shapes that need a
   * generated behavior (`line`, or a `disc` with `inner`) belong to a real
   * emitter — add one with `addEmitter`.
   */
  emit(count: number, options?: EmitterOptions): void {
    if (!(count > 0)) return;
    if (!options) {
      this.emitter().burst(count);
      return;
    }
    const scratch = this.scratch ?? new EmitterHandle(options, '');
    if (this.scratch) scratch.set(options);
    this.scratch = scratch;
    scratch.burst(count);
  }

  play(): void {
    this._playing = true;
  }

  pause(): void {
    this._playing = false;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Kills every particle and resets the emitters' timers. */
  clear(): void {
    super.clear();
    for (let i = 0; i < this.handles.length; i++) resetEmitter(this.handles[i]);
    if (this.scratch) resetEmitter(this.scratch);
  }

  /** Replaces the over-life curves (one small upload, no recompile of shapes). */
  setOverLife(over: OverLife): void {
    this.particleOptions.over = over;
    if (this.module) this.rebuild();
  }

  // ─── frame ────────────────────────────────────────────────────────────────

  /** Manual step; also advances the emitters (use with autoStep = false). */
  step(dt: number): void {
    if (dt > 0) this.emitDt += dt;
    super.step(dt);
  }

  /** @internal */
  override _emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    const dt = this.emitDt + (this.autoStep ? frame.dt * this.timeScale : 0);
    this.emitDt = 0;
    const module = this.module;
    if (module && frame.isSystemReady(OpcodeRange.SWARM)) {
      if (this.scratch) this.handles.push(this.scratch);
      module.advanceEmitters(
        this,
        this.handles,
        this._playing ? dt : 0,
        this._playing,
      );
      if (this.scratch) this.handles.pop();
    }
    if (
      frame.rendererId !== this.curveRendererId ||
      frame.generation !== this.curveGeneration
    ) {
      this.curveRendererId = frame.rendererId;
      this.curveGeneration = frame.generation;
      this.curvesDirty = this.curves !== null;
    }
    const before = frame.encoder.cursor;
    super._emitDraw(frame, world, worldOffset, worldAlpha);
    // The swarm emits nothing while its core system (or, on WebGL2, its GLSL
    // composer) is still loading: the curves would arrive before SWARM_CREATE
    // and be dropped, leaving a zeroed curve block. Keep them dirty until the
    // swarm is live on this frame.
    if (
      this.curvesDirty &&
      this.curveBytes &&
      frame.encoder.cursor !== before
    ) {
      this.curvesDirty = false;
      const enc = frame.encoder;
      enc.begin(Op.SWARM_SET_CURVES, 4 + SWARM_CURVE_BYTES);
      enc.u32(this.swarmId);
      enc.bytes(this.curveBytes);
      enc.end();
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /** Compiles behaviors, shape plans and curves from the current emitters. */
  private rebuild(): void {
    const module = this.module;
    if (!module) return;
    const plans: (ShapePlan | null)[] = [];
    const options: EmitterOptions[] = [];
    for (let i = 0; i < this.handles.length; i++) {
      options.push(this.handles[i].options);
    }
    const compiled = module.compileFor(this.particleOptions, options, plans);
    for (let i = 0; i < this.handles.length; i++) {
      const plan = plans[i];
      const handle = this.handles[i];
      handle.shapeName = plan ? plan.name : '';
      handle.shapeGroup = plan ? plan.group : 0;
      handle.dirty = true;
    }
    if (this.scratch) this.scratch.dirty = true;
    this.setBehaviors(compiled.behaviors);
    this.curves = compiled.curves ?? module.identityCurves();
    this.curveBytes = new Uint8Array(
      this.curves.buffer,
      this.curves.byteOffset,
      SWARM_CURVE_BYTES,
    );
    this.curvesDirty = true;
  }
}

function resetEmitter(state: EmitterState): void {
  state.carry = 0;
  state.time = 0;
  state.queued = 0;
  state.dirty = true;
}

/** The `SwarmOptions` half of `ParticlesOptions` (§24.5: ring allocation). */
function toSwarmOptions(options: ParticlesOptions): SwarmCurveOptions {
  return {
    ...options,
    allocation: 'ring',
    behaviors: undefined,
    // The over-life curve block is always bound: `setOverLife` then never
    // needs a pipeline rebuild.
    curves: true,
  };
}

/** Ready-made looks; each returns full `ParticlesOptions` to tweak. */
export const particlePresets: ParticlePresets = {
  fire: options => ({
    capacity: 20_000,
    shape: 'circle',
    blendMode: 'add',
    emitter: {
      rate: 700,
      shape: { disc: { radius: 8 } },
      speed: [90, 210],
      direction: [-Math.PI * 0.58, -Math.PI * 0.42],
      size: [6, 16],
      life: [0.45, 0.95],
    },
    over: {
      color: ['#fff3c4', '#ff8c1a', '#c01a08', '#20000000'],
      alpha: [0.85, 0.7, 0.3, 0],
      size: [0.5, 1.1, 0.9, 0.25],
    },
    ...options,
  }),

  smoke: options => ({
    capacity: 12_000,
    shape: 'circle',
    emitter: {
      rate: 200,
      shape: { disc: { radius: 18 } },
      speed: [10, 40],
      direction: [-Math.PI * 0.7, -Math.PI * 0.3],
      size: [20, 46],
      life: [1.6, 3.2],
      angularVelocity: [-0.6, 0.6],
    },
    over: {
      color: ['#8a8a96', '#5a5a66', '#33333c'],
      alpha: [0, 0.35, 0],
      size: [0.6, 1.4, 2.2],
      drag: [0.2, 1.4],
    },
    ...options,
  }),

  sparks: options => ({
    capacity: 30_000,
    shape: 'circle',
    blendMode: 'add',
    emitter: {
      rate: 600,
      shape: { point: true },
      speed: [180, 520],
      size: [2, 5],
      life: [0.3, 0.8],
    },
    over: {
      color: ['#ffffff', '#ffd36b', '#ff5a1f'],
      alpha: [1, 0.9, 0],
      size: [1, 0.8, 0.2],
      drag: [0.5, 3],
    },
    ...options,
  }),

  rain: options => ({
    capacity: 40_000,
    shape: 'quad',
    emitter: {
      rate: 1200,
      shape: { rect: { width: 1600, height: 8 } },
      speed: [700, 950],
      direction: [Math.PI * 0.47, Math.PI * 0.53],
      size: [2, 3],
      life: [0.8, 1.4],
    },
    over: { color: ['#9fd8ff', '#5aa0d8'], alpha: [0.5, 0.2] },
    ...options,
  }),

  confetti: options => ({
    capacity: 8_000,
    shape: 'quad',
    emitter: {
      rate: 0,
      burst: { count: 600, at: 0, repeat: 2.5 },
      shape: { disc: { radius: 6 } },
      speed: [260, 620],
      direction: [-Math.PI * 0.85, -Math.PI * 0.15],
      size: [6, 12],
      life: [1.6, 2.6],
      rotation: [0, Math.PI * 2],
      angularVelocity: [-9, 9],
      color: ['#ff4d6d', '#4dd0ff'],
    },
    over: {
      alpha: [1, 1, 0],
      size: [1, 1, 0.9],
      rotation: [6, -6],
      drag: [0.4, 2.4],
    },
    ...options,
  }),
};
