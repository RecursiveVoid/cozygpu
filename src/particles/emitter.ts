/**
 * The emitter compiler (ARCHITECTURE §24.3, §24.4).
 *
 * It turns declarative emitters and over-life curves into what Swarm already
 * understands:
 *   shape + speed/direction/size/life  → SpawnOptions (+ SpawnFlag bits)
 *   rate, burst                        → an accumulator that emits at most
 *                                        one SWARM_SPAWN per emitter per frame
 *   color / alpha / size over life     → the SWARM_SET_CURVES block, read by
 *                                        the render shader (no sim cost)
 *   rotation / drag over life          → generated behaviors (WGSL + GLSL)
 *   line / ring shapes                 → a generated behavior that places the
 *                                        objects spawned in this step
 *
 * Nothing here runs per particle on the CPU: per frame and per emitter it
 * advances two numbers and, when something is due, calls `Swarm.spawn` once.
 * This module is the lazily loaded `particles` chunk; the class shell in
 * ./Particles.ts never imports it statically.
 */
import { toPackedColor } from '../math/color';
import { velocityBehavior } from '../swarm/velocity';
import type {
  Behavior,
  BehaviorDefinition,
  ParamSpec,
  Range,
  SpawnOptions,
} from '../swarm/types';
import { CozyGPUError } from '../types/errors';
import {
  SCV_ALPHA,
  SCV_COLOR,
  SCV_SIZE,
  SCV_STOPS,
  SWARM_CURVE_BYTES,
  SWARM_CURVE_STOPS,
  SwarmRenderFlag,
} from '../types/layouts';
import type {
  EmitterOptions,
  EmitterShape,
  OverLife,
  ParticlesOptions,
} from './types';

const TAU = Math.PI * 2;
const WHOLE_CIRCLE: readonly [number, number] = [0, TAU];
const WHITE = 0xffffffff;
/** Behavior group bits usable by generated shape behaviors (cold.flags 8-15). */
const GROUP_BITS = 8;
/** Safety valve for a repeating burst with a period far below the frame time. */
const MAX_BURSTS_PER_FRAME = 64;

export interface CompiledParticles {
  /** Behaviors appended to the swarm, generated ones first. */
  readonly behaviors: readonly BehaviorDefinition[];
  /** SWARM_SET_CURVES payload, or null when no render-side curve is used. */
  readonly curves: Float32Array | null;
  /** SwarmRenderFlag bits the curves need. */
  readonly renderFlags: number;
}

/**
 * One emitter's live state. `Particles` creates these (its handles implement
 * the interface) so the API works before this chunk has loaded; everything
 * that reads or compiles them lives here.
 */
export interface EmitterState {
  readonly name: string;
  rate: number;
  enabled: boolean;
  x: number;
  y: number;
  options: EmitterOptions;
  /** The options changed: recompile the spawn block. */
  dirty: boolean;
  /** Only the position changed: patch the spawn block in place. */
  moved: boolean;
  /** One-off count queued by `burst()` / `emit()`. */
  queued: number;
  /** Fractional part of `rate` carried to the next frame. */
  carry: number;
  /** Seconds this emitter has been playing (burst schedule). */
  time: number;
  burstCount: number;
  burstRepeat: number;
  /** Next scheduled burst, `Infinity` when none is left. */
  nextBurst: number;
  /** Compiled spawn block, reused frame after frame (no allocation). */
  spawn: SpawnOptions | null;
  /** Name of the generated shape behavior, or '' when the shape is direct. */
  shapeName: string;
  /** Group bit of that behavior (0 when there is none). */
  shapeGroup: number;
  /** Its params, reused. */
  shapeParams: [number, number, number, number];
}

function fail(message: string): never {
  throw new CozyGPUError('INVALID_ARGUMENT', message);
}

function isFinitePair(range: Range | undefined): boolean {
  if (range === undefined) return true;
  if (typeof range === 'number') return Number.isFinite(range);
  return (
    range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])
  );
}

