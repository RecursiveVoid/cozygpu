/**
 * Tester: SpawnOptions → SpawnParams packing (layouts.ts §4.4), read back
 * with a DataView at the normative byte offsets (not via the SP_ / 4 math
 * the encoder uses).
 */
import * as L from '../types/layouts';
import { encodeSpawnParams, SPAWN_WORDS } from './spawn';
import type { SpawnOptions } from './types';

const TAU = Math.PI * 2;

function pack(
  options: SpawnOptions | undefined,
  first = 3,
  count = 5,
  seed = 77,
  defaultW = 16,
  defaultH = 24,
): DataView {
  // 1 sentinel word before and after the record, to catch stray writes
  const buf = new ArrayBuffer((SPAWN_WORDS + 2) * 4);
  const u32 = new Uint32Array(buf);
  u32.fill(0xdeadbeef);
  encodeSpawnParams(
    u32,
    new Float32Array(buf),
    1,
    first,
    count,
    seed,
    options,
    defaultW,
    defaultH,
  );
  expect(u32[0]).toBe(0xdeadbeef);
  expect(u32[SPAWN_WORDS + 1]).toBe(0xdeadbeef);
  return new DataView(buf, 4, L.SWARM_SPAWN_BYTES);
}

const f = (v: DataView, off: number): number => v.getFloat32(off, true);
const u = (v: DataView, off: number): number => v.getUint32(off, true);
const vec = (v: DataView, off: number): number[] => [f(v, off), f(v, off + 4)];

