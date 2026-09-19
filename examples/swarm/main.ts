// Owner: "swarm". GPU-simulated objects; the CPU only sends a few commands.
//   ?count=1000000    objects (default 1M)
//   ?shape=circle     'circle' (SDF, default) or 'quad' (textured atlas frames)
//   ?mode=bounce      'bounce' (immortal, bounds bounce, default), 'wrap', or
//                     'fountain' (ring allocation: count/2 spawned per second, 2 s life)
//   ?cull=1           GPU compute culling into an indirect draw
//   ?substeps=1       simulation substeps per frame
//   ?worker=1         render in a worker
//   ?backend=webgl2   'auto' (default), 'webgpu', or 'webgl2' (transform
//                     feedback; M2, ARCHITECTURE §14.2)
//   ?allocation=gpu   'ring' (default), 'manual', or 'gpu' (GPU free list +
//                     compacted indirect draw; WebGPU compute only, §14.3)
// Hold the mouse button to attract. The per-frame loop allocates nothing;
// the HUD text is rebuilt twice a second.
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const COUNT = Math.max(1, Number(params.get('count') ?? 1_000_000) | 0);
const SHAPE = params.get('shape') === 'quad' ? 'quad' : 'circle';
const MODE = params.get('mode') ?? 'bounce';
const CULL = params.get('cull') === '1';
const SUBSTEPS = Math.max(1, Number(params.get('substeps') ?? 1) | 0);
const WORKER = params.get('worker') === '1';
const BACKEND =
  params.get('backend') === 'webgl2'
    ? 'webgl2'
    : params.get('backend') === 'webgpu'
      ? 'webgpu'
      : 'auto';
const ALLOCATION =
  params.get('allocation') === 'gpu'
    ? 'gpu'
    : params.get('allocation') === 'manual'
      ? 'manual'
      : 'ring';