function lo(range: Range | undefined, fallback: number): number {
  if (range === undefined) return fallback;
  return typeof range === 'number' ? range : range[0];
}

// ─── shapes ───────────────────────────────────────────────────────────────────

type ShapeKind = 'point' | 'rect' | 'disc' | 'ring' | 'line';

function shapeKind(shape: EmitterShape | undefined): ShapeKind {
  if (!shape) return 'point';
  const s = shape as Partial<Record<string, unknown>>;
  if (s.point) return 'point';
  if (s.rect) return 'rect';
  if (s.line) return 'line';
  if (s.disc) {
    const disc = s.disc as { radius: number; inner?: number };
    return (disc.inner ?? 0) > 0 ? 'ring' : 'disc';
  }
  return fail('particle emitter: unknown shape');
}

/**
 * `line` and `ring` cannot be expressed with the spawn block's per-axis box,
 * so they are placed by a behavior that runs once per object, in the step it
 * was spawned in (`age <= dt`). `sim.time` salts the hash so a reused ring
 * slot does not land on the same spot every cycle.
 */
function shapeBehavior(
  name: string,
  group: number,
  kind: 'line' | 'ring',
  defaults: readonly [number, number, number, number],
): BehaviorDefinition<{ shape: 'vec4f' }> {
  const wgsl =
    kind === 'line'
      ? `
    if (p.age <= sim.dt) {
      p.pos = mix($params.shape.xy, $params.shape.zw, rand01(i, ${name}_salt()));
    }`
      : `
    if (p.age <= sim.dt) {
      let salt = ${name}_salt();
      let s = $params.shape;
      let r = sqrt(mix(s.z * s.z, s.w * s.w, rand01(i, salt)));
      let a = SWARM_TAU * rand01(i, salt + 7919u);
      p.pos = s.xy + vec2f(cos(a), sin(a)) * r;
    }`;
  const glsl =
    kind === 'line'
      ? `
    if (p.age <= sim.dt) {
      p.pos = mix($params.shape.xy, $params.shape.zw, rand01(i, ${name}_salt()));
    }`
      : `
    if (p.age <= sim.dt) {
      uint salt = ${name}_salt();
      vec4 s = $params.shape;
      float r = sqrt(mix(s.z * s.z, s.w * s.w, rand01(i, salt)));
      float a = SWARM_TAU * rand01(i, salt + 7919u);
      p.pos = s.xy + vec2(cos(a), sin(a)) * r;
    }`;
  return {
    name,
    params: { shape: 'vec4f' },
    defaults: { shape: [defaults[0], defaults[1], defaults[2], defaults[3]] },
    groups: group,
    helpers: `fn ${name}_salt() -> u32 { return u32(fract(sim.time) * 65535.0); }`,
    update: wgsl,
    glsl: {
      helpers: `uint ${name}_salt() { return uint(fract(sim.time) * 65535.0); }`,
      update: glsl,
    },
  };
}

/** Params of the shape behavior: line = both ends, ring = centre + radii. */
function shapeParamsOf(
  state: EmitterState,
  out: [number, number, number, number],
): void {
  const shape = state.options.shape;
  if (shapeKind(shape) === 'line') {
    const line = (shape as { line: { x2: number; y2: number } }).line;
    // The segment keeps its direction and length when the emitter moves.
    out[0] = state.x;
    out[1] = state.y;
    out[2] = state.x + (line.x2 - (state.options.x ?? 0));
    out[3] = state.y + (line.y2 - (state.options.y ?? 0));
    return;
  }
  const disc = (shape as { disc: { radius: number; inner?: number } }).disc;
  out[0] = state.x;
  out[1] = state.y;
  out[2] = disc.inner ?? 0;
  out[3] = disc.radius;
}

export interface ShapePlan {
  readonly name: string;
  readonly group: number;
  readonly definition: BehaviorDefinition;
}

/**
 * Assigns a generated behavior (and a free behavior group bit) to every
 * emitter whose shape needs one. Deterministic: the same emitter list always
 * produces the same names and bits.
 */
