/**
 * Emitter compiler, the cases the main suite leaves out (ARCHITECTURE §24.2-
 * §24.4): three render channels of different lengths on one stop set, motion
 * curves with explicit stops, the burst guard, the carry across many small
 * frames, the line/ring shape params as the emitter moves, and the group-bit
 * allocator running out.
 */
import { behaviors as builtin } from '../swarm/behaviors';
import { composeSwarmShaders } from '../swarm/composer';
import { installGlslComposer } from '../swarm/glsl';
import type { SpawnOptions } from '../swarm/types';
import {
  SCV_ALPHA,
  SCV_COLOR,
  SCV_SIZE,
  SCV_STOPS,
  SWARM_CURVE_BYTES,
  SWARM_CURVE_STOPS,
} from '../types/layouts';
import {
  advanceEmitters,
  compileOverLife,
  compileSpawn,
  dueCount,
  moveSpawn,
  packCurves,
  planShapes,
} from './emitter';
import type { EmitterState, SpawnTarget } from './emitter';
import type { EmitterOptions } from './types';

installGlslComposer();

/** The weights the render shader computes (render.wgsl swarm_curve_w). */
function weights(stops: Float32Array, t: number): number[] {
  const u = (a: number, b: number): number =>
    Math.min(1, Math.max(0, (t - a) / Math.max(b - a, 1e-6)));
  const u0 = u(stops[0], stops[1]);
  const u1 = u(stops[1], stops[2]);
  const u2 = u(stops[2], stops[3]);
  return [1 - u0, u0 - u0 * u1, u1 - u1 * u2, u2];
}

function evaluate(curves: Float32Array, t: number) {
  const u32 = new Uint32Array(curves.buffer, curves.byteOffset, 16);
  const w = weights(curves.subarray(SCV_STOPS / 4, SCV_STOPS / 4 + 4), t);
  const color = [0, 0, 0, 0];
  let size = 0;
  let alpha = 0;
  for (let k = 0; k < SWARM_CURVE_STOPS; k++) {
    const packed = u32[SCV_COLOR / 4 + k];
    for (let c = 0; c < 4; c++) {
      color[c] += (((packed >>> (c * 8)) & 0xff) / 255) * w[k];
    }
    size += curves[SCV_SIZE / 4 + k] * w[k];
    alpha += curves[SCV_ALPHA / 4 + k] * w[k];
  }
  return { color, size, alpha };
}

function state(options: EmitterOptions): EmitterState {
  return {
    name: options.name ?? 'main',
    rate: options.rate ?? 0,
    enabled: options.enabled ?? true,
    x: options.x ?? 0,
    y: options.y ?? 0,
    options,
    dirty: true,
    moved: false,
    queued: 0,
    carry: 0,
    time: 0,
    burstCount: 0,
    burstRepeat: 0,
    nextBurst: Infinity,
    spawn: null,
    shapeName: '',
    shapeGroup: 0,
    shapeParams: [0, 0, 0, 0],
  };
}

/** A SpawnTarget that records what it was asked for. */
function recorder(capacity = 1_000_000) {
  const spawns: number[] = [];
  const params: number[][] = [];
  const target: SpawnTarget = {
    capacity,
    spawn: (count: number) => {
      spawns.push(count);
      return 0;
    },
    behavior: () =>
      ({
        set: (_name: string, value: readonly number[]) => {
          params.push(Array.from(value));
        },
      }) as never,
  };
  return { target, spawns, params };
}

