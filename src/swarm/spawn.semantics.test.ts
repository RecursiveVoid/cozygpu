/**
 * Tester (logic, round 1): SpawnOptions semantics end to end on the CPU.
 *
 * encodeSpawnParams() output is fed to a line-by-line JS port of cs_spawn
 * (src/shaders/swarm/compute.wgsl, prelude hash32/rand01) using f32/u32
 * arithmetic, and the resulting hot/cold records are checked against what
 * SpawnOptions promises (ranges, disc, polar velocity, uniform size, life,
 * frames, colors). The port is tied to the WGSL by checking the random
 * field indices and hash constants in the shader source.
 */
import computeWGSL from '../shaders/swarm/compute.wgsl';
import preludeWGSL from '../shaders/swarm/prelude.wgsl';
import * as L from '../types/layouts';
import { encodeSpawnParams, SPAWN_WORDS } from './spawn';
import type { SpawnOptions } from './types';

const fr = Math.fround;
const TAU = fr(6.283185307179586);

// ─── WGSL port ────────────────────────────────────────────────────────────────

function hash32(x: number): number {
  let h = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0;
  return ((h >>> 22) ^ h) >>> 0;
}

function rand01(i: number, salt: number): number {
  return fr(fr(hash32((i ^ hash32(salt)) >>> 0)) / fr(4294967295));
}

function spawnRand(slot: number, base: number, field: number): number {
  return rand01(slot, (base + Math.imul(field, 2654435769)) >>> 0);
}

/** WGSL mix(e1, e2, e3) = e1 * (1 - e3) + e2 * e3, in f32. */
function mix(a: number, b: number, t: number): number {
  return fr(fr(a * fr(1 - t)) + fr(b * t));
}

function unpack4x8unorm(u: number): number[] {
  return [u & 255, (u >>> 8) & 255, (u >>> 16) & 255, u >>> 24].map(v =>
    fr(v / 255),
  );
}

