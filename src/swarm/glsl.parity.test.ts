/**
 * Tester (logic, M2). SWARM_SET_PARAMS bytes are backend-agnostic: the GLSL
 * std140 `G2_B3` block the WebGL2 composer emits must place every param at
 * exactly the byte offset `layoutParams` (the WGSL layout) reports, and the
 * blocks must be the same size. Offsets are recomputed here from the emitted
 * GLSL source with the std140 rules, so a reordered or dropped member fails.
 */
import { behaviors, defineBehavior } from './behaviors';
import { composeSwarmShaders, layoutParams } from './composer';
import { installGlslComposer } from './glsl';
import type { BehaviorDefinition, ParamType } from './types';

beforeAll(() => installGlslComposer());

const STD140: Record<string, { size: number; align: number }> = {
  float: { size: 4, align: 4 },
  int: { size: 4, align: 4 },
  uint: { size: 4, align: 4 },
  vec2: { size: 8, align: 8 },
  vec3: { size: 12, align: 16 },
  vec4: { size: 16, align: 16 },
};
const roundUp = (v: number, a: number) => Math.ceil(v / a) * a;

/** std140 offsets of `layout(std140) uniform G2_B3 { … } params;` in `src`. */
function std140Layout(src: string): {
  offsets: Map<string, number>;
  size: number;
} {
  const structs = new Map<string, [string, string][]>();
  const structRe = /struct (P_\w+) \{([^}]*)\};/g;
  let m: RegExpExecArray | null;
  while ((m = structRe.exec(src)) !== null) {
    const members: [string, string][] = [];
    for (const line of m[2].split('\n')) {
      const f = /^\s*(\w+)\s+(\w+);/.exec(line);
      if (f) members.push([f[1], f[2]]);
    }
    structs.set(m[1], members);
  }
  const block = /layout\(std140\) uniform G2_B3 \{([^}]*)\} params;/.exec(src);
  if (!block) throw new Error('params block not found');
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const line of block[1].split('\n')) {
    const f = /^\s*(\w+)\s+(\w+);/.exec(line);
    if (!f) continue;
    const [, type, field] = f;
    const members = structs.get(type);
    if (!members) {
      // scalar member (the `_pad` case)
      const info = STD140[type];
      offset = roundUp(offset, info.align) + info.size;
      continue;
    }
    offset = roundUp(offset, 16);
    const base = offset;
    let local = 0;
    for (const [mType, mName] of members) {
      const info = STD140[mType];
      if (!info) throw new Error(`unknown GLSL type ${mType}`);
      local = roundUp(local, info.align);
      offsets.set(`${field}.${mName}`, base + local);
      local += info.size;
    }
    offset = base + roundUp(local, 16);
  }
  return { offsets, size: roundUp(offset, 16) };
}

const cases: Array<[string, BehaviorDefinition[]]> = [
  [
    'built-ins',
    [
      behaviors.acceleration(),
      behaviors.drag(),
      behaviors.bounds({ x: 0, y: 0, width: 10, height: 10 }),
      behaviors.attractor({ x: 1, y: 2 }),
    ],
  ],
  [
    'vec3 followed by a scalar',
    [
      defineBehavior({
        name: 'a',
        params: { v: 'vec3f', s: 'f32' } as Record<string, ParamType>,
        defaults: { v: [1, 2, 3], s: 4 },
        update: 'p.pos.x += $params.s;',
        glsl: { update: 'p.pos.x += $params.s;' },
      } as unknown as BehaviorDefinition),
    ],
  ],
  [
    'scalar, vec2, vec3, vec4, ints',
    [
      defineBehavior({
        name: 'b',
        params: {
          f: 'f32',
          v2: 'vec2f',
          v3: 'vec3f',
          i: 'i32',
          v4: 'vec4f',
          u: 'u32',
        } as Record<string, ParamType>,
        defaults: {
          f: 1,
          v2: [1, 2],
          v3: [1, 2, 3],
          i: 5,
          v4: [1, 2, 3, 4],
          u: 7,
        },
        update: 'p.pos.x += $params.f;',
        glsl: { update: 'p.pos.x += $params.f;' },
      } as unknown as BehaviorDefinition),
      defineBehavior({
        name: 'c',
        params: { k: 'f32' } as Record<string, ParamType>,
        defaults: { k: 1 },
        update: 'p.pos.y += $params.k;',
        glsl: { update: 'p.pos.y += $params.k;' },
      } as unknown as BehaviorDefinition),
    ],
  ],
  ['no params at all', [behaviors.velocity()]],
];

describe('GLSL std140 params match the WGSL layout byte for byte', () => {
  it.each(cases)('%s', (_name, defs) => {
    const layout = layoutParams(defs);
    const glsl = composeSwarmShaders(defs, 0, 'glsl300es');
    const std = std140Layout(glsl.compute);
    expect(std.size).toBe(layout.paramsBytes);
    expect(glsl.paramsBytes).toBe(layout.paramsBytes);
    for (const entry of layout.params) {
      const field = layout.fields.get(entry.behavior);
      const key = `${field}.${entry.param}`;
      expect([key, std.offsets.get(key)]).toEqual([key, entry.offset]);
    }
    expect(std.offsets.size).toBe(layout.params.length);
  });
});
