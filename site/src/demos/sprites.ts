// Bunnymark: N ordinary Sprites bouncing under gravity, one atlas, one draw
// call. Positions go through the bulk writer (one typed array for every
// child). Full example: examples/sprites/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

const FRAME = 16;
const COLORS = [0xffb3c7, 0xa8e6ff, 0xfff0a8, 0xb9ffb0];
const GRAVITY = 900;

/** 4 x 16x16 bunny-ish frames in one atlas (one texture, one draw call). */
function atlasPixels(): Uint8Array {
  const w = FRAME * COLORS.length;
  const px = new Uint8Array(w * FRAME * 4);
  for (let f = 0; f < COLORS.length; f++) {
    const c = COLORS[f];
    for (let y = 0; y < FRAME; y++) {
      for (let x = 0; x < FRAME; x++) {
        const cx = x + 0.5 - 8;
        const body = Math.hypot(cx, y + 0.5 - 11) < 5;
        const ears = Math.abs(Math.abs(cx) - 2.5) < 1.2 && y > 1 && y < 8;
        const eye =
          Math.abs(Math.abs(cx) - 2) < 0.8 && Math.abs(y + 0.5 - 10) < 0.8;
        if (!(body || ears)) continue;
        const i = (y * w + f * FRAME + x) * 4;
        px[i] = eye ? 20 : (c >> 16) & 255;
        px[i + 1] = eye ? 20 : (c >> 8) & 255;
        px[i + 2] = eye ? 30 : c & 255;
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const renderer = await GPU.createRenderer({
    canvas: ctx.canvas,
    background: 0x0b0b12,
    backend: ctx.backend,
    worker: workerOption(ctx),
  });
  const atlas = GPU.Texture.fromPixels(
    FRAME * COLORS.length,
    FRAME,
    atlasPixels(),
    { nearest: true },
  );
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < COLORS.length; f++) {
    frames.push(atlas.sub(f * FRAME, 0, FRAME, FRAME));
  }

  const world = new GPU.Container();
  renderer.stage.addChild(world);

  let count = 0;
  let vx = new Float32Array(0);
  let vy = new Float32Array(0);
  let bulk: GPU.BulkChildren | null = null;

  const resize = (n: number): void => {
    if (n < count) {
      const removed = world.removeChildren(n, count);
      for (let i = 0; i < removed.length; i++) removed[i].destroy();
      count = n;
      return;
    }
    if (n > vx.length) {
      const grow = (
        a: Float32Array<ArrayBuffer>,
      ): Float32Array<ArrayBuffer> => {
        const b = new Float32Array(n);
        b.set(a);
        return b;
      };
      vx = grow(vx);
      vy = grow(vy);
    }
    const w = renderer.width;
    const h = renderer.height;
    for (let i = count; i < n; i++) {
      world.addChild(
        new GPU.Sprite({
          texture: frames[i % frames.length],
          anchor: 0.5,
          x: Math.random() * w,
          y: Math.random() * h * 0.5,
          scale: 1 + Math.random(),
        }),
      );
      vx[i] = (Math.random() - 0.5) * 400;
      vy[i] = (Math.random() - 0.5) * 400;
    }
    count = n;
  };
  resize(ctx.count);

  const ticker = GPU.ticker(renderer);
  ticker.add(dt => {
    ctx.tick();
    const w = renderer.width;
    const h = renderer.height;
    if (bulk === null || bulk.version !== world.childrenVersion) {
      bulk = world.bulkChildren(GPU.BulkField.POSITION);
      bulk.pull(GPU.BulkField.POSITION);
    }
    const pos = bulk.position;
    for (let i = 0; i < count; i++) {
      let x = pos[i * 2] + vx[i] * dt;
      let y = pos[i * 2 + 1] + vy[i] * dt;
      let vyi = vy[i] + GRAVITY * dt;
      if (x < 0) {
        x = 0;
        vx[i] = -vx[i];
      } else if (x > w) {
        x = w;
        vx[i] = -vx[i];
      }
      if (y > h) {
        y = h;
        vyi = -vyi * 0.85;
        if (Math.random() > 0.5) vyi -= Math.random() * 600;
      } else if (y < 0) {
        y = 0;
        vyi = 0;
      }
      vy[i] = vyi;
      pos[i * 2] = x;
      pos[i * 2 + 1] = y;
    }
    bulk.commit(GPU.BulkField.POSITION);
  });

  return {
    renderer,
    ticker,
    objects: () => count,
    setCount: resize,
    destroy: () => teardown(ticker, renderer),
  };
}
