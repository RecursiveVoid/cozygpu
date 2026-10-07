// "1 million sprites": a SpriteLayer draws every sprite in one draw call,
// from compact GPU streams instead of one object per sprite.
//
//   static   positions, rotation, frame and colour are written once; a frame
//            then sends ~100 bytes and does no per-sprite work at all.
//   columns  the "ECS" is plain typed arrays moved by a CPU loop; the layer
//            uploads the interleaved `xy` column straight from that memory
//            (no per-sprite objects, no packing).
//
// The slider stops at what the device can hold (one GPU buffer per stream).
// Full example: examples/spritelayer/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

const CELL = 8;
const SHAPES = 4;
/** Hard ceiling of the slider, whatever the device reports. */
const MAX_SPRITES = 16_000_000;

/** Four white 8 px shapes in one atlas page. */
function atlasPixels(): Uint8Array {
  const w = CELL * SHAPES;
  const px = new Uint8Array(w * CELL * 4);
  for (let f = 0; f < SHAPES; f++) {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const cx = Math.abs(x + 0.5 - CELL / 2);
        const cy = Math.abs(y + 0.5 - CELL / 2);
        const inside =
          f === 0
            ? cx * cx + cy * cy < 14
            : f === 1
              ? cx < 3 && cy < 3
              : f === 2
                ? cx + cy < 4
                : y > 0 && cx < y * 0.5;
        if (inside)
          px.fill(
            255,
            4 * (y * w + f * CELL + x),
            4 * (y * w + f * CELL + x) + 4,
          );
      }
    }
  }
  return px;
}

/** A soft glow from a second texture: frames of two sources, still one draw. */
function glowPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const a = Math.max(0, 1 - d / (size / 2)) ** 1.5;
      px.fill(Math.round(a * 255), 4 * (y * size + x), 4 * (y * size + x) + 4);
    }
  }
  return px;
}

/** f16 bits of a positive normal number (enough for sprite scales). */
function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const b = new Uint32Array(f.buffer)[0];
  const e = ((b >>> 23) & 0xff) - 127 + 15;
  return (e << 10) | ((b >>> 13) & 0x3ff);
}

/** Packed RGBA8 of a hue (0..1) at full saturation. */
function hueColor(h: number, alpha: number): number {
  const c = (o: number): number => {
    const k = (o + h * 6) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(1, k, 4 - k))));
  };
  return c(5) | (c(3) << 8) | (c(1) << 16) | (alpha << 24);
}

