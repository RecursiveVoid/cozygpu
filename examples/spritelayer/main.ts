// SpriteLayer: millions of sprites in one draw (docs/API.md "SpriteLayer").
//
//   ?n=1000000        instances (default 1M)
//   ?mode=static      written once, nothing per frame (default)
//   ?mode=columns     an ECS-style Float32Array `xy` column moved on the CPU
//                     and committed every frame (zero-copy upload)
//   ?mode=packed      separate x / y / rotation columns (packed per frame)
//   ?mode=external    positions written by a WebGPU compute pass into a
//                     registered buffer, count in a 'draw-indirect' buffer
//                     (main thread, WebGPU only; no upload at all)
//   ?cull=1           GPU culling (WebGPU); the world is 3× the screen and
//                     the layer pans, so most instances are off screen.
//                     Press C to toggle culling while it runs.
//   ?textures=1       one atlas page only (default: frames from three
//                     textures, still one draw)
//   ?pan=0            keep the culled world still (image comparisons)
//   ?group=mask|blur  draw the layer inside a masked (rotated disc: stencil on
//                     WebGL2, alpha on WebGPU) or blurred Group
//   ?msaa=1           4× MSAA
//   ?lose=2           simulate a device loss after 2 s (restore check)
//   ?world=3          world size in screens (default 3 with cull, else 1)
//   ?backend=auto|webgpu|webgl2, ?worker=1
//
// Click a sprite: the pick answers with the layer, the instance index and
// the USER stream value. `window.__layer` exposes rolling timings for the
// headless benchmark (benchmarks/layer).
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const N = Math.max(1, Number(params.get('n') ?? 1_000_000) | 0);
const MODE = params.get('mode') ?? 'static';
const CULL = params.get('cull') === '1';
const backendParam = params.get('backend');
const backend: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const WORKER = params.get('worker') === '1';
const PAN = params.get('pan') !== '0';
const WORLD = Number(params.get('world') ?? (CULL ? 3 : 1));
const MIXED = params.get('textures') !== '1';
const CELL = 8;

/** Seeded PRNG (mulberry32): every run places the same sprites. */
let seed = 0x9e3779b9;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const SHAPES = 4;

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
        if (!inside) continue;
        const i = (y * w + f * CELL + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 255;
      }
    }
  }
  return px;
}

/** A soft round glow (premultiplied white). */
function glowPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const a = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2) ** 1.5;
      px.fill(Math.round(a * 255), 4 * (y * size + x), 4 * (y * size + x) + 4);
    }
  }
  return px;
}

/** A ring with a darker core: shows that a second texture is sampled. */
function ringPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const i = 4 * (y * size + x);
      if (r > 1) continue;
      const v = r > 0.65 ? 255 : 90;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Rolling stats read by the benchmark: front ms (render + commit), fps. */
