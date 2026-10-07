// Browser side of tests/browser/stress.mjs. Bundled with esbuild ('cozygpu'
// aliased to src/index.ts) and driven through page.evaluate(). Every scenario
// returns plain JSON; the Node side decides pass/fail.
import * as GPU from 'cozygpu';
import { installGfx } from './stress-gfx.js';
import { installM3 } from './stress-m3.js';
import { installM5 } from './stress-m5.js';

const S = globalThis.__stress;
// Marks where the stress page's own code starts in the bundle (after the
// library), so heap profiles can tell library allocations from the driver's.
S.pageCodeMarker = '__stress_page_code_begins__';
// The page query (?nogpu=1 / ?noadapter=1, M2.5 fallback checks) is passed on
// to the worker so the build banner hides WebGPU there too.
const WORKER_URL = `/cozygpu.worker.js${location.search}`;
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
  // M2.5: an events sink that records every emit in order, interleaved with
  // the onDeviceLost / onDeviceRestored callbacks ('cb:*' entries).
  const log = opts.eventLog ?? null;
  const sink = opts.sink ?? (log ? { emit: (name, payload) => log.push({ name, payload, t: performance.now() }) } : undefined);
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
    retained: opts.retained,
    onDeviceLost: info => {
      events.lost.push(info);
      if (log) log.push({ name: 'cb:lost', payload: { willRestore: info.willRestore }, t: performance.now() });
    },
    onDeviceRestored: () => {
      events.restored++;
      if (log) log.push({ name: 'cb:restored', payload: null, t: performance.now() });
    },
    events: sink,
  });
  if (log) log.push({ name: '@resolved', payload: null, t: performance.now() });
  const ctx = {
    renderer,
    canvas,
    events,
    createMs: performance.now() - t0,
    loop: null,
    backend: renderer.info.backend,
    eventLog: log,
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

// ═══ M2.5 scenarios (ARCHITECTURE §19) ══════════════════════════════════════

/** Per-rect pixel counts of a canvas screenshot. rects: [[x, y, w, h], …] (CSS px). */
async function regionStats(b64, rects) {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const g = oc.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  return rects.map(([rx, ry, rw, rh]) => {
    let lit = 0;
    let blue = 0;
    let red = 0;
    const x1 = Math.min(bmp.width, rx + rw);
    const y1 = Math.min(bmp.height, ry + rh);
    for (let y = Math.max(0, ry); y < y1; y++) {
      for (let x = Math.max(0, rx); x < x1; x++) {
        const i = (y * bmp.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
        if (d[i + 2] > 150 && d[i] < 160) blue++;
        if (d[i] > 150 && d[i + 1] < 100) red++;
      }
    }
    return { lit, blue, red, area: rw * rh };
  });
}

const codeOf = e => (e && e.code) || errText(e);
/** Runs f; returns 'ok' or the thrown error code. */
function codeOfCall(f) {
  try {
    f();
    return 'ok';
  } catch (e) {
    return codeOf(e);
  }
}
async function codeOfAsync(p, ms = 8000) {
  try {
    const v = await Promise.race([p, sleep(ms).then(() => '__timeout')]);
    return v === '__timeout' ? 'timeout' : 'ok';
  } catch (e) {
    return codeOf(e);
  }
}

// ─── Columns world: plain typed arrays driving one container (§19.1) ───────

/**
 * Rows 0..3 are fixed "probe" rows (big, distinct tint and userId); rows 4..n
 * move every frame. Grow = new arrays + rebind (and a layout switch between
 * dense and interleaved x/y); shrink = swap-remove of random moving rows.
 */
const PROBES = [
  { x: 40, y: 530, tint: 0xff0000, user: 0xffffffff },
  { x: 240, y: 530, tint: 0x00ff00, user: 0x80000000 },
  { x: 440, y: 530, tint: 0x0000ff, user: 1 },
  { x: 640, y: 530, tint: 0xffff00, user: 0xdeadbeef },
];
const PROBE_PX = 30;

function makeWorld(cap, interleaved) {
  return {
    cap,
    n: 0,
    interleaved,
    xy: interleaved ? new Float32Array(cap * 2) : null,
    x: interleaved ? null : new Float32Array(cap),
    y: interleaved ? null : new Float32Array(cap),
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    rotation: new Float32Array(cap),
    scale: new Float32Array(cap),
    alpha: new Float32Array(cap),
    tint: new Uint32Array(cap),
    frame: new Uint32Array(cap),
    userId: new Uint32Array(cap),
    serial: 1_000_000,
  };
}
const wx = (w, i) => (w.interleaved ? w.xy[i * 2] : w.x[i]);
const wy = (w, i) => (w.interleaved ? w.xy[i * 2 + 1] : w.y[i]);
function wset(w, i, x, y) {
  if (w.interleaved) {
    w.xy[i * 2] = x;
    w.xy[i * 2 + 1] = y;
  } else {
    w.x[i] = x;
    w.y[i] = y;
  }
}
function worldColumns(w) {
  const pos = w.interleaved
    ? { x: { array: w.xy, offset: 0, stride: 2 }, y: { array: w.xy, offset: 1, stride: 2 } }
    : { x: w.x, y: w.y };
  return { ...pos, rotation: w.rotation, scaleX: w.scale, scaleY: w.scale, alpha: w.alpha, tint: w.tint, frame: w.frame, userId: w.userId };
}
function initRow(w, i) {
  if (i < PROBES.length) {
    const p = PROBES[i];
    wset(w, i, p.x, p.y);
    w.vx[i] = 0;
    w.vy[i] = 0;
    w.rotation[i] = 0;
    w.scale[i] = PROBE_PX; // the slot texture is a 1×1 frame: scale = px
    w.tint[i] = p.tint;
    w.userId[i] = p.user;
    w.frame[i] = i & 1;
  } else {
    wset(w, i, 10 + Math.random() * 770, 20 + Math.random() * 440);
    w.vx[i] = (Math.random() - 0.5) * 4;
    w.vy[i] = (Math.random() - 0.5) * 4;
    w.rotation[i] = Math.random() * 6.28;
    w.scale[i] = 2;
    w.tint[i] = 0x406080;
    w.userId[i] = w.serial++;
    w.frame[i] = i & 1;
  }
  w.alpha[i] = 1;
}
/** New arrays of `cap` rows (optionally switching the x/y layout), rows copied. */
function regrow(w, cap, interleaved) {
  const nw = makeWorld(cap, interleaved);
  nw.serial = w.serial;
  for (let i = 0; i < w.n; i++) wset(nw, i, wx(w, i), wy(w, i));
  nw.vx.set(w.vx.subarray(0, w.n));
  nw.vy.set(w.vy.subarray(0, w.n));
  nw.rotation.set(w.rotation.subarray(0, w.n));
  nw.scale.set(w.scale.subarray(0, w.n));
  nw.alpha.set(w.alpha.subarray(0, w.n));
  nw.tint.set(w.tint.subarray(0, w.n));
  nw.frame.set(w.frame.subarray(0, w.n));
  nw.userId.set(w.userId.subarray(0, w.n));
  nw.n = w.n;
  return nw;
}
function moveWorld(w) {
  const n = w.n;
  if (w.interleaved) {
    const xy = w.xy;
    for (let i = PROBES.length; i < n; i++) {
      let x = xy[i * 2] + w.vx[i];
      let y = xy[i * 2 + 1] + w.vy[i];
      if (x < 10 || x > 780) w.vx[i] = -w.vx[i];
      if (y < 20 || y > 470) w.vy[i] = -w.vy[i];
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
      w.rotation[i] += 0.02;
    }
  } else {
    const X = w.x;
    const Y = w.y;
    for (let i = PROBES.length; i < n; i++) {
      const x = X[i] + w.vx[i];
      const y = Y[i] + w.vy[i];
      if (x < 10 || x > 780) w.vx[i] = -w.vx[i];
      if (y < 20 || y > 470) w.vy[i] = -w.vy[i];
      X[i] = x;
      Y[i] = y;
      w.rotation[i] += 0.02;
    }
  }
}
function copyRow(w, from, to) {
  wset(w, to, wx(w, from), wy(w, from));
  w.vx[to] = w.vx[from];
  w.vy[to] = w.vy[from];
  w.rotation[to] = w.rotation[from];
  w.scale[to] = w.scale[from];
  w.alpha[to] = w.alpha[from];
  w.tint[to] = w.tint[from];
  w.frame[to] = w.frame[from];
  w.userId[to] = w.userId[from];
}

/** The columns scene: `count` slot sprites under one layer, bound once. */
function columnsLayer(ctx, count, { interleaved = false } = {}) {
  const px = new Uint8Array(8).fill(255);
  const atlas = GPU.Texture.fromPixels(2, 1, px);
  const frames = [atlas.sub(0, 0, 1, 1), atlas.sub(1, 0, 1, 1)];
  const layer = new GPU.Container();
  ctx.renderer.stage.addChild(layer);
  let w = makeWorld(count, interleaved);
  for (let i = 0; i < count; i++) initRow(w, i);
  w.n = count;
  for (let i = 0; i < count; i++) layer.addChild(new GPU.Sprite({ texture: frames[0], width: 2, height: 2 }));
  const binding = layer.bindColumns(worldColumns(w), { frames });
  const C = {
    layer,
    frames,
    binding,
    get w() {
      return w;
    },
    rebinds: 0,
    unbinds: 0,
    grows: 0,
    shrinks: 0,
    partials: 0,
    /** Last commit() duration, in a typed array (a double stored on an object allocates). */
    commitMs: new Float64Array(1),
    /** Adds k rows: new arrays (layout toggled), rebind, add children. */
    grow(k) {
      const nw = regrow(w, w.n + k, !w.interleaved);
      for (let i = w.n; i < w.n + k; i++) initRow(nw, i);
      nw.n = w.n + k;
      w = nw;
      binding.rebind(worldColumns(w), { frames });
      C.rebinds++;
      for (let i = layer.children.length; i < w.n; i++) layer.addChild(new GPU.Sprite({ texture: frames[0], width: 2, height: 2 }));
      C.grows++;
    },
    /** Swap-removes k random moving rows, then drops the last k children. */
    shrink(k) {
      const old = w.n;
      for (let j = 0; j < k && w.n > PROBES.length + 1; j++) {
        const row = PROBES.length + ((Math.random() * (w.n - PROBES.length)) | 0);
        copyRow(w, w.n - 1, row);
        w.n--;
      }
      const removed = layer.removeChildren(w.n, old);
      for (let i = 0; i < removed.length; i++) removed[i].destroy();
      C.shrinks++;
    },
    commit() {
      const t = performance.now();
      binding.commit(w.n);
      C.commitMs[0] = performance.now() - t;
    },
  };
  return C;
}

/** Validation paths of bindColumns / commit; ends with the proper binding restored. */
function columnsValidation(C) {
  const { layer, frames, binding } = C;
  const w = C.w;
  const n = w.n;
  const out = {};
  out.commitPastChildren = codeOfCall(() => binding.commit(n + 1));
  out.commitFirstPastChildren = codeOfCall(() => binding.commit(2, n - 1));
  out.strideZero = codeOfCall(() => layer.bindColumns({ x: w.vx, y: w.vy }, { stride: 0 }));
  out.frameWithoutFrames = codeOfCall(() => layer.bindColumns({ x: w.vx, y: w.vy, frame: w.frame }));
  out.wrongArrayType = codeOfCall(() => layer.bindColumns({ x: new Float64Array(n), y: w.vy }));
  const short = new Float32Array(n - 1);
  out.shortColumnBind = codeOfCall(() => layer.bindColumns({ x: short, y: w.vy }));
  out.shortColumnCommit = codeOfCall(() => layer.bindColumns({ x: short, y: w.vy }).commit(n));
  out.shortColumnCommitFits = codeOfCall(() => layer.bindColumns({ x: short, y: w.vy }).commit(n - 1));
  out.strided = codeOfCall(() => layer.bindColumns({ x: { array: new Float32Array(n * 3), offset: 2, stride: 3 }, y: w.vy }).commit(n));
  out.stridedShort = codeOfCall(() => layer.bindColumns({ x: { array: new Float32Array(n * 3 - 1), offset: 2, stride: 3 }, y: w.vy }).commit(n));
  out.sameObject = layer.bindColumns(worldColumns(w), { frames }) === binding;
  out.rebindOk = codeOfCall(() => binding.rebind(worldColumns(w), { frames }));
  out.commitOk = codeOfCall(() => binding.commit(n));
  out.fields = binding.fields;
  out.allFields = GPU.BulkField.POSITION | GPU.BulkField.ROTATION | GPU.BulkField.SCALE | GPU.BulkField.ALPHA | GPU.BulkField.TINT | GPU.BulkField.FRAME | GPU.BulkField.USER_ID;
  return out;
}

/**
 * 100k slot sprites driven by bindColumns for `seconds`: every frame a full
 * x/y/rotation/... commit; every `structEvery` frames a grow (new arrays,
 * rebind, layout toggle) or a swap-remove shrink; every 7th structural change
 * also unbind() + rebind of the same arrays; partial commits with first/fields.
 */
async function columnsChurn({ worker, backend, count = 100_000, seconds = 20, structEvery = 30, step = 5000 }) {
  const ctx = await createCtx({ worker, backend, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const C = columnsLayer(ctx, count);
  ctx.cols = C;
  const out = { worker, count, backend: renderer.info.backend };
  out.validation = columnsValidation(C);
  const maxFrames = Math.ceil(seconds * 240);
  const times = new Float64Array(maxFrames);
  const cpu = new Float64Array(maxFrames);
  const commit = new Float64Array(maxFrames);
  const throws = [];
  let minRows = count;
  let maxRows = count;
  let n = 0;
  let structural = 0;
  const end = performance.now() + seconds * 1000;
  let last = performance.now();
  while (performance.now() < end && n < maxFrames) {
    try {
      if (n > 0 && n % structEvery === 0) {
        structural++;
        if (structural % 2) C.grow(step);
        else C.shrink(step);
        if (structural % 7 === 0) {
          C.binding.unbind();
          C.unbinds++;
          C.binding.rebind(worldColumns(C.w), { frames: C.frames });
          C.rebinds++;
        }
        minRows = Math.min(minRows, C.w.n);
        maxRows = Math.max(maxRows, C.w.n);
      }
      moveWorld(C.w);
      C.commit();
      if (n % 50 === 25) {
        // Partial commit: only tints of the last 1000 rows.
        const k = Math.min(1000, C.w.n - PROBES.length);
        C.binding.commit(k, C.w.n - k, GPU.BulkField.TINT);
        C.partials++;
      }
      renderer.render();
    } catch (e) {
      if (throws.length < 10) throws.push(errText(e));
    }
    commit[n] = C.commitMs[0];
    cpu[n] = renderer.stats.cpuMs;
    await raf();
    const now = performance.now();
    times[n++] = now - last;
    last = now;
  }
  const cs = summarize(commit.subarray(0, n), commit.subarray(0, n));
  Object.assign(out, {
    stats: summarize(times.subarray(0, n), cpu.subarray(0, n)),
    commitMsAvg: cs.cpuMsAvg,
    commitMsP99: cs.cpuMsP99,
    throws,
    rows: C.w.n,
    children: C.layer.children.length,
    minRows,
    maxRows,
    rebinds: C.rebinds,
    unbinds: C.unbinds,
    grows: C.grows,
    shrinks: C.shrinks,
    partials: C.partials,
    interleavedNow: C.w.interleaved,
    drawCalls: renderer.stats.drawCalls,
  });
  out.ctxId = registerCtx(ctx);
  return out;
}

/**
 * Steady state: move + commit + render from a plain rAF callback (no promise
 * or closure per frame), timings into preallocated arrays, so the page's
 * own per-frame allocations are ~0 and a heap profile over this window shows
 * the library's. columnsSteadyStop() summarizes.
 */
function columnsSteadyStart(id) {
  const ctx = getCtx(id);
  const { renderer } = ctx;
  const C = ctx.cols;
  const cap = 1 << 16;
  const S2 = { times: new Float64Array(cap), cpu: new Float64Array(cap), commit: new Float64Array(cap), n: 0, last: new Float64Array(1), throws: [] };
  ctx.steady = S2;
  startLoop(ctx, () => {
    const i = S2.n;
    if (i < cap) {
      const now = performance.now();
      S2.times[i] = i === 0 ? 0 : now - S2.last[0];
      S2.last[0] = now;
    }
    moveWorld(C.w);
    C.commit();
    if (i < cap) {
      S2.commit[i] = C.commitMs[0];
      S2.cpu[i] = renderer.stats.cpuMs; // the previous render()'s
    }
    S2.n++;
  });
  return { started: true };
}

function columnsSteadyStop(id) {
  const ctx = getCtx(id);
  const l = stopLoop(ctx);
  const S2 = ctx.steady;
  const n = Math.min(S2.n, S2.times.length);
  // Skip the first frame (no interval) and the first cpu sample (previous loop).
  const st = summarize(S2.times.subarray(1, n), S2.cpu.subarray(1, n));
  const cs = summarize(S2.commit.subarray(1, n), S2.commit.subarray(1, n));
  return { stats: st, commitMsAvg: cs.cpuMsAvg, commitMsP99: cs.cpuMsP99, frames: n, throws: l ? l.throws : [], rows: ctx.cols.w.n, interleaved: ctx.cols.w.interleaved };
}

/** Stops moving; renders a few frames; returns the probe rows (points, tints, user ids). */
async function columnsProbes(id) {
  const ctx = getCtx(id);
  stopLoop(ctx);
  const C = ctx.cols;
  C.commit();
  await settle(ctx, 8);
  const probes = PROBES.map((p, i) => ({
    row: i,
    center: [p.x + PROBE_PX / 2, p.y + PROBE_PX / 2],
    tint: p.tint,
    userId: C.w.userId[i],
    nodeUserId: C.layer.children[i].userId,
    nodeX: C.layer.children[i].x,
    nodeY: C.layer.children[i].y,
  }));
  // The moving load goes on for the picks that follow.
  startLoop(ctx, () => {
    moveWorld(C.w);
    C.commit();
  });
  return { probes, rows: C.w.n, children: C.layer.children.length };
}

/** Picks every probe (moving load keeps running). Checks node + userId. */
async function columnsPickProbes(id) {
  const ctx = getCtx(id);
  const C = ctx.cols;
  const res = [];
  for (let i = 0; i < PROBES.length; i++) {
    const [x, y] = [PROBES[i].x + PROBE_PX / 2, PROBES[i].y + PROBE_PX / 2];
    try {
      const hit = await Promise.race([ctx.renderer.pick(x, y), sleep(8000).then(() => 'timeout')]);
      if (hit === 'timeout') res.push({ row: i, timeout: true });
      else res.push({ row: i, want: C.w.userId[i], got: hit ? hit.userId : null, nodeOk: !!hit && hit.node === C.layer.children[i], instance: hit ? hit.instance : null });
    } catch (e) {
      res.push({ row: i, error: errText(e) });
    }
  }
  return res;
}

// ─── userId picking under load (§19.3) ─────────────────────────────────────

/**
 * Columns layer (moving + churning, 4 fixed probe rows), 4 stage sprites
 * with NodeOptions.userId (one without), and a 'manual' Swarm whose slots
 * 0..4 are fixed 40 px objects with SpawnOptions.user; the other slots are
 * killed and respawned every frame.
 */
const UID_SPRITES = [
  { x: 40, y: 20, user: 0xfffffffe },
  { x: 160, y: 20, user: 0 },
  { x: 280, y: 20, user: 0x7fffffff },
  { x: 400, y: 20, user: 12345 }, // its userId is changed through the setter every round
];
const UID_SWARM = [
  { x: 80, y: 250, user: 0xffffffff },
  { x: 200, y: 250, user: 0 },
  { x: 320, y: 250, user: 0x80000001 },
  { x: 440, y: 250, user: 7 },
  { x: 560, y: 250, user: 42 }, // rewritten with write() every round
];

async function uidScene({ worker, backend, count = 100_000, swarmCount = 200_000, structEvery = 20, step = 2000 }) {
  const ctx = await createCtx({ worker, backend, cssW: 800, cssH: 600 });
  const { renderer } = ctx;
  const C = columnsLayer(ctx, count);
  ctx.cols = C;
  const white = whiteTex(200, 120, 255);
  const targets = UID_SPRITES.map(t => {
    const s = new GPU.Sprite({ texture: white, x: t.x, y: t.y, width: 60, height: 60, ...(t.user ? { userId: t.user } : {}) });
    renderer.stage.addChild(s);
    return s;
  });
  ctx.uidTargets = targets;
  const out = { backend: renderer.info.backend, worker, count, swarm: null, targetUserIds: targets.map(t => t.userId) };
  let swarm = null;
  const blocks = [];
  if (swarmCount > 0 && swarmSupported(renderer, swarmCount)) {
    swarm = new GPU.Swarm({ capacity: swarmCount, shape: 'quad', allocation: 'manual', behaviors: [GPU.behaviors.velocity()] });
    swarm.pickable = true;
    renderer.stage.addChild(swarm);
    const slots = UID_SWARM.map(o => swarm.spawn(1, { x: o.x, y: o.y, size: 40, color: '#ff4444', user: o.user }));
    for (let first = UID_SWARM.length; first + 1000 <= swarmCount; first += 1000) {
      const f = swarm.spawn(1000, { x: [20, 780], y: [560, 590], vx: [-10, 10], size: 1, color: '#4444ff', user: 0x1000 + first });
      if (f >= 0) blocks.push(f);
    }
    out.swarm = { capacity: swarmCount, slots, blocks: blocks.length };
    ctx.swarm = swarm;
  }
  ctx.uidChurn = { structural: 0, respawnFails: 0, swarmChurn: 0 };
  const ch = ctx.uidChurn;
  startLoop(ctx, f => {
    if (f > 0 && f % structEvery === 0) {
      ch.structural++;
      if (ch.structural % 2) C.grow(step);
      else C.shrink(step);
    }
    moveWorld(C.w);
    C.commit();
    if (swarm && blocks.length) {
      const b = blocks[(f * 7) % blocks.length];
      swarm.kill(b, 1000);
      const again = swarm.spawn(1000, { x: [20, 780], y: [560, 590], vx: [-10, 10], size: 1, color: '#4444ff', user: (0x2000 + f) >>> 0 });
      if (again < 0) ch.respawnFails++;
      ch.swarmChurn++;
    }
  });
  await sleep(800);
  // Slot 4's cold record, so write() can change only its user id.
  if (swarm) {
    try {
      ctx.uidCold4 = await Promise.race([swarm.readCold(4, 1), sleep(8000).then(() => null)]);
    } catch (e) {
      out.readColdError = errText(e);
    }
    out.cold4 = ctx.uidCold4 ? Array.from(ctx.uidCold4) : null;
  }
  // Warm-up: the first pick loads the pick client and the readback ring.
  out.warmPick = await codeOfAsync(renderer.pick(5, 5));
  out.ctxId = registerCtx(ctx);
  return out;
}

/**
 * One round: new user ids for the 4 column probes (column write + commit in
 * the loop), the setter target and swarm slot 4 (write()); then every target
 * is picked on its own and all of them once more in a single frame.
 */
async function uidRound(id, round) {
  const ctx = getCtx(id);
  const C = ctx.cols;
  const swarm = ctx.swarm;
  const out = { round, cases: 0, bad: [], timeouts: 0, errors: [], frames: [] };
  // New ids (u32, some above 2^31).
  for (let i = 0; i < PROBES.length; i++) C.w.userId[i] = (PROBES[i].user + round * 0x01000193) >>> 0;
  const setterTarget = ctx.uidTargets[3];
  setterTarget.userId = (0x70000000 + round) >>> 0;
  let swarmUser4 = UID_SWARM[4].user;
  if (swarm && ctx.uidCold4) {
    swarmUser4 = (0x50000000 + round) >>> 0;
    const cold = new Uint32Array(ctx.uidCold4);
    cold[GPU.layouts.SC_USER / 4] = swarmUser4;
    swarm.write(4, undefined, cold);
  }
  await raf();
  await raf();
  await raf();
  const cases = [];
  for (let i = 0; i < PROBES.length; i++) cases.push({ kind: 'column', x: PROBES[i].x + 15, y: PROBES[i].y + 15, node: C.layer.children[i], user: C.w.userId[i], instance: -1 });
  for (let i = 0; i < UID_SPRITES.length; i++) {
    const t = ctx.uidTargets[i];
    cases.push({ kind: 'sprite', x: UID_SPRITES[i].x + 30, y: UID_SPRITES[i].y + 30, node: t, user: i === 3 ? setterTarget.userId : UID_SPRITES[i].user >>> 0, instance: -1 });
  }
  if (swarm) {
    for (let i = 0; i < UID_SWARM.length; i++) cases.push({ kind: 'swarm', x: UID_SWARM[i].x, y: UID_SWARM[i].y, node: swarm, user: i === 4 ? swarmUser4 : UID_SWARM[i].user >>> 0, instance: i });
  }
  const judge = (c, hit, how) => {
    out.cases++;
    const ok = !!hit && hit.node === c.node && hit.userId === c.user && hit.instance === c.instance;
    if (!ok && out.bad.length < 12) {
      out.bad.push({ how, kind: c.kind, at: [c.x, c.y], want: { user: c.user, instance: c.instance }, got: hit ? { user: hit.userId, instance: hit.instance, sameNode: hit.node === c.node, kind: hit.node && hit.node.kind } : null });
    }
  };
  for (const c of cases) {
    const f0 = ctx.renderer.stats.frameId;
    try {
      const hit = await Promise.race([ctx.renderer.pick(c.x, c.y), sleep(8000).then(() => 'timeout')]);
      if (hit === 'timeout') out.timeouts++;
      else judge(c, hit, 'single');
    } catch (e) {
      out.errors.push(errText(e));
    }
    out.frames.push(ctx.renderer.stats.frameId - f0);
  }
  // All at once (more than the 4 ring slots: requests must queue).
  try {
    const hits = await Promise.race([Promise.all(cases.map(c => ctx.renderer.pick(c.x, c.y))), sleep(15000).then(() => 'timeout')]);
    if (hits === 'timeout') out.timeouts++;
    else cases.forEach((c, i) => judge(c, hits[i], 'batch'));
  } catch (e) {
    out.errors.push(errText(e));
  }
  out.loopThrows = ctx.loop?.throws ?? [];
  out.rows = C.w.n;
  out.churn = { ...ctx.uidChurn };
  return out;
}

// ─── Events sink (§19.2) ───────────────────────────────────────────────────

async function eventsInit({ worker, backend, debug = true, throwing = false }) {
  const log = [];
  const sink = throwing
    ? {
        emit(name, payload) {
          log.push({ name, payload, t: performance.now() });
          throw new Error(`sink failure on ${name}`);
        },
      }
    : undefined;
  let ctx;
  try {
    ctx = await createCtx({ worker, backend, debug, cssW: 640, cssH: 480, eventLog: log, sink });
  } catch (e) {
    return { createError: errText(e), log: log.map(e => ({ name: e.name, payload: e.payload })) };
  }
  const { renderer } = ctx;
  ctx.eventLog = log;
  const tex = whiteTex(255, 200, 80);
  ctx.mover = new GPU.Sprite({ texture: tex, x: 20, y: 20, width: 80, height: 80 });
  renderer.stage.addChild(ctx.mover);
  startLoop(ctx, f => (ctx.mover.x = 20 + (f % 300)));
  return {
    ctxId: registerCtx(ctx),
    info: { backend: renderer.info.backend, worker: renderer.info.worker, sharedMemory: renderer.info.sharedMemory, fallbackReason: renderer.info.fallbackReason ?? null },
    log: log.map(e => ({ name: e.name, payload: e.payload })),
  };
}

const eventsSince = (ctx, k) => ctx.eventLog.slice(k).map(e => ({ name: e.name, payload: e.payload }));

async function eventsStep(id, step) {
  const ctx = getCtx(id);
  const { renderer } = ctx;
  const k = ctx.eventLog.length;
  const out = { step };
  const waitFrames = async n => {
    const f0 = ctx.loop ? ctx.loop.frames : 0;
    const until = performance.now() + 15000;
    while ((ctx.loop ? ctx.loop.frames : 0) - f0 < n && performance.now() < until) await raf();
  };
  if (step === 'frames') {
    await waitFrames(300);
  } else if (step === 'css') {
    // autoResize: a CSS change → one resize event; the same size again → none.
    ctx.canvas.style.width = '600px';
    ctx.canvas.style.height = '450px';
    await waitFrames(10);
    out.afterFirst = ctx.eventLog.length - k;
    ctx.canvas.style.width = '600px';
    ctx.canvas.style.height = '450px';
    await waitFrames(10);
    out.state = { width: renderer.width, height: renderer.height, resolution: renderer.resolution };
  } else if (step === 'manual') {
    renderer.resize(600, 450, 2);
    renderer.resize(600, 450, 2); // no change: no event
    await waitFrames(10);
    renderer.resize(600, 450, 1);
    await waitFrames(10);
    out.state = { width: renderer.width, height: renderer.height, resolution: renderer.resolution };
  } else if (step === 'loss') {
    const before = ctx.events.restored;
    out.trigger = loseDevice(ctx);
    const until = performance.now() + 15000;
    while (ctx.events.restored <= before && performance.now() < until) await sleep(50);
    await waitFrames(30);
  } else if (step === 'glLose') {
    const core = globalThis.__COZYGPU_CORE__;
    const gl = core && core.backend && core.backend.gl;
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) out.trigger = 'no WEBGL_lose_context';
    else {
      const before = ctx.events.restored;
      ext.loseContext();
      out.trigger = 'ok';
      const until = performance.now() + 15000;
      while (ctx.events.restored <= before && performance.now() < until) await sleep(50);
      await waitFrames(30);
    }
  } else if (step === 'error') {
    // A non-fatal core error: WebGPU refuses a Swarm whose hot buffer exceeds
    // the default binding limit (OUT_OF_CAPACITY); WebGL2 refuses allocation
    // 'gpu' (UNSUPPORTED).
    const webgl2 = renderer.info.backend === 'webgl2';
    const swarm = webgl2
      ? new GPU.Swarm({ capacity: 10_000, allocation: 'gpu', behaviors: [GPU.behaviors.velocity()] })
      : new GPU.Swarm({ capacity: 4_000_000, behaviors: [GPU.behaviors.velocity()] });
    renderer.stage.addChild(swarm);
    out.expectCode = webgl2 ? 'UNSUPPORTED' : 'OUT_OF_CAPACITY';
    await waitFrames(60);
    swarm.destroy();
    await waitFrames(10);
  } else if (step === 'assets') {
    const base = new URL('/files/', location.href).href;
    const a = renderer.assets;
    try {
      const h = await a.load(`${base}icon-3.png`);
      out.loaded = true;
      h.release();
    } catch (e) {
      out.loadError = errText(e);
    }
    try {
      await a.load(`${base}missing-${Date.now()}.png`);
      out.missing = 'resolved';
    } catch (e) {
      out.missing = codeOf(e);
    }
    await waitFrames(5);
  }
  out.events = eventsSince(ctx, k);
  out.loopThrows = ctx.loop?.throws ?? [];
  out.frameId = renderer.stats.frameId;
  return out;
}

// ─── Uncapped picking without allocation growth (§19.6) ────────────────────

/**
 * Keeps exactly one pick in flight (issue → answer → issue), cycling over
 * `points` = [[x, y, expectedId], …]. Allocation-free on the page side except
 * the `.then` of each pick; latencies go to a preallocated array.
 */
function pickPumpStart(id, points) {
  const ctx = getCtx(id);
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const want = points.map(p => p[2]);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
  }
  const P = { on: true, picks: 0, bad: 0, errors: 0, badSamples: [], errSamples: [], lat: new Float64Array(1 << 20), k: 0, t0: 0, cur: 0, pending: false, startFrame: ctx.renderer.stats.frameId, startT: performance.now() };
  ctx.pump = P;
  let next = null;
  const onHit = hit => {
    const dt = performance.now() - P.t0;
    if (P.k < P.lat.length) P.lat[P.k++] = dt;
    const got = pickIdOf(ctx, hit && hit.node);
    if (got !== want[P.cur]) {
      P.bad++;
      if (P.badSamples.length < 8) P.badSamples.push({ at: [xs[P.cur], ys[P.cur]], want: want[P.cur], got });
    }
    P.picks++;
    next();
  };
  const onErr = e => {
    P.errors++;
    if (P.errSamples.length < 8) P.errSamples.push(errText(e));
    next();
  };
  next = () => {
    if (!P.on) {
      P.pending = false;
      return;
    }
    P.cur = P.cur + 1 === n ? 0 : P.cur + 1;
    P.pending = true;
    P.t0 = performance.now();
    ctx.renderer.pick(xs[P.cur], ys[P.cur]).then(onHit, onErr);
  };
  next();
  return { started: true };
}

function pickPumpState(id) {
  const ctx = getCtx(id);
  const P = ctx.pump;
  return { picks: P ? P.picks : 0, pendingMs: P && P.pending ? +(performance.now() - P.t0).toFixed(1) : 0, frames: ctx.loop ? ctx.loop.frames : null, frameId: ctx.renderer.stats.frameId };
}

async function pickPumpStop(id) {
  const ctx = getCtx(id);
  const P = ctx.pump;
  P.on = false;
  const until = performance.now() + 10000;
  while (P.pending && performance.now() < until) await sleep(20);
  const lat = Float64Array.from(P.lat.subarray(0, P.k)).sort();
  const q = f => (lat.length ? +lat[Math.min(lat.length - 1, Math.floor(lat.length * f))].toFixed(2) : null);
  let sum = 0;
  for (let i = 0; i < P.k; i++) sum += P.lat[i];
  const spanS = (performance.now() - P.startT) / 1000;
  return {
    picks: P.picks,
    bad: P.bad,
    errors: P.errors,
    badSamples: P.badSamples,
    errSamples: P.errSamples,
    stillPending: P.pending,
    firstMs: P.k ? +P.lat[0].toFixed(2) : null,
    avgMs: P.k ? +(sum / P.k).toFixed(2) : null,
    p50Ms: q(0.5),
    p99Ms: q(0.99),
    maxMs: q(1),
    over100: lat.filter(v => v > 100).length,
    frames: ctx.renderer.stats.frameId - P.startFrame,
    picksPerS: +(P.picks / spanS).toFixed(1),
    loopThrows: ctx.loop?.throws ?? [],
  };
}

function loopFrames(id) {
  const ctx = getCtx(id);
  return { frames: ctx.loop ? ctx.loop.frames : 0, frameId: ctx.renderer.stats.frameId, skipped: ctx.renderer.stats.skippedFrames, cpuMs: ctx.renderer.stats.cpuMs };
}

// ─── External instance buffer (WebGPU interop, §19.4) ──────────────────────

const EXT_L = [20, 20, 280, 440]; // own objects
const EXT_R = [500, 20, 280, 440]; // external records
const EXT_RT = [500, 20, 280, 210];
const EXT_RB = [500, 250, 280, 210];
const EXT_P = [630, 520, 40, 40]; // external record 0 (40 px, pick target)
const EXT_MARK = [0, 560, 40, 40]; // red marker sprite

/** Hot records inside EXT_R: first half in the top band, second half in the bottom band. */
function externalRecords(count, { vx = 0 } = {}) {
  const f = new Float32Array(count * HOT_WORDS);
  const half = count >> 1;
  for (let i = 0; i < count; i++) {
    const o = i * HOT_WORDS;
    const top = i < half;
    f[o] = 502 + ((i * 7919) % 274);
    f[o + 1] = (top ? 22 : 252) + ((i * 104729) % 204);
    f[o + 2] = vx;
    f[o + 3] = 0;
    f[o + 4] = 2;
    f[o + 5] = 2;
    f[o + 9] = 1e30;
  }
  // Record 0: a 40 px object at the pick point.
  f[0] = 650;
  f[1] = 540;
  f[4] = 40;
  f[5] = 40;
  return f;
}

function extBuffer(device, records, usage) {
  const b = device.createBuffer({ size: records.byteLength, usage });
  device.queue.writeBuffer(b, 0, records);
  return b;
}

const MOVE_X_WGSL = `
struct Hot { pos: vec2f, vel: vec2f, scale: vec2f, rot: f32, angVel: f32, age: f32, life: f32 }
@group(0) @binding(0) var<storage, read_write> hot: array<Hot>;
@group(0) @binding(1) var<uniform> sim: vec4f;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * 65535u * 256u;
  if (i == 0u || i >= u32(sim.y)) { return; }
  hot[i].pos.x = hot[i].pos.x + sim.x;
}`;

async function extStep(o) {
  const out = { step: o.step, throws: [] };
  const tryit = (label, f) => {
    try {
      return f();
    } catch (e) {
      out.throws.push(`${label}: ${errText(e)}`);
    }
  };
  if (o.step === 'init') {
    const ctx = await createCtx({ worker: o.worker, backend: o.backend, debug: true, cssW: 800, cssH: 600 });
    const { renderer } = ctx;
    const N = o.count;
    out.backend = renderer.info.backend;
    const marker = new GPU.Sprite({ texture: whiteTex(255, 0, 0), x: EXT_MARK[0], y: EXT_MARK[1], width: 40, height: 40 });
    renderer.stage.addChild(marker);
    ctx.ext = { N, frames: 0 };
    // interop availability first: worker mode rejects with UNSUPPORTED.
    out.interop = await codeOfAsync(renderer.interop());
    if (out.interop !== 'ok') {
      startLoop(ctx);
      await sleep(300);
      out.ctxId = registerCtx(ctx);
      return out;
    }
    const interop = await renderer.interop();
    ctx.ext.interop = interop;
    out.interopBackend = interop.backend;
    out.deviceKind = interop.device ? interop.device.constructor.name : null;
    const swarm = new GPU.Swarm({ capacity: N, shape: 'quad', behaviors: [GPU.behaviors.velocity()] });
    swarm.pickable = true;
    renderer.stage.addChild(swarm);
    swarm.spawn(N, { x: [EXT_L[0] + 2, EXT_L[0] + EXT_L[2] - 4], y: [EXT_L[1] + 2, EXT_L[1] + EXT_L[3] - 4], size: 2, color: '#4488ff', user: 77 });
    ctx.swarm = swarm;
    startLoop(ctx, () => {
      if (ctx.ext.each) ctx.ext.each();
    });
    await sleep(500);
    out.ctxId = registerCtx(ctx);
    return out;
  }
  const ctx = getCtx(o.ctxId);
  const { renderer } = ctx;
  const E = ctx.ext;
  const swarm = ctx.swarm;
  const N = E.N;
  const settleLoop = async (n = 8) => {
    const f0 = ctx.loop.frames;
    const until = performance.now() + 15000;
    while (ctx.loop.frames - f0 < n && performance.now() < until) await raf();
  };
  const interop = E.interop;
  const device = interop && interop.device;
  const U = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage : null;
  switch (o.step) {
    case 'webgl2': {
      // WebGL2 in M2.5: interop resolves, but Swarm external sources are
      // refused (UNSUPPORTED) and 'sprite-instance' is reserved.
      const gl = device;
      out.isGL = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, 1000 * 40, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      interop.invalidateState();
      out.spriteInstance = codeOfCall(() => interop.registerInstanceBuffer(buf, { layout: 'sprite-instance', capacity: 1000 }));
      let ext = null;
      out.registerHot = codeOfCall(() => (ext = interop.registerInstanceBuffer(buf, { layout: 'swarm-hot', capacity: 1000 })));
      if (ext) {
        out.setSourceAfterRun = codeOfCall(() => swarm.setSource({ hot: ext, count: 1000 }));
        // A swarm given a source before its first WebGL2 frame is disabled
        // with one UNSUPPORTED error; its readbacks reject.
        const s2 = new GPU.Swarm({ capacity: 1000, behaviors: [GPU.behaviors.velocity()] });
        renderer.stage.addChild(s2);
        out.setSourceBeforeRun = codeOfCall(() => s2.setSource({ hot: ext, count: 1000 }));
        await settleLoop(20);
        out.s2Read = await codeOfAsync(awaitWhileRendering(ctx, s2.readHot(0, 4), 8000));
        E.s2 = s2;
      }
      await settleLoop(10);
      break;
    }
    case 'set': {
      E.recA = externalRecords(N);
      E.bufA = extBuffer(device, E.recA, U.STORAGE | U.COPY_SRC | U.COPY_DST);
      E.extA = interop.registerInstanceBuffer(E.bufA, { layout: 'swarm-hot', capacity: N, label: 'stress.A' });
      out.valid = E.extA.valid;
      out.id = E.extA.id;
      out.layout = E.extA.layout;
      tryit('setSource', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(10);
      break;
    }
    case 'readback': {
      const safe = p => awaitWhileRendering(ctx, p, 10000).catch(e => `rejected ${codeOf(e)}`);
      const head = await safe(swarm.readHot(0, 8));
      const tail = await safe(swarm.readHot(N - 8, 8));
      const cmp = (got, first) => {
        if (!(got instanceof Float32Array)) return String(got);
        let bad = 0;
        for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - E.recA[first * HOT_WORDS + i]) > 1e-3 && !(got[i] > 1e29 && E.recA[first * HOT_WORDS + i] > 1e29)) bad++;
        return bad;
      };
      out.headMismatch = cmp(head, 0);
      out.tailMismatch = cmp(tail, N - 8);
      try {
        out.alive = await awaitWhileRendering(ctx, swarm.aliveCount(), 10000);
      } catch (e) {
        out.alive = codeOf(e);
      }
      try {
        const cold = await awaitWhileRendering(ctx, swarm.readCold(0, 2), 10000);
        out.coldUser = cold instanceof Uint32Array ? cold[GPU.layouts.SC_USER / 4] : String(cold);
      } catch (e) {
        out.coldUser = codeOf(e);
      }
      break;
    }
    case 'throws': {
      out.codes = {
        spawn: codeOfCall(() => swarm.spawn(10, { x: 10, y: 10 })),
        kill: codeOfCall(() => swarm.kill(0, 10)),
        killList: codeOfCall(() => swarm.killList(new Uint32Array([1, 2]))),
        write: codeOfCall(() => swarm.write(0, new Float32Array(HOT_WORDS))),
        clear: codeOfCall(() => swarm.clear()),
      };
      await settleLoop(4);
      break;
    }
    case 'count0':
      tryit('setSourceCount(0)', () => swarm.setSourceCount(0));
      await settleLoop(8);
      break;
    case 'countHalf':
      tryit('setSourceCount(N/2)', () => swarm.setSourceCount(N >> 1));
      await settleLoop(8);
      break;
    case 'countFull':
      tryit('setSourceCount(N)', () => swarm.setSourceCount(N));
      tryit('setSourceCount(2N) clamps', () => swarm.setSourceCount(N * 2));
      await settleLoop(8);
      break;
    case 'pick': {
      const hit = await Promise.race([renderer.pick(650, 540), sleep(8000).then(() => 'timeout')]);
      out.hit = hit === 'timeout' ? 'timeout' : hit ? { swarm: hit.node === swarm, instance: hit.instance, userId: hit.userId } : null;
      // Own objects are not drawn while the source is set.
      const own = await Promise.race([renderer.pick(160, 240), sleep(8000).then(() => 'timeout')]);
      out.ownHit = own === 'timeout' ? 'timeout' : own ? { swarm: own.node === swarm, instance: own.instance } : null;
      break;
    }
    case 'compute': {
      // External compute moves records 1..N-1 by +dx per frame; submitted on
      // the renderer's queue before each render().
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: MOVE_X_WGSL }), entryPoint: 'main' } });
      const sim = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
      const dx = 0.05;
      device.queue.writeBuffer(sim, 0, new Float32Array([dx, N, 0, 0]));
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: E.bufA } }, { binding: 1, resource: { buffer: sim } }] });
      const groups = Math.ceil(N / 256);
      const gx = Math.min(groups, 65535);
      const gy = Math.ceil(groups / 65535);
      let submits = 0;
      const frames = o.frames ?? 240;
      const times = new Float64Array(frames);
      const cpu = new Float64Array(frames);
      stopLoop(ctx);
      let last = performance.now();
      for (let i = 0; i < frames; i++) {
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(gx, gy);
        pass.end();
        device.queue.submit([enc.finish()]);
        submits++;
        renderer.render();
        cpu[i] = renderer.stats.cpuMs;
        await raf();
        const now = performance.now();
        times[i] = now - last;
        last = now;
      }
      out.stats = summarize(times, cpu);
      out.submits = submits;
      out.dx = dx;
      const head = await awaitWhileRendering(ctx, swarm.readHot(1, 4), 10000).catch(e => `rejected ${codeOf(e)}`);
      out.moved = head instanceof Float32Array ? [0, 1, 2, 3].map(j => +(head[j * HOT_WORDS] - E.recA[(1 + j) * HOT_WORDS]).toFixed(3)) : String(head);
      out.expectedMove = +(submits * dx).toFixed(3);
      sim.destroy();
      startLoop(ctx, () => {
        if (ctx.ext.each) ctx.ext.each();
      });
      await settleLoop(4);
      break;
    }
    case 'simulate': {
      const M = 1000;
      const rec = externalRecords(M, { vx: 60 });
      const buf = extBuffer(device, rec, U.STORAGE | U.COPY_SRC | U.COPY_DST);
      const ext = interop.registerInstanceBuffer(buf, { layout: 'swarm-hot', capacity: M });
      tryit('setSource simulate', () => swarm.setSource({ hot: ext, count: M, simulate: true }));
      await settleLoop(60);
      const got = await awaitWhileRendering(ctx, swarm.readHot(1, 4), 10000).catch(e => `rejected ${codeOf(e)}`);
      out.moved = got instanceof Float32Array ? [0, 1, 2, 3].map(j => +(got[j * HOT_WORDS] - rec[(1 + j) * HOT_WORDS]).toFixed(2)) : String(got);
      // Back to A (draw-only).
      tryit('setSource A', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(4);
      tryit('release sim', () => ext.release());
      buf.destroy();
      await settleLoop(4);
      break;
    }
    case 'invalid': {
      const small = device.createBuffer({ size: 400, usage: U.STORAGE | U.COPY_SRC });
      const noStorage = device.createBuffer({ size: 4000, usage: U.COPY_DST | U.VERTEX });
      const coldBuf = device.createBuffer({ size: 16 * 1000, usage: U.STORAGE | U.COPY_SRC });
      const hot1k = device.createBuffer({ size: 40 * 1000, usage: U.STORAGE | U.COPY_SRC });
      let coldExt = null;
      let hotExt = null;
      out.codes = {
        tooSmall: codeOfCall(() => interop.registerInstanceBuffer(small, { layout: 'swarm-hot', capacity: 100 })),
        noStorage: codeOfCall(() => interop.registerInstanceBuffer(noStorage, { layout: 'swarm-hot', capacity: 100 })),
        spriteInstance: codeOfCall(() => interop.registerInstanceBuffer(hot1k, { layout: 'sprite-instance', capacity: 100 })),
        notABuffer: codeOfCall(() => interop.registerInstanceBuffer({}, { layout: 'swarm-hot', capacity: 1 })),
        badLayout: codeOfCall(() => interop.registerInstanceBuffer(hot1k, { layout: 'nope', capacity: 1 })),
        coldRegister: codeOfCall(() => (coldExt = interop.registerInstanceBuffer(coldBuf, { layout: 'swarm-cold', capacity: 1000 }))),
        hotRegister: codeOfCall(() => (hotExt = interop.registerInstanceBuffer(hot1k, { layout: 'swarm-hot', capacity: 1000 }))),
      };
      out.codes.coldAsHot = coldExt ? codeOfCall(() => swarm.setSource({ hot: coldExt, count: 10 })) : 'n/a';
      out.codes.countOverRecords = hotExt ? codeOfCall(() => swarm.setSource({ hot: hotExt, count: 1001 })) : 'n/a';
      out.codes.hotAsCold = hotExt ? codeOfCall(() => swarm.setSource({ hot: hotExt, cold: hotExt, count: 10 })) : 'n/a';
      const other = new GPU.Swarm({ capacity: 10, behaviors: [GPU.behaviors.velocity()] });
      out.codes.countWithoutSource = codeOfCall(() => other.setSourceCount(5));
      other.destroy();
      // Whatever was tried, the swarm must still draw from A.
      tryit('setSource A again', () => swarm.setSource({ hot: E.extA, count: N }));
      coldExt?.release();
      hotExt?.release();
      out.codes.releasedSource = hotExt ? codeOfCall(() => swarm.setSource({ hot: hotExt, count: 10 })) : 'n/a';
      tryit('setSource A again', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(6);
      small.destroy();
      noStorage.destroy();
      coldBuf.destroy();
      hot1k.destroy();
      break;
    }
    case 'nocopysrc': {
      const M = 1000;
      const rec = externalRecords(M);
      const buf = extBuffer(device, rec, U.STORAGE | U.COPY_DST);
      const ext = interop.registerInstanceBuffer(buf, { layout: 'swarm-hot', capacity: M });
      tryit('setSource', () => swarm.setSource({ hot: ext, count: M }));
      await settleLoop(4);
      out.readHot = await codeOfAsync(awaitWhileRendering(ctx, swarm.readHot(0, 4), 8000));
      tryit('setSource A', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(4);
      ext.release();
      buf.destroy();
      break;
    }
    case 'release': {
      tryit('release A', () => E.extA.release());
      out.valid = E.extA.valid;
      await settleLoop(8);
      out.readHot = await codeOfAsync(awaitWhileRendering(ctx, swarm.readHot(0, 4), 8000));
      // aliveCount while the source is gone waits until the swarm has buffers again.
      E.pendingAlive = 'pending';
      swarm.aliveCount().then(
        v => (E.pendingAlive = v),
        e => (E.pendingAlive = `rejected ${codeOf(e)}`),
      );
      await settleLoop(10);
      out.pendingAlive = E.pendingAlive;
      break;
    }
    case 'null': {
      tryit('setSource(null)', () => swarm.setSource(null));
      await settleLoop(10);
      const until = performance.now() + 8000;
      while (E.pendingAlive === 'pending' && performance.now() < until) await raf();
      out.pendingAlive = E.pendingAlive;
      out.spawn = codeOfCall(() => swarm.spawn(1, { x: 150, y: 240, size: 2, color: '#4488ff', user: 77 }));
      out.countWithoutSource = codeOfCall(() => swarm.setSourceCount(5));
      await settleLoop(4);
      break;
    }
    case 'churn': {
      // Register / use / release / destroy cycles (outside buffers come and go).
      const cycles = o.cycles ?? 100;
      const M = 1000;
      const rec = externalRecords(M);
      let done = 0;
      for (let i = 0; i < cycles; i++) {
        try {
          const buf = extBuffer(device, rec, U.STORAGE | U.COPY_SRC | U.COPY_DST);
          const ext = interop.registerInstanceBuffer(buf, { layout: 'swarm-hot', capacity: M });
          swarm.setSource({ hot: ext, count: M });
          await raf();
          if (i % 2) {
            // Release first (the swarm draws nothing), then drop the source.
            ext.release();
            await raf();
            swarm.setSource(null);
          } else {
            swarm.setSource(null);
            ext.release();
          }
          await raf();
          buf.destroy();
          done++;
        } catch (e) {
          if (out.throws.length < 5) out.throws.push(errText(e));
        }
      }
      out.cycles = done;
      await settleLoop(6);
      break;
    }
    case 'loss': {
      // A fresh source, then a device loss: the registration dies, the swarm
      // draws nothing; after deviceRestored a new buffer on the new device works.
      E.recA = externalRecords(N);
      E.bufA = extBuffer(device, E.recA, U.STORAGE | U.COPY_SRC | U.COPY_DST);
      E.extA = interop.registerInstanceBuffer(E.bufA, { layout: 'swarm-hot', capacity: N });
      tryit('setSource', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(6);
      const before = ctx.events.restored;
      out.trigger = loseDevice(ctx);
      const until = performance.now() + 15000;
      while (ctx.events.restored <= before && performance.now() < until) await sleep(50);
      out.restored = ctx.events.restored > before;
      await settleLoop(10);
      out.validAfter = E.extA.valid;
      out.newDevice = interop.device !== device;
      out.readHotAfter = await codeOfAsync(awaitWhileRendering(ctx, swarm.readHot(0, 4), 8000));
      E.oldDevice = device;
      break;
    }
    case 'reregister': {
      const dev = interop.device;
      E.recA = externalRecords(N);
      E.bufA = extBuffer(dev, E.recA, U.STORAGE | U.COPY_SRC | U.COPY_DST);
      tryit('register', () => (E.extA = interop.registerInstanceBuffer(E.bufA, { layout: 'swarm-hot', capacity: N })));
      tryit('setSource', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(10);
      out.valid = E.extA.valid;
      const head = await awaitWhileRendering(ctx, swarm.readHot(0, 2), 10000).catch(e => `rejected ${codeOf(e)}`);
      out.headOk = head instanceof Float32Array && Math.abs(head[0] - 650) < 1e-3 && Math.abs(head[1] - 540) < 1e-3;
      break;
    }
    case 'restoreCold': {
      // The swarm's own cold records (colors, user ids) were lost with the
      // device too: refill them with one spawn() on the own buffers, then point
      // the swarm at the external hot buffer again.
      tryit('setSource(null)', () => swarm.setSource(null));
      out.spawn = codeOfCall(() => swarm.spawn(N, { x: [EXT_L[0] + 2, EXT_L[0] + EXT_L[2] - 4], y: [EXT_L[1] + 2, EXT_L[1] + EXT_L[3] - 4], size: 2, color: '#4488ff', user: 77 }));
      await settleLoop(2);
      tryit('setSource', () => swarm.setSource({ hot: E.extA, count: N }));
      await settleLoop(10);
      const hit = await Promise.race([renderer.pick(650, 540), sleep(8000).then(() => 'timeout')]);
      out.hit = hit === 'timeout' ? 'timeout' : hit ? { swarm: hit.node === swarm, instance: hit.instance, userId: hit.userId } : null;
      break;
    }
  }
  out.loopThrows = ctx.loop?.throws ?? [];
  out.frameId = renderer.stats.frameId;
  return out;
}

globalThis.stress = {
  // M2.5
  regionStats,
  columnsChurn,
  columnsSteadyStart,
  columnsSteadyStop,
  columnsProbes,
  columnsPickProbes,
  uidScene,
  uidRound,
  eventsInit,
  eventsStep,
  pickPumpStart,
  pickPumpState,
  pickPumpStop,
  loopFrames,
  extStep,
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
// M3 scenarios (masks, filters, text, particles) share the helpers above.
Object.assign(
  globalThis.stress,
  installM3({ createCtx, startLoop, stopLoop, registerCtx, getCtx, settle, sleep, raf, errText, phase, swarmSupported }),
);
// Graphics scenarios.
Object.assign(globalThis.stress, installGfx({ createCtx, startLoop, stopLoop, registerCtx, getCtx, settle, sleep, raf, errText, phase }));
// Rendering at scale: retained, static containers, SpriteLayer.
Object.assign(globalThis.stress, installM5({ createCtx, startLoop, stopLoop, registerCtx, getCtx, settle, sleep, raf, errText, phase }));
globalThis.__stressReady = true;
