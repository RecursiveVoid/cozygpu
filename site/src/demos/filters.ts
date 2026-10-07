// Filters on Group: a cheap in-batch color matrix, pooled-target chains
// (blur, glow), a custom filter written in WGSL and GLSL, and a mixed chain.
// Full example: examples/filters/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

const TILE = 24;
const COLORS = [0xff6f91, 0x6fe3ff, 0xffe66f, 0x9dff8a, 0xc08aff];
const PER_PANEL = 28;

function stripPixels(): Uint8Array {
  const w = TILE * COLORS.length;
  const px = new Uint8Array(w * TILE * 4);
  for (let f = 0; f < COLORS.length; f++) {
    const c = COLORS[f];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot(x + 0.5 - TILE / 2, y + 0.5 - TILE / 2);
        const a = Math.max(0, Math.min(1, (TILE / 2 - 1 - d) / 2));
        const i = (y * w + f * TILE + x) * 4;
        px[i] = (c >> 16) & 255;
        px[i + 1] = (c >> 8) & 255;
        px[i + 2] = c & 255;
        px[i + 3] = Math.round(a * 255);
      }
    }
  }
  return px;
}

let pixelate: ReturnType<typeof GPU.defineFilter> | null = null;

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const renderer = await GPU.createRenderer({
    canvas: ctx.canvas,
    background: 0x0b0b12,
    backend: ctx.backend,
    worker: workerOption(ctx),
  });
  const strip = GPU.Texture.fromPixels(
    TILE * COLORS.length,
    TILE,
    stripPixels(),
  );
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < COLORS.length; f++) {
    frames.push(strip.sub(f * TILE, 0, TILE, TILE));
  }
  await GPU.loadEffects('filters');

  pixelate ??= GPU.defineFilter({
    name: 'pixelate',
    params: { block: 'f32' },
    defaults: { block: 8 },
    wgsl: `@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let s = max($params.block, 1.0) * fpass.texel;
  return cozySample((floor(in.uv / s) + 0.5) * s);
}`,
    glsl: `void main() {
  vec2 s = max($params.block, 1.0) * fpass.texel;
  fragColor = cozySample((floor(vUv / s) + 0.5) * s);
}`,
  });

  const hue = GPU.filters.colorMatrix();
  const blur = GPU.filters.blur({ strength: 6, quality: 'fast' });
  const glow = GPU.filters.glow({ strength: 14, color: 0x66ccff });
  const groups: GPU.Group[] = [
    new GPU.Group(),
    new GPU.Group({ filters: [GPU.filters.colorMatrix().sepia()] }),
    new GPU.Group({ filters: [blur] }),
    new GPU.Group({ filters: [glow] }),
    new GPU.Group({ filters: [pixelate()] }),
    new GPU.Group({ filters: [hue, blur] }),
  ];
  const sprites: GPU.Sprite[] = [];
  for (let p = 0; p < groups.length; p++) {
    for (let i = 0; i < PER_PANEL; i++) {
      const sprite = new GPU.Sprite(frames[(i + p) % frames.length]);
      sprite.anchorX = 0.5;
      sprite.anchorY = 0.5;
      groups[p].addChild(sprite);
      sprites.push(sprite);
    }
    renderer.stage.addChild(groups[p]);
  }

  let lastW = -1;
  let lastH = -1;
  let cellW = 0;
  let cellH = 0;
  const layout = (): void => {
    lastW = renderer.width;
    lastH = renderer.height;
    const cols = lastW < 560 ? 2 : 3;
    const rows = Math.ceil(groups.length / cols);
    cellW = lastW / cols;
    cellH = lastH / rows;
    for (let p = 0; p < groups.length; p++) {
      const ox = (p % cols) * cellW;
      const oy = Math.floor(p / cols) * cellH;
      groups[p].x = ox;
      groups[p].y = oy;
      groups[p].filterOptions = {
        area: { x: ox + 4, y: oy + 4, width: cellW - 8, height: cellH - 8 },
      };
    }
  };
  layout();

  const ticker = GPU.ticker(renderer);
  ticker.add((_dt, time) => {
    ctx.tick();
    if (renderer.width !== lastW || renderer.height !== lastH) layout();
    const degrees = time * 40;
    hue.reset().hue(degrees);
    blur.set('strength', 4 + 4 * (1 + Math.sin(time)));
    const r = Math.min(cellW, cellH) * 0.3;
    for (let i = 0; i < sprites.length; i++) {
      const k = i % PER_PANEL;
      const a = time * 0.7 + (k / PER_PANEL) * Math.PI * 2;
      const rr = r * (0.45 + 0.55 * ((k * 7) % 5) * 0.25);
      sprites[i].setPosition(
        cellW / 2 + Math.cos(a) * rr,
        cellH / 2 + Math.sin(a * 1.3 + k) * rr,
      );
      sprites[i].scaleX = sprites[i].scaleY = Math.max(0.8, r / 40);
    }
  });

  return {
    renderer,
    ticker,
    objects: () => sprites.length,
    destroy: () => teardown(ticker, renderer),
  };
}
