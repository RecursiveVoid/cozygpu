// Masking: three Groups, one per implementation. Left: a rect mask (scissor,
// no extra draw). Middle: a turning disc (stencil where the backend clips
// with it, alpha otherwise). Right: a feathered disc (alpha mask).
// Full example: examples/masking/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

const PANELS = 3;
const TILES = 24;

function checkerPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = ((x >> 3) + (y >> 3)) & 1;
      px[i] = on ? 245 : 120;
      px[i + 1] = on ? 245 : 120;
      px[i + 2] = on ? 245 : 140;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** A white disc; `feather` > 0 gives it a soft edge. */
function discPixels(size: number, feather: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = size / 2;
  const edge = feather > 0 ? feather : 1.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const v = Math.round(255 * Math.max(0, Math.min(1, (r - d) / edge)));
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = v;
    }
  }
  return px;
}

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const renderer = await GPU.createRenderer({
    canvas: ctx.canvas,
    background: 0x101018,
    backend: ctx.backend,
    worker: workerOption(ctx),
  });
  const checker = GPU.Texture.fromPixels(64, 64, checkerPixels(64));
  const disc = GPU.Texture.fromPixels(64, 64, discPixels(64, 0), {
    premultiplied: true,
  });
  const soft = GPU.Texture.fromPixels(64, 64, discPixels(64, 24), {
    premultiplied: true,
  });

  const groups: GPU.Group[] = [];
  const tiles: GPU.Sprite[] = [];
  const shapes: GPU.Sprite[] = [];
  for (let i = 0; i < PANELS; i++) {
    const group = new GPU.Group();
    renderer.stage.addChild(group);
    groups.push(group);
    for (let k = 0; k < TILES; k++) {
      const tile = new GPU.Sprite({
        texture: checker,
        anchor: 0.5,
        tint: k % 2 ? 0x66ccff : 0xff88bb,
      });
      group.addChild(tile);
      tiles.push(tile);
    }
    // The mask shapes draw themselves too, dimmed, so the clip is visible.
    const shape = new GPU.Sprite({
      texture: i === 2 ? soft : disc,
      anchor: 0.5,
    });
    shape.alpha = 0.15;
    renderer.stage.addChild(shape);
    shapes.push(shape);
  }
  await GPU.loadEffects('mask');

  const layout = (): void => {
    const w = renderer.width;
    const h = renderer.height;
    const panel = w / PANELS;
    const size = Math.min(panel, h) * 0.7;
    for (let i = 0; i < PANELS; i++) {
      const cx = panel * (i + 0.5);
      const cy = h / 2;
      const shape = shapes[i];
      shape.setPosition(cx, cy);
      shape.width = size;
      shape.height = size;
      if (i === 0) {
        groups[i].mask = {
          source: {
            x: cx - size / 2,
            y: cy - size / 2,
            width: size,
            height: size,
          },
          mode: 'auto',
        };
      } else {
        groups[i].mask = { source: shape, mode: i === 2 ? 'alpha' : 'auto' };
      }
    }
  };
  layout();

  const ticker = GPU.ticker(renderer);
  ticker.add((_dt, time) => {
    ctx.tick();
    const w = renderer.width;
    const h = renderer.height;
    const panel = w / PANELS;
    const radius = Math.min(panel, h) * 0.36;
    const side = Math.max(14, Math.min(panel, h) * 0.12);
    for (let i = 0; i < tiles.length; i++) {
      const index = Math.floor(i / TILES);
      const k = i % TILES;
      const a = time * 0.6 + (k / TILES) * Math.PI * 2;
      const rr = radius * (0.25 + 0.75 * (((k * 5) % 7) / 6));
      const tile = tiles[i];
      tile.setPosition(
        panel * (index + 0.5) + Math.cos(a) * rr,
        h / 2 + Math.sin(a * 1.3 + k) * rr,
      );
      tile.width = side;
      tile.height = side;
      tile.rotation = a;
    }
    shapes[1].rotation = time * 0.5;
    layout();
  });

  return {
    renderer,
    ticker,
    objects: () => tiles.length + shapes.length,
    destroy: () => teardown(ticker, renderer),
  };
}