export function planShapes(
  emitters: readonly EmitterOptions[],
  userBehaviors: readonly BehaviorDefinition[],
): readonly (ShapePlan | null)[] {
  let used = 0;
  for (let i = 0; i < emitters.length; i++)
    used |= (emitters[i].group ?? 0) & 0xff;
  for (let i = 0; i < userBehaviors.length; i++) {
    used |= userBehaviors[i].groups ?? 0;
  }
  const plans: (ShapePlan | null)[] = [];
  for (let i = 0; i < emitters.length; i++) {
    const kind = shapeKind(emitters[i].shape);
    if (kind !== 'line' && kind !== 'ring') {
      plans.push(null);
      continue;
    }
    let bit = 0;
    for (let b = 0; b < GROUP_BITS; b++) {
      if ((used & (1 << b)) === 0) {
        bit = 1 << b;
        break;
      }
    }
    if (bit === 0) {
      fail(
        'particle emitter: no free behavior group bit left for a line or ' +
          'ring shape (8 bits are shared with SpawnOptions.group)',
      );
    }
    used |= bit;
    const name = `pxShape${i}`;
    plans.push({
      name,
      group: bit,
      definition: shapeBehavior(name, bit, kind, [0, 0, 0, 0]),
    });
  }
  return plans;
}

// ─── over-life curves ─────────────────────────────────────────────────────────

/** Linear sample of `values` (spread evenly over [0, 1]) at `u`. */
function sampleAt(values: readonly number[], u: number): number {
  const last = values.length - 1;
  if (last <= 0) return values[0];
  const x = Math.min(Math.max(u, 0), 1) * last;
  const i = Math.min(last - 1, Math.floor(x));
  const f = x - i;
  return values[i] + (values[i + 1] - values[i]) * f;
}

/** Same, channel by channel, on packed colors. */
function sampleColorAt(colors: readonly number[], u: number): number {
  const last = colors.length - 1;
  if (last <= 0) return colors[0];
  const x = Math.min(Math.max(u, 0), 1) * last;
  const i = Math.min(last - 1, Math.floor(x));
  const f = x - i;
  const a = colors[i];
  const b = colors[i + 1];
  let out = 0;
  for (let k = 0; k < 4; k++) {
    const s = k * 8;
    const v = Math.round(
      ((a >>> s) & 0xff) + (((b >>> s) & 0xff) - ((a >>> s) & 0xff)) * f,
    );
    out |= v << s;
  }
  return out >>> 0;
}

function channel(
  over: OverLife,
  key: 'alpha' | 'size' | 'rotation' | 'drag',
): readonly number[] | undefined {
  const values = over[key];
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0) {
    fail(`particle over-life "${key}" must be a non-empty array`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      fail(`particle over-life "${key}" must contain finite numbers`);
    }
  }
  if (values.length > SWARM_CURVE_STOPS) {
    fail(
      `particle over-life "${key}" has ${values.length} stops; the limit is ` +
        `${SWARM_CURVE_STOPS}`,
    );
  }
  return values as readonly number[];
}

interface CurveStops {
  /** SWARM_CURVE_STOPS positions; the last one repeats when there are fewer. */
  readonly stops: number[];
  /** Stops actually used (1 to SWARM_CURVE_STOPS). */
  readonly count: number;
}

/** Shared stop positions of every channel (ascending, in [0, 1]). */
function curveStops(over: OverLife, counts: readonly number[]): CurveStops {
  let n = 1;
  for (let i = 0; i < counts.length; i++) n = Math.max(n, counts[i]);
  const given = over.stops;
  if (given) {
    if (given.length < 1 || given.length > SWARM_CURVE_STOPS) {
      fail(`particle over-life "stops" needs 1 to ${SWARM_CURVE_STOPS} values`);
    }
    for (let i = 0; i < given.length; i++) {
      const s = given[i];
      if (!(s >= 0 && s <= 1))
        fail('particle over-life "stops" must be in [0, 1]');
      if (i > 0 && s < given[i - 1]) {
        fail('particle over-life "stops" must ascend');
      }
    }
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0 && counts[i] !== given.length) {
        fail(
          'particle over-life channels must have as many values as "stops" ' +
            `(${given.length})`,
        );
      }
    }
    n = given.length;
  }
  const stops: number[] = [];
  for (let k = 0; k < SWARM_CURVE_STOPS; k++) {
    const i = Math.min(k, n - 1);
    stops.push(given ? given[i] : n > 1 ? i / (n - 1) : 0);
  }
  return { stops, count: n };
}

