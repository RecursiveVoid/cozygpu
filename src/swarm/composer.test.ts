import { CozyGPUError } from '../types/errors';
import {
  SWARM_COLD_BYTES,
  SWARM_DRAW_BYTES,
  SWARM_HOT_BYTES,
  SWARM_SIM_BYTES,
  SWARM_SPAWN_BYTES,
  SwarmRenderFlag,
  VIEW_UNIFORM_BYTES,
} from '../types/layouts';
import prelude from '../shaders/swarm/prelude.wgsl';
import { behaviors, defineBehavior } from './behaviors';
import { composeSwarmShaders, layoutParams, PARAM_TYPE_INFO } from './composer';
import { SwarmInternalRenderFlag } from './constants';
import type { ParamType } from './types';

/** Tiny WGSL struct layout calculator (host-shareable, non-uniform rules). */
function structSize(src: string, name: string): number {
  const m = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`struct ${name} not found`);
  let offset = 0;
  let maxAlign = 4;
  for (const line of m[1].split('\n')) {
    const field = /^\s*\w+:\s*(\w+)/.exec(line);
    if (!field) continue;
    const info = PARAM_TYPE_INFO[field[1] as ParamType];
    if (!info) throw new Error(`unknown type ${field[1]}`);
    offset = Math.ceil(offset / info.align) * info.align + info.size;
    maxAlign = Math.max(maxAlign, info.align);
  }
  return Math.ceil(offset / maxAlign) * maxAlign;
}

function annotatedSize(src: string, name: string): number {
  const m = new RegExp(`// @size (\\d+)\\s*\\nstruct ${name} `).exec(src);
  if (!m) throw new Error(`@size comment for ${name} not found`);
  return Number(m[1]);
}

describe('prelude structs match layouts.ts', () => {
  test.each([
    ['SwarmHot', SWARM_HOT_BYTES],
    ['SwarmCold', SWARM_COLD_BYTES],
    ['View', VIEW_UNIFORM_BYTES],
    ['SwarmSim', SWARM_SIM_BYTES],
    ['SpawnParams', SWARM_SPAWN_BYTES],
    ['SwarmDraw', SWARM_DRAW_BYTES],
  ])('%s is %i bytes', (name, bytes) => {
    expect(structSize(prelude, name)).toBe(bytes);
    expect(annotatedSize(prelude, name)).toBe(bytes);
  });
});

describe('layoutParams', () => {
  test('empty params get a 16-byte pad struct', () => {
    const layout = layoutParams([behaviors.velocity()]);
    expect(layout.paramsBytes).toBe(16);
    expect(layout.params).toEqual([]);
    expect(layout.wgsl).toContain('_pad: u32');
  });

  test('uniform alignment: vec2f align 8, vec3f/vec4f align 16, structs round to 16', () => {
    const a = defineBehavior({
      name: 'a',
      params: { s: 'f32', v2: 'vec2f', v3: 'vec3f', t: 'u32' },
      defaults: { s: 0, v2: [0, 0], v3: [0, 0, 0], t: 0 },
      update: '',
    });
    const b = defineBehavior({
      name: 'b',
      params: { v4: 'vec4f', i: 'i32' },
      defaults: { v4: [0, 0, 0, 0], i: 0 },
      update: '',
    });
    const layout = layoutParams([a, behaviors.velocity(), b]);
    const offsets = Object.fromEntries(
      layout.params.map(p => [`${p.behavior}.${p.param}`, p.offset]),
    );
    // a: s@0, v2@8, v3@16 (size 12), t@28 → size 32
    expect(offsets).toEqual({
      'a.s': 0,
      'a.v2': 8,
      'a.v3': 16,
      'a.t': 28,
      'b.v4': 32,
      'b.i': 48,
    });
    expect(layout.paramsBytes).toBe(64);
  });

  test('built-in layouts', () => {
    const layout = layoutParams([
      behaviors.velocity(),
      behaviors.acceleration({ name: 'gravity', y: 10 }),
      behaviors.attractor({ x: 1, y: 2 }),
      behaviors.bounds({ x: 0, y: 0, width: 10, height: 10 }),
    ]);
    expect(layout.params.map(p => [p.behavior, p.param, p.offset])).toEqual([
      ['gravity', 'value', 0],
      ['attractor', 'point', 16],
      ['attractor', 'strength', 24],
      ['attractor', 'radius', 28],
      ['bounds', 'rect', 32],
      ['bounds', 'restitution', 48],
    ]);
    expect(layout.paramsBytes).toBe(64);
  });
});