describe('encodeSpawnParams', () => {
  it('SPAWN_WORDS covers exactly the 112-byte record', () => {
    expect(SPAWN_WORDS * 4).toBe(L.SWARM_SPAWN_BYTES);
  });

  it('defaults: origin, no velocity, frame size, immortal, white, frame 0', () => {
    const v = pack(undefined, 10, 20, 0xfffffffe);
    expect(u(v, L.SP_FIRST)).toBe(10);
    expect(u(v, L.SP_COUNT)).toBe(20);
    expect(u(v, L.SP_SEED)).toBe(0xfffffffe);
    expect(vec(v, L.SP_POS_MIN)).toEqual([0, 0]);
    expect(vec(v, L.SP_POS_MAX)).toEqual([0, 0]);
    expect(vec(v, L.SP_VEL_MIN)).toEqual([0, 0]);
    expect(vec(v, L.SP_VEL_MAX)).toEqual([0, 0]);
    expect(vec(v, L.SP_SCALE_MIN)).toEqual([16, 24]);
    expect(vec(v, L.SP_SCALE_MAX)).toEqual([16, 24]);
    expect(f(v, L.SP_ROT_MIN)).toBe(0);
    expect(f(v, L.SP_ANG_VEL_MAX)).toBe(0);
    expect(f(v, L.SP_LIFE_MIN)).toBe(Math.fround(L.SWARM_IMMORTAL));
    expect(f(v, L.SP_LIFE_MAX)).toBe(Math.fround(L.SWARM_IMMORTAL));
    expect(u(v, L.SP_COLOR_A)).toBe(0xffffffff);
    expect(u(v, L.SP_COLOR_B)).toBe(0xffffffff);
    expect(u(v, L.SP_FRAME)).toBe(0);
    expect(u(v, L.SP_FRAME_COUNT)).toBe(1);
    expect(u(v, L.SP_FLAGS)).toBe(0);
    expect(u(v, L.SP_USER)).toBe(0);
    expect(u(v, L.SP_PAD)).toBe(0);
  });

  it('ranges: scalar → [v, v], tuple → [min, max]', () => {
    const v = pack({
      x: [1, 2],
      y: 3,
      vx: [-4, 4],
      vy: 5,
      scaleX: [6, 7],
      scaleY: 8,
      rotation: [0.5, 1.5],
      angularVelocity: -2,
      life: [1, 3],
      user: 0xabcdef12,
    });
    expect(vec(v, L.SP_POS_MIN)).toEqual([1, 3]);
    expect(vec(v, L.SP_POS_MAX)).toEqual([2, 3]);
    expect(vec(v, L.SP_VEL_MIN)).toEqual([-4, 5]);
    expect(vec(v, L.SP_VEL_MAX)).toEqual([4, 5]);
    expect(vec(v, L.SP_SCALE_MIN)).toEqual([6, 8]);
    expect(vec(v, L.SP_SCALE_MAX)).toEqual([7, 8]);
    expect([f(v, L.SP_ROT_MIN), f(v, L.SP_ROT_MAX)]).toEqual([0.5, 1.5]);
    expect([f(v, L.SP_ANG_VEL_MIN), f(v, L.SP_ANG_VEL_MAX)]).toEqual([-2, -2]);
    expect([f(v, L.SP_LIFE_MIN), f(v, L.SP_LIFE_MAX)]).toEqual([1, 3]);
    expect(u(v, L.SP_USER)).toBe(0xabcdef12);
    expect(u(v, L.SP_FLAGS)).toBe(0);
  });

  it('disc position sets DISC_POSITION: posMin = center, posMax.x = radius', () => {
    const v = pack({ disc: { x: 100, y: 200, radius: 50 }, x: 999 });
    expect(u(v, L.SP_FLAGS)).toBe(L.SpawnFlag.DISC_POSITION);
    expect(vec(v, L.SP_POS_MIN)).toEqual([100, 200]);
    expect(vec(v, L.SP_POS_MAX)).toEqual([50, 0]);
  });

  it('polar velocity: x = speed, y = angle, angle defaults to [0, TAU]', () => {
    const v = pack({ speed: [10, 20], vx: 99 });
    expect(u(v, L.SP_FLAGS)).toBe(L.SpawnFlag.POLAR_VELOCITY);
    expect(vec(v, L.SP_VEL_MIN)).toEqual([10, 0]);
    expect(vec(v, L.SP_VEL_MAX)).toEqual([20, Math.fround(TAU)]);
    const a = pack({ angle: 1 });
    expect(u(a, L.SP_FLAGS)).toBe(L.SpawnFlag.POLAR_VELOCITY);
    expect(vec(a, L.SP_VEL_MIN)).toEqual([0, 1]);
    expect(vec(a, L.SP_VEL_MAX)).toEqual([0, 1]);
  });

  it('size sets UNIFORM_SCALE and overrides scaleX/scaleY', () => {
    const v = pack({ size: [2, 9], scaleX: 100 });
    expect(u(v, L.SP_FLAGS)).toBe(L.SpawnFlag.UNIFORM_SCALE);
    expect(vec(v, L.SP_SCALE_MIN)).toEqual([2, 2]);
    expect(vec(v, L.SP_SCALE_MAX)).toEqual([9, 9]);
  });

  it('flags combine', () => {
    const v = pack({ size: 1, speed: 1, disc: { x: 0, y: 0, radius: 1 } });
    expect(u(v, L.SP_FLAGS)).toBe(
      L.SpawnFlag.UNIFORM_SCALE |
        L.SpawnFlag.POLAR_VELOCITY |
        L.SpawnFlag.DISC_POSITION,
    );
  });

  it('colors pack as r | g<<8 | b<<16 | a<<24, pairs and alpha ranges', () => {
    const one = pack({ color: 0x112233 });
    expect(u(one, L.SP_COLOR_A)).toBe(0xff332211);
    expect(u(one, L.SP_COLOR_B)).toBe(0xff332211);
    const pair = pack({ color: ['#ff000080', 0x0000ff], alpha: [0.5, 1] });
    // A: red, a = 0x80 * 0.5 = 64; B: blue, a = 255 * 1
    expect(u(pair, L.SP_COLOR_A)).toBe(0x400000ff);
    expect(u(pair, L.SP_COLOR_B)).toBe(0xffff0000);
    const clamped = pack({ alpha: [-1, 2] });
    expect(u(clamped, L.SP_COLOR_A) >>> 24).toBe(0);
    expect(u(clamped, L.SP_COLOR_B) >>> 24).toBe(255);
    // bytes on disk are R G B A
    expect(one.getUint8(L.SP_COLOR_A)).toBe(0x11);
    expect(one.getUint8(L.SP_COLOR_A + 3)).toBe(0xff);
  });

  it('frames: index or [first, count] with count >= 1', () => {
    expect(u(pack({ frame: 7 }), L.SP_FRAME)).toBe(7);
    expect(u(pack({ frame: 7 }), L.SP_FRAME_COUNT)).toBe(1);
    const r = pack({ frame: [2, 4] });
    expect([u(r, L.SP_FRAME), u(r, L.SP_FRAME_COUNT)]).toEqual([2, 4]);
    expect(u(pack({ frame: [2, 0] }), L.SP_FRAME_COUNT)).toBe(1);
  });

  it("life 'immortal' and negative seeds", () => {
    const v = pack({ life: 'immortal' }, 0, 1, -1);
    expect(f(v, L.SP_LIFE_MIN)).toBe(Math.fround(L.SWARM_IMMORTAL));
    expect(u(v, L.SP_SEED)).toBe(0xffffffff);
  });

  it('re-encoding into the same slot overwrites every field (no stale flags)', () => {
    const buf = new ArrayBuffer(L.SWARM_SPAWN_BYTES);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    encodeSpawnParams(
      u32,
      f32,
      0,
      1,
      2,
      3,
      {
        disc: { x: 1, y: 2, radius: 3 },
        speed: 5,
        size: 4,
        color: 0x123456,
        alpha: 0.5,
        frame: [1, 3],
        user: 9,
        life: 2,
      },
      8,
      8,
    );
    const fresh = new ArrayBuffer(L.SWARM_SPAWN_BYTES);
    encodeSpawnParams(u32, f32, 0, 1, 2, 3, undefined, 8, 8);
    encodeSpawnParams(
      new Uint32Array(fresh),
      new Float32Array(fresh),
      0,
      1,
      2,
      3,
      undefined,
      8,
      8,
    );
    expect(new Uint8Array(buf)).toEqual(new Uint8Array(fresh));
  });
});