/** 4 × 8×8 soft dots in one atlas. */
function atlasPixels(): Uint8Array {
  const S = 8;
  const colors = [0xffb3c7, 0xa8e6ff, 0xfff0a8, 0xb9ffb0];
  const px = new Uint8Array(S * colors.length * S * 4);
  for (let f = 0; f < colors.length; f++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / (S / 2);
        const a = Math.max(0, Math.min(1, (1 - d) * 3));
        const i = (y * S * colors.length + f * S + x) * 4;
        px[i] = (colors[f] >> 16) & 255;
        px[i + 1] = (colors[f] >> 8) & 255;
        px[i + 2] = colors[f] & 255;
        px[i + 3] = Math.round(a * 255);
      }
    }
  }
  return px;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const renderer = await GPU.createRenderer({
    canvas,
    limits: 'max',
    background: 0x0d0d14,
    powerPreference: 'high-performance',
    backend: BACKEND,
    worker: WORKER ? { url: '/build/examples/cozygpu.worker.js' } : false,
  });
  const caps = renderer.info.capabilities;
  // WebGPU simulates in compute; WebGL2 in a transform-feedback vertex pass.
  if (!caps.compute && !caps.transformFeedback) {
    hud.textContent = 'Swarm needs WebGPU compute or WebGL2 transform feedback';
    return;
  }
  // The GPU free list needs compute's atomicAdd (§14.3); WebGL2 uses the ring.
  const allocation =
    ALLOCATION === 'gpu' && !caps.compute ? 'ring' : ALLOCATION;
  const demoted = allocation !== ALLOCATION;

  let frames: GPU.Texture[] | undefined;
  if (SHAPE === 'quad') {
    const atlas = GPU.Texture.fromPixels(32, 8, atlasPixels());
    frames = [0, 1, 2, 3].map(f => atlas.sub(f * 8, 0, 8, 8));
  }

  // renderer.width/height catch up with the canvas CSS size a frame later
  // (ResizeObserver); the layout size is exact from the start.
  const w = canvas.clientWidth || renderer.width;
  const h = canvas.clientHeight || renderer.height;
  const fountain = MODE === 'fountain';
  const colors: [string, string] = ['#3fa9ff', '#ff5fc8'];
  const fill = (target: GPU.SwarmNode): void => {
    if (fountain) return; // the fountain refills itself
    target.spawn(COUNT, {
      x: [0, w],
      y: [0, h],
      speed: [10, 90],
      angle: [0, Math.PI * 2],
      size: SHAPE === 'quad' ? [2, 5] : [1, 3],
      color: colors,
      alpha: SHAPE === 'quad' ? [0.15, 0.4] : [0.35, 0.8],
      frame: [0, 4],
    });
  };
  const swarm = new GPU.Swarm({
    capacity: COUNT,
    shape: SHAPE,
    frames,
    blendMode: 'add',
    substeps: SUBSTEPS,
    allocation,
    // GPU contents are gone after a device loss: spawn again.
    onRestore: fill,
    render: {
      fadeOut: fountain,
      cull: CULL,
    },
    behaviors: [
      GPU.behaviors.velocity(),
      GPU.behaviors.acceleration({ name: 'gravity', y: fountain ? 400 : 60 }),
      GPU.behaviors.attractor({ x: w / 2, y: h / 2, strength: 0, radius: 400 }),
      GPU.behaviors.bounds({
        x: 0,
        y: 0,
        width: w,
        height: h,
        mode: MODE === 'wrap' ? 'wrap' : fountain ? 'kill' : 'bounce',
        restitution: 0.9,
      }),
    ],
  });
  renderer.stage.addChild(swarm);

  fill(swarm);

  const attractor = swarm.behavior<{
    point: 'vec2f';
    strength: 'f32';
    radius: 'f32';
  }>('attractor');
  const bounds = swarm.behavior<{ rect: 'vec4f'; restitution: 'f32' }>(
    'bounds',
  );
  const point: [number, number] = [w / 2, h / 2];
  canvas.addEventListener('pointermove', e => {
    point[0] = e.offsetX;
    point[1] = e.offsetY;
    attractor.set('point', point);
  });
  canvas.addEventListener('pointerdown', e => {
    point[0] = e.offsetX;
    point[1] = e.offsetY;
    attractor.set('point', point);
    attractor.set('strength', 3000);
  });
  window.addEventListener('pointerup', () => {
    attractor.set('strength', 0);
  });
  const rect: [number, number, number, number] = [0, 0, w, h];
  let lastW = w;
  let lastH = h;

  // Fountain: spawn in small per-frame bursts into the ring.
  const perSecond = COUNT / 2;
  let spawnCarry = 0;
  const burst = {
    disc: { x: w / 2, y: h * 0.8, radius: 6 },
    speed: [150, 650] as [number, number],
    angle: [-Math.PI * 0.75, -Math.PI * 0.25] as [number, number],
    size:
      SHAPE === 'quad'
        ? ([2, 5] as [number, number])
        : ([1, 3] as [number, number]),
    life: [1.2, 2] as [number, number],
    color: colors,
    alpha: [0.5, 1] as [number, number],
    frame: [0, 4] as [number, number],
  };

  // Frame-time stats (ring of the last 120 frame intervals).
  const samples = new Float64Array(120);
  let sampleCount = 0;
  let sampleAt = 0;
  let lastNow = performance.now();
  let hudAt = lastNow;
  const stats = {
    fps: 0,
    frameMs: 0,
    worstMs: 0,
    cpuMs: 0,
    packetBytes: 0,
    alive: -1,
  };
  // aliveCount() is a GPU readback: poll it with the HUD, never per frame,
  // and never more than one request in flight.
  let alivePending = false;
  // Debug handles for the headless checks.
  const debug = window as unknown as Record<string, unknown>;
  debug.__swarmStats = stats;
  debug.__swarm = swarm;
  debug.__renderer = renderer;

  const t = GPU.ticker(renderer);
  t.add(dt => {
    const now = performance.now();
    samples[sampleAt] = now - lastNow;
    sampleAt = (sampleAt + 1) % samples.length;
    if (sampleCount < samples.length) sampleCount++;
    lastNow = now;

    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if ((cw !== lastW || ch !== lastH) && cw > 0 && ch > 0) {
      lastW = cw;
      lastH = ch;
      rect[2] = lastW;
      rect[3] = lastH;
      bounds.set('rect', rect);
      burst.disc.x = lastW / 2;
      burst.disc.y = lastH * 0.8;
    }

    if (fountain) {
      spawnCarry += perSecond * Math.min(dt, 0.1);
      const n = Math.floor(spawnCarry);
      if (n > 0) {
        spawnCarry -= n;
        swarm.spawn(n, burst);
      }
    }

    if (now - hudAt > 500) {
      hudAt = now;
      let sum = 0;
      let worst = 0;
      for (let k = 0; k < sampleCount; k++) {
        sum += samples[k];
        if (samples[k] > worst) worst = samples[k];
      }
      stats.frameMs = sampleCount ? sum / sampleCount : 0;
      stats.fps = stats.frameMs ? 1000 / stats.frameMs : 0;
      stats.worstMs = worst;
      stats.cpuMs = renderer.stats.cpuMs;
      stats.packetBytes = renderer.stats.packetBytes;
      if (!alivePending) {
        alivePending = true;
        swarm.aliveCount().then(
          n => {
            stats.alive = n;
            alivePending = false;
          },
          () => {
            alivePending = false;
          },
        );
      }
      hud.textContent =
        `swarm ${COUNT.toLocaleString()} ${SHAPE} ${MODE}` +
        `${CULL ? ' cull' : ''}${WORKER ? ' worker' : ''}\n` +
        `${renderer.info.backend} · ${allocation} alloc` +
        `${demoted ? ' (gpu needs compute)' : ''}\n` +
        `fps ${stats.fps.toFixed(1)} · frame ${stats.frameMs.toFixed(2)} ms` +
        ` (worst ${worst.toFixed(1)})\n` +
        `front cpu ${stats.cpuMs.toFixed(3)} ms · packet ${stats.packetBytes} B` +
        ` · active ${swarm.activeCount.toLocaleString()}` +
        `${stats.alive >= 0 ? ` · alive ${stats.alive.toLocaleString()}` : ''}\n` +
        'hold mouse to attract';
    }
  });
}

main().catch(err => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = String(err);
});