describe('params WGSL pins the layout with @size', () => {
  /** Offsets as WGSL computes them when every member carries @size. */
  function pinnedOffsets(wgsl: string, struct: string): Record<string, number> {
    const m = new RegExp(`struct ${struct} \\{[^\\n]*\\n([^}]*)\\}`).exec(wgsl);
    if (!m) throw new Error(`struct ${struct} not found`);
    const out: Record<string, number> = {};
    let offset = 0;
    for (const line of m[1].split('\n')) {
      const f = /@size\((\d+)\)\s+(\w+):\s*(\w+)/.exec(line);
      if (!f) continue;
      const info = PARAM_TYPE_INFO[f[3] as ParamType];
      const align = info ? info.align : 16; // nested P_ structs: offsets are multiples of 16
      offset = Math.ceil(offset / align) * align;
      out[f[2]] = offset;
      offset += Number(f[1]);
    }
    out.$size = offset;
    return out;
  }

  test('every member is sized and offsets match the layout entries', () => {
    const defs = [
      behaviors.velocity(),
      behaviors.acceleration({ name: 'gravity', y: 10 }),
      behaviors.attractor({ x: 1, y: 2 }),
      behaviors.bounds({ x: 0, y: 0, width: 10, height: 10 }),
      defineBehavior({
        name: 'mix',
        params: { a: 'f32', v3: 'vec3f', b: 'u32', v2: 'vec2f' },
        defaults: { a: 0, v3: [0, 0, 0], b: 0, v2: [0, 0] },
        update: '',
      }),
    ];
    const { wgsl, params, paramsBytes } = layoutParams(defs);
    const top = pinnedOffsets(wgsl, 'Params');
    expect(top.$size).toBe(paramsBytes);
    for (const entry of params) {
      const inner = pinnedOffsets(wgsl, `P_${entry.behavior}`);
      expect(top[`b_${entry.behavior}`] + inner[entry.param]).toBe(
        entry.offset,
      );
      expect(inner.$size % 16).toBe(0);
    }
    const members = wgsl.split('\n').filter(l => /^\s+\w+:/.test(l));
    expect(members).toEqual([]); // no member without @size
  });
});

