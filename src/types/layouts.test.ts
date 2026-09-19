/**
 * Tester: normative byte layouts (src/types/layouts.ts, ARCHITECTURE §4)
 * checked against the WGSL structs with an independent implementation of
 * the WGSL memory layout rules (host-shareable + uniform address space).
 */
import cullWGSL from '../shaders/swarm/cull.wgsl';
import computeWGSL from '../shaders/swarm/compute.wgsl';
import preludeWGSL from '../shaders/swarm/prelude.wgsl';
import spriteWGSL from '../shaders/sprite/sprite.wgsl';
import { SPRITE_VERTEX_LAYOUT } from '../sprites/pipeline';
import { composeSwarmShaders } from '../swarm/composer';
import {
  SWARM_UNIFORM_STRIDE,
  SWARM_WORKGROUP_SIZE,
  SWARM_MAX_WORKGROUPS,
} from '../swarm/constants';
import * as L from './layouts';

// ─── Independent WGSL layout calculator ──────────────────────────────────────

interface Layout {
  size: number;
  align: number;
}
interface Member {
  name: string;
  type: string;
  offset: number;
  size: number;
}
interface Struct {
  name: string;
  size: number;
  align: number;
  members: Member[];
}

const roundUp = (k: number, n: number): number => Math.ceil(n / k) * k;

function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function typeLayout(
  type: string,
  structs: Map<string, Struct>,
  uniform: boolean,
): Layout {
  const t = type.replace(/\s+/g, '');
  const scalar: Record<string, Layout> = {
    f32: { size: 4, align: 4 },
    i32: { size: 4, align: 4 },
    u32: { size: 4, align: 4 },
    f16: { size: 2, align: 2 },
  };
  if (scalar[t]) return scalar[t];
  const atomic = /^atomic<(\w+)>$/.exec(t);
  if (atomic) return typeLayout(atomic[1], structs, uniform);
  const vec = /^vec([234])(?:([fiu])|<(\w+)>)$/.exec(t);
  if (vec) {
    const n = Number(vec[1]);
    const el = vec[2] ? { f: 'f32', i: 'i32', u: 'u32' }[vec[2]]! : vec[3];
    const e = typeLayout(el, structs, uniform);
    return { size: n * e.size, align: n === 2 ? 2 * e.align : 4 * e.align };
  }
  const arr = /^array<(.+),(\d+)u?>$/.exec(t);
  if (arr) {
    const e = typeLayout(arr[1], structs, uniform);
    const align = uniform ? roundUp(16, e.align) : e.align;
    const stride = uniform
      ? roundUp(16, roundUp(e.align, e.size))
      : roundUp(e.align, e.size);
    return { size: Number(arr[2]) * stride, align };
  }
  const s = structs.get(t);
  if (s) {
    return { size: s.size, align: uniform ? roundUp(16, s.align) : s.align };
  }
  throw new Error(`unknown WGSL type ${type}`);
}

/** Parses every `struct` in `src` (in order) using WGSL layout rules. */
function parseStructs(
  src: string,
  uniform = false,
  known = new Map<string, Struct>(),
): Map<string, Struct> {
  const clean = stripComments(src);
  const re = /struct\s+(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const members: Member[] = [];
    let offset = 0;
    let align = 1;
    // split on top-level commas (not inside <...> or (...))
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of m[2]) {
      if (ch === '<' || ch === '(') depth++;
      if (ch === '>' || ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    parts.push(cur.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!parts[i]) parts.splice(i, 1);
    }
    for (const part of parts) {
      const f = /^((?:@\w+\([^)]*\)\s*)*)(\w+)\s*:\s*([\w<>, ]+?)\s*$/.exec(
        part,
      );
      if (!f) throw new Error(`cannot parse member "${part}" of ${m[1]}`);
      // Skip vertex-input structs (@location/@builtin members).
      if (/@(location|builtin)/.test(f[1])) {
        members.length = 0;
        break;
      }
      const lay = typeLayout(f[3], known, uniform);
      const sizeAttr = /@size\((\d+)\)/.exec(f[1]);
      const alignAttr = /@align\((\d+)\)/.exec(f[1]);
      const a = alignAttr ? Number(alignAttr[1]) : lay.align;
      const size = sizeAttr ? Number(sizeAttr[1]) : lay.size;
      offset = roundUp(a, offset);
      members.push({ name: f[2], type: f[3], offset, size });
      offset += size;
      align = Math.max(align, a);
    }
    if (members.length === 0) continue;
    known.set(m[1], {
      name: m[1],
      members,
      align,
      size: roundUp(align, offset),
    });
  }
  return known;
}