/** Normalized position of stop `k` within the used stops. */
function stopU(k: number, count: number): number {
  const i = Math.min(k, count - 1);
  return count > 1 ? i / (count - 1) : 0;
}

/**
 * Packs the render-side curves into the SWARM_CURVE_BYTES block. Channels
 * shorter than the stop count are resampled, so `{ color: [a, b, c], size:
 * [1, 0] }` is one consistent set of four stops.
 */
export function packCurves(over: OverLife): Float32Array | null {
  const colors = over.color;
  if (colors !== undefined && (!Array.isArray(colors) || colors.length === 0)) {
    fail('particle over-life "color" must be a non-empty array');
  }
  const alpha = channel(over, 'alpha');
  const size = channel(over, 'size');
  if (colors !== undefined && colors.length > SWARM_CURVE_STOPS) {
    fail(
      `particle over-life "color" has ${colors.length} stops; the limit is ` +
        `${SWARM_CURVE_STOPS}`,
    );
  }
  if (!colors && !alpha && !size) return null;
  const packed: number[] = [];
  if (colors) {
    for (let i = 0; i < colors.length; i++)
      packed.push(toPackedColor(colors[i]));
  }
  const { stops, count } = curveStops(over, [
    packed.length,
    alpha ? alpha.length : 0,
    size ? size.length : 0,
  ]);
  const buffer = new ArrayBuffer(SWARM_CURVE_BYTES);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  for (let k = 0; k < SWARM_CURVE_STOPS; k++) {
    const u = stopU(k, count);
    f32[SCV_STOPS / 4 + k] = stops[k];
    u32[SCV_COLOR / 4 + k] = packed.length ? sampleColorAt(packed, u) : WHITE;
    f32[SCV_SIZE / 4 + k] = size ? sampleAt(size, u) : 1;
    f32[SCV_ALPHA / 4 + k] = alpha ? sampleAt(alpha, u) : 1;
  }
  return f32;
}

/**
 * WGSL/GLSL helper evaluating the four stops of a generated curve: the same
 * piecewise-linear weights the render shader uses for the color curves.
 */
function curveHelper(name: string, glsl: boolean): string {
  const head = glsl
    ? `vec4 ${name}_w(float t) {`
    : `fn ${name}_w(t: f32) -> vec4f {`;
  const vec = glsl ? 'vec4' : 'vec4f';
  const decl = glsl ? 'float' : 'let';
  return (
    `${head}\n` +
    `  ${glsl ? 'vec4' : 'let'} s = $params.stops;\n` +
    `  ${decl} u0 = clamp((t - s.x) / max(s.y - s.x, 1e-6), 0.0, 1.0);\n` +
    `  ${decl} u1 = clamp((t - s.y) / max(s.z - s.y, 1e-6), 0.0, 1.0);\n` +
    `  ${decl} u2 = clamp((t - s.z) / max(s.w - s.z, 1e-6), 0.0, 1.0);\n` +
    `  return ${vec}(1.0 - u0, u0 - u0 * u1, u1 - u1 * u2, u2);\n` +
    `}`
  );
}

