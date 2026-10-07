/**
 * SpawnOptions → SpawnParams (112 B, layouts.ts §4.4).
 * Runs once per spawn() call, never per object.
 */
import { toPackedColor } from '../math/color';
import type { ColorSource } from '../math/types';
import {
  SP_ANG_VEL_MAX,
  SP_ANG_VEL_MIN,
  SC_GROUP_MASK,
  SC_GROUP_SHIFT,
  SP_COLD_FLAGS,
  SP_COLOR_A,
  SP_COLOR_B,
  SP_COUNT,
  SP_FIRST,
  SP_FLAGS,
  SP_FRAME,
  SP_FRAME_COUNT,
  SP_LIFE_MAX,
  SP_LIFE_MIN,
  SP_POS_MAX,
  SP_POS_MIN,
  SP_ROT_MAX,
  SP_ROT_MIN,
  SP_SCALE_MAX,
  SP_SCALE_MIN,
  SP_SEED,
  SP_USER,
  SP_VEL_MAX,
  SP_VEL_MIN,
  SWARM_IMMORTAL,
  SWARM_SPAWN_BYTES,
  SpawnFlag,
} from '../types/layouts';
import type { Range, SpawnOptions } from './types';

export const SPAWN_WORDS = SWARM_SPAWN_BYTES / 4;
const TAU = Math.PI * 2;
const WHITE = 0xffffffff;

function lo(range: Range | undefined, fallback: number): number {
  if (range === undefined) return fallback;
  return typeof range === 'number' ? range : range[0];
}

function hi(range: Range | undefined, fallback: number): number {
  if (range === undefined) return fallback;
  return typeof range === 'number' ? range : range[1];
}

function scaleAlpha(color: number, alpha: number): number {
  const a = Math.round(
    ((color >>> 24) & 0xff) * Math.min(1, Math.max(0, alpha)),
  );
  return ((color & 0x00ffffff) | (a << 24)) >>> 0;
}

function packColor(color: ColorSource): number {
  // Numbers are 0xRRGGBB (opaque); strings may carry alpha.
  return toPackedColor(color, 1) >>> 0;
}

/**
 * Writes SpawnParams at word index `w` of `u32`/`f32` (views over the same
 * buffer). `defaultWidth/Height` is the size used when no size/scale is set.
 */