function offsets(s: Struct | undefined): Record<string, number> {
  if (!s) throw new Error('struct missing');
  return Object.fromEntries(s.members.map(m => [m.name, m.offset]));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WGSL layout calculator (self-check)', () => {
  it('follows the WGSL spec examples', () => {
    const s = parseStructs(
      'struct A { u: f32, v: vec3f, w: vec2f, x: f32 }\n' +
        'struct B { a: vec2f, b: vec3f, c: f32, d: f32, e: A, f: vec3f }',
    );
    expect(offsets(s.get('A'))).toEqual({ u: 0, v: 16, w: 32, x: 40 });
    expect(s.get('A')!.size).toBe(48);
    expect(offsets(s.get('B'))).toEqual({
      a: 0,
      b: 16,
      c: 28,
      d: 32,
      e: 48, // AlignOf(A) = 16
      f: 96, // 48 + SizeOf(A) = 96
    });
    expect(s.get('B')!.size).toBe(112);
    // uniform rules: arrays/structs as members round their alignment up to 16
    const u = parseStructs('struct C { x: f32, y: array<f32, 2> }', true);
    expect(offsets(u.get('C'))).toEqual({ x: 0, y: 16 });
    expect(u.get('C')!.size).toBe(48);
  });
});

describe('prelude.wgsl structs match layouts.ts', () => {
  const structs = parseStructs(preludeWGSL as string, true);

  it('SwarmHot offsets and size', () => {
    const s = structs.get('SwarmHot');
    expect(offsets(s)).toEqual({
      pos: L.SH_POS_X,
      vel: L.SH_VEL_X,
      scale: L.SH_SCALE_X,
      rot: L.SH_ROT,
      angVel: L.SH_ANG_VEL,
      age: L.SH_AGE,
      life: L.SH_LIFE,
    });
    expect(s!.size).toBe(L.SWARM_HOT_BYTES);
    expect(L.SH_POS_Y).toBe(L.SH_POS_X + 4);
    expect(L.SH_VEL_Y).toBe(L.SH_VEL_X + 4);
    expect(L.SH_SCALE_Y).toBe(L.SH_SCALE_X + 4);
    // array<SwarmHot> stride == record bytes (storage: no uniform rounding)
    expect(roundUp(s!.align, s!.size)).toBe(L.SWARM_HOT_BYTES);
  });

  it('SwarmCold offsets and size', () => {
    const s = structs.get('SwarmCold');
    expect(offsets(s)).toEqual({
      color: L.SC_COLOR,
      frame: L.SC_FRAME,
      flags: L.SC_FLAGS,
      user: L.SC_USER,
    });
    expect(s!.size).toBe(L.SWARM_COLD_BYTES);
  });

  it('SpawnParams offsets and size (uniform address space)', () => {
    const s = structs.get('SpawnParams');
    expect(offsets(s)).toEqual({
      first: L.SP_FIRST,
      count: L.SP_COUNT,
      seed: L.SP_SEED,
      frame: L.SP_FRAME,
      posMin: L.SP_POS_MIN,
      posMax: L.SP_POS_MAX,
      velMin: L.SP_VEL_MIN,
      velMax: L.SP_VEL_MAX,
      scaleMin: L.SP_SCALE_MIN,
      scaleMax: L.SP_SCALE_MAX,
      rotMin: L.SP_ROT_MIN,
      rotMax: L.SP_ROT_MAX,
      angVelMin: L.SP_ANG_VEL_MIN,
      angVelMax: L.SP_ANG_VEL_MAX,
      lifeMin: L.SP_LIFE_MIN,
      lifeMax: L.SP_LIFE_MAX,
      colorA: L.SP_COLOR_A,
      colorB: L.SP_COLOR_B,
      frameCount: L.SP_FRAME_COUNT,
      flags: L.SP_FLAGS,
      user: L.SP_USER,
      _pad: L.SP_PAD,
    });
    expect(s!.size).toBe(L.SWARM_SPAWN_BYTES);
  });

  it('View offsets and size', () => {
    const s = structs.get('View');
    expect(offsets(s)).toEqual({
      col0: L.VU_COL0,
      col1: L.VU_COL1,
      translate: L.VU_TRANSLATE,
      resolution: L.VU_RESOLUTION,
      time: L.VU_TIME,
      dt: L.VU_DT,
      dpr: L.VU_DPR,
      _pad: L.VU_DPR + 4,
    });
    expect(s!.size).toBe(L.VIEW_UNIFORM_BYTES);
  });

  it('SwarmSim / SwarmDraw match the offsets the swarm core writes', () => {
    // core.ts: arenaF32[w]=dt, [w+1]=time, arenaU32[w+2]=count, [w+3]=substep
    expect(offsets(structs.get('SwarmSim'))).toEqual({
      dt: 0,
      time: 4,
      count: 8,
      substep: 12,
    });
    expect(structs.get('SwarmSim')!.size).toBe(L.SWARM_SIM_BYTES);
    // core.ts draw(): drawF32[0..5] = a b c d tx ty, [6] = alpha, drawU32[7] = flags
    expect(offsets(structs.get('SwarmDraw'))).toEqual({
      col0: 0,
      col1: 8,
      translate: 16,
      alpha: 24,
      flags: 28,
    });
    expect(structs.get('SwarmDraw')!.size).toBe(L.SWARM_DRAW_BYTES);
  });

  it('uniform structs fit in one dynamic-offset stride', () => {
    for (const bytes of [
      L.SWARM_SPAWN_BYTES,
      L.SWARM_SIM_BYTES,
      L.SWARM_DRAW_BYTES,
    ]) {
      expect(bytes).toBeLessThanOrEqual(SWARM_UNIFORM_STRIDE);
      expect(bytes % 4).toBe(0);
    }
    // stride must be a valid minUniformBufferOffsetAlignment (power of 2 ≤ 256)
    expect(SWARM_UNIFORM_STRIDE & (SWARM_UNIFORM_STRIDE - 1)).toBe(0);
  });

  it('constants inlined in WGSL agree with TypeScript', () => {
    const src = preludeWGSL as string;
    const immortal = /const SWARM_IMMORTAL: f32 = ([\d.e+-]+);/.exec(src);
    expect(Number(immortal?.[1])).toBe(L.SWARM_IMMORTAL);
    // Math.fround(3.4e38) must stay finite and compare >= with itself on GPU
    expect(Number.isFinite(Math.fround(L.SWARM_IMMORTAL))).toBe(true);
    const idx = /gid\.y \* (\d+)u/.exec(src);
    expect(Number(idx?.[1])).toBe(SWARM_MAX_WORKGROUPS * SWARM_WORKGROUP_SIZE);
    const compute = computeWGSL as string;
    const sizes = compute.match(/@workgroup_size\((\d+)\)/g) ?? [];
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const s of sizes)
      expect(s).toBe(`@workgroup_size(${SWARM_WORKGROUP_SIZE})`);
    for (const s of (cullWGSL as string).match(/@workgroup_size\((\d+)\)/g) ??
      []) {
      expect(s).toBe(`@workgroup_size(${SWARM_WORKGROUP_SIZE})`);
    }
  });

  it('cs_spawn tests the SpawnFlag bits it documents', () => {
    const src = computeWGSL as string;
    const flagUse = (bit: number, marker: string): void => {
      const at = src.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      const window = src.slice(at, at + 120);
      expect(window).toContain(`(op.flags & ${bit}u) != 0u`);
    };
    flagUse(L.SpawnFlag.DISC_POSITION, '// position');
    flagUse(L.SpawnFlag.POLAR_VELOCITY, 'if ((op.flags & 2u)');
    flagUse(L.SpawnFlag.UNIFORM_SCALE, 'if ((op.flags & 1u)');
  });
});