function curveBehavior(
  name: string,
  values: readonly number[],
  stops: CurveStops,
  body: string,
): BehaviorDefinition<{ stops: 'vec4f'; values: 'vec4f' }> {
  const v: number[] = [];
  for (let k = 0; k < SWARM_CURVE_STOPS; k++) {
    v.push(sampleAt(values, stopU(k, stops.count)));
  }
  const update = `
    ${body.replace(/\$w/g, `${name}_w(clamp(p.age / p.life, 0.0, 1.0))`)}`;
  return {
    name,
    params: { stops: 'vec4f', values: 'vec4f' },
    defaults: {
      stops: [stops.stops[0], stops.stops[1], stops.stops[2], stops.stops[3]],
      values: [v[0], v[1], v[2], v[3]],
    },
    helpers: curveHelper(name, false),
    update,
    glsl: { helpers: curveHelper(name, true), update },
  };
}

/**
 * Curves that drive motion cannot live in the render shader: `rotation` and
 * `drag` become behaviors that run in the step shader on both backends.
 */
export function compileOverLife(over: OverLife): CompiledParticles {
  const curves = packCurves(over);
  const rotation = channel(over, 'rotation');
  const drag = channel(over, 'drag');
  const list: BehaviorDefinition[] = [];
  if (rotation || drag) {
    const stops = curveStops(over, [
      rotation ? rotation.length : 0,
      drag ? drag.length : 0,
    ]);
    // `rotation` and `drag` share the stop positions of the render curves.
    if (rotation) {
      list.push(
        curveBehavior(
          'pxRot',
          rotation,
          stops,
          'p.angVel = dot($w, $params.values);',
        ),
      );
    }
    if (drag) {
      list.push(
        curveBehavior(
          'pxDrag',
          drag,
          stops,
          'p.vel *= exp(-dot($w, $params.values) * sim.dt);',
        ),
      );
    }
  }
  return {
    behaviors: list,
    curves,
    renderFlags: curves ? SwarmRenderFlag.CURVES : 0,
  };
}

// ─── emitters ─────────────────────────────────────────────────────────────────

/** Throws INVALID_ARGUMENT when the emitter cannot be compiled. */
export function validateEmitter(emitter: EmitterOptions): void {
  const e = emitter ?? {};
  if (e.rate !== undefined && !(e.rate >= 0 && Number.isFinite(e.rate))) {
    fail('particle emitter: "rate" must be a finite, non-negative number');
  }
  if (typeof e.burst === 'object' && e.burst !== null) {
    const burst = e.burst;
    if (!(burst.count > 0)) fail('particle emitter: "burst.count" must be > 0');
    if (burst.at !== undefined && !(burst.at >= 0)) {
      fail('particle emitter: "burst.at" must be >= 0');
    }
    if (burst.repeat !== undefined && !(burst.repeat >= 0)) {
      fail('particle emitter: "burst.repeat" must be >= 0');
    }
  } else if (e.burst !== undefined && !(e.burst > 0)) {
    fail('particle emitter: "burst" must be a count > 0');
  }
  const ranges: (Range | undefined)[] = [
    e.speed,
    e.size,
    e.rotation,
    e.angularVelocity,
    e.alpha,
    e.direction,
  ];
  for (let i = 0; i < ranges.length; i++) {
    if (!isFinitePair(ranges[i])) {
      fail('particle emitter: ranges must be a number or [min, max]');
    }
  }
  const life = e.life as Range | 'immortal' | undefined;
  if (life === 'immortal') {
    fail(
      "particle emitter: life 'immortal' never frees a ring slot; give a " +
        'finite life (ARCHITECTURE §24.5)',
    );
  }
  if (life !== undefined) {
    if (!isFinitePair(life) || !(lo(life, 1) > 0)) {
      fail('particle emitter: "life" must be a positive number or [min, max]');
    }
  }
  if (e.group !== undefined && (e.group < 0 || e.group > 0xff)) {
    fail('particle emitter: "group" must be a bit mask in [0, 255]');
  }
  shapeKind(e.shape);
}

/** `EmitterOptions.burst` → count + period. */
export function burstOf(emitter: EmitterOptions): {
  count: number;
  at: number;
  repeat: number;
} {
  const burst = emitter.burst;
  if (burst === undefined) return { count: 0, at: Infinity, repeat: 0 };
  if (typeof burst === 'number') return { count: burst, at: 0, repeat: 0 };
  return { count: burst.count, at: burst.at ?? 0, repeat: burst.repeat ?? 0 };
}