describe('curve packing', () => {
  it('fills the whole SWARM_CURVE_BYTES block', () => {
    const curves = packCurves({ size: [1, 0] })!;
    expect(curves.byteLength).toBe(SWARM_CURVE_BYTES);
    expect(curves.length).toBe(SWARM_CURVE_BYTES / 4);
  });

  it('puts three channels of different lengths on one stop set', () => {
    // color is the longest (4), so the stops are [0, 1/3, 2/3, 1] and the
    // shorter channels are resampled onto them.
    const curves = packCurves({
      color: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
      size: [4, 0],
      alpha: [1, 0.5, 0],
    })!;
    const stops = Array.from(curves.subarray(SCV_STOPS / 4, SCV_STOPS / 4 + 4));
    expect(stops[0]).toBeCloseTo(0, 6);
    expect(stops[1]).toBeCloseTo(1 / 3, 6);
    expect(stops[2]).toBeCloseTo(2 / 3, 6);
    expect(stops[3]).toBeCloseTo(1, 6);
    expect(curves[SCV_SIZE / 4 + 0]).toBeCloseTo(4, 5);
    expect(curves[SCV_SIZE / 4 + 3]).toBeCloseTo(0, 5);
    expect(curves[SCV_ALPHA / 4 + 0]).toBeCloseTo(1, 5);
    expect(curves[SCV_ALPHA / 4 + 3]).toBeCloseTo(0, 5);
    expect(evaluate(curves, 0.5).size).toBeCloseTo(2, 5);
    expect(evaluate(curves, 0.5).alpha).toBeCloseTo(0.5, 5);
  });

  it('defaults the channels nobody gave to white, size 1, alpha 1', () => {
    const curves = packCurves({ size: [2, 1] })!;
    for (let k = 0; k < SWARM_CURVE_STOPS; k++) {
      expect(
        new Uint32Array(curves.buffer, curves.byteOffset, 16)[
          SCV_COLOR / 4 + k
        ],
      ).toBe(0xffffffff);
      expect(curves[SCV_ALPHA / 4 + k]).toBe(1);
    }
  });

  it('refuses an empty or non-array channel', () => {
    expect(() => packCurves({ color: [] })).toThrow(/non-empty/);
    expect(() => packCurves({ size: [] })).toThrow(/non-empty/);
    expect(() => packCurves({ alpha: [1, NaN] })).toThrow(/finite/);
    expect(() =>
      packCurves({ color: ['#fff', '#000', '#fff', '#000', '#fff'] }),
    ).toThrow(/limit is 4/);
  });
});

describe('motion curves', () => {
  it('takes its stops from rotation alone when nothing else is given', () => {
    const compiled = compileOverLife({ rotation: [1, 2] });
    expect(compiled.behaviors).toHaveLength(1);
    expect(compiled.behaviors[0].defaults).toEqual({
      stops: [0, 1, 1, 1],
      values: [1, 2, 2, 2],
    });
  });

  it('honours explicit stops shared by rotation and drag', () => {
    const compiled = compileOverLife({
      rotation: [0, 4, 0],
      drag: [1, 1, 5],
      stops: [0, 0.25, 1],
    });
    for (const behavior of compiled.behaviors) {
      const defaults = behavior.defaults as unknown as { stops: number[] };
      expect(defaults.stops).toEqual([0, 0.25, 1, 1]);
    }
    expect(compiled.behaviors[1].defaults).toEqual({
      stops: [0, 0.25, 1, 1],
      values: [1, 1, 5, 5],
    });
  });

  it('emits a drag body that reads dt, and compiles in both languages', () => {
    const compiled = compileOverLife({ drag: [0, 3] });
    const wgsl = composeSwarmShaders(compiled.behaviors, 0);
    expect(wgsl.compute).toContain('sim.dt');
    expect(wgsl.compute).toContain('pxDrag_w(clamp(p.age / p.life, 0.0, 1.0))');
    const glsl = composeSwarmShaders(compiled.behaviors, 0, 'glsl300es');
    expect(glsl.compute).toContain('pxDrag_w');
  });

  it('refuses more stops than the block holds', () => {
    expect(() => compileOverLife({ rotation: [1, 2, 3, 4, 5] })).toThrow(
      /limit is 4/,
    );
    expect(() =>
      compileOverLife({ drag: [1, 2], stops: [0, 0.5, 1] }),
    ).toThrow();
  });
});