describe('cull.wgsl indirect args', () => {
  it('SwarmDrawArgs is the 16-byte drawIndirect record', () => {
    const structs = parseStructs(
      cullWGSL as string,
      false,
      parseStructs(preludeWGSL as string),
    );
    expect(offsets(structs.get('SwarmDrawArgs'))).toEqual({
      vertexCount: 0,
      instanceCount: 4,
      firstVertex: 8,
      firstInstance: 12,
    });
  });
});

describe('sprite.wgsl', () => {
  it('View is member-for-member identical to the swarm prelude View', () => {
    const a = parseStructs(spriteWGSL as string, true).get('View')!;
    const b = parseStructs(preludeWGSL as string, true).get('View')!;
    expect(a.members).toEqual(b.members);
    expect(a.size).toBe(L.VIEW_UNIFORM_BYTES);
  });

  it('ALPHA_ONLY matches SpriteInstanceFlag', () => {
    const m = /const ALPHA_ONLY: u32 = (\d+)u;/.exec(spriteWGSL as string);
    expect(Number(m?.[1])).toBe(L.SpriteInstanceFlag.ALPHA_ONLY);
  });

  it('vertex attributes tile the 40-byte instance exactly once', () => {
    const formatBytes: Record<string, number> = {
      float32x4: 16,
      float32x2: 8,
      unorm8x4: 4,
      unorm16x4: 8,
      uint32: 4,
    };
    const covered = new Uint8Array(L.SPRITE_INSTANCE_BYTES);
    for (const attr of SPRITE_VERTEX_LAYOUT.attributes) {
      const n = formatBytes[attr.format];
      expect(n).toBeDefined();
      for (let i = attr.offset; i < attr.offset + n; i++) covered[i]++;
    }
    expect(Array.from(covered)).toEqual(
      new Array(L.SPRITE_INSTANCE_BYTES).fill(1),
    );
    expect(SPRITE_VERTEX_LAYOUT.stride).toBe(L.SPRITE_INSTANCE_BYTES);
    expect(SPRITE_VERTEX_LAYOUT.stepMode).toBe('instance');
    // u16 uv block is contiguous
    expect([L.SI_U0, L.SI_V0, L.SI_U1, L.SI_V1]).toEqual([28, 30, 32, 34]);
    expect([L.SI_A, L.SI_B, L.SI_C, L.SI_D, L.SI_TX, L.SI_TY]).toEqual([
      0, 4, 8, 12, 16, 20,
    ]);
    expect(L.SPRITE_INSTANCE_F32_PER * 4).toBe(L.SPRITE_INSTANCE_BYTES);
  });
});