/**
 * (Re)builds the emitter's spawn block. Called when its options change, never
 * per frame; the object and its range tuples are reused.
 */
export function compileSpawn(state: EmitterState): SpawnOptions {
  const e = state.options;
  const kind = shapeKind(e.shape);
  if ((kind === 'line' || kind === 'ring') && !state.shapeName) {
    fail(
      'particle emitter: a line shape (or a disc with an inner radius) needs ' +
        'its own emitter (addEmitter), not a one-off emit()',
    );
  }
  const out = (state.spawn ?? {}) as Record<string, unknown>;
  // position (fields the shape does not use stay undefined)
  out.disc = undefined;
  out.x = undefined;
  out.y = undefined;
  if (kind === 'rect') {
    const rect = (e.shape as { rect: { width: number; height: number } }).rect;
    out.x = [state.x - rect.width / 2, state.x + rect.width / 2];
    out.y = [state.y - rect.height / 2, state.y + rect.height / 2];
  } else if (kind === 'disc') {
    const disc = (e.shape as { disc: { radius: number } }).disc;
    out.disc = { x: state.x, y: state.y, radius: disc.radius };
  } else {
    // point, or a shape placed by the generated behavior.
    out.x = state.x;
    out.y = state.y;
  }
  const moving = e.speed !== undefined || e.direction !== undefined;
  out.speed = moving ? (e.speed ?? 0) : undefined;
  out.angle = moving ? (e.direction ?? WHOLE_CIRCLE) : undefined;
  out.size = e.size ?? 8;
  out.life = e.life ?? 1;
  out.rotation = e.rotation;
  out.angularVelocity = e.angularVelocity;
  out.color = e.color;
  out.alpha = e.alpha;
  out.frame = e.frame;
  out.group = (e.group ?? 0) | state.shapeGroup;
  state.spawn = out as SpawnOptions;
  return state.spawn;
}

/** Moves an already compiled spawn block (no allocation, no recompile). */
export function moveSpawn(state: EmitterState): void {
  const out = state.spawn as Record<string, unknown> | null;
  if (!out) return;
  const kind = shapeKind(state.options.shape);
  if (kind === 'rect') {
    const rect = (
      state.options.shape as { rect: { width: number; height: number } }
    ).rect;
    const x = out.x as [number, number];
    const y = out.y as [number, number];
    x[0] = state.x - rect.width / 2;
    x[1] = state.x + rect.width / 2;
    y[0] = state.y - rect.height / 2;
    y[1] = state.y + rect.height / 2;
  } else if (kind === 'disc') {
    const disc = out.disc as { x: number; y: number };
    disc.x = state.x;
    disc.y = state.y;
  } else {
    out.x = state.x;
    out.y = state.y;
  }
}

/** Objects due from one emitter after `dt` seconds (and the bookkeeping). */
export function dueCount(state: EmitterState, dt: number): number {
  let n = state.queued;
  state.queued = 0;
  if (state.rate > 0 && dt > 0) {
    state.carry += state.rate * dt;
    const whole = Math.floor(state.carry);
    if (whole > 0) {
      state.carry -= whole;
      n += whole;
    }
  }
  state.time += dt;
  if (state.burstCount > 0) {
    let guard = MAX_BURSTS_PER_FRAME;
    while (state.time >= state.nextBurst && guard-- > 0) {
      n += state.burstCount;
      state.nextBurst =
        state.burstRepeat > 0 ? state.nextBurst + state.burstRepeat : Infinity;
    }
  }
  return n;
}

/** What `Particles` needs from its swarm; keeps this module free of it. */
export interface SpawnTarget {
  readonly capacity: number;
  spawn(count: number, options?: SpawnOptions): number;
  behavior<P extends ParamSpec>(name: string): Behavior<P>;
}

