// Browser side of tests/browser/stress.mjs. Bundled with esbuild ('cozygpu'
// aliased to src/index.ts) and driven through page.evaluate(). Every scenario
// returns plain JSON; the Node side decides pass/fail.
import * as GPU from 'cozygpu';

const S = globalThis.__stress;
const WORKER_URL = '/cozygpu.worker.js';
const HOT_WORDS = GPU.layouts.SWARM_HOT_BYTES / 4;
const LIFE = GPU.layouts.SH_LIFE / 4;

const raf = () => new Promise(r => requestAnimationFrame(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const phase = t => (S.phase = `${t} @${performance.now().toFixed(0)}ms`);
const errText = e => (e && (e.code ? `${e.code}: ${e.message}` : e.message)) || String(e);

function makeCanvas(w = 640, h = 480) {
  const c = document.createElement('canvas');
  c.style.cssText = `display:block;position:absolute;left:0;top:0;width:${w}px;height:${h}px`;
  document.body.appendChild(c);
  return c;
}

function whiteTex(r = 255, g = 255, b = 255) {
  return GPU.Texture.fromPixels(1, 1, new Uint8Array([r, g, b, 255]));
}

async function createCtx(opts = {}) {
  const canvas = opts.canvas ?? makeCanvas(opts.cssW, opts.cssH);
  const events = { lost: [], restored: 0 };
  // M2 command ring (worker + crossOriginIsolated). `ring: false` forces the
  // transfer path (WorkerTransport reads __COZYGPU_RING__ at create time).
  if (opts.ring === false) globalThis.__COZYGPU_RING__ = false;
  else if (opts.ring === true) delete globalThis.__COZYGPU_RING__;
  const t0 = performance.now();
  const renderer = await GPU.createRenderer({
    canvas,
    worker: opts.worker ? { url: WORKER_URL } : false,
    backend: opts.backend ?? 'auto',
    background: 0x000000,
    limits: opts.limits ?? 'default',
    debug: !!opts.debug,
    autoResize: opts.autoResize,
    assets: opts.assets,
    onDeviceLost: info => events.lost.push(info),
    onDeviceRestored: () => events.restored++,
  });
  const ctx = {
    renderer,
    canvas,
    events,
    createMs: performance.now() - t0,
    loop: null,
    backend: renderer.info.backend,
  };
  return ctx;
}

/** True when this renderer can run a Swarm of `capacity` objects. */
function swarmSupported(renderer, capacity = 1) {
  const caps = renderer.info.capabilities;
  if (caps.compute) return true;
  return caps.transformFeedback && capacity <= GPU.SWARM_GL_MAX_CAPACITY;
}

/** Loses the device wherever the core lives (needs debug: true). */
function loseDevice(ctx) {
  const r = ctx.renderer;
  if (typeof r._debug === 'function') {
    r._debug('loseDevice');
    return 'ok';
  }
  const core = globalThis.__COZYGPU_CORE__;
  if (!core) return 'no __COZYGPU_CORE__ (debug off?)';
  core.backend.simulateDeviceLoss();
  return 'ok';
}

function destroyCtx(ctx) {
  stopLoop(ctx);
  ctx.renderer.destroy();
  ctx.canvas.remove();
}

/** Renders `n` frames on rAF; returns frame-time stats. */
async function frames(ctx, n, each) {
  const times = new Float64Array(n);
  const cpu = new Float64Array(n);
  let last = performance.now();
  for (let i = 0; i < n; i++) {
    if (each) each(i);
    ctx.renderer.render();
    cpu[i] = ctx.renderer.stats.cpuMs;
    S.frameCounter = (S.frameCounter ?? 0) + 1;
    await raf();
    const now = performance.now();
    times[i] = now - last;
    last = now;
  }
  return summarize(times, cpu);
}

function summarize(times, cpu) {
  const n = times.length;
  if (n === 0) return { frames: 0 };
  const sorted = Float64Array.from(times).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += times[i];
  let cpuSum = 0;
  let cpuMax = 0;
  const cpuSorted = Float64Array.from(cpu).sort();
  for (let i = 0; i < n; i++) {
    cpuSum += cpu[i];
    if (cpu[i] > cpuMax) cpuMax = cpu[i];
  }
  return {
    frames: n,
    fps: +(1000 / (sum / n)).toFixed(1),
    frameMsP50: +sorted[Math.floor(n * 0.5)].toFixed(2),
    frameMsP99: +sorted[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(2),
    frameMsMax: +sorted[n - 1].toFixed(2),
    cpuMsAvg: +(cpuSum / n).toFixed(3),
    cpuMsP99: +cpuSorted[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(3),
    cpuMsMax: +cpuMax.toFixed(3),
  };
}

function startLoop(ctx, each) {
  stopLoop(ctx);
  const loop = { on: true, frames: 0, throws: [] };
  const tick = () => {
    if (!loop.on) return;
    try {
      if (each) each(loop.frames);
      ctx.renderer.render();
    } catch (e) {
      if (loop.throws.length < 10) loop.throws.push(errText(e));
    }
    loop.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  ctx.loop = loop;
}

function stopLoop(ctx) {
  if (ctx.loop) ctx.loop.on = false;
  const l = ctx.loop;
  ctx.loop = null;
  return l;
}

/** Readbacks are encoded by the next render(), so keep rendering while waiting. */
async function countAlive(swarm, first, count, ctx, timeoutMs = 8000) {
  const promise = swarm.readHot(first, count);
  let done = false;
  promise.finally(() => (done = true)).catch(() => {});
  if (ctx && !ctx.loop) {
    const until = performance.now() + timeoutMs;
    while (!done && performance.now() < until) {
      ctx.renderer.render();
      await raf();
    }
  }
  const hot = await promise;
  let alive = 0;
  for (let i = 0; i < count; i++) if (hot[i * HOT_WORDS + LIFE] > 0) alive++;
  return alive;
}

/** Awaits a GPU readback while keeping frames flowing (readbacks ride a frame). */
async function awaitWhileRendering(ctx, promise, timeoutMs = 10000) {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  const until = performance.now() + timeoutMs;
  while (!done && performance.now() < until) {
    if (!ctx.loop) ctx.renderer.render();
    await raf();
  }
  return Promise.race([promise, sleep(50).then(() => 'timeout')]);
}

function gpuErrorSnapshot() {
  return { count: S.gpuErrorCount, first: S.gpuErrors.slice(0, 5) };
}

function aliveDevices() {
  let n = 0;
  for (const d of S.devices) {
    if (!d.destroyed && !d.lost) n++;
  }
  return n;
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

/** Swarm at a given capacity: spawn everything, render, read back. */
async function swarmCapacity({ worker, backend, capacity, limits, frameCount = 180, warmFrames = 30, readTimeoutMs = 8000 }) {
  const out = { capacity, limits, worker };
  phase('createRenderer');
  let ctx;
  try {
    ctx = await createCtx({ worker, backend, limits, cssW: 800, cssH: 600 });
  } catch (e) {
    out.createError = errText(e);
    return out;
  }
  const { renderer } = ctx;
  const caps = renderer.info.capabilities;
  out.caps = {
    compute: caps.compute,
    vertexStorage: caps.vertexStorage,
    maxStorageBufferBindingSize: caps.maxStorageBufferBindingSize ?? caps.limits?.maxStorageBufferBindingSize,
    maxBufferSize: caps.maxBufferSize ?? caps.limits?.maxBufferSize,
  };
  // A marker sprite proves the renderer still draws even if the swarm fails.
  const marker = new GPU.Sprite({ texture: whiteTex(255, 0, 0), x: 0, y: 0, width: 40, height: 40 });
  let swarm;
  try {
    swarm = new GPU.Swarm({
      capacity,
      shape: 'quad',
      behaviors: [
        GPU.behaviors.velocity(),
        GPU.behaviors.bounds({ x: 0, y: 0, width: 800, height: 600, mode: 'bounce' }),
      ],
    });
    renderer.stage.addChild(swarm);
    renderer.stage.addChild(marker);
    const t = performance.now();
    phase('spawn');
    swarm.spawn(capacity, { x: [0, 800], y: [0, 600], speed: [10, 60], angle: [0, 6.283], size: [1, 2], color: ['#66ccff', '#ff66cc'] });
    out.spawnFrontMs = +(performance.now() - t).toFixed(3);
  } catch (e) {
    out.frontError = errText(e);
  }
  if (!marker.parent) renderer.stage.addChild(marker);
  phase('warm frames');
  const warm = await frames(ctx, warmFrames);
  out.warm = warm;
  phase('measured frames');
  out.stats = await frames(ctx, frameCount);
  out.packetBytes = renderer.stats.packetBytes;
  out.activeCount = swarm?.activeCount;
  if (swarm) {
    try {
      const n = 16;
      phase('readback');
      out.aliveTail = await Promise.race([
        countAlive(swarm, capacity - n, n, ctx, readTimeoutMs),
        sleep(readTimeoutMs).then(() => 'timeout'),
      ]);
      phase('readback head');
      const th = performance.now();
      out.aliveHead = await Promise.race([countAlive(swarm, 0, n, ctx, readTimeoutMs), sleep(readTimeoutMs).then(() => 'timeout')]);
      out.readHeadMs = +(performance.now() - th).toFixed(0);
      out.readN = n;
    } catch (e) {
      out.readError = errText(e);
    }
  }
  out.rendererDestroyed = renderer.destroyed;
  phase('done');
  ctx.swarm = swarm;
  out.ctxId = registerCtx(ctx);
  return out;
}

const ctxs = new Map();
let nextCtx = 1;
function registerCtx(ctx) {
  const id = nextCtx++;
  ctxs.set(id, ctx);
  return id;
}
function getCtx(id) {
  return ctxs.get(id);
}
function dropCtx(id) {
  const ctx = ctxs.get(id);
  if (!ctx) return;
  ctxs.delete(id);
  try {
    destroyCtx(ctx);
  } catch (e) {
    return errText(e);
  }
}
/** Destroys the context's swarm and renders a few frames (does the renderer recover?). */
async function removeSwarm(id) {
  const ctx = getCtx(id);
  if (ctx.swarm) {
    ctx.swarm.destroy();
    ctx.swarm = null;
  }
  await frames(ctx, 30);
  return ctx.renderer.destroyed;
}

function canvasRect(id) {
  const r = getCtx(id).canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Spawn bursts for `seconds`: bursts, kills, clears, behavior swaps, param spam. */
async function spawnBurst({ worker, backend, seconds, capacity = 1_000_000 }) {
  const ctx = await createCtx({ worker, backend, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const out = { worker, seconds, capacity };
  const base = [
    GPU.behaviors.velocity(),
    GPU.behaviors.acceleration({ name: 'gravity', y: 200 }),
    GPU.behaviors.attractor({ x: 400, y: 300, strength: 50, radius: 300 }),
    GPU.behaviors.bounds({ x: 0, y: 0, width: 800, height: 600, mode: 'kill' }),
  ];
  const alt = [
    GPU.behaviors.velocity(),
    GPU.behaviors.drag({ k: 0.5 }),
    GPU.behaviors.attractor({ x: 400, y: 300, strength: -80, radius: 200 }),
    GPU.behaviors.bounds({ x: 0, y: 0, width: 800, height: 600, mode: 'wrap' }),
  ];
  const swarm = new GPU.Swarm({ capacity, blendMode: 'add', shape: 'circle', render: { fadeOut: true, shrink: true }, behaviors: base });
  const manual = new GPU.Swarm({ capacity: 50_000, allocation: 'manual', behaviors: [GPU.behaviors.velocity()] });
  renderer.stage.addChild(swarm);
  renderer.stage.addChild(manual);
  const held = [];
  let bursts = 0;
  let spawned = 0;
  let manualFull = 0;
  let swaps = 0;
  let clears = 0;
  let kills = 0;
  let throws = [];
  let maxActive = 0;
  let badActive = 0;
  const maxFrames = Math.ceil(seconds * 240);
  const times = new Float64Array(maxFrames);
  const cpu = new Float64Array(maxFrames);
  let n = 0;
  const end = performance.now() + seconds * 1000;
  let last = performance.now();
  let useAlt = false;
  let nextSwap = performance.now() + 7000;
  let nextClear = performance.now() + 11000;
  while (performance.now() < end && n < maxFrames) {
    try {
      const k = (Math.random() * 20000) | 0;
      swarm.spawn(k + 1, { disc: { x: 400 + Math.random() * 200 - 100, y: 300, radius: 40 }, speed: [50, 400], angle: [0, 6.283], life: [0.2, 1.5], size: [1, 4], color: ['#ffaa00', '#ff0044'] });
      spawned += k + 1;
      if (n % 60 === 0) {
        swarm.spawn(capacity, { x: [0, 800], y: [0, 600], life: [0.1, 0.8], size: 1 });
        spawned += capacity;
        bursts++;
      }
      if (n % 97 === 0) {
        swarm.kill((Math.random() * capacity) | 0, (Math.random() * 100000) | 0);
        kills++;
      }
      // manual allocator churn: fill until full, then free
      const first = manual.spawn(1000, { x: [0, 800], y: [0, 600], vx: [-20, 20], vy: [-20, 20] });
      if (first < 0) {
        manualFull++;
        for (let i = 0; i < 10 && held.length; i++) {
          const j = (Math.random() * held.length) | 0;
          manual.kill(held[j], 1000);
          held[j] = held[held.length - 1];
          held.pop();
        }
      } else held.push(first);
      swarm.behavior('attractor').set('point', [Math.random() * 800, Math.random() * 600]);
      if (performance.now() > nextSwap) {
        useAlt = !useAlt;
        swarm.setBehaviors(useAlt ? alt : base);
        swaps++;
        nextSwap += 7000;
      }
      if (performance.now() > nextClear) {
        swarm.clear();
        clears++;
        nextClear += 11000;
      }
      renderer.render();
      const a = swarm.activeCount;
      if (a > maxActive) maxActive = a;
      if (a > capacity || a < 0) badActive++;
    } catch (e) {
      if (throws.length < 10) throws.push(errText(e));
    }
    cpu[n] = renderer.stats.cpuMs;
    await raf();
    const now = performance.now();
    times[n++] = now - last;
    last = now;
  }
  Object.assign(out, {
    stats: summarize(times.subarray(0, n), cpu.subarray(0, n)),
    bursts,
    spawned,
    kills,
    swaps,
    clears,
    manualFull,
    maxActive,
    badActive,
    throws,
    skippedFrames: renderer.stats.skippedFrames,
    lastPacketBytes: renderer.stats.packetBytes,
  });
  // after the storm: still simulating? spawn a known immortal block and read it back
  swarm.setBehaviors([GPU.behaviors.velocity()]);
  swarm.clear();
  swarm.spawn(1000, { x: [100, 200], y: [100, 200], size: 4 });
  await frames(ctx, 60);
  try {
    out.postAlive = await Promise.race([countAlive(swarm, 0, 1000, ctx), sleep(8000).then(() => 'timeout')]);
  } catch (e) {
    out.postReadError = errText(e);
  }
  out.ctxId = registerCtx(ctx);
  return out;
}

/**
 * 200k sprites with constant add/remove.
 *  atlas: all sprites share one texture source (sub-frames), one blend mode:
 *         the realistic, batch-friendly case.
 *  mixed: 3 textures + 2 blend modes interleaved in random tree order: the
 *         batching worst case (draw calls ≈ sprite count).
 * Removal takes a contiguous run (removeChildren) plus `singles` random
 * removeChild() calls; additions go to the end plus some addChildAt().
 */
async function spriteChurn({ worker, backend, seconds, count = 200_000, churn = 2000, singles = 20, variant = 'atlas' }) {
  const ctx = await createCtx({ worker, backend, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const atlasPx = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < atlasPx.length; i += 4) {
    atlasPx[i] = 255;
    atlasPx[i + 1] = (i / 4) % 16 < 8 ? 255 : 80;
    atlasPx[i + 2] = 80;
    atlasPx[i + 3] = 255;
  }
  const atlas = GPU.Texture.fromPixels(16, 16, atlasPx);
  const frames3 =
    variant === 'atlas'
      ? [atlas.sub(0, 0, 8, 8), atlas.sub(8, 0, 8, 8), atlas.sub(0, 8, 8, 8)]
      : [whiteTex(255, 255, 255), whiteTex(255, 80, 80), whiteTex(80, 255, 80)];
  const world = new GPU.Container();
  renderer.stage.addChild(world);
  const make = i =>
    new GPU.Sprite({
      texture: frames3[i % 3],
      x: Math.random() * 800,
      y: Math.random() * 600,
      width: 2,
      height: 2,
      blendMode: variant === 'mixed' && i % 7 === 0 ? 'add' : 'normal',
    });
  let t = performance.now();
  for (let i = 0; i < count; i++) world.addChild(make(i));
  const out = { worker, variant, count, churn, singles, seconds, buildMs: +(performance.now() - t).toFixed(1) };
  t = performance.now();
  renderer.render();
  out.firstRenderMs = +(performance.now() - t).toFixed(1);
  await raf();
  const maxFrames = Math.ceil(seconds * 240);
  const times = new Float64Array(maxFrames);
  const cpu = new Float64Array(maxFrames);
  const removeMs = new Float64Array(maxFrames);
  const addMs = new Float64Array(maxFrames);
  let n = 0;
  let added = 0;
  let removed = 0;
  let maxDraw = 0;
  const throws = [];
  const end = performance.now() + seconds * 1000;
  let last = performance.now();
  while (performance.now() < end && n < maxFrames) {
    try {
      let c0 = performance.now();
      const kids = world.children;
      const start = (Math.random() * (kids.length - churn)) | 0;
      const run = world.removeChildren(start, start + churn - singles);
      for (let i = 0; i < run.length; i++) run[i].destroy();
      removed += run.length;
      for (let i = 0; i < singles; i++) {
        const s = kids[(Math.random() * kids.length) | 0];
        world.removeChild(s);
        s.destroy();
        removed++;
      }
      removeMs[n] = performance.now() - c0;
      c0 = performance.now();
      for (let i = 0; i < churn; i++) {
        const s = make(added);
        if (i < singles) world.addChildAt(s, (Math.random() * world.children.length) | 0);
        else world.addChild(s);
        added++;
      }
      for (let i = 0; i < 10000; i++) {
        const s = kids[(Math.random() * kids.length) | 0];
        s.x = Math.random() * 800;
      }
      addMs[n] = performance.now() - c0;
    } catch (e) {
      if (throws.length < 10) throws.push(errText(e));
    }
    try {
      renderer.render();
    } catch (e) {
      if (throws.length < 10) throws.push(errText(e));
    }
    cpu[n] = renderer.stats.cpuMs;
    if (renderer.stats.drawCalls > maxDraw) maxDraw = renderer.stats.drawCalls;
    await raf();
    const now = performance.now();
    times[n++] = now - last;
    last = now;
  }
  const avg = a => +(a.subarray(0, n).reduce((x, y) => x + y, 0) / Math.max(1, n)).toFixed(2);
  Object.assign(out, {
    stats: summarize(times.subarray(0, n), cpu.subarray(0, n)),
    removeMsAvg: avg(removeMs),
    addMsAvg: avg(addMs),
    added,
    removed,
    finalChildren: world.children.length,
    drawCalls: renderer.stats.drawCalls,
    maxDrawCalls: maxDraw,
    skippedFrames: renderer.stats.skippedFrames,
    throws,
    // A GL/GPU context loss mid-run (e.g. ANGLE out of memory) must not pass silently.
    lost: ctx.events.lost.length,
    restored: ctx.events.restored,
  });
  await frames(ctx, 10);
  out.ctxId = registerCtx(ctx);
  return out;
}

/** Keeps a scene (sprites + swarm) rendering on rAF for DPR / resize / loss tests. */
async function liveScene({ worker, backend, debug = false, cssW = 640, cssH = 480, swarmCount = 100_000, autoResize }) {
  const ctx = await createCtx({ worker, backend, debug, cssW, cssH, autoResize });
  const { renderer } = ctx;
  const tex = whiteTex(255, 255, 255);
  const grid = new GPU.Container();
  renderer.stage.addChild(grid);
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      grid.addChild(new GPU.Sprite({ texture: tex, x: 20 + x * 8, y: 20 + y * 8, width: 5, height: 5, tint: 0xffcc66 }));
    }
  }
  const restoreCalls = { n: 0 };
  let swarm = null;
  if (swarmCount > 0 && swarmSupported(renderer, swarmCount)) {
    const spawnAll = s => s.spawn(swarmCount, { x: [440, 620], y: [20, 460], size: 2, color: '#66ccff' });
    swarm = new GPU.Swarm({
      capacity: swarmCount,
      behaviors: [GPU.behaviors.velocity()],
      onRestore: s => {
        restoreCalls.n++;
        spawnAll(s);
      },
    });
    renderer.stage.addChild(swarm);
    spawnAll(swarm);
  }
  ctx.swarm = swarm;
  ctx.tex = tex;
  ctx.restoreCalls = restoreCalls;
  startLoop(ctx);
  await sleep(500);
  return { ctxId: registerCtx(ctx), create: ctx.createMs };
}

function liveState(id) {
  const ctx = getCtx(id);
  const r = ctx.renderer;
  return {
    width: r.width,
    height: r.height,
    resolution: r.resolution,
    destroyed: r.destroyed,
    dpr: devicePixelRatio,
    clientWidth: ctx.canvas.clientWidth,
    clientHeight: ctx.canvas.clientHeight,
    canvasWidth: r.info.worker ? null : ctx.canvas.width,
    canvasHeight: r.info.worker ? null : ctx.canvas.height,
    frameId: r.stats.frameId,
    skippedFrames: r.stats.skippedFrames,
    loopFrames: ctx.loop?.frames ?? null,
    loopThrows: ctx.loop?.throws ?? [],
    lost: ctx.events.lost,
    restored: ctx.events.restored,
    onRestoreCalls: ctx.restoreCalls?.n ?? 0,
    swarmActive: ctx.swarm?.activeCount ?? null,
    gpu: gpuErrorSnapshot(),
    aliveDevices: aliveDevices(),
    devices: S.devices.length,
  };
}

async function readSwarmAlive(id, n = 64) {
  const ctx = getCtx(id);
  if (!ctx.swarm) return null;
  try {
    return await Promise.race([countAlive(ctx.swarm, 0, n, ctx), sleep(8000).then(() => 'timeout')]);
  } catch (e) {
    return `error: ${errText(e)}`;
  }
}

/** Resize storm: random CSS sizes (0, 1px, huge) every frame, then settle. */
async function resizeStorm(id, { steps = 600, manual = false }) {
  const ctx = getCtx(id);
  const { renderer, canvas } = ctx;
  stopLoop(ctx);
  const throws = [];
  let huge = 0;
  let zero = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    let w;
    let h;
    const r = Math.random();
    if (r < 0.05) {
      w = 0;
      h = (Math.random() * 600) | 0;
      zero++;
    } else if (r < 0.08) {
      w = 1;
      h = 1;
    } else if (r < 0.11) {
      w = 5000 + ((Math.random() * 4000) | 0);
      h = 5000;
      huge++;
    } else {
      w = 1 + Math.random() * 1400;
      h = 1 + Math.random() * 900;
    }
    try {
      if (manual) renderer.resize(w, h);
      else {
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      renderer.render();
    } catch (e) {
      if (throws.length < 10) throws.push(errText(e));
    }
    if (i % 3 === 0) await raf();
  }
  const stormMs = performance.now() - t0;
  // settle
  if (manual) renderer.resize(640, 480);
  else {
    canvas.style.width = '640px';
    canvas.style.height = '480px';
  }
  await raf();
  await raf();
  await frames(ctx, 30);
  startLoop(ctx);
  await sleep(300);
  return { steps, manual, huge, zero, throws, stormMs: +stormMs.toFixed(0), state: liveState(id) };
}

/** create → use → destroy, once. Returns counters; heap is measured from Node. */
async function recreateCycle({ worker, backend, reuseCanvasId = null, sprites = 20_000, swarmCount = 200_000 }) {
  let canvas = null;
  if (reuseCanvasId != null) canvas = reusedCanvases.get(reuseCanvasId) ?? null;
  const ctx = await createCtx({ worker, backend, canvas: canvas ?? undefined, cssW: 640, cssH: 480 });
  const { renderer } = ctx;
  const tex = GPU.Texture.fromPixels(64, 64, new Uint8Array(64 * 64 * 4).fill(200));
  const c = new GPU.Container();
  renderer.stage.addChild(c);
  for (let i = 0; i < sprites; i++) c.addChild(new GPU.Sprite({ texture: tex, x: (i * 7) % 640, y: (i * 13) % 480, width: 3, height: 3 }));
  const swarm = new GPU.Swarm({ capacity: swarmCount, behaviors: [GPU.behaviors.velocity()] });
  renderer.stage.addChild(swarm);
  swarm.spawn(swarmCount, { x: [0, 640], y: [0, 480], speed: [5, 20], angle: [0, 6.28] });
  const st = await frames(ctx, 30);
  let alive;
  try {
    alive = await Promise.race([countAlive(swarm, 0, 32, ctx), sleep(8000).then(() => 'timeout')]);
  } catch (e) {
    alive = `error: ${errText(e)}`;
  }
  // readback pending at destroy must reject, not hang
  const pending = swarm.readHot(0, 4).then(
    () => 'resolved',
    e => `rejected ${e?.code ?? ''}`,
  );
  let destroyThrow = null;
  try {
    renderer.destroy();
    renderer.render(); // no-op after destroy
    swarm.destroy();
    tex.destroy();
  } catch (e) {
    destroyThrow = errText(e);
  }
  const pendingResult = await Promise.race([pending, sleep(3000).then(() => 'hang')]);
  if (reuseCanvasId != null) reusedCanvases.set(reuseCanvasId, ctx.canvas);
  else ctx.canvas.remove();
  await sleep(worker ? 700 : 50);
  return { fps: st.fps, createMs: +ctx.createMs.toFixed(1), alive, pendingResult, destroyThrow, aliveDevices: aliveDevices(), devices: S.devices.length };
}
const reusedCanvases = new Map();

/** Raw GPUDevice.destroy() on the renderer's device (main-thread mode only). */
async function rawDeviceDestroy(id) {
  const ctx = getCtx(id);
  const rec = [...S.devices].reverse().find(d => !d.destroyed && !d.lost && d.ref.deref());
  if (!rec) return { error: 'no live device' };
  const lostBefore = ctx.events.lost.length;
  rec.ref.deref().destroy();
  await sleep(1500);
  // Is the canvas still live? Flip the background to red and look.
  ctx.renderer.background = 0xff0000;
  await sleep(300);
  const alive = await readSwarmAlive(id, 8);
  const st = liveState(id);
  return { ...st, lostDelta: st.lost.length - lostBefore, readback: alive };
}

/**
 * Loses the device again as soon as restore() installs a new one (lostAgain
 * path, ARCHITECTURE §9.1). Runs in the realm that owns the core.
 */
const doubleLossSource = `(async () => {
  const core = globalThis.__COZYGPU_CORE__;
  const S = globalThis.__stress;
  if (!core) return 'no __COZYGPU_CORE__';
  const n = S.devices.length;
  // WebGL2 creates no GPUDevice: its restore() is done when \`lost\` clears.
  const gl = !!core.backend.gl;
  const restored = () => (gl ? core.backend.lost === false : S.devices.length !== n);
  core.backend.simulateDeviceLoss();
  const end = performance.now() + 5000;
  if (gl) while (core.backend.lost !== true && performance.now() < end) await new Promise(r => setTimeout(r, 0));
  while (!restored() && performance.now() < end) await new Promise(r => setTimeout(r, 0));
  if (!restored()) return gl ? 'webgl2 restore never finished' : 'restore never created a device';
  await Promise.resolve();
  core.backend.simulateDeviceLoss();
  return 'ok';
})()`;

/** Starts a readback that will be in flight when the device goes away. */
function startPendingReadback(id) {
  const ctx = getCtx(id);
  ctx.pendingRead = 'pending';
  if (!ctx.swarm) return;
  ctx.swarm.readHot(0, 4).then(
    () => (ctx.pendingRead = 'resolved'),
    e => (ctx.pendingRead = `rejected ${e?.code ?? ''}`),
  );
}

function simulateLossHere() {
  const core = globalThis.__COZYGPU_CORE__;
  if (!core) return 'no __COZYGPU_CORE__ (debug off?)';
  core.backend.simulateDeviceLoss();
  return 'ok';
}

async function analyzePng(b64, bg = [0, 0, 0]) {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const g = oc.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  let lit = 0;
  let blue = 0;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
    if (diff > 60) lit++;
    if (d[i + 2] > 150 && d[i] < 160) blue++;
    if (d[i] > 150 && d[i + 1] < 100) red++;
  }
  return { w: bmp.width, h: bmp.height, lit, litRatio: +(lit / (bmp.width * bmp.height)).toFixed(4), blue, red };
}

// ─── Regression checks for fixed bugs (pixel-level) ─────────────────────────

/** Renders a few frames so the (possibly worker-side) core has presented. */
async function settle(ctx, n = 6) {
  for (let i = 0; i < n; i++) {
    ctx.renderer.render();
    await raf();
  }
}

/**
 * Step-driven so the Node side can screenshot between steps.
 * step 'init'      : 8 red sprites in a row (x = 20 + 70·i, y = 20, 50×50)
 * step 'tail'      : hide sprites 4..7, render, recolor all green, show 4..7
 *                    (stale tail bytes after the instance list shrank)
 * step 'odd'       : hide odd sprites
 * step 'texreuse'  : destroy a red texture + its sprite, create a green texture
 *                    (likely the same id) and a sprite in the same place (y = 120)
 * step 'reassign'  : a sprite that held a destroyed texture gets the new one (y = 200)
 * step 'readd'     : red over green at y = 280; addChild(green) again → green on top
 */
async function regressStep(o) {
  const out = { throws: [] };
  const tryit = (label, f) => {
    try {
      return f();
    } catch (e) {
      out.throws.push(`${label}: ${errText(e)}`);
    }
  };
  if (o.step === 'init') {
    const ctx = await createCtx({ worker: o.worker, backend: o.backend, cssW: 640, cssH: 480 });
    const white = whiteTex();
    const row = new GPU.Container();
    ctx.renderer.stage.addChild(row);
    const sprites = [];
    for (let i = 0; i < 8; i++) {
      const s = new GPU.Sprite({ texture: white, x: 20 + 70 * i, y: 20, width: 50, height: 50, tint: 0xff0000 });
      row.addChild(s);
      sprites.push(s);
    }
    ctx.reg = { white, row, sprites };
    await settle(ctx);
    out.ctxId = registerCtx(ctx);
    return out;
  }
  const ctx = getCtx(o.ctxId);
  const R = ctx.reg;
  if (o.step === 'tail') {
    for (let i = 4; i < 8; i++) R.sprites[i].visible = false;
    await settle(ctx, 3);
    for (let i = 0; i < 8; i++) R.sprites[i].tint = 0x00ff00;
    await settle(ctx, 2);
    for (let i = 4; i < 8; i++) R.sprites[i].visible = true;
    await settle(ctx);
  } else if (o.step === 'odd') {
    for (let i = 1; i < 8; i += 2) R.sprites[i].visible = false;
    await settle(ctx);
  } else if (o.step === 'texreuse') {
    const red = GPU.Texture.fromPixels(1, 1, new Uint8Array([255, 0, 0, 255]));
    const a = new GPU.Sprite({ texture: red, x: 20, y: 120, width: 50, height: 50 });
    ctx.renderer.stage.addChild(a);
    // Keeps the old sprite around too (holds the destroyed texture) for 'reassign'.
    const stale = new GPU.Sprite({ texture: red, x: 20, y: 200, width: 50, height: 50 });
    ctx.renderer.stage.addChild(stale);
    await settle(ctx);
    tryit('destroy texture', () => {
      a.destroy();
      red.destroy();
    });
    await settle(ctx);
    const green = GPU.Texture.fromPixels(1, 1, new Uint8Array([0, 255, 0, 255]));
    const b = new GPU.Sprite({ texture: green, x: 20, y: 120, width: 50, height: 50 });
    tryit('add after destroy', () => ctx.renderer.stage.addChild(b));
    R.green = green;
    R.stale = stale;
    await settle(ctx);
  } else if (o.step === 'reassign') {
    tryit('reassign', () => (R.stale.texture = R.green));
    await settle(ctx);
  } else if (o.step === 'readd') {
    const red = new GPU.Sprite({ texture: R.white, x: 20, y: 280, width: 50, height: 50, tint: 0xff0000 });
    const green = new GPU.Sprite({ texture: R.white, x: 20, y: 280, width: 50, height: 50, tint: 0x00ff00 });
    const c = new GPU.Container();
    ctx.renderer.stage.addChild(c);
    c.addChild(green);
    c.addChild(red);
    await settle(ctx);
    tryit('addChild(existing child)', () => c.addChild(green));
    out.childCount = c.children.length;
    out.lastIsGreen = c.children[c.children.length - 1] === green;
    await settle(ctx);
  }
  return out;
}

/** RGB at CSS-pixel points (canvas-relative) of a canvas screenshot. */
async function samplePng(b64, pts) {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const g = oc.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  return pts.map(([x, y]) => {
    const i = (Math.round(y) * bmp.width + Math.round(x)) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  });
}


// ═══ M2 scenarios ═══════════════════════════════════════════════════════════

// ─── Assets (ARCHITECTURE §15) ──────────────────────────────────────────────

const statsOf = a => {
  const s = a.stats;
  return {
    entries: s.entries,
    referenced: s.referenced,
    inFlight: s.inFlight,
    queued: s.queued,
    gpuMB: +(s.gpuBytes / 1048576).toFixed(2),
    budgetMB: +(s.gpuBudgetBytes / 1048576).toFixed(1),
    atlasPages: s.atlasPages,
    evictions: s.evictions,
  };
};

/** Renderer + asset manager. Files are served from /files/ by the harness. */
async function assetsInit({ worker, backend, budgetMB = 8, atlas = true, debug = false, concurrency = 6 }) {
  const base = new URL('/files/', location.href).href;
  const ctx = await createCtx({
    worker,
    backend,
    debug,
    cssW: 800,
    cssH: 600,
    assets: { baseUrl: base, gpuBudgetMB: budgetMB, atlas: atlas ? undefined : false, concurrency },
  });
  ctx.assets = ctx.renderer.assets;
  ctx.assetsBase = base;
  ctx.held = [];
  startLoop(ctx);
  await sleep(200);
  return { ctxId: registerCtx(ctx), backend: ctx.renderer.info.backend, stats: statsOf(ctx.assets) };
}

/** Bundle of `count` small icons + one JSON, with progress. First 8 are drawn. */
async function assetsBundle(id, { count = 32 }) {
  const ctx = getCtx(id);
  const a = ctx.assets;
  const entries = { level: 'data.json' };
  for (let i = 0; i < count; i++) entries[`icon${i}`] = `icon-${i}.png`;
  const out = { count, progress: [], throws: [] };
  try {
    a.addBundle('ui', entries);
  } catch (e) {
    out.throws.push(errText(e));
  }
  const t0 = performance.now();
  let bundle = null;
  try {
    bundle = await a.loadBundle('ui', {
      onProgress: p => out.progress.push([p.loaded, p.total, +p.ratio.toFixed(3)]),
    });
  } catch (e) {
    out.error = errText(e);
  }
  out.ms = +(performance.now() - t0).toFixed(0);
  if (!bundle) return out;
  ctx.bundle = bundle;
  let packed = 0;
  for (let i = 0; i < count; i++) {
    const asset = bundle.get(`icon${i}`).value;
    if (asset.packed) packed++;
    if (i < 8) {
      ctx.renderer.stage.addChild(
        new GPU.Sprite({ texture: asset.texture, x: 20 + i * 40, y: 20, width: 32, height: 32 }),
      );
    }
  }
  const lvl = bundle.get('level').value;
  Object.assign(out, {
    packed,
    handles: bundle.handles.length,
    levelOk: !!lvl && lvl.hello === 'cozygpu' && Array.isArray(lvl.spawns),
    monotonic: out.progress.every((p, i) => i === 0 || p[0] >= out.progress[i - 1][0]),
    lastRatio: out.progress.length ? out.progress[out.progress.length - 1][2] : null,
    lastLoaded: out.progress.length ? out.progress[out.progress.length - 1][0] : null,
    total: out.progress.length ? out.progress[out.progress.length - 1][1] : null,
    drawCalls: ctx.renderer.stats.drawCalls,
    stats: statsOf(a),
  });
  await sleep(250);
  out.drawCalls = ctx.renderer.stats.drawCalls;
  return out;
}

/**
 * Loads `count` 512² textures one at a time, holding only the last `hold`.
 * With a small gpuBudgetMB this must evict the released ones (LRU).
 */
async function assetsBudgetChurn(id, { count = 24, hold = 2 }) {
  const ctx = getCtx(id);
  const a = ctx.assets;
  const out = { count, loaded: 0, errors: [], maxGpuMB: 0, samples: [] };
  if (!ctx.bigSprite) {
    ctx.bigSprite = new GPU.Sprite({ x: 620, y: 380, width: 160, height: 160 });
    ctx.renderer.stage.addChild(ctx.bigSprite);
  }
  const recent = [];
  for (let i = 0; i < count; i++) {
    try {
      const h = await a.load(`big-${i}.png`);
      out.loaded++;
      ctx.bigSprite.texture = h.value.texture;
      recent.push(h);
      while (recent.length > hold) recent.shift().release();
      const s = a.stats;
      const gpuMB = +(s.gpuBytes / 1048576).toFixed(2);
      if (gpuMB > out.maxGpuMB) out.maxGpuMB = gpuMB;
      out.samples.push([i, gpuMB, s.evictions, s.entries]);
      if (i === 0) out.firstFormat = h.value.format;
    } catch (e) {
      if (out.errors.length < 5) out.errors.push(errText(e));
    }
    await sleep(25);
  }
  while (recent.length) recent.shift().release();
  await sleep(200);
  out.stats = statsOf(a);
  out.stillCached0 = a.has(new URL('big-0.png', ctx.assetsBase).href);
  out.loopThrows = ctx.loop?.throws ?? [];
  return out;
}

/** Re-loads an evicted texture; the Node side pixel-checks the reloaded colour. */
async function assetsReload(id, { index = 0 }) {
  const ctx = getCtx(id);
  const a = ctx.assets;
  const key = new URL(`big-${index}.png`, ctx.assetsBase).href;
  const before = { cached: a.has(key), stats: statsOf(a) };
  const t0 = performance.now();
  let out = { before, index };
  try {
    const h = await a.load(`big-${index}.png`);
    ctx.reloadHandle = h;
    if (!ctx.reloadSprite) {
      ctx.reloadSprite = new GPU.Sprite({ x: 20, y: 380, width: 160, height: 160 });
      ctx.renderer.stage.addChild(ctx.reloadSprite);
    }
    ctx.reloadSprite.texture = h.value.texture;
    out.ms = +(performance.now() - t0).toFixed(0);
    out.format = h.value.format;
    out.packed = h.value.packed;
    out.size = [h.value.width, h.value.height];
  } catch (e) {
    out.error = errText(e);
  }
  await sleep(300);
  out.stats = statsOf(a);
  return out;
}

/** Aborts a bundle of slow loads mid-flight. */
async function assetsAbort(id, { count = 6, delayMs = 900 }) {
  const ctx = getCtx(id);
  const a = ctx.assets;
  const ctrl = new AbortController();
  const srcs = [];
  for (let i = 0; i < count; i++) srcs.push(`big-${i}.png?delay=${delayMs}&v=abort${i}`);
  let outcome = 'pending';
  const p = a.loadAll(srcs, { signal: ctrl.signal }).then(
    hs => {
      outcome = 'resolved';
      for (const h of hs) h.release();
    },
    e => {
      outcome = (e && e.code) || errText(e);
    },
  );
  await sleep(Math.max(120, delayMs / 3));
  const during = statsOf(a);
  ctrl.abort();
  await Promise.race([p, sleep(delayMs * 3)]);
  const rightAfter = statsOf(a);
  await sleep(delayMs * 2 + 600);
  return {
    outcome,
    during,
    rightAfter,
    settled: statsOf(a),
    loopFrames: ctx.loop?.frames ?? null,
    loopThrows: ctx.loop?.throws ?? [],
  };
}

/** Device loss with referenced assets: they must reload from their URL. */
async function assetsLoss(id, { timeoutMs = 20000 } = {}) {
  const ctx = getCtx(id);
  const before = { lost: ctx.events.lost.length, restored: ctx.events.restored, stats: statsOf(ctx.assets) };
  const res = loseDevice(ctx);
  const end = performance.now() + timeoutMs;
  while (ctx.events.restored <= before.restored && performance.now() < end) await sleep(100);
  const restoredMs = +(timeoutMs - (end - performance.now())).toFixed(0);
  await sleep(3000); // asset reloads happen after deviceRestored
  return {
    trigger: res,
    restoredMs,
    lost: ctx.events.lost.length - before.lost,
    restored: ctx.events.restored - before.restored,
    before,
    after: statsOf(ctx.assets),
    frameId: ctx.renderer.stats.frameId,
    loopThrows: ctx.loop?.throws ?? [],
  };
}

/** Releases everything and destroys the manager (must not throw or leak). */
async function assetsTeardown(id) {
  const ctx = getCtx(id);
  const a = ctx.assets;
  const out = { throws: [] };
  try {
    ctx.reloadHandle?.release();
    ctx.bundle?.release();
    out.afterRelease = statsOf(a);
    a.trim(0);
    await sleep(200);
    out.afterTrim = statsOf(a);
    a.destroy();
    await sleep(200);
    out.afterDestroy = statsOf(a);
    ctx.renderer.render();
  } catch (e) {
    out.throws.push(errText(e));
  }
  out.loopThrows = ctx.loop?.throws ?? [];
  return out;
}

// ─── Picking under load (ARCHITECTURE §16) ──────────────────────────────────

/**
 * `count` background sprites plus known targets:
 *   id 0..5   : opaque 60×60 squares along y = 470
 *   id 100    : half-transparent sprite at (600,20)-(720,80); its right half
 *               has alpha 0 and must NOT be picked
 *   id 200/201: stacked pair at (300,150); 201 is on top
 *   id 300    : pickable = false; the sprite below it (301) must answer
 *   swarm     : `swarmCount` objects, five of them at known points
 */
async function pickScene({ worker, backend, count = 100_000, swarmCount = 0 }) {
  const ctx = await createCtx({ worker, backend, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const white = whiteTex();
  const halfPx = new Uint8Array(8);
  halfPx.set([255, 255, 255, 255], 0);
  halfPx.set([255, 255, 255, 0], 4);
  const half = GPU.Texture.fromPixels(2, 1, halfPx);
  const bg = new GPU.Container();
  renderer.stage.addChild(bg);
  for (let i = 0; i < count; i++) {
    bg.addChild(
      new GPU.Sprite({
        texture: white,
        x: (i * 37) % 780,
        y: 100 + ((i * 53) % 220),
        width: 2,
        height: 2,
        tint: 0x304050,
      }),
    );
  }
  const ids = new Map();
  ctx.pickIds = ids;
  const add = (node, id) => {
    renderer.stage.addChild(node);
    ids.set(node, id);
    return node;
  };
  for (let i = 0; i < 6; i++) {
    add(new GPU.Sprite({ texture: white, x: 40 + i * 120, y: 470, width: 60, height: 60, tint: 0xff8800 }), i);
  }
  add(new GPU.Sprite({ texture: half, x: 600, y: 20, width: 120, height: 60, tint: 0x66ff66 }), 100);
  add(new GPU.Sprite({ texture: white, x: 300, y: 150, width: 80, height: 80, tint: 0x8888ff }), 200);
  add(new GPU.Sprite({ texture: white, x: 300, y: 150, width: 80, height: 80, tint: 0xffff66 }), 201);
  const below = add(new GPU.Sprite({ texture: white, x: 460, y: 150, width: 80, height: 80, tint: 0x66ffff }), 301);
  const unpickable = add(new GPU.Sprite({ texture: white, x: 460, y: 150, width: 80, height: 80, tint: 0xff66ff }), 300);
  unpickable.pickable = false;
  const out = { count, backend: renderer.info.backend, worker, below: !!below, swarm: null };
  if (swarmCount > 0 && swarmSupported(renderer, swarmCount)) {
    const swarm = new GPU.Swarm({ capacity: swarmCount, shape: 'quad', behaviors: [GPU.behaviors.velocity()] });
    swarm.pickable = true;
    renderer.stage.addChild(swarm);
    ctx.swarm = swarm;
    // Slots 0..4: five motionless 40 px objects at known points.
    const pts = [
      [80, 250],
      [200, 250],
      [320, 250],
      [440, 250],
      [560, 250],
    ];
    for (let i = 0; i < pts.length; i++) {
      swarm.spawn(1, { x: pts[i][0], y: pts[i][1], size: 40, color: '#ff4444' });
    }
    // The rest: a tiny band away from every probe point (see the miss probe at
    // (760, 420) and the empty corner the Node side checks).
    if (swarmCount > pts.length) {
      swarm.spawn(swarmCount - pts.length, { x: [20, 700], y: [560, 590], size: 1, color: '#4444ff' });
    }
    out.swarm = { capacity: swarmCount, points: pts };
  }
  startLoop(ctx);
  await sleep(600);
  out.ctxId = registerCtx(ctx);
  return out;
}

function pickIdOf(ctx, node) {
  if (!node) return null;
  if (ctx.pickIds.has(node)) return ctx.pickIds.get(node);
  if (node === ctx.swarm) return 'swarm';
  return 'unknown';
}

/** One pick; reports how many frames it took to resolve. */
async function pickAt(id, x, y) {
  const ctx = getCtx(id);
  const t0 = performance.now();
  const f0 = ctx.renderer.stats.frameId;
  let hit;
  try {
    hit = await Promise.race([ctx.renderer.pick(x, y), sleep(10000).then(() => 'timeout')]);
  } catch (e) {
    return { error: errText(e) };
  }
  if (hit === 'timeout') return { timeout: true };
  return {
    got: pickIdOf(ctx, hit && hit.node),
    instance: hit ? hit.instance : null,
    at: hit ? [hit.x, hit.y] : null,
    ms: +(performance.now() - t0).toFixed(1),
    frames: ctx.renderer.stats.frameId - f0,
  };
}

/** Sequential picks. `points` = [[x, y, expectedId], …]. */
async function pickBatch(id, points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y, expect] = points[i];
    const r = await pickAt(id, x, y);
    out.push({ x, y, expect, ...r });
  }
  return out;
}

/** All picks issued in the same frame (queue behaviour). */
async function pickConcurrent(id, points) {
  const ctx = getCtx(id);
  const t0 = performance.now();
  const rs = await Promise.all(
    points.map(([x, y]) =>
      ctx.renderer.pick(x, y).then(
        hit => ({ x, y, got: pickIdOf(ctx, hit && hit.node), instance: hit ? hit.instance : null }),
        e => ({ x, y, error: errText(e) }),
      ),
    ),
  );
  return { ms: +(performance.now() - t0).toFixed(1), results: rs, loopThrows: ctx.loop?.throws ?? [] };
}

/**
 * Diagnostic: the same point picked as batches of 1..n picks issued in one
 * frame (the core renders at most PICK_SLOTS = 4 requests per packet).
 * Returns one row per batch size: the id each slot resolved to.
 */
async function pickDiag(id, x, y, maxBatch = 5, repeats = 3) {
  const ctx = getCtx(id);
  const out = { point: [x, y], single: [], batches: [] };
  for (let i = 0; i < repeats; i++) {
    const r = await pickAt(id, x, y);
    out.single.push(r.got === undefined ? r : r.got);
  }
  for (let n = 1; n <= maxBatch; n++) {
    const rs = await Promise.all(
      Array.from({ length: n }, () =>
        ctx.renderer.pick(x, y).then(
          hit => pickIdOf(ctx, hit && hit.node),
          e => errText(e),
        ),
      ),
    );
    out.batches.push({ n, got: rs });
  }
  // Distinct points in one frame, and the same points in reverse: every slot
  // must answer for its OWN coordinates.
  const distinct = [
    [70, 500, 0],
    [190, 500, 1],
    [310, 500, 2],
    [430, 500, 3],
  ];
  for (const order of ['forward', 'reverse']) {
    const pts = order === 'forward' ? distinct : distinct.slice().reverse();
    const got = await Promise.all(
      pts.map(([px, py]) =>
        ctx.renderer.pick(px, py).then(
          hit => pickIdOf(ctx, hit && hit.node),
          e => errText(e),
        ),
      ),
    );
    out[order] = { points: pts.map(p => p.slice(0, 2)), want: pts.map(p => p[2]), got };
  }
  return out;
}

/** A pick whose node is destroyed before it resolves must give null, not throw. */
async function pickDestroyedNode(id, x, y) {
  const ctx = getCtx(id);
  let target = null;
  for (const [node, nid] of ctx.pickIds) if (nid === 5) target = node;
  if (!target) return { error: 'no target 5' };
  const p = ctx.renderer.pick(x, y);
  target.destroy();
  try {
    const hit = await Promise.race([p, sleep(8000).then(() => 'timeout')]);
    if (hit === 'timeout') return { timeout: true };
    return { got: pickIdOf(ctx, hit && hit.node), destroyedTarget: true };
  } catch (e) {
    return { error: errText(e) };
  }
}

/** pick() after destroy() must reject, not hang. */
async function pickAfterDestroy(id, x, y) {
  const ctx = getCtx(id);
  stopLoop(ctx);
  ctx.renderer.destroy();
  try {
    const hit = await Promise.race([ctx.renderer.pick(x, y), sleep(4000).then(() => 'timeout')]);
    return { resolved: hit === 'timeout' ? 'timeout' : pickIdOf(ctx, hit && hit.node) };
  } catch (e) {
    return { rejected: (e && e.code) || errText(e) };
  }
}

// ─── Swarm allocation: 'gpu' free-list churn ────────────────────────────────

async function gpuAllocChurn({ worker, backend, seconds = 60, capacity = 200_000, perFrame = 3000 }) {
  const ctx = await createCtx({ worker, backend, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const out = {
    worker,
    backend: renderer.info.backend,
    capacity,
    seconds,
    throws: [],
    aliveSamples: [],
    aliveErrors: [],
    spawnReturns: [],
  };
  const marker = new GPU.Sprite({ texture: whiteTex(255, 0, 0), x: 0, y: 0, width: 40, height: 40 });
  let swarm = null;
  try {
    swarm = new GPU.Swarm({
      capacity,
      allocation: 'gpu',
      shape: 'circle',
      render: { fadeOut: true },
      behaviors: [
        GPU.behaviors.velocity(),
        GPU.behaviors.bounds({ x: 0, y: 0, width: 800, height: 600, mode: 'kill' }),
      ],
    });
    renderer.stage.addChild(swarm);
    ctx.swarm = swarm;
  } catch (e) {
    out.createError = errText(e);
  }
  renderer.stage.addChild(marker);
  const maxFrames = Math.ceil(seconds * 240);
  const times = new Float64Array(maxFrames);
  const cpu = new Float64Array(maxFrames);
  let n = 0;
  const t0 = performance.now();
  const end = t0 + seconds * 1000;
  let last = t0;
  let nextSample = t0 + 3000;
  let kills = 0;
  let overspawns = 0;
  while (performance.now() < end && n < maxFrames) {
    try {
      if (swarm) {
        const r = swarm.spawn(perFrame, {
          disc: { x: 400, y: 300, radius: 60 },
          speed: [60, 320],
          angle: [0, 6.283],
          life: [0.3, 1.6],
          size: [2, 5],
          color: ['#ffaa00', '#ff0044'],
        });
        if (out.spawnReturns.length < 5) out.spawnReturns.push(r);
        // Every ~2 s ask for far more than the capacity: must be dropped, not wrap.
        if (n % 120 === 60) {
          swarm.spawn(capacity * 2, { x: [0, 800], y: [0, 600], life: [0.2, 0.5], size: 1 });
          overspawns++;
        }
        if (n % 97 === 0) {
          swarm.kill((Math.random() * capacity) | 0, 5000);
          kills++;
        }
      }
      renderer.render();
    } catch (e) {
      if (out.throws.length < 10) out.throws.push(errText(e));
    }
    const now = performance.now();
    if (swarm && now > nextSample) {
      nextSample = now + 3000;
      const at = +((now - t0) / 1000).toFixed(1);
      const issued = now;
      swarm.aliveCount().then(
        v => out.aliveSamples.push([at, v, +(performance.now() - issued).toFixed(0)]),
        e => out.aliveErrors.push(errText(e)),
      );
    }
    cpu[n] = renderer.stats.cpuMs;
    await raf();
    const t = performance.now();
    times[n++] = t - last;
    last = t;
  }
  Object.assign(out, {
    stats: summarize(times.subarray(0, n), cpu.subarray(0, n)),
    kills,
    overspawns,
    packetBytes: renderer.stats.packetBytes,
    skippedFrames: renderer.stats.skippedFrames,
  });
  if (!swarm) {
    out.ctxId = registerCtx(ctx);
    return out;
  }
  // Drain: stop spawning and let every mortal object die.
  await frames(ctx, 180);
  try {
    out.aliveAfterDrain = await awaitWhileRendering(ctx, swarm.aliveCount(), 15000);
  } catch (e) {
    out.drainError = errText(e);
  }
  // The free list must hand the slots back: a fresh immortal block stays alive.
  swarm.setBehaviors([GPU.behaviors.velocity()]);
  swarm.spawn(10_000, { x: [100, 700], y: [100, 500], size: 3, color: '#66ccff' });
  await frames(ctx, 90);
  try {
    out.aliveAfterRespawn = await awaitWhileRendering(ctx, swarm.aliveCount(), 15000);
  } catch (e) {
    out.respawnError = errText(e);
  }
  swarm.clear();
  await frames(ctx, 60);
  try {
    out.aliveAfterClear = await awaitWhileRendering(ctx, swarm.aliveCount(), 15000);
  } catch (e) {
    out.clearError = errText(e);
  }
  out.ctxId = registerCtx(ctx);
  return out;
}

// ─── Worker command ring: wraparound, growth, backpressure (§17) ────────────

async function ringStress({ backend, ring = true, seconds = 10, big = 120_000 }) {
  const ctx = await createCtx({ worker: true, backend, ring, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const out = {
    backend: renderer.info.backend,
    ringRequested: ring,
    ringActive: renderer.transport ? !!renderer.transport.ring : null,
    sharedMemory: renderer.info.sharedMemory,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    throws: [],
    phases: {},
  };
  const white = whiteTex();
  const small = new GPU.Container();
  renderer.stage.addChild(small);
  for (let i = 0; i < 2000; i++) {
    small.addChild(
      new GPU.Sprite({ texture: white, x: (i * 13) % 780, y: 20 + ((i * 29) % 260), width: 3, height: 3, tint: 0x66ccff }),
    );
  }
  // A marker the Node side can look for after the storm.
  renderer.stage.addChild(new GPU.Sprite({ texture: whiteTex(255, 0, 0), x: 0, y: 560, width: 60, height: 40 }));

  const runFor = async (ms, mutate, burst = 1) => {
    const f0 = renderer.stats.frameId;
    const s0 = renderer.stats.skippedFrames;
    let calls = 0;
    const t0 = performance.now();
    let maxPacket = 0;
    while (performance.now() - t0 < ms) {
      try {
        if (mutate) mutate(calls);
        for (let b = 0; b < burst; b++) {
          renderer.render();
          calls++;
        }
        if (renderer.stats.packetBytes > maxPacket) maxPacket = renderer.stats.packetBytes;
      } catch (e) {
        if (out.throws.length < 10) out.throws.push(errText(e));
      }
      await sleep(0);
    }
    return {
      ms: +(performance.now() - t0).toFixed(0),
      calls,
      submitted: renderer.stats.frameId - f0,
      skipped: renderer.stats.skippedFrames - s0,
      maxPacketBytes: maxPacket,
      lastPacketBytes: renderer.stats.packetBytes,
    };
  };

  // 1. Wraparound: as many small packets as the ring will take.
  out.phases.wrap = await runFor(seconds * 1000);
  out.phases.wrap.ringActive = renderer.transport ? !!renderer.transport.ring : null;

  // 2. Growth: a COMMAND packet far larger than the 64 KiB ring slot. Sprite
  // data rides shared memory, so size comes from batch count: alternating blend
  // modes defeat batching and emit one draw command per sprite.
  const bigC = new GPU.Container();
  renderer.stage.addChild(bigC);
  for (let i = 0; i < big; i++) {
    bigC.addChild(
      new GPU.Sprite({
        texture: white,
        x: (i * 7) % 780,
        y: 300 + ((i * 11) % 240),
        width: 3,
        height: 3,
        tint: 0xffcc66,
        blendMode: i % 2 === 0 ? 'add' : 'normal',
      }),
    );
  }
  out.phases.grow = await runFor(4000, () => {
    const kids = bigC.children;
    for (let k = 0; k < 200; k++) {
      const s = kids[(Math.random() * kids.length) | 0];
      s.x = (s.x + 1) % 780;
    }
  });
  out.phases.grow.ringActive = renderer.transport ? !!renderer.transport.ring : null;

  // 3. Shrink back: small packets again, ring still in use.
  bigC.destroy();
  await sleep(200);
  out.phases.shrink = await runFor(3000);
  out.phases.shrink.ringActive = renderer.transport ? !!renderer.transport.ring : null;

  // 4. Backpressure: a heavy core (full-screen overdraw) plus render() spam.
  let swarm = null;
  if (swarmSupported(renderer, 400_000)) {
    swarm = new GPU.Swarm({
      capacity: 400_000,
      shape: 'circle',
      blendMode: 'add',
      behaviors: [GPU.behaviors.velocity(), GPU.behaviors.bounds({ x: 0, y: 0, width: 800, height: 600, mode: 'wrap' })],
    });
    renderer.stage.addChild(swarm);
    swarm.spawn(400_000, { x: [0, 800], y: [0, 600], speed: [5, 40], angle: [0, 6.283], size: [6, 12], color: '#ff66cc' });
  }
  // Backpressure: submit synchronously, far faster than the core can drain the
  // ring (2 slots) or the buffer pool. render() must skip, never block or throw.
  out.phases.pressure = await runFor(6000, null, 40);
  if (swarm) {
    swarm.destroy();
    swarm = null;
  }
  await sleep(300);
  // 5. Cool-down: the front must go back to submitting nearly every call.
  out.phases.cool = await runFor(3000);
  out.loopThrows = ctx.loop?.throws ?? [];
  out.frameId = renderer.stats.frameId;
  out.destroyed = renderer.destroyed;
  startLoop(ctx);
  await sleep(300);
  out.ctxId = registerCtx(ctx);
  return out;
}

// ─── Heap soak (worker + ring) ──────────────────────────────────────────────

/** Starts a steady animated scene on rAF; the Node side samples the heap. */
async function heapSoakStart({ worker = true, backend, ring = true, sprites = 20_000, swarmCount = 100_000 }) {
  const ctx = await createCtx({ worker, backend, ring, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const white = whiteTex();
  const world = new GPU.Container();
  renderer.stage.addChild(world);
  const kids = [];
  for (let i = 0; i < sprites; i++) {
    const s = new GPU.Sprite({
      texture: white,
      x: (i * 17) % 780,
      y: 20 + ((i * 31) % 540),
      width: 3,
      height: 3,
      tint: 0x66ccff,
    });
    world.addChild(s);
    kids.push(s);
  }
  let swarm = null;
  if (swarmCount > 0 && swarmSupported(renderer, swarmCount)) {
    swarm = new GPU.Swarm({
      capacity: swarmCount,
      behaviors: [GPU.behaviors.velocity(), GPU.behaviors.bounds({ x: 0, y: 0, width: 800, height: 600, mode: 'wrap' })],
    });
    renderer.stage.addChild(swarm);
    swarm.spawn(swarmCount, { x: [0, 800], y: [0, 600], speed: [10, 60], angle: [0, 6.283], size: 2, color: '#ff66cc' });
    ctx.swarm = swarm;
  }
  let t = 0;
  startLoop(ctx, () => {
    t += 0.016;
    for (let i = 0; i < 4000; i++) {
      const s = kids[(i * 7 + ((t * 60) | 0)) % kids.length];
      s.x = (s.x + 1) % 780;
      s.rotation = t;
    }
    world.rotation = Math.sin(t * 0.1) * 0.01;
  });
  await sleep(500);
  return {
    ctxId: registerCtx(ctx),
    ringActive: renderer.transport ? !!renderer.transport.ring : null,
    sharedMemory: renderer.info.sharedMemory,
    backend: renderer.info.backend,
  };
}

function soakState(id) {
  const ctx = getCtx(id);
  const r = ctx.renderer;
  return {
    frameId: r.stats.frameId,
    skipped: r.stats.skippedFrames,
    packetBytes: r.stats.packetBytes,
    drawCalls: r.stats.drawCalls,
    cpuMs: +r.stats.cpuMs.toFixed(3),
    loopFrames: ctx.loop?.frames ?? null,
    loopThrows: ctx.loop?.throws ?? [],
    lost: ctx.events.lost.length,
    restored: ctx.events.restored,
    destroyed: r.destroyed,
    jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null,
  };
}

// ─── WebGL2: external context loss (not through simulateDeviceLoss) ─────────

async function rawContextLose(id, { waitMs = 6000 } = {}) {
  const ctx = getCtx(id);
  const core = globalThis.__COZYGPU_CORE__;
  const gl = core && core.backend && core.backend.gl;
  if (!gl) return { error: 'no WebGL2 context on __COZYGPU_CORE__.backend' };
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return { error: 'no WEBGL_lose_context' };
  const before = { lost: ctx.events.lost.length, restored: ctx.events.restored, frameId: ctx.renderer.stats.frameId };
  ext.loseContext();
  const end = performance.now() + waitMs;
  while (ctx.events.restored <= before.restored && performance.now() < end) await sleep(100);
  await sleep(1500);
  const after = liveState(id);
  return {
    before,
    lostDelta: after.lost.length - before.lost,
    restoredDelta: after.restored - before.restored,
    frameDelta: after.frameId - before.frameId,
    loopThrows: after.loopThrows,
    destroyed: after.destroyed,
  };
}

globalThis.stress = {
  pickDiag,
  assetsInit,
  assetsBundle,
  assetsBudgetChurn,
  assetsReload,
  assetsAbort,
  assetsLoss,
  assetsTeardown,
  pickScene,
  pickAt,
  pickBatch,
  pickConcurrent,
  pickDestroyedNode,
  pickAfterDestroy,
  gpuAllocChurn,
  ringStress,
  heapSoakStart,
  soakState,
  rawContextLose,
  loseDevice: id => loseDevice(getCtx(id)),
  regressStep,
  samplePng,
  swarmCapacity,
  spawnBurst,
  spriteChurn,
  liveScene,
  liveState,
  readSwarmAlive,
  resizeStorm,
  recreateCycle,
  rawDeviceDestroy,
  simulateLossHere,
  startPendingReadback,
  pendingRead: id => getCtx(id).pendingRead,
  doubleLossSource,
  doubleLossHere: () => (0, eval)(doubleLossSource),
  nudgeCanvas: async (id, w, h) => {
    const c = getCtx(id).canvas;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    await raf();
    await raf();
  },
  analyzePng,
  canvasRect,
  removeSwarm,
  dropCtx,
  aliveDevices,
  gpuErrorSnapshot,
  resetGpuErrors: () => {
    S.gpuErrorCount = 0;
    S.gpuErrors.length = 0;
  },
  version: GPU.VERSION,
};
globalThis.__stressReady = true;