function pack4x8unorm(v: number[]): number {
  const b = v.map(c => Math.floor(0.5 + 255 * Math.min(1, Math.max(0, c))));
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

interface Hot {
  pos: [number, number];
  vel: [number, number];
  scale: [number, number];
  rot: number;
  angVel: number;
  age: number;
  life: number;
}
interface Cold {
  color: number;
  frame: number;
  flags: number;
  user: number;
}

/** cs_spawn for slot i = first + k. */
function csSpawn(u32: Uint32Array, f32: Float32Array, i: number): [Hot, Cold] {
  const W = (off: number) => off / 4;
  const flags = u32[W(L.SP_FLAGS)];
  const base = hash32(u32[W(L.SP_SEED)]);
  const posMin = [f32[W(L.SP_POS_MIN)], f32[W(L.SP_POS_MIN) + 1]];
  const posMax = [f32[W(L.SP_POS_MAX)], f32[W(L.SP_POS_MAX) + 1]];
  let pos: [number, number];
  if ((flags & 4) !== 0) {
    const r = fr(posMax[0] * fr(Math.sqrt(spawnRand(i, base, 1))));
    const a = fr(TAU * spawnRand(i, base, 2));
    pos = [
      fr(posMin[0] + fr(fr(Math.cos(a)) * r)),
      fr(posMin[1] + fr(fr(Math.sin(a)) * r)),
    ];
  } else {
    pos = [
      mix(posMin[0], posMax[0], spawnRand(i, base, 1)),
      mix(posMin[1], posMax[1], spawnRand(i, base, 2)),
    ];
  }
  const velMin = [f32[W(L.SP_VEL_MIN)], f32[W(L.SP_VEL_MIN) + 1]];
  const velMax = [f32[W(L.SP_VEL_MAX)], f32[W(L.SP_VEL_MAX) + 1]];
  const v = [
    mix(velMin[0], velMax[0], spawnRand(i, base, 3)),
    mix(velMin[1], velMax[1], spawnRand(i, base, 4)),
  ];
  const vel: [number, number] =
    (flags & 2) !== 0
      ? [fr(fr(Math.cos(v[1])) * v[0]), fr(fr(Math.sin(v[1])) * v[0])]
      : [v[0], v[1]];
  const sMin = [f32[W(L.SP_SCALE_MIN)], f32[W(L.SP_SCALE_MIN) + 1]];
  const sMax = [f32[W(L.SP_SCALE_MAX)], f32[W(L.SP_SCALE_MAX) + 1]];
  const sx = spawnRand(i, base, 5);
  let scale: [number, number];
  if ((flags & 1) !== 0) {
    const s = mix(sMin[0], sMax[0], sx);
    scale = [s, s];
  } else {
    scale = [
      mix(sMin[0], sMax[0], sx),
      mix(sMin[1], sMax[1], spawnRand(i, base, 6)),
    ];
  }
  const rot = mix(
    f32[W(L.SP_ROT_MIN)],
    f32[W(L.SP_ROT_MAX)],
    spawnRand(i, base, 7),
  );
  const angVel = mix(
    f32[W(L.SP_ANG_VEL_MIN)],
    f32[W(L.SP_ANG_VEL_MAX)],
    spawnRand(i, base, 8),
  );
  const lifeMin = f32[W(L.SP_LIFE_MIN)];
  const lifeMax = f32[W(L.SP_LIFE_MAX)];
  const life =
    lifeMax <= lifeMin ? lifeMin : mix(lifeMin, lifeMax, spawnRand(i, base, 9));

  const ca = unpack4x8unorm(u32[W(L.SP_COLOR_A)]);
  const cb = unpack4x8unorm(u32[W(L.SP_COLOR_B)]);
  const t = spawnRand(i, base, 10);
  const rgb = [0, 1, 2].map(k => mix(ca[k], cb[k], t));
  const alpha = mix(ca[3], cb[3], spawnRand(i, base, 11));
  const frameBase = u32[W(L.SP_FRAME)];
  const frameCount = u32[W(L.SP_FRAME_COUNT)];
  let frame = frameBase;
  if (frameCount > 1) {
    frame =
      (frameBase + (hash32((i ^ ((base + 12) >>> 0)) >>> 0) % frameCount)) >>>
      0;
  }
  return [
    { pos, vel, scale, rot, angVel, age: 0, life },
    {
      color: pack4x8unorm([...rgb, alpha]),
      frame,
      flags: 0,
      user: u32[W(L.SP_USER)],
    },
  ];
}

function spawnAll(
  options: SpawnOptions,
  first = 100,
  count = 400,
  seed = 12345,
): Array<[Hot, Cold]> {
  const buf = new ArrayBuffer(SPAWN_WORDS * 4);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  encodeSpawnParams(u32, f32, 0, first, count, seed, options, 16, 24);
  const out: Array<[Hot, Cold]> = [];
  for (let k = 0; k < u32[L.SP_COUNT / 4]; k++) {
    out.push(csSpawn(u32, f32, u32[L.SP_FIRST / 4] + k));
  }
  return out;
}

const EPS = 1e-3;
const within = (v: number, lo: number, hi: number) =>
  v >= Math.min(lo, hi) - EPS && v <= Math.max(lo, hi) + EPS;

// ─── port ↔ WGSL agreement ───────────────────────────────────────────────────

describe('JS port matches the WGSL source', () => {
  it('prelude hash32 / rand01 constants', () => {
    expect(preludeWGSL).toContain('x * 747796405u + 2891336453u');
    expect(preludeWGSL).toContain(
      '((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u',
    );
    expect(preludeWGSL).toContain('(h >> 22u) ^ h');
    expect(preludeWGSL).toContain(
      'f32(hash32(i ^ hash32(salt))) / 4294967295.0',
    );
    expect(computeWGSL).toContain('rand01(slot, base + field * 2654435769u)');
    expect(computeWGSL).toContain('let base = hash32(op.seed);');
  });

  it('every random draw in cs_spawn uses its own field (no correlated values)', () => {
    const body = computeWGSL.slice(
      computeWGSL.indexOf('fn cs_spawn'),
      computeWGSL.indexOf('fn cs_kill'),
    );
    const fields = [
      ...body.matchAll(/swarm_spawn_rand\(i, base, (\d+)u\)/g),
    ].map(m => Number(m[1]));
    // position draws 1 and 2 appear once per (exclusive) branch
    const afterPosition = fields.slice(4);
    expect(fields.slice(0, 4)).toEqual([1, 2, 1, 2]);
    expect(new Set(afterPosition).size).toBe(afterPosition.length);
    expect(afterPosition).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // the frame pick uses a distinct salt path
    expect(body).toContain('hash32(i ^ (base + 12u)) % op.frameCount');
    // flag bits tested by the shader are the SpawnFlag values
    expect(body).toContain(`(op.flags & ${L.SpawnFlag.DISC_POSITION}u)`);
    expect(body).toContain(`(op.flags & ${L.SpawnFlag.POLAR_VELOCITY}u)`);
    expect(body).toContain(`(op.flags & ${L.SpawnFlag.UNIFORM_SCALE}u)`);
  });

  it('rand01 stays within [0, 1] including the u32 extremes', () => {
    for (const salt of [0, 1, 0xffffffff, 0x80000000]) {
      for (let i = 0; i < 2000; i++) {
        const v = rand01(i, salt);
        if (!(v >= 0 && v <= 1))
          throw new Error(`rand01(${i}, ${salt}) = ${v}`);
      }
    }
    expect(fr(fr(0xffffffff) / fr(4294967295))).toBe(1);
  });
});

// ─── SpawnOptions semantics ──────────────────────────────────────────────────

describe('SpawnOptions → cs_spawn results', () => {
  it('rectangular ranges and defaults', () => {
    const recs = spawnAll({
      x: [10, 20],
      y: [-5, 5],
      vx: [1, 2],
      vy: 3,
      rotation: [0, 1],
      angularVelocity: [-2, -1],
      user: 42,
    });
    let xs = 0;
    for (const [h, c] of recs) {
      expect(within(h.pos[0], 10, 20) && within(h.pos[1], -5, 5)).toBe(true);
      // scalar ranges go through mix(v, v, t) on the GPU: exact only to f32 rounding
      expect(within(h.vel[0], 1, 2) && within(h.vel[1], 3, 3)).toBe(true);
      // default size = texture frame size
      expect(within(h.scale[0], 16, 16) && within(h.scale[1], 24, 24)).toBe(
        true,
      );
      expect(within(h.rot, 0, 1) && within(h.angVel, -2, -1)).toBe(true);
      expect(h.life).toBe(fr(L.SWARM_IMMORTAL));
      expect(c).toEqual({ color: 0xffffffff, frame: 0, flags: 0, user: 42 });
      xs += h.pos[0];
    }
    // actually random: mean near the middle, not a constant
    expect(xs / recs.length).toBeGreaterThan(14);
    expect(xs / recs.length).toBeLessThan(16);
  });

  it('disc: every position is within radius of the center', () => {
    const recs = spawnAll({ disc: { x: 50, y: -30, radius: 12 }, x: 1e6 });
    let maxR = 0;
    for (const [h] of recs) {
      const r = Math.hypot(h.pos[0] - 50, h.pos[1] + 30);
      maxR = Math.max(maxR, r);
    }
    expect(maxR).toBeLessThanOrEqual(12 + EPS);
    expect(maxR).toBeGreaterThan(10); // fills the disc
  });

  it('polar velocity: |v| in the speed range, direction in the angle range', () => {
    const recs = spawnAll({ speed: [100, 200], angle: [0, Math.PI / 2] });
    for (const [h] of recs) {
      const speed = Math.hypot(h.vel[0], h.vel[1]);
      expect(within(speed, 100, 200)).toBe(true);
      expect(h.vel[0]).toBeGreaterThanOrEqual(-EPS);
      expect(h.vel[1]).toBeGreaterThanOrEqual(-EPS);
    }
    // angle only: speed defaults to 0 → zero velocity
    for (const [h] of spawnAll({ angle: 1 }, 0, 20)) {
      expect(Math.hypot(h.vel[0], h.vel[1])).toBe(0);
    }
  });

  it('size: square objects in range; scaleX/scaleY are ignored', () => {
    for (const [h] of spawnAll({ size: [4, 8], scaleX: 100, scaleY: 200 })) {
      expect(h.scale[0]).toBe(h.scale[1]);
      expect(within(h.scale[0], 4, 8)).toBe(true);
    }
  });

  it('life: range, scalar, reversed range, and alive right after spawn', () => {
    for (const [h] of spawnAll({ life: [1, 3] })) {
      expect(within(h.life, 1, 3)).toBe(true);
      expect(h.age < h.life).toBe(true);
    }
    for (const [h] of spawnAll({ life: 2 }, 0, 10)) expect(h.life).toBe(2);
    // reversed: shader uses lifeMin when max <= min
    for (const [h] of spawnAll({ life: [3, 1] }, 0, 10)) expect(h.life).toBe(3);
  });

  it('frames: [first, count] picks in [first, first + count) and uses them all', () => {
    const seen = new Set<number>();
    for (const [, c] of spawnAll({ frame: [5, 4] })) {
      expect(c.frame >= 5 && c.frame < 9).toBe(true);
      seen.add(c.frame);
    }
    expect([...seen].sort()).toEqual([5, 6, 7, 8]);
    for (const [, c] of spawnAll({ frame: 7 }, 0, 20)) expect(c.frame).toBe(7);
    for (const [, c] of spawnAll({ frame: [3, 0] }, 0, 20))
      expect(c.frame).toBe(3);
  });

  it('colors: channels between the endpoints, alpha range multiplies', () => {
    const recs = spawnAll({
      color: ['#ff0000', '#0000ff'],
      alpha: [0.5, 1],
    });
    for (const [, c] of recs) {
      const r = c.color & 255;
      const g = (c.color >>> 8) & 255;
      const b = (c.color >>> 16) & 255;
      const a = c.color >>> 24;
      expect(g).toBe(0);
      // one gradient parameter for rgb: r + b stays 255 (±1 rounding)
      expect(Math.abs(r + b - 255)).toBeLessThanOrEqual(1);
      expect(a >= 127 && a <= 255).toBe(true);
    }
    // single color with alpha in the string and a scalar alpha
    for (const [, c] of spawnAll({ color: '#11223380', alpha: 0.5 }, 0, 5)) {
      expect(c.color).toBe(0x40332211);
    }
    // numbers are opaque 0xRRGGBB
    for (const [, c] of spawnAll({ color: 0x336699 }, 0, 5)) {
      expect(c.color).toBe(0xff996633);
    }
  });

  it('deterministic per (seed, slot); different seeds and slots differ', () => {
    const a = spawnAll({ x: [0, 1000] }, 0, 50, 7);
    const b = spawnAll({ x: [0, 1000] }, 0, 50, 7);
    const c = spawnAll({ x: [0, 1000] }, 0, 50, 8);
    expect(a).toEqual(b);
    let same = 0;
    for (let k = 0; k < 50; k++) if (a[k][0].pos[0] === c[k][0].pos[0]) same++;
    expect(same).toBeLessThan(3);
    // ring wrap halves share a seed but cover different slots → distinct
    const tail = spawnAll({ x: [0, 1000] }, 90, 10, 7);
    const head = spawnAll({ x: [0, 1000] }, 0, 10, 7);
    let equal = 0;
    for (let k = 0; k < 10; k++)
      if (tail[k][0].pos[0] === head[k][0].pos[0]) equal++;
    expect(equal).toBe(0);
  });

  it('x and y draws are not correlated (no diagonal line)', () => {
    const recs = spawnAll({ x: [0, 1], y: [0, 1] }, 0, 4000);
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const [h] of recs) {
      sx += h.pos[0];
      sy += h.pos[1];
      sxy += h.pos[0] * h.pos[1];
      sxx += h.pos[0] * h.pos[0];
      syy += h.pos[1] * h.pos[1];
    }
    const n = recs.length;
    const cov = sxy / n - (sx / n) * (sy / n);
    const corr =
      cov / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
    expect(Math.abs(corr)).toBeLessThan(0.1);
  });
});