export function encodeSpawnParams(
  u32: Uint32Array,
  f32: Float32Array,
  w: number,
  first: number,
  count: number,
  seed: number,
  options: SpawnOptions | undefined,
  defaultWidth: number,
  defaultHeight: number,
): void {
  const o = options ?? {};
  let flags = 0;
  u32[w + SP_FIRST / 4] = first;
  u32[w + SP_COUNT / 4] = count;
  u32[w + SP_SEED / 4] = seed >>> 0;

  // position
  if (o.disc) {
    flags |= SpawnFlag.DISC_POSITION;
    f32[w + SP_POS_MIN / 4] = o.disc.x;
    f32[w + SP_POS_MIN / 4 + 1] = o.disc.y;
    f32[w + SP_POS_MAX / 4] = o.disc.radius;
    f32[w + SP_POS_MAX / 4 + 1] = 0;
  } else {
    f32[w + SP_POS_MIN / 4] = lo(o.x, 0);
    f32[w + SP_POS_MIN / 4 + 1] = lo(o.y, 0);
    f32[w + SP_POS_MAX / 4] = hi(o.x, 0);
    f32[w + SP_POS_MAX / 4 + 1] = hi(o.y, 0);
  }

  // velocity
  if (o.speed !== undefined || o.angle !== undefined) {
    flags |= SpawnFlag.POLAR_VELOCITY;
    f32[w + SP_VEL_MIN / 4] = lo(o.speed, 0);
    f32[w + SP_VEL_MIN / 4 + 1] = lo(o.angle, 0);
    f32[w + SP_VEL_MAX / 4] = hi(o.speed, 0);
    f32[w + SP_VEL_MAX / 4 + 1] = hi(o.angle, TAU);
  } else {
    f32[w + SP_VEL_MIN / 4] = lo(o.vx, 0);
    f32[w + SP_VEL_MIN / 4 + 1] = lo(o.vy, 0);
    f32[w + SP_VEL_MAX / 4] = hi(o.vx, 0);
    f32[w + SP_VEL_MAX / 4 + 1] = hi(o.vy, 0);
  }

  // scale
  if (o.size !== undefined) {
    flags |= SpawnFlag.UNIFORM_SCALE;
    f32[w + SP_SCALE_MIN / 4] = lo(o.size, 0);
    f32[w + SP_SCALE_MIN / 4 + 1] = lo(o.size, 0);
    f32[w + SP_SCALE_MAX / 4] = hi(o.size, 0);
    f32[w + SP_SCALE_MAX / 4 + 1] = hi(o.size, 0);
  } else {
    f32[w + SP_SCALE_MIN / 4] = lo(o.scaleX, defaultWidth);
    f32[w + SP_SCALE_MIN / 4 + 1] = lo(o.scaleY, defaultHeight);
    f32[w + SP_SCALE_MAX / 4] = hi(o.scaleX, defaultWidth);
    f32[w + SP_SCALE_MAX / 4 + 1] = hi(o.scaleY, defaultHeight);
  }

  f32[w + SP_ROT_MIN / 4] = lo(o.rotation, 0);
  f32[w + SP_ROT_MAX / 4] = hi(o.rotation, 0);
  f32[w + SP_ANG_VEL_MIN / 4] = lo(o.angularVelocity, 0);
  f32[w + SP_ANG_VEL_MAX / 4] = hi(o.angularVelocity, 0);

  if (o.life === undefined || o.life === 'immortal') {
    f32[w + SP_LIFE_MIN / 4] = SWARM_IMMORTAL;
    f32[w + SP_LIFE_MAX / 4] = SWARM_IMMORTAL;
  } else {
    f32[w + SP_LIFE_MIN / 4] = lo(o.life, 0);
    f32[w + SP_LIFE_MAX / 4] = hi(o.life, 0);
  }

  // color (+ alpha range folded into the endpoints' alpha)
  let colorA = WHITE;
  let colorB = WHITE;
  if (o.color !== undefined) {
    if (typeof o.color === 'number' || typeof o.color === 'string') {
      colorA = colorB = packColor(o.color);
    } else {
      const pair = o.color as readonly [ColorSource, ColorSource];
      colorA = packColor(pair[0]);
      colorB = packColor(pair[1]);
    }
  }
  if (o.alpha !== undefined) {
    colorA = scaleAlpha(colorA, lo(o.alpha, 1));
    colorB = scaleAlpha(colorB, hi(o.alpha, 1));
  }
  u32[w + SP_COLOR_A / 4] = colorA;
  u32[w + SP_COLOR_B / 4] = colorB;

  if (o.frame === undefined) {
    u32[w + SP_FRAME / 4] = 0;
    u32[w + SP_FRAME_COUNT / 4] = 1;
  } else if (typeof o.frame === 'number') {
    u32[w + SP_FRAME / 4] = o.frame;
    u32[w + SP_FRAME_COUNT / 4] = 1;
  } else {
    u32[w + SP_FRAME / 4] = o.frame[0];
    u32[w + SP_FRAME_COUNT / 4] = Math.max(1, o.frame[1]);
  }

  u32[w + SP_FLAGS / 4] = flags;
  u32[w + SP_USER / 4] = (o.user ?? 0) >>> 0;
  // SP_COLD_FLAGS: behavior group bits → cold.flags bits 8-15 (§14.4)
  u32[w + SP_COLD_FLAGS / 4] =
    (((o.group ?? 0) & SC_GROUP_MASK) << SC_GROUP_SHIFT) >>> 0;
}