/** Sprites one GPU stream of 8-byte records can hold on this device. */
function deviceLimit(renderer: GPU.Renderer): number {
  const caps = renderer.info.capabilities;
  const bytes =
    caps.backend === 'webgpu'
      ? Math.min(caps.maxStorageBufferBindingSize, caps.maxBufferSize)
      : caps.maxBufferSize;
  // CPU memory: ~36 bytes per sprite with the columns (navigator.deviceMemory
  // is Chromium-only and capped at 8).
  const gb = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const memory = gb >= 8 ? MAX_SPRITES : gb >= 4 ? 4_000_000 : 2_000_000;
  return Math.min(Math.floor(bytes / 8), memory);
}

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const { canvas } = ctx;
  const renderer = await GPU.createRenderer({
    canvas,
    limits: 'max',
    background: 0x0b0b12,
    powerPreference: 'high-performance',
    backend: ctx.backend,
    worker: workerOption(ctx),
  });
  const maxCount = deviceLimit(renderer);
  const atlas = GPU.Texture.fromPixels(CELL * SHAPES, CELL, atlasPixels(), {
    nearest: true,
  });
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < SHAPES; f++)
    frames.push(atlas.sub(f * CELL, 0, CELL, CELL));
  frames.push(GPU.Texture.fromPixels(12, 12, glowPixels(12)));

  let w = canvas.clientWidth || renderer.width;
  let h = canvas.clientHeight || renderer.height;
  const layer = new GPU.SpriteLayer({ capacity: 1, frames });
  renderer.stage.addChild(layer);
  const { POSITION, XFORM, COLOR } = GPU.layerLayouts.LayerStreamBit;

  // Fast seeded PRNG: filling 16M rows with Math.random takes seconds.
  let seed = 0x2545f491;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  let count = 0;
  let mode = ctx.mode === 'columns' ? 'columns' : 'static';
  // Columns mode only: positions shared with the layer, and velocities.
  let xy: Float32Array<ArrayBufferLike> | null = null;
  let vel: Float32Array | null = null;
  let binding: GPU.LayerColumnBinding | null = null;

  /**
   * Rows [from, to) of the own stores: position, scale/rotation/frame and a
   * colour picked from the position (hue by angle around the centre), so a
   * million sprites form a colour wheel that the columns mode stirs up.
   * Sprites shrink as the count grows, to keep the stage readable.
   */
  const fill = (from: number, to: number): void => {
    const d = layer.data;
    const xf = new Uint32Array(d.xform.buffer, d.xform.byteOffset);
    const size = Math.min(1.25, Math.max(0.3, Math.sqrt((w * h) / to) / 5));
    const scale = toHalf(size) * 0x10001;
    for (let i = from; i < to; i++) {
      const x = random() * w;
      const y = random() * h;
      d.position[2 * i] = x;
      d.position[2 * i + 1] = y;
      // Same f16 scale twice; rotation; frame (4 shapes + glow).
      xf[2 * i] = scale;
      xf[2 * i + 1] = (random() * 65536) | 0 | ((i % 5) << 16);
      const hue = Math.atan2(y - h / 2, x - w / 2) / (2 * Math.PI) + 0.5;
      d.color[i] = hueColor(hue, 230);
    }
    if (to > from) layer.markDirty(from, to - from, POSITION | XFORM | COLOR);
  };

  /** Columns: copy the current positions into a fresh `xy` and bind it. */
  const bindColumns = (): void => {
    const shared =
      typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
    const next = new Float32Array(
      shared ? new SharedArrayBuffer(8 * count) : new ArrayBuffer(8 * count),
    );
    const nextVel = new Float32Array(2 * count);
    const keep = xy ? Math.min(xy.length, 2 * count) : 0;
    if (xy) next.set(xy.subarray(0, keep));
    next.set(layer.data.position.subarray(keep, 2 * count), keep);
    if (vel) nextVel.set(vel.subarray(0, Math.min(vel.length, keep)));
    for (let p = keep; p < 2 * count; p += 2) {
      const a = random() * Math.PI * 2;
      const s = 15 + random() * 60;
      nextVel[p] = Math.cos(a) * s;
      nextVel[p + 1] = Math.sin(a) * s;
    }
    xy = next;
    vel = nextVel;
    if (binding) binding.rebind({ xy });
    else binding = layer.bindColumns({ xy });
    binding.commit(count);
  };

  /** Static: the own position store takes over again, written once. */
  const unbindColumns = (): void => {
    if (!binding || !xy) return;
    binding.unbind();
    binding = null;
    layer.data.position.set(xy.subarray(0, 2 * count));
    layer.markDirty(0, count, POSITION);
    xy = null;
    vel = null;
  };

  const setCount = (value: number): void => {
    const n = Math.max(1, Math.min(maxCount, value | 0));
    if (n > layer.capacity) layer.capacity = n;
    if (n > count) fill(count, n);
    count = n;
    layer.count = n;
    if (mode === 'columns') bindColumns();
  };
  setCount(ctx.count);

  const setMode = (next: string): void => {
    const m = next === 'columns' ? 'columns' : 'static';
    if (m === mode) return;
    mode = m;
    if (m === 'columns') bindColumns();
    else unbindColumns();
  };

  const ticker = GPU.ticker(renderer);
  ticker.add(dt => {
    ctx.tick();
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw > 0 && ch > 0) {
      w = cw;
      h = ch;
    }
    if (mode !== 'columns' || !xy || !vel || !binding) return;
    // The "ECS system": move every sprite, then one commit.
    const p2 = xy;
    const v2 = vel;
    const step = Math.min(dt, 0.05);
    for (let p = 0; p < 2 * count; p += 2) {
      let x = p2[p] + v2[p] * step;
      let y = p2[p + 1] + v2[p + 1] * step;
      if (x < 0 || x > w) {
        v2[p] = -v2[p];
        x = x < 0 ? 0 : w;
      }
      if (y < 0 || y > h) {
        v2[p + 1] = -v2[p + 1];
        y = y < 0 ? 0 : h;
      }
      p2[p] = x;
      p2[p + 1] = y;
    }
    binding.commit(count);
  });

  return {
    renderer,
    ticker,
    maxCount,
    objects: () => count,
    setCount,
    setMode,
    destroy() {
      teardown(ticker, renderer);
    },
  };
}