describe('packed color convention', () => {
  /** WGSL unpack4x8unorm reference. */
  const unpack4x8unorm = (u: number): number[] => [
    (u & 0xff) / 255,
    ((u >>> 8) & 0xff) / 255,
    ((u >>> 16) & 0xff) / 255,
    ((u >>> 24) & 0xff) / 255,
  ];

  it('r | g<<8 | b<<16 | a<<24 is R G B A on disk and in unpack4x8unorm', () => {
    const packed = (0x11 | (0x22 << 8) | (0x33 << 16) | (0x80 << 24)) >>> 0;
    const bytes = new Uint8Array(new Uint32Array([packed]).buffer);
    expect(Array.from(bytes)).toEqual([0x11, 0x22, 0x33, 0x80]);
    // vertex format unorm8x4 reads bytes in order → same as unpack4x8unorm
    expect(unpack4x8unorm(packed)).toEqual(Array.from(bytes).map(b => b / 255));
  });
});

describe('flag bit sets', () => {
  it('have distinct single bits', () => {
    for (const set of [L.SpawnFlag, L.SwarmRenderFlag, L.SpriteInstanceFlag]) {
      const values = Object.values(set) as number[];
      let seen = 0;
      for (const v of values) {
        expect(v & (v - 1)).toBe(0);
        expect(seen & v).toBe(0);
        seen |= v;
      }
    }
    // SpriteInstanceFlag must stay in bits 0-7 (8-31 are the pick id)
    for (const v of Object.values(L.SpriteInstanceFlag)) {
      expect(v).toBeLessThan(256);
    }
    // public render flags stay in bits 0-7 (8+ are internal)
    for (const v of Object.values(L.SwarmRenderFlag)) {
      expect(v).toBeLessThan(256);
    }
  });
});

// ─── Composer params vs real WGSL uniform layout rules ───────────────────────

describe('composed Params uniform layout (random behaviors)', () => {
  /** Deterministic PRNG (mulberry32). */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const TYPES = ['f32', 'i32', 'u32', 'vec2f', 'vec3f', 'vec4f'] as const;
  const ARITY: Record<string, number> = {
    f32: 1,
    i32: 1,
    u32: 1,
    vec2f: 2,
    vec3f: 3,
    vec4f: 4,
  };

  it('offsets reported by the composer equal WGSL offsets (200 random sets)', () => {
    const random = rng(1234);
    for (let iter = 0; iter < 200; iter++) {
      const defs = [];
      const nb = 1 + Math.floor(random() * 5);
      for (let b = 0; b < nb; b++) {
        const np = Math.floor(random() * 6); // 0 → behavior without params
        const params: Record<string, string> = {};
        const defaults: Record<string, number | number[]> = {};
        for (let k = 0; k < np; k++) {
          const type = TYPES[Math.floor(random() * TYPES.length)];
          params[`p${k}`] = type;
          defaults[`p${k}`] =
            ARITY[type] === 1 ? 0 : new Array(ARITY[type]).fill(0);
        }
        defs.push({ name: `b${b}`, params, defaults, update: '' });
      }
      const out = composeSwarmShaders(defs as never, 0);
      const structs = parseStructs(out.compute, true);
      const P = structs.get('Params')!;
      expect(P.size).toBe(out.paramsBytes);
      expect(out.paramsBytes % 16).toBe(0);
      const top = offsets(P);
      for (const entry of out.params) {
        const inner = offsets(structs.get(`P_${entry.behavior}`));
        expect(top[`b_${entry.behavior}`] + inner[entry.param]).toBe(
          entry.offset,
        );
      }
      // no two params overlap and all fit in the buffer
      const spans = out.params
        .map(e => [e.offset, e.offset + 4 * ARITY[e.type]])
        .sort((x, y) => x[0] - y[0]);
      for (let i = 0; i < spans.length; i++) {
        expect(spans[i][1]).toBeLessThanOrEqual(out.paramsBytes);
        if (i > 0) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
      }
    }
  });
});