describe('composeSwarmShaders', () => {
  test('inlines behaviors in order and rewrites $params', () => {
    const out = composeSwarmShaders(
      [
        behaviors.velocity(),
        behaviors.acceleration({ name: 'gravity', y: 300 }),
        behaviors.drag({ k: 0.5 }),
      ],
      0,
    );
    const iVel = out.compute.indexOf('behavior: velocity');
    const iGrav = out.compute.indexOf('behavior: gravity');
    const iDrag = out.compute.indexOf('behavior: drag');
    expect(iVel).toBeGreaterThan(0);
    expect(iGrav).toBeGreaterThan(iVel);
    expect(iDrag).toBeGreaterThan(iGrav);
    expect(out.compute).toContain('params.b_gravity.value');
    expect(out.compute).toContain('params.b_drag.k');
    expect(out.compute).not.toContain('$params');
    expect(out.compute).not.toMatch(/\/\/@[A-Z]/);
    expect(out.render).not.toMatch(/\/\/@[A-Z]/);
    for (const entry of ['cs_step', 'cs_spawn', 'cs_kill']) {
      expect(out.compute).toContain(`fn ${entry}(`);
    }
    expect(out.compute).not.toContain('fn cs_cull(');
    expect(out.render).toContain('fn vs_main(');
    expect(out.render).toContain('fn fs_main(');
  });

  test('user WGSL containing `$` replacement patterns is inserted verbatim', () => {
    const custom = defineBehavior({
      name: 'weird',
      params: { k: 'f32' },
      defaults: { k: 1 },
      update: "// $& $' $1\n p.vel *= $params.k;",
    });
    const out = composeSwarmShaders([custom], 0);
    expect(out.compute).toContain("// $& $' $1");
    expect(out.compute).toContain('p.vel *= params.b_weird.k;');
  });

  test('render flags specialize the render shader', () => {
    const flags =
      SwarmRenderFlag.FADE_OUT |
      SwarmRenderFlag.CIRCLE |
      SwarmInternalRenderFlag.CULL;
    const out = composeSwarmShaders([], flags);
    expect(out.render).toContain('const RF_FADE_OUT: bool = true;');
    expect(out.render).toContain('const RF_SHRINK: bool = false;');
    expect(out.render).toContain('const RF_CIRCLE: bool = true;');
    expect(out.render).toContain('let slot = visible[ii];');
    expect(out.render).toContain('fwidth');
    expect(out.compute).toContain('fn cs_cull(');

    const textured = composeSwarmShaders([], 0);
    expect(textured.render).toContain('let slot = ii;');
    expect(textured.render).toContain('textureSample');
    expect(textured.render).not.toMatch(/var<storage, read> visible/);
  });

  test('helpers are emitted once, before cs_step', () => {
    const swirl = defineBehavior({
      name: 'swirl',
      params: { center: 'vec2f' },
      defaults: { center: [0, 0] },
      helpers:
        'fn swirl_rot(v: vec2f) -> vec2f {\n  let t = v;\n  return vec2f(-t.y, t.x);\n}',
      update: 'p.vel += swirl_rot(p.pos - $params.center) * sim.dt;',
    });
    const out = composeSwarmShaders([swirl], 0);
    expect(out.compute.indexOf('fn swirl_rot')).toBeLessThan(
      out.compute.indexOf('fn cs_step'),
    );
  });
});

describe('validation', () => {
  const expectInvalid = (fn: () => unknown, match: RegExp): void => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(CozyGPUError);
      expect((e as CozyGPUError).code).toBe('INVALID_ARGUMENT');
      expect((e as Error).message).toMatch(match);
      return;
    }
    throw new Error('expected a CozyGPUError');
  };

  test('bad names', () => {
    expectInvalid(
      () =>
        defineBehavior({ name: 'Bad', params: {}, defaults: {}, update: '' }),
      /name must match/,
    );
    expectInvalid(
      () =>
        defineBehavior({ name: '9x', params: {}, defaults: {}, update: '' }),
      /name must match/,
    );
  });

  test('duplicate names', () => {
    expectInvalid(
      () =>
        composeSwarmShaders([behaviors.velocity(), behaviors.velocity()], 0),
      /"velocity": duplicate/,
    );
  });

  test('$params without params, unknown params', () => {
    expectInvalid(
      () =>
        defineBehavior({
          name: 'x',
          params: {},
          defaults: {},
          update: 'p.pos += $params.a;',
        }),
      /"x": uses \$params but declares no params/,
    );
    expectInvalid(
      () =>
        defineBehavior({
          name: 'y',
          params: { a: 'f32' },
          defaults: { a: 1 },
          update: 'p.pos.x += $params.b;',
        }),
      /unknown param "\$params.b"/,
    );
  });

  test('defaults must match the param type', () => {
    expectInvalid(
      () =>
        defineBehavior({
          name: 'z',
          params: { v: 'vec2f' },
          defaults: { v: [1] as unknown as [number, number] },
          update: '',
        }),
      /default for "v" must be 2 numbers/,
    );
  });

  test('helper identifiers must be prefixed', () => {
    expectInvalid(
      () =>
        defineBehavior({
          name: 'swirl',
          params: {},
          defaults: {},
          helpers: 'fn rotate(v: vec2f) -> vec2f { return v; }',
          update: '',
        }),
      /helper "rotate" must be prefixed with "swirl_"/,
    );
  });
});