describe('emission maths', () => {
  it('carries the fraction across many very small frames', () => {
    const s = state({ rate: 37 });
    let total = 0;
    for (let f = 0; f < 1000; f++) total += dueCount(s, 1 / 1000);
    expect(total).toBe(37);
  });

  it('emits nothing for rate 0 and dt 0 unless something was queued', () => {
    const s = state({ rate: 0 });
    expect(dueCount(s, 1 / 60)).toBe(0);
    s.queued = 4;
    expect(dueCount(s, 0)).toBe(4);
    expect(dueCount(s, 0)).toBe(0);
  });

  it('caps a repeating burst whose period is far below the frame time', () => {
    const s = state({ burst: { count: 1, at: 0, repeat: 1e-5 } });
    s.burstCount = 1;
    s.burstRepeat = 1e-5;
    s.nextBurst = 0;
    const first = dueCount(s, 1 / 60);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(64);
    // The schedule is behind, not lost: the next frame emits again.
    expect(dueCount(s, 1 / 60)).toBeGreaterThan(0);
  });

  it('a disabled emitter drops its queue and does not advance its clock', () => {
    const s = state({ rate: 600, burst: { count: 3, at: 1 } });
    s.enabled = false;
    s.queued = 10;
    const { target, spawns } = recorder();
    for (let f = 0; f < 120; f++) advanceEmitters(target, [s], 1 / 60);
    expect(spawns).toEqual([]);
    expect(s.queued).toBe(0);
    expect(s.time).toBe(0);
  });

  it('clamps one spawn to the capacity rather than to the particle count', () => {
    const s = state({ rate: 1e9 });
    const { target, spawns } = recorder(500);
    advanceEmitters(target, [s], 1 / 60);
    expect(spawns).toEqual([500]);
  });
});

describe('generated shape behaviors', () => {
  it('keeps a line segment direction and length as the emitter moves', () => {
    const s = state({
      x: 10,
      y: 20,
      shape: { line: { x2: 110, y2: 20 } },
    });
    s.shapeName = 'pxShape0';
    s.shapeGroup = 1;
    const { target, params } = recorder();
    advanceEmitters(target, [s], 0);
    expect(params[0]).toEqual([10, 20, 110, 20]);
    s.x = 60;
    s.y = 25;
    s.moved = true;
    advanceEmitters(target, [s], 0);
    expect(params[1]).toEqual([60, 25, 160, 25]);
  });

  it('passes a ring its centre and both radii', () => {
    const s = state({
      x: 4,
      y: 5,
      shape: { disc: { radius: 30, inner: 12 } },
    });
    s.shapeName = 'pxShape0';
    s.shapeGroup = 2;
    const { target, params } = recorder();
    advanceEmitters(target, [s], 0);
    expect(params[0]).toEqual([4, 5, 12, 30]);
    // The shape behavior's group bit joins the emitter's own group bits.
    expect((s.spawn as SpawnOptions).group).toBe(2);
  });

  it('refuses to place a line or ring when no group bit is left', () => {
    const emitters: EmitterOptions[] = [
      { shape: { line: { x2: 1, y2: 1 } }, group: 0xff },
    ];
    expect(() => planShapes(emitters, [])).toThrow(/no free behavior group/);
  });

  it('skips group bits an emitter or a user behavior already claimed', () => {
    const plans = planShapes(
      [{ shape: { line: { x2: 1, y2: 1 } }, group: 0b0011 }],
      [{ ...builtin.velocity(), groups: 0b0100 }],
    );
    expect(plans[0]!.group).toBe(0b1000);
  });

  it('a point emitter needs no behavior and keeps its own group bits', () => {
    const plans = planShapes([{ shape: { point: true }, group: 5 }], []);
    expect(plans[0]).toBeNull();
    const spawn = compileSpawn(state({ group: 5 })) as SpawnOptions;
    expect(spawn.group).toBe(5);
  });
});

describe('moveSpawn', () => {
  it('patches a disc centre in place and keeps its radius', () => {
    const s = state({ x: 0, y: 0, shape: { disc: { radius: 9 } } });
    const spawn = compileSpawn(s);
    const disc = spawn.disc;
    s.x = 40;
    s.y = -3;
    moveSpawn(s);
    expect(spawn.disc).toBe(disc);
    expect(spawn.disc).toEqual({ x: 40, y: -3, radius: 9 });
  });

  it('patches a point emitter and is a no-op before the first compile', () => {
    const s = state({ x: 1, y: 2 });
    moveSpawn(s);
    expect(s.spawn).toBeNull();
    compileSpawn(s);
    s.x = 7;
    s.y = 8;
    moveSpawn(s);
    expect((s.spawn as SpawnOptions).x).toBe(7);
    expect((s.spawn as SpawnOptions).y).toBe(8);
  });
});