const stats = {
  frames: 0,
  jsMs: 0,
  cpuMs: 0,
  packetBytes: 0,
  drawCalls: 0,
  fps: 0,
  backend: '',
  restored: 0,
  reset(): void {
    this.frames = 0;
    this.jsMs = 0;
    this.cpuMs = 0;
  },
};
(globalThis as { __layer?: typeof stats }).__layer = stats;

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x0d0d14,
    backend,
    worker: WORKER ? { url: '/build/examples/cozygpu.worker.js' } : false,
    limits: 'max',
    debug: params.has('lose'),
    antialias: params.get('msaa') === '1',
    events: {
      emit(name) {
        if (name === 'deviceRestored') stats.restored++;
      },
    },
  });
  stats.backend = renderer.info.backend;
  const lose = Number(params.get('lose') ?? 0);
  if (lose > 0) {
    setTimeout(() => {
      type Debuggable = { _debug(action: 'loseDevice'): void };
      (renderer as unknown as Debuggable)._debug('loseDevice');
    }, lose * 1000);
  }
  const atlas = GPU.Texture.fromPixels(CELL * SHAPES, CELL, atlasPixels(), {
    nearest: true,
  });
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < SHAPES; f++)
    frames.push(atlas.sub(f * CELL, 0, CELL, CELL));
  if (MIXED) {
    // Two more texture sources: the layer samples up to 8 in one draw.
    frames.push(GPU.Texture.fromPixels(12, 12, glowPixels(12)));
    frames.push(GPU.Texture.fromPixels(10, 10, ringPixels(10)));
  }
  const FRAMES = frames.length;

  const W = renderer.width * WORLD;
  const H = renderer.height * WORLD;
  const layer = new GPU.SpriteLayer({
    capacity: N,
    frames,
    streams: { xform: true, color: true, user: true },
    cull: CULL,
    pickable: true,
  });
  const group = params.get('group');
  if (group) {
    const g = new GPU.Group();
    renderer.stage.addChild(g);
    g.addChild(layer);
    if (group === 'blur') {
      g.filters = [GPU.filters.blur({ strength: 4, quality: 'fast' })];
    } else {
      const R = 128;
      const px = new Uint8Array(4 * 4 * R * R);
      for (let y = 0; y < 2 * R; y++) {
        for (let x = 0; x < 2 * R; x++) {
          const inside = (x - R + 0.5) ** 2 + (y - R + 0.5) ** 2 < R * R;
          px.fill(
            inside ? 255 : 0,
            4 * (y * 2 * R + x),
            4 * (y * 2 * R + x) + 4,
          );
        }
      }
      const disc = new GPU.Sprite({
        texture: GPU.Texture.fromPixels(2 * R, 2 * R, px),
        anchor: 0.5,
        x: renderer.width / 2,
        y: renderer.height / 2,
        scale: 2,
        rotation: 0.3,
      });
      g.mask = { source: disc };
    }
  } else {
    renderer.stage.addChild(layer);
  }

  // Setup through the own stores: one pass over every row.
  const d = layer.data;
  const xf32 = new Uint32Array(d.xform.buffer);
  for (let i = 0; i < N; i++) {
    d.position[2 * i] = random() * W;
    d.position[2 * i + 1] = random() * H;
    // f16 scale 1 (0x3c00) in both halves; rotation 0 | frame << 16.
    xf32[2 * i] = 0x3c003c00;
    xf32[2 * i + 1] = (random() * 65536) | 0 | ((i % FRAMES) << 16);
    const h = (i * 0.0007) % 1;
    d.color[i] =
      ((128 + 127 * Math.sin(6.28 * h)) & 255) |
      (((128 + 127 * Math.sin(6.28 * h + 2.1)) & 255) << 8) |
      (((128 + 127 * Math.sin(6.28 * h + 4.2)) & 255) << 16) |
      (0xff << 24);
    d.user[i] = 1_000_000 + i;
  }
  layer.markDirty(0, N);
  layer.count = N;

  let step: (t: number, dt: number) => void = () => {};
  let commit: () => void = () => {};
  if (MODE === 'columns' || MODE === 'packed') {
    // The "ECS": velocities and positions as plain typed arrays.
    const vx = new Float32Array(N);
    const vy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      vx[i] = (random() - 0.5) * 120;
      vy[i] = (random() - 0.5) * 120;
    }
    if (MODE === 'columns') {
      // Shared memory keeps the column zero-copy in worker mode too.
      const xy = new Float32Array(
        crossOriginIsolated
          ? new SharedArrayBuffer(8 * N)
          : new ArrayBuffer(8 * N),
      );
      xy.set(d.position);
      const binding = layer.bindColumns({ xy });
      step = (_t, dt) => {
        for (let i = 0, p = 0; i < N; i++, p += 2) {
          let x = xy[p] + vx[i] * dt;
          let y = xy[p + 1] + vy[i] * dt;
          if (x < 0 || x > W) vx[i] = -vx[i];
          if (y < 0 || y > H) vy[i] = -vy[i];
          xy[p] = x = Math.min(W, Math.max(0, x));
          xy[p + 1] = y = Math.min(H, Math.max(0, y));
        }
      };
      commit = () => binding.commit(N);
    } else {
      const x = new Float32Array(N);
      const y = new Float32Array(N);
      const rotation = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        x[i] = d.position[2 * i];
        y[i] = d.position[2 * i + 1];
      }
      const binding = layer.bindColumns({ x, y, rotation });
      step = (t, dt) => {
        for (let i = 0; i < N; i++) {
          x[i] += vx[i] * dt;
          y[i] += vy[i] * dt;
          if (x[i] < 0 || x[i] > W) vx[i] = -vx[i];
          if (y[i] < 0 || y[i] > H) vy[i] = -vy[i];
          rotation[i] = t + i;
        }
      };
      commit = () => binding.commit(N);
    }
  } else if (MODE === 'external') {
    step = await externalSource(renderer, layer, W, H);
  }

  let picked = 'click a sprite to pick it';
  canvas.addEventListener('click', e => {
    renderer.pick(e.offsetX, e.offsetY).then(hit => {
      const what = hit && {
        kind: hit.node.kind,
        instance: hit.instance,
        userId: hit.userId,
      };
      console.log('pick', JSON.stringify(what));
      picked = hit
        ? `picked ${hit.node.kind} instance ${hit.instance} (user ${hit.userId})`
        : 'picked nothing';
    });
  });
  addEventListener('keydown', e => {
    if (e.key === 'c' || e.key === 'C') layer.cull = !layer.cull;
  });
  modeLinks();

  let last = performance.now();
  let fpsFrames = 0;
  let fpsStart = last;
  let hudAt = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(now / 1000, dt);
    if (CULL && PAN) {
      // Pan over the 3× world.
      layer.x = -renderer.width * (1 + Math.sin(now / 4000));
      layer.y = -renderer.height * (1 + Math.cos(now / 5000));
    }
    const t0 = performance.now();
    commit();
    renderer.render();
    stats.jsMs += performance.now() - t0;
    stats.cpuMs += renderer.stats.cpuMs;
    stats.packetBytes = renderer.stats.packetBytes;
    stats.drawCalls = renderer.stats.drawCalls;
    stats.frames++;
    fpsFrames++;
    if (now - fpsStart > 500) {
      stats.fps = (fpsFrames * 1000) / (now - fpsStart);
      fpsFrames = 0;
      fpsStart = now;
    }
    if (now > hudAt) {
      hudAt = now + 500;
      const n = Math.max(1, stats.frames);
      hud.textContent =
        `SpriteLayer ${N.toLocaleString()} · ${MODE} · ${FRAMES} frames from ${MIXED ? 3 : 1} texture${MIXED ? 's' : ''}` +
        `${layer.cull ? ' · cull' : ''} · ${renderer.info.backend}${WORKER ? ' · worker' : ''}\n` +
        `${stats.fps.toFixed(0)} fps · front ${(stats.jsMs / n).toFixed(2)} ms · ` +
        `${stats.drawCalls} draws · packet ${stats.packetBytes} B\n` +
        `${picked} · C toggles culling`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/** Links to the other modes, keeping the remaining parameters. */
function modeLinks(): void {
  const nav = document.getElementById('modes');
  if (!nav) return;
  for (const [mode, cull] of [
    ['static', false],
    ['columns', false],
    ['packed', false],
    ['external', false],
    ['static', true],
  ] as const) {
    const q = new URLSearchParams(location.search);
    q.set('mode', mode);
    if (cull) q.set('cull', '1');
    else q.delete('cull');
    const a = document.createElement('a');
    a.href = `?${q}`;
    a.textContent = cull ? `${mode} + cull` : mode;
    if (mode === MODE && cull === CULL) a.className = 'on';
    nav.append(a);
  }
}

/**
 * GPU-driven positions: a compute pass on the renderer's own device writes
 * the POSITION stream and the draw count; the layer draws them with zero
 * copies (§28.5).
 */
async function externalSource(
  renderer: GPU.Renderer,
  layer: GPU.SpriteLayerNode,
  W: number,
  H: number,
): Promise<(t: number) => void> {
  const interop = await renderer.interop();
  if (interop.backend !== 'webgpu')
    throw new Error('external mode needs WebGPU');
  const device = interop.device as GPUDevice;
  const positions = device.createBuffer({
    size: N * GPU.layerLayouts.LAYER_POSITION_BYTES,
    usage: GPUBufferUsage.STORAGE,
  });
  const args = device.createBuffer({
    size: GPU.layerLayouts.LAYER_INDIRECT_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
  });
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const module = device.createShaderModule({
    code: /* wgsl */ `
      struct P { t: f32, w: f32, h: f32, n: u32 }
      @group(0) @binding(0) var<uniform> p: P;
      @group(0) @binding(1) var<storage, read_write> pos: array<vec2f>;
      @group(0) @binding(2) var<storage, read_write> args: array<u32, 4>;
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) g: vec3u) {
        let i = g.x;
        if (i == 0u) {
          // The live count: half of the rows breathe in and out.
          args[0] = 4u;
          args[1] = p.n / 2u + u32(f32(p.n / 2u) * (0.5 + 0.5 * sin(p.t)));
          args[2] = 0u;
          args[3] = 0u;
        }
        if (i >= p.n) { return; }
        let f = f32(i);
        let r = fract(sin(f * 12.9898) * 43758.5453);
        let a = f * 0.0137 + p.t * (0.2 + r);
        let rad = (0.1 + 0.4 * fract(f * 0.618)) * min(p.w, p.h);
        pos[i] = vec2f(p.w * 0.5 + cos(a) * rad, p.h * 0.5 + sin(a) * rad);
      }`,
  });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: positions } },
      { binding: 2, resource: { buffer: args } },
    ],
  });
  layer.setSource({
    position: interop.registerInstanceBuffer(positions, {
      layout: 'layer-position',
      capacity: N,
    }),
    indirect: interop.registerInstanceBuffer(args, {
      layout: 'draw-indirect',
      capacity: 1,
    }),
  });
  const data = new Float32Array(4);
  const u32 = new Uint32Array(data.buffer);
  return t => {
    data[0] = t;
    data[1] = W;
    data[2] = H;
    u32[3] = N;
    device.queue.writeBuffer(params, 0, data);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(N / 256));
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
}

main().catch(err => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = `error: ${(err as Error).message}`;
});
