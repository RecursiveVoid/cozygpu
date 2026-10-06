// Filter chains on Group: cheap in-batch color effects, pooled-target chains
// (blur, glow), a custom filter, and a mixed chain.
//   ?backend=webgl2  force a backend ('auto' by default, 'webgpu' also valid)
//   ?worker=1        run the core in a worker (needs the worker bundle built)
//   ?resolution=0.5  render the filter targets at half resolution
//   ?still=1         do not animate (stable screenshots)
//   ?msaa=1          multisampled main pass (the capture resolves into it)
// The per-frame loop allocates nothing: the filters' uniform mirrors are
// written in place and uploaded only when they moved.
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const backendParam = params.get('backend');
const backend: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const WORKER = params.get('worker') === '1';
const RESOLUTION = Math.max(0.1, Number(params.get('resolution') ?? 1));
const STILL = params.get('still') === '1';
const MSAA = params.get('msaa') === '1';

const TILE = 24;
const COLORS = [0xff6f91, 0x6fe3ff, 0xffe66f, 0x9dff8a, 0xc08aff];

/** One 5-frame strip of soft discs, so every tile is one draw call. */
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

/** A custom filter: quantises the captured pixels into blocks. */
const pixelate = GPU.defineFilter({
  name: 'pixelate',
  params: { block: 'f32' },
  defaults: { block: 10 },
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

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x0d0d14,
    backend,
    antialias: MSAA,
    worker: WORKER ? { url: '/build/examples/cozygpu.worker.js' } : false,
  });

  // Dev handle for the headless verification driver (examples only).
  (globalThis as { __renderer?: unknown }).__renderer = renderer;

  const strip = GPU.Texture.fromPixels(
    TILE * COLORS.length,
    TILE,
    stripPixels(),
  );
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < COLORS.length; f++) {
    frames.push(strip.sub(f * TILE, 0, TILE, TILE));
  }

  // Preload both effect chunks so the first frame already draws the groups.
  await GPU.loadEffects('filters');

  const hue = GPU.filters.colorMatrix();
  const blur = GPU.filters.blur({ strength: 6, quality: 'fast' });
  const glow = GPU.filters.glow({ strength: 14, color: 0x66ccff });

  const panels: { title: string; group: GPU.Group }[] = [
    { title: 'none', group: new GPU.Group() },
    {
      title: 'colorMatrix (cheap)',
      group: new GPU.Group({ filters: [GPU.filters.colorMatrix().sepia()] }),
    },
    { title: 'blur (fast)', group: new GPU.Group({ filters: [blur] }) },
    { title: 'glow', group: new GPU.Group({ filters: [glow] }) },
    {
      title: 'pixelate (custom)',
      group: new GPU.Group({ filters: [pixelate()] }),
    },
    { title: 'hue + blur', group: new GPU.Group({ filters: [hue, blur] }) },
  ];

  const cols = 3;
  const cellW = 260;
  const cellH = 200;
  for (let p = 0; p < panels.length; p++) {
    const { group } = panels[p];
    const ox = (p % cols) * cellW + 40;
    const oy = Math.floor(p / cols) * cellH + 60;
    group.x = ox;
    group.y = oy;
    group.filterOptions = {
      resolution: RESOLUTION,
      area: { x: ox - 10, y: oy - 10, width: cellW - 20, height: cellH - 40 },
    };
    for (let i = 0; i < 28; i++) {
      const sprite = new GPU.Sprite(frames[i % frames.length]);
      sprite.anchorX = 0.5;
      sprite.anchorY = 0.5;
      sprite.x = 30 + (i % 7) * 26;
      sprite.y = 30 + Math.floor(i / 7) * 26;
      sprite.scaleX = 1.6;
      sprite.scaleY = 1.6;
      group.addChild(sprite);
    }
    renderer.stage.addChild(group);
  }

  let degrees = 0;
  GPU.ticker(renderer).add(dt => {
    if (STILL) return;
    degrees += dt * 40;
    hue.reset().hue(degrees);
    blur.set('strength', 4 + 4 * (1 + Math.sin(degrees / 40)));
  });

  setInterval(() => {
    const info = renderer.info;
    hud.textContent =
      `filters · ${info.backend} · resolution ${RESOLUTION}\n` +
      panels.map(p => p.title).join(' | ');
  }, 500);
}

void main();