/**
 * Advances every emitter and emits at most one SWARM_SPAWN each. O(emitters),
 * never O(particles), and allocation-free in the steady state.
 *
 * `emitting` false (a paused `Particles`) still compiles and moves the
 * emitters but spawns nothing, and leaves queued bursts queued.
 */
export function advanceEmitters(
  target: SpawnTarget,
  states: readonly EmitterState[],
  dt: number,
  emitting = true,
): number {
  let spawned = 0;
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    if (!state.enabled) {
      state.queued = 0;
      continue;
    }
    if (!state.spawn || state.dirty) {
      state.dirty = false;
      state.moved = false;
      compileSpawn(state);
      const burst = burstOf(state.options);
      state.burstCount = burst.count;
      state.burstRepeat = burst.repeat;
      state.nextBurst = burst.count > 0 ? state.time + burst.at : Infinity;
      if (state.shapeName) updateShape(target, state);
    } else if (state.moved) {
      state.moved = false;
      moveSpawn(state);
      if (state.shapeName) updateShape(target, state);
    }
    // Paused: shapes and moves still take effect, but nothing spawns and
    // `queued` is kept, so a burst() while paused fires on play().
    if (!emitting) continue;
    const n = dueCount(state, dt);
    const spawn = state.spawn;
    if (n > 0 && spawn) {
      target.spawn(Math.min(n, target.capacity), spawn);
      spawned += n;
    }
  }
  return spawned;
}

function updateShape(target: SpawnTarget, state: EmitterState): void {
  shapeParamsOf(state, state.shapeParams);
  const params = state.shapeParams;
  target
    .behavior<{ shape: 'vec4f' }>(state.shapeName)
    .set(
      'shape',
      params as unknown as readonly [number, number, number, number],
    );
}

/** `ParticlesOptions.emitter` → a list (possibly empty). */
export function emitterList(
  emitter: ParticlesOptions['emitter'],
): readonly EmitterOptions[] {
  if (!emitter) return [];
  return Array.isArray(emitter)
    ? (emitter as readonly EmitterOptions[])
    : [emitter as EmitterOptions];
}

function hasVelocity(list: readonly BehaviorDefinition[]): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i].name === 'velocity') return true;
  }
  return false;
}

/**
 * Full compilation of one `Particles`: generated shape behaviors, the
 * built-in velocity integrator (unless the caller brought one), the over-life
 * motion curves, then the caller's own behaviors.
 */
export function compileParticles(options: ParticlesOptions): CompiledParticles {
  return compileFor(options, emitterList(options.emitter));
}

/**
 * Same, for a live emitter list (emitters added after construction). The
 * shape plans are returned so the caller can wire them into its states.
 */
export function compileFor(
  options: ParticlesOptions,
  emitters: readonly EmitterOptions[],
  plansOut?: (ShapePlan | null)[],
): CompiledParticles {
  for (let i = 0; i < emitters.length; i++) validateEmitter(emitters[i]);
  const user = options.behaviors ?? [];
  const plans = planShapes(emitters, user);
  const life = compileOverLife(options.over ?? {});
  const list: BehaviorDefinition[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (plan) list.push(plan.definition);
    if (plansOut) plansOut.push(plan);
  }
  if (!hasVelocity(user)) list.push(velocityBehavior());
  for (let i = 0; i < life.behaviors.length; i++) list.push(life.behaviors[i]);
  for (let i = 0; i < user.length; i++) list.push(user[i]);
  return {
    behaviors: list,
    curves: life.curves,
    renderFlags: life.renderFlags,
  };
}

/** Identity curves: white, full size, full alpha at every stop. */
export function identityCurves(): Float32Array {
  const buffer = new ArrayBuffer(SWARM_CURVE_BYTES);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  for (let k = 0; k < SWARM_CURVE_STOPS; k++) {
    f32[SCV_STOPS / 4 + k] = k / (SWARM_CURVE_STOPS - 1);
    u32[SCV_COLOR / 4 + k] = WHITE;
    f32[SCV_SIZE / 4 + k] = 1;
    f32[SCV_ALPHA / 4 + k] = 1;
  }
  return f32;
}
