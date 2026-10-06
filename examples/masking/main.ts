// Masking (docs/ARCHITECTURE.md §21). Three panels, one per implementation:
//
//   left    rect mask     → scissor (axis-aligned, no draw, no target)
//   middle  shape mask    → stencil where the backend clips other draws with
//                           the stencil buffer, alpha (render to texture)
//                           otherwise
//   right   soft mask     → alpha: a radial gradient multiplies the group
//
// Query flags:
//   ?backend=auto|webgpu|webgl2   backend preference (default auto)
//   ?worker=1                     render from a Web Worker (OffscreenCanvas)
//   ?msaa=1                       4× MSAA (all three modes work; the mask
//                                 pass reopens the multisampled attachment)
//   ?invert=1                     invert all three masks
//   ?mode=auto|scissor|stencil|alpha  force one implementation
//
// What each backend does (the HUD shows the mode each group resolved to):
// scissor masks are exact everywhere. Stencil masks clip on WebGL2, where
// the stencil test applies to the draws that follow it; on WebGPU a pipeline
// carries its own stencil state, so 'auto' picks the alpha path until the
// sprite pipelines declare one, and an explicit ?mode=stencil falls back to
// alpha there. The soft panel asks for alpha by name: 'auto' reads geometry,
// not texels, so it would clip an unrotated sprite to a hard rectangle.
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const backendParam = params.get('backend');
const preference: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const modeParam = params.get('mode');
const forced =
  modeParam === 'scissor' || modeParam === 'stencil' || modeParam === 'alpha'
    ? modeParam
    : undefined;
const invert = params.get('invert') === '1';
const hud = document.getElementById('hud') as HTMLElement;

/** Read by the headless check (puppeteer-core). */
const status = {
  backend: '',
  worker: params.get('worker') === '1',
  frames: 0,
  ready: false,
  modes: [] as string[],
  errors: [] as string[],
};
(globalThis as { __masking?: typeof status }).__masking = status;

const PANELS = 3;

type GroupInternals = GPU.Group & {
  _maskBinding: { mode: string } | null;
};

async function run(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = await GPU.createRenderer({
    canvas,
    backend: preference,
    background: 0x101018,
    antialias: params.get('msaa') === '1',
    worker: status.worker
      ? { url: '/build/examples/cozygpu.worker.js' }
      : false,
    events: {
      emit(name: string, payload: unknown) {
        if (name === 'error') {
          status.errors.push(JSON.stringify(payload));
          console.warn('[masking]', payload);
        }
      },
    },
  });
  (globalThis as { __renderer?: unknown }).__renderer = renderer;
  status.backend = renderer.info.backend;

  const checker = GPU.Texture.fromPixels(64, 64, checkerPixels(64));
  const disc = GPU.Texture.fromPixels(64, 64, discPixels(64, 0));
  const soft = GPU.Texture.fromPixels(64, 64, discPixels(64, 24));

  // Each panel is a Group: its subtree is what the mask clips.
  const groups: GroupInternals[] = [];
  const spinners: GPU.Sprite[] = [];
  const shapes: GPU.Sprite[] = [];
  for (let i = 0; i < PANELS; i++) {
    const group = new GPU.Group();
    renderer.stage.addChild(group);
    groups.push(group as unknown as GroupInternals);
    for (let k = 0; k < 24; k++) {
      const tile = new GPU.Sprite({
        texture: checker,
        anchor: 0.5,
        tint: k % 2 ? 0x66ccff : 0xff88bb,
      });
      group.addChild(tile);
      spinners.push(tile);
    }
    // The shape masks draw themselves too, dimmed, so the clip is visible.
    const shape = new GPU.Sprite({
      texture: i === 2 ? soft : disc,
      anchor: 0.5,
    });
    shape.alpha = 0.15;
    renderer.stage.addChild(shape);
    shapes.push(shape);
  }

  // Preloading keeps the first frames from skipping the groups' subtrees.
  await GPU.loadEffects('mask');

  const layout = (): void => {
    const w = renderer.width;
    const h = renderer.height;
    const panel = w / PANELS;
    const size = Math.min(panel, h) * 0.62;
    for (let i = 0; i < PANELS; i++) {
      const cx = panel * (i + 0.5);
      const cy = h / 2;
      const shape = shapes[i];
      shape.setPosition(cx, cy);
      shape.width = size;
      shape.height = size;
      if (i === 0) {
        // A plain rect in the group's parent space: the cheapest mask.
        groups[i].mask = {
          source: {
            x: cx - size / 2,
            y: cy - size / 2,
            width: size,
            height: size,
          },
          mode: forced ?? 'auto',
          invert,
        };
      } else {
        // The soft panel asks for 'alpha' by name: 'auto' cannot see that a
        // texture has a feathered edge, so it would pick the cheaper scissor
        // for an unrotated sprite and clip to a hard rectangle (§21.2).
        const mode = forced ?? (i === 2 ? 'alpha' : 'auto');
        groups[i].mask = { source: shape, mode, invert };
      }
    }
  };
  layout();

  let hudTimer = 0;
  GPU.ticker(renderer).add((dt, time) => {
    const w = renderer.width;
    const h = renderer.height;
    const panel = w / PANELS;
    const radius = Math.min(panel, h) * 0.34;
    for (let i = 0; i < spinners.length; i++) {
      const p = (i / spinners.length) * PANELS;
      const index = Math.min(PANELS - 1, Math.floor(p));
      const k = i % 24;
      const a = time * 0.6 + (k / 24) * Math.PI * 2;
      const tile = spinners[i];
      tile.setPosition(
        panel * (index + 0.5) + Math.cos(a) * radius,
        h / 2 + Math.sin(a * 1.3) * radius,
      );
      tile.width = 26;
      tile.height = 26;
      tile.rotation = a;
    }
    // The middle mask turns, which is what takes it off the scissor path.
    shapes[1].rotation = time * 0.5;
    layout();
    status.frames++;
    status.ready = true;
    status.modes = groups.map(g => g._maskBinding?.mode ?? 'pending');
    hudTimer += dt;
    if (hudTimer > 0.4) {
      hudTimer = 0;
      const s = renderer.stats;
      hud.textContent =
        `masking · ${renderer.info.backend} · ${status.worker ? 'worker' : 'main thread'}` +
        ` · ${renderer.width}×${renderer.height}@${renderer.resolution}\n` +
        `rect → ${status.modes[0]}   shape → ${status.modes[1]}   soft → ${status.modes[2]}\n` +
        `frame ${s.frameId} · draws ${s.drawCalls} · ${s.packetBytes} B` +
        (invert ? ' · inverted' : '');
    }
  });

  new ResizeObserver(layout).observe(canvas);
}

/** Opaque checkerboard, premultiplied (every texel masks). */
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

/**
 * A disc, premultiplied. `feather` > 0 gives it a soft edge, which is what
 * makes a mask continuous instead of binary.
 */
function discPixels(size: number, feather: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const d = Math.sqrt(dx * dx + dy * dy);
      const edge = feather > 0 ? feather : 1.5;
      const alpha = Math.max(0, Math.min(1, (r - d) / edge));
      const value = Math.round(255 * alpha);
      px[i] = value;
      px[i + 1] = value;
      px[i + 2] = value;
      px[i + 3] = value;
    }
  }
  return px;
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  status.errors.push(message);
  hud.textContent = message;
  console.error(err);
});
