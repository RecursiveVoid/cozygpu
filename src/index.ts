// ─── Library exports ──────────────────────────────────────────────────────────
export { CozyGPU } from './CozyGPU';
export { SpriteBatch } from './sprites/SpriteBatch';
export { Sprite } from './sprites/Sprite';
export { TextureLoader } from './loaders/TextureLoader';
export { QuadMesh } from './meshes/QuadMesh';
export { TriangleMesh } from './meshes/TriangleMesh';

// ─── Dev test scene (browser only) ───────────────────────────────────────────
import { CozyGPU } from './CozyGPU';
import { SpriteBatch } from './sprites/SpriteBatch';
import { Sprite } from './sprites/Sprite';
import { mat4 } from 'gl-matrix';

const SPRITE_COUNT = 500;
const CANVAS_W = 900;
const CANVAS_H = 600;
const SPRITE_SIZE = 36;

// ─── Procedural texture ───────────────────────────────────────────────────────

function createProceduralTexture(device: GPUDevice): GPUTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2;
      const cy = y - size / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const radius = size / 2 - 2;
      const idx = (y * size + x) * 4;

      // Smooth circle with soft edge
      const alpha = Math.max(0, Math.min(1, (radius - dist) / 4));

      // Hue-based color ring
      const hue = (dist / radius) * 360;
      const [r, g, b] = hslToRgb(hue, 0.9, 0.65);

      data[idx + 0] = Math.round(r * 255);
      data[idx + 1] = Math.round(g * 255);
      data[idx + 2] = Math.round(b * 255);
      data[idx + 3] = Math.round(alpha * 255);
    }
  }

  const texture = device.createTexture({
    size: { width: size, height: size },
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4 },
    { width: size, height: size },
  );

  return texture;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = h % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  return [r + m, g + m, b + m];
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function buildUI(canvas: HTMLCanvasElement): {
  fpsEl: HTMLElement;
  countEl: HTMLElement;
} {
  document.body.style.cssText =
    'margin:0;background:#0d0d14;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;height:100vh;font-family:monospace;';

  const header = document.createElement('div');
  header.style.cssText =
    'color:#c8d4f0;font-size:13px;margin-bottom:8px;' +
    'display:flex;gap:24px;align-items:center;';

  const title = document.createElement('span');
  title.textContent = '⬡ CozyGPU Test Scene';
  title.style.cssText = 'font-size:15px;font-weight:bold;color:#8af;';

  const fpsEl = document.createElement('span');
  fpsEl.textContent = 'FPS: –';

  const countEl = document.createElement('span');
  countEl.textContent = `Sprites: ${SPRITE_COUNT}`;

  const infoEl = document.createElement('span');
  infoEl.textContent = 'WebGPU · Instanced · 1 draw call';
  infoEl.style.color = '#556';

  header.append(title, fpsEl, countEl, infoEl);

  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'border:1px solid #2a2a3a;border-radius:6px;overflow:hidden;';
  wrapper.appendChild(canvas);

  document.body.append(header, wrapper);
  return { fpsEl, countEl };
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const gpu = new CozyGPU();

  const renderer = await gpu.init({
    width: CANVAS_W,
    height: CANVAS_H,
    hello: true,
  });

  const canvas = renderer.canvas as HTMLCanvasElement;
  const { fpsEl } = buildUI(canvas);

  // ── SpriteBatch setup ────────────────────────────────────────────────────
  const batch = new SpriteBatch(renderer.device, SPRITE_COUNT, renderer.format);

  const texture = createProceduralTexture(renderer.device);
  batch.setTexture(texture);
  renderer.addRenderable(batch);

  // Ortho camera covering the canvas in screen-pixel space
  const view = mat4.create() as Float32Array;
  const projection = mat4.create() as Float32Array;
  mat4.ortho(projection, 0, CANVAS_W, CANVAS_H, 0, -1, 1);
  batch.updateCamera(view, projection);

  // ── Sprite data ──────────────────────────────────────────────────────────
  const sprites: Sprite[] = [];

  // Velocity array kept separate (not on the Sprite itself — data stays lean)
  const vx = new Float32Array(SPRITE_COUNT);
  const vy = new Float32Array(SPRITE_COUNT);

  for (let i = 0; i < SPRITE_COUNT; i++) {
    const s = new Sprite();
    s.x = Math.random() * CANVAS_W;
    s.y = Math.random() * CANVAS_H;
    s.z = 0;
    s.scaleX = SPRITE_SIZE;
    s.scaleY = SPRITE_SIZE;
    s.rotation = Math.random() * Math.PI * 2;

    // Vary hue via tint
    const [r, g, b] = hslToRgb(Math.random() * 360, 0.9, 0.8);
    s.tint = [r, g, b, 0.9];

    vx[i] = (Math.random() - 0.5) * 3;
    vy[i] = (Math.random() - 0.5) * 3;

    sprites.push(s);
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  let frameCount = 0;
  let lastFpsTime = performance.now();
  const half = SPRITE_SIZE / 2;

  function loop(): void {
    const now = performance.now();
    frameCount++;

    if (now - lastFpsTime >= 500) {
      const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
      fpsEl.textContent = `FPS: ${fps}`;
      frameCount = 0;
      lastFpsTime = now;
    }

    // Update sprite positions
    for (let i = 0; i < SPRITE_COUNT; i++) {
      const s = sprites[i];
      s.x += vx[i];
      s.y += vy[i];
      s.rotation += 0.02;

      // Bounce off canvas edges
      if (s.x < half) {
        s.x = half;
        vx[i] = Math.abs(vx[i]);
      }
      if (s.x > CANVAS_W - half) {
        s.x = CANVAS_W - half;
        vx[i] = -Math.abs(vx[i]);
      }
      if (s.y < half) {
        s.y = half;
        vy[i] = Math.abs(vy[i]);
      }
      if (s.y > CANVAS_H - half) {
        s.y = CANVAS_H - half;
        vy[i] = -Math.abs(vy[i]);
      }
    }

    batch.update(sprites);
    renderer.render();
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

if (typeof window !== 'undefined') {
  boot().catch(console.error);
}
