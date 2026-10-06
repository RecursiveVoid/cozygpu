/**
 * Emitter compiler: curve packing, generated behaviors, shape plans and the
 * emission maths (ARCHITECTURE §24.2-§24.4). No GPU, no DOM.
 */
import { composeSwarmShaders } from '../swarm/composer';
import { installGlslComposer } from '../swarm/glsl';
import { behaviors as builtin } from '../swarm/behaviors';
import type { SpawnOptions } from '../swarm/types';
import {
  SCV_ALPHA,
  SCV_COLOR,
  SCV_SIZE,
  SCV_STOPS,
  SWARM_CURVE_STOPS,
  SwarmRenderFlag,
} from '../types/layouts';
import {
  advanceEmitters,
  burstOf,
  compileOverLife,
  compileParticles,
  compileSpawn,
  dueCount,
  identityCurves,
  moveSpawn,
  packCurves,
  planShapes,
  validateEmitter,
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

function evaluate(
  curves: Float32Array,
  t: number,
): { color: number[]; size: number; alpha: number } {
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

describe('over-life curve packing', () => {
  test('spreads values evenly and evaluates to the given colors', () => {
    const curves = packCurves({ color: ['#ff0000', '#00ff00', '#0000ff'] })!;
    expect(curves).not.toBeNull();
    expect(
      Array.from(curves.subarray(SCV_STOPS / 4, SCV_STOPS / 4 + 4)),
    ).toEqual([0, 0.5, 1, 1]);
    expect(evaluate(curves, 0).color).toEqual([1, 0, 0, 1]);
    expect(evaluate(curves, 0.5).color).toEqual([0, 1, 0, 1]);
    expect(evaluate(curves, 1).color).toEqual([0, 0, 1, 1]);
    // halfway between the first two stops
    const mid = evaluate(curves, 0.25).color;
    expect(mid[0]).toBeCloseTo(0.5, 2);
    expect(mid[1]).toBeCloseTo(0.5, 2);
  });

  test('resamples shorter channels onto the shared stops', () => {
    // 3 color stops → stops [0, .5, 1]; size [4, 0] is sampled at each.
    const curves = packCurves({
      color: ['#ffffff', '#ffffff', '#ffffff'],
      size: [4, 0],
    })!;
    expect(evaluate(curves, 0).size).toBeCloseTo(4, 5);
    expect(evaluate(curves, 0.5).size).toBeCloseTo(2, 5);
    expect(evaluate(curves, 1).size).toBeCloseTo(0, 5);
  });

  test('honours explicit stops and the alpha channel', () => {
    const curves = packCurves({
      alpha: [0, 1, 0],
      stops: [0, 0.2, 1],
    })!;
    expect(evaluate(curves, 0).alpha).toBeCloseTo(0, 5);
    expect(evaluate(curves, 0.1).alpha).toBeCloseTo(0.5, 5);
    expect(evaluate(curves, 0.2).alpha).toBeCloseTo(1, 5);
    expect(evaluate(curves, 0.6).alpha).toBeCloseTo(0.5, 5);
    expect(evaluate(curves, 1).alpha).toBeCloseTo(0, 5);
  });

  test('a single stop is constant, and colors multiply the alpha curve', () => {
    const curves = packCurves({ color: ['#20408060'] })!;
    for (const t of [0, 0.3, 1]) {
      const c = evaluate(curves, t);
      expect(c.color[0]).toBeCloseTo(0x20 / 255, 5);
      expect(c.color[3]).toBeCloseTo(0x60 / 255, 5);
      expect(c.size).toBeCloseTo(1, 5);
      expect(c.alpha).toBeCloseTo(1, 5);
    }
  });

  test('identity curves leave color, size and alpha untouched', () => {
    const curves = identityCurves();
    for (const t of [0, 0.5, 1]) {
      const c = evaluate(curves, t);
      expect(c.color).toEqual([1, 1, 1, 1]);
      expect(c.size).toBeCloseTo(1, 5);
      expect(c.alpha).toBeCloseTo(1, 5);
    }
  });

  test('no render channel packs nothing', () => {
    expect(packCurves({})).toBeNull();
    expect(packCurves({ rotation: [1, 2] })).toBeNull();
  });

  test('refuses too many stops and mismatched explicit stops', () => {
    expect(() => packCurves({ alpha: [1, 1, 1, 1, 1] })).toThrow(
      /limit is 4|INVALID_ARGUMENT/,
    );
    expect(() => packCurves({ alpha: [1, 0], stops: [0, 0.5, 1] })).toThrow();
    expect(() => packCurves({ alpha: [1, 0], stops: [1, 0] })).toThrow(
      /ascend/,
    );
  });
});

describe('over-life motion curves', () => {
  test('rotation and drag become behaviors that compile in both languages', () => {
    const compiled = compileOverLife({ rotation: [0, 6], drag: [0, 2, 4] });
    expect(compiled.behaviors.map(b => b.name)).toEqual(['pxRot', 'pxDrag']);
    expect(compiled.curves).toBeNull();
    expect(compiled.renderFlags).toBe(0);
    const wgsl = composeSwarmShaders(compiled.behaviors, 0);
    expect(wgsl.compute).toContain('pxRot_w');
    expect(wgsl.compute).toContain('params.b_pxDrag');
    const glsl = composeSwarmShaders(compiled.behaviors, 0, 'glsl300es');
    expect(glsl.compute).toContain('vec4 pxRot_w(float t)');
    // the stops and values are uniform params, one vec4 each
    // drag has three values, so both curves use the stops [0, .5, 1] and
    // rotation is resampled onto them.
    const rot = compiled.behaviors[0];
    expect(rot.defaults).toEqual({
      stops: [0, 0.5, 1, 1],
      values: [0, 3, 6, 6],
    });
  });

  test('render curves set the CURVES render flag', () => {
    const compiled = compileOverLife({ size: [1, 0] });
    expect(compiled.renderFlags).toBe(SwarmRenderFlag.CURVES);
    expect(compiled.curves).not.toBeNull();
  });
});

describe('emitter validation', () => {
  test('refuses an immortal life', () => {
    expect(() =>
      validateEmitter({
        rate: 10,
        life: 'immortal',
      } as unknown as EmitterOptions),
    ).toThrow(/immortal/);
  });

  test('refuses nonsense ranges and bursts', () => {
    expect(() => validateEmitter({ rate: -1 })).toThrow();
    expect(() => validateEmitter({ speed: [1, NaN] })).toThrow();
    expect(() => validateEmitter({ burst: 0 })).toThrow();
    expect(() =>
      validateEmitter({ burst: { count: 10, repeat: -1 } }),
    ).toThrow();
    expect(() => validateEmitter({ life: 0 })).toThrow();
    expect(() => validateEmitter({ group: 999 })).toThrow();
  });

  test('accepts the documented shapes', () => {
    validateEmitter({ shape: { point: true } });
    validateEmitter({ shape: { rect: { width: 10, height: 4 } } });
    validateEmitter({ shape: { disc: { radius: 8, inner: 4 } } });
    validateEmitter({ shape: { line: { x2: 100, y2: 40 } } });
    expect(() =>
      validateEmitter({ shape: {} as unknown as EmitterOptions['shape'] }),
    ).toThrow(/unknown shape/);
  });
});

describe('shape compilation', () => {
  test('point, rect and disc map onto SpawnOptions', () => {
    const point = compileSpawn(state({ x: 5, y: 7 })) as SpawnOptions;
    expect(point.x).toBe(5);
    expect(point.y).toBe(7);
    expect(point.size).toBe(8);
    expect(point.life).toBe(1);

    const rect = compileSpawn(
      state({ x: 100, y: 50, shape: { rect: { width: 20, height: 4 } } }),
    ) as SpawnOptions;
    expect(rect.x).toEqual([90, 110]);
    expect(rect.y).toEqual([48, 52]);

    const disc = compileSpawn(
      state({ x: 3, y: 4, shape: { disc: { radius: 12 } } }),
    ) as SpawnOptions;
    expect(disc.disc).toEqual({ x: 3, y: 4, radius: 12 });
  });

  test('speed and direction become the polar spawn fields', () => {
    const spawn = compileSpawn(
      state({ speed: [10, 20], direction: [0, 1] }),
    ) as SpawnOptions;
    expect(spawn.speed).toEqual([10, 20]);
    expect(spawn.angle).toEqual([0, 1]);
    // speed alone emits in every direction
    const any = compileSpawn(state({ speed: 40 })) as SpawnOptions;
    expect(any.angle).toEqual([0, Math.PI * 2]);
  });

  test('moving an emitter patches the spawn block in place', () => {
    const s = state({ x: 0, y: 0, shape: { rect: { width: 10, height: 10 } } });
    const spawn = compileSpawn(s);
    const x = spawn.x;
    s.x = 100;
    s.y = 20;
    moveSpawn(s);
    // same array object: no allocation per move
    expect(spawn.x).toBe(x);
    expect(spawn.x).toEqual([95, 105]);
    expect(spawn.y).toEqual([15, 25]);
  });

  test('line and ring get a generated behavior with a free group bit', () => {
    const emitters: EmitterOptions[] = [
      { shape: { point: true } },
      { shape: { line: { x2: 10, y2: 10 } } },
      { shape: { disc: { radius: 10, inner: 5 } }, group: 1 },
    ];
    const plans = planShapes(emitters, [{ ...builtin.velocity(), groups: 2 }]);
    expect(plans[0]).toBeNull();
    expect(plans[1]!.name).toBe('pxShape1');
    // bits 0 (emitter group) and 1 (behavior groups) are taken
    expect(plans[1]!.group).toBe(4);
    expect(plans[2]!.group).toBe(8);
    const composed = composeSwarmShaders(
      [plans[1]!.definition, plans[2]!.definition],
      0,
    );
    expect(composed.compute).toContain('pxShape1_salt');
    expect(composed.compute).toContain('(c.flags >> 8u) & 4u');
    composeSwarmShaders(
      [plans[1]!.definition, plans[2]!.definition],
      0,
      'glsl300es',
    );
  });

  test('a shape needing a behavior is refused without one', () => {
    expect(() =>
      compileSpawn(state({ shape: { line: { x2: 1, y2: 1 } } })),
    ).toThrow(/addEmitter/);
  });
});

describe('emission maths', () => {
  test('a fractional rate emits exactly rate x time objects', () => {
    const s = state({ rate: 100 });
    let total = 0;
    for (let f = 0; f < 60; f++) total += dueCount(s, 1 / 60);
    expect(total).toBe(100);
    expect(s.carry).toBeCloseTo(0, 6);
  });

  test('bursts fire once, repeat on their period, and queue on demand', () => {
    const s = state({ burst: { count: 5, at: 0.1, repeat: 0.5 } });
    const burst = burstOf(s.options);
    s.burstCount = burst.count;
    s.burstRepeat = burst.repeat;
    s.nextBurst = burst.at;
    expect(dueCount(s, 0.05)).toBe(0);
    expect(dueCount(s, 0.05)).toBe(5);
    expect(dueCount(s, 0.4)).toBe(0);
    expect(dueCount(s, 0.1)).toBe(5);
    s.queued = 3;
    expect(dueCount(s, 0.01)).toBe(3);
  });

  test('a one-shot burst never repeats', () => {
    const s = state({ burst: 7 });
    const burst = burstOf(s.options);
    s.burstCount = burst.count;
    s.burstRepeat = burst.repeat;
    s.nextBurst = burst.at;
    expect(dueCount(s, 0.016)).toBe(7);
    let more = 0;
    for (let f = 0; f < 100; f++) more += dueCount(s, 0.016);
    expect(more).toBe(0);
  });

  test('advanceEmitters spawns once per emitter and skips disabled ones', () => {
    const calls: { count: number; spawn: SpawnOptions | undefined }[] = [];
    const target: SpawnTarget = {
      capacity: 1000,
      spawn: (count, spawn) => {
        calls.push({ count, spawn });
        return 0;
      },
      behavior: () => {
        throw new Error('no behaviors in this test');
      },
    };
    const a = state({ name: 'a', rate: 600 });
    const b = state({ name: 'b', rate: 600, enabled: false });
    advanceEmitters(target, [a, b], 1 / 60);
    expect(calls.length).toBe(1);
    expect(calls[0].count).toBe(10);
    // clamped to the capacity, never to the particle count
    calls.length = 0;
    a.rate = 1e9;
    a.dirty = true;
    advanceEmitters(target, [a, b], 1 / 60);
    expect(calls[0].count).toBe(1000);
  });

  test('a burst emitter reschedules when its options change', () => {
    const calls: number[] = [];
    const target: SpawnTarget = {
      capacity: 100,
      spawn: count => {
        calls.push(count);
        return 0;
      },
      behavior: () => {
        throw new Error('no behaviors in this test');
      },
    };
    const s = state({ burst: { count: 4, at: 0, repeat: 1 } });
    advanceEmitters(target, [s], 0);
    expect(calls).toEqual([4]);
    advanceEmitters(target, [s], 0.5);
    expect(calls).toEqual([4]);
    advanceEmitters(target, [s], 0.5);
    expect(calls).toEqual([4, 4]);
  });
});

describe('compileParticles', () => {
  test('generated behaviors come first and velocity is added once', () => {
    const compiled = compileParticles({
      capacity: 100,
      emitter: [{ shape: { line: { x2: 10, y2: 0 } } }],
      over: { size: [1, 0], rotation: [0, 4] },
      behaviors: [builtin.acceleration({ name: 'gravity', y: 300 })],
    });
    expect(compiled.behaviors.map(b => b.name)).toEqual([
      'pxShape0',
      'velocity',
      'pxRot',
      'gravity',
    ]);
    expect(compiled.renderFlags).toBe(SwarmRenderFlag.CURVES);
    // the whole program compiles on both backends
    composeSwarmShaders(compiled.behaviors, compiled.renderFlags);
    composeSwarmShaders(compiled.behaviors, compiled.renderFlags, 'glsl300es');
  });

  test('a caller-supplied velocity is not duplicated', () => {
    const compiled = compileParticles({
      capacity: 10,
      behaviors: [builtin.velocity()],
    });
    expect(compiled.behaviors.map(b => b.name)).toEqual(['velocity']);
  });
});
