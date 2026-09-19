/**
 * In-page benchmark harness. Each library entry calls `start(adapter)`.
 *
 * Phases: gc → init (renderer) → populate (objects) → first frame → gc →
 * warmup (rAF loop) → measure (rAF loop) → report on `window.__benchResult`.
 *
 * Frame time = interval between consecutive rAF callbacks (what the user
 * sees; includes GPU backpressure). CPU time = time spent inside the frame
 * callback (sim step + library update + render/submit call).
 */
import {
  type Adapter,
  type BenchContext,
  BounceSim,
  SIM_DT,
  SPRITE_TEXTURE_SIZE,
  SkipError,
  circlePixels,
  readParams,
} from './common';

export interface FrameStats {
  frames: number;
  elapsedMs: number;
  fps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface BenchResult {
  status: 'ok' | 'error' | 'not-implemented' | 'skipped';
  params: ReturnType<typeof readParams>;
  tool?: string;
  error?: string;
  errorCode?: string;
  info?: Record<string, unknown>;
  init?: {
    rendererMs: number;
    populateMs: number;
    firstFrameMs: number;
    totalMs: number;
  };
  heap?: {
    precise: boolean;
    baselineBytes: number;
    afterInitBytes: number;
    afterPopulateBytes: number;
    endBytes: number;
    perObjectBytes: number;
    /**
     * (heap at end of measure − heap at start of measure) / frames, no forced
     * GC in between. Approximate: a minor GC during the window makes it
     * smaller or negative. ≈ 0 means no steady-state allocation.
     */
    growthPerFrameBytes: number;
  };
  frame?: FrameStats;
  /**
   * Frame callback CPU, excluding time blocked in WebGPU's
   * `GPUCanvasContext.getCurrentTexture()` (back-pressure: the main thread
   * waits for a swap texture while the GPU is behind; ARCHITECTURE §19.7).
   */
  cpu?: { avgMs: number; p50Ms: number; p99Ms: number; maxMs: number };
  /** Time per frame spent inside getCurrentTexture() (WebGPU pages; else 0). */
  swapWait?: { avgMs: number; p50Ms: number; p99Ms: number; maxMs: number };
  env?: Record<string, unknown>;
}

declare global {
  interface Window {
    __benchResult?: BenchResult;
    __benchPhase?: string;
    __benchDestroy?: () => Promise<number>;
    gc?: () => void;
  }
  interface Performance {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
  }
}

const MAX_SAMPLES = 1 << 20;
/** Slow cases keep measuring past `duration` until this many frames… */
const MIN_FRAMES = 20;
/** …but never longer than duration × this. */
const MAX_DURATION_FACTOR = 4;

function heap(): number {
  return performance.memory ? performance.memory.usedJSHeapSize : NaN;
}

function collect(): void {
  if (window.gc) {
    window.gc();
    window.gc();
  }
}

function raf(): Promise<number> {
  return new Promise(r => requestAnimationFrame(r));
}

function stats(
  samples: Float64Array,
  n: number,
): Omit<FrameStats, 'frames' | 'elapsedMs' | 'fps'> {
  if (n === 0)
    return { avgMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN, maxMs: NaN };
  const sorted = samples.slice(0, n).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const pct = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))];
  return {
    avgMs: sum / n,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    maxMs: sorted[n - 1],
  };
}

async function env(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    crossOriginIsolated: window.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    if (adapter) {
      const i = adapter.info;
      out.gpu = {
        vendor: i.vendor,
        architecture: i.architecture,
        device: i.device,
        description: i.description,
      };
    }
  } catch {
    /* ignore */
  }
  return out;
}

function classify(
  err: unknown,
): Pick<BenchResult, 'status' | 'error' | 'errorCode'> {
  const e = err as
    | { code?: string; message?: string; stack?: string }
    | undefined;
  const message = e?.message ?? String(err);
  if (err instanceof SkipError) return { status: 'skipped', error: message };
  if (e?.code === 'NOT_IMPLEMENTED' || /NOT_IMPLEMENTED/.test(message)) {
    return {
      status: 'not-implemented',
      error: message,
      errorCode: 'NOT_IMPLEMENTED',
    };
  }
  return { status: 'error', error: e?.stack ?? message, errorCode: e?.code };
}

async function run(
  adapter: Adapter,
  ctx: BenchContext,
  result: BenchResult,
): Promise<void> {
  const { params } = ctx;
  const phase = (p: string): void => {
    window.__benchPhase = p;
  };

  // Sample buffers are allocated before the baseline so they don't skew heap numbers.
  const intervals = new Float64Array(MAX_SAMPLES);
  const cpu = new Float64Array(MAX_SAMPLES);
  const swapWait = new Float64Array(MAX_SAMPLES);
  // Swap-texture wait (§19.7): time blocked in getCurrentTexture() is
  // back-pressure, not work, so it is reported apart from CPU. Applies to
  // every WebGPU library alike (they all acquire the texture in this call).
  let swapWaitMs = 0;
  const gctProto = (
    globalThis as {
      GPUCanvasContext?: { prototype: { getCurrentTexture(): unknown } };
    }
  ).GPUCanvasContext?.prototype;
  if (gctProto) {
    const orig = gctProto.getCurrentTexture;
    gctProto.getCurrentTexture = function (this: unknown) {
      const t = performance.now();
      try {
        return orig.call(this);
      } finally {
        swapWaitMs += performance.now() - t;
      }
    };
  }
  collect();
  const baselineBytes = heap();
  const t0 = performance.now();
  phase('init');
  await adapter.init(ctx);
  const t1 = performance.now();
  collect();
  const afterInitBytes = heap();
  phase('populate');
  const t2 = performance.now();
  const pop = await adapter.populate(ctx);
  const t3 = performance.now();
  result.tool = pop.tool;
  phase('first-frame');
  adapter.frame(ctx, false);
  await raf();
  await raf();
  const t4 = performance.now();
  result.init = {
    rendererMs: t1 - t0,
    populateMs: t3 - t2,
    firstFrameMs: t4 - t3,
    totalMs: t4 - t0 - (t2 - t1), // exclude the gc pause between init and populate
  };
  collect();
  const afterPopulateBytes = heap();

  // ── frame loop ────────────────────────────────────────────────────────────
  const cpuSim = pop.cpuSim;
  const sim = ctx.sim;
  const warmupMs = params.warmupSec * 1000;
  const durationMs = params.durationSec * 1000;

  let measureStartBytes = NaN;
  let measuredFrames = 0;
  await new Promise<void>(resolve => {
    let measuring = false;
    let n = 0;
    let last = performance.now();
    let startWarm = last;
    let startMeasure = 0;
    phase('warmup');
    const tick = (): void => {
      const now = performance.now();
      if (measuring) {
        if (n < MAX_SAMPLES) intervals[n] = now - last;
      } else if (now - startWarm >= warmupMs) {
        measuring = true;
        startMeasure = now;
        measureStartBytes = heap();
        adapter.measureStart?.();
        phase('measure');
      }
      last = now;
      swapWaitMs = 0;
      const c0 = performance.now();
      if (cpuSim) sim.step(SIM_DT);
      adapter.frame(ctx, cpuSim);
      const c1 = performance.now();
      if (measuring && startMeasure !== now) {
        if (n < MAX_SAMPLES) {
          cpu[n] = c1 - c0 - swapWaitMs;
          swapWait[n] = swapWaitMs;
        }
        n++;
      }
      const elapsed = now - startMeasure;
      if (
        measuring &&
        n > 0 &&
        ((elapsed >= durationMs && n >= MIN_FRAMES) ||
          elapsed >= durationMs * MAX_DURATION_FACTOR)
      ) {
        measuredFrames = n;
        const elapsedMs = now - startMeasure;
        const count = Math.min(n, MAX_SAMPLES);
        result.frame = {
          frames: n,
          elapsedMs,
          fps: (n * 1000) / elapsedMs,
          ...stats(intervals, count),
        };
        const c = stats(cpu, count);
        result.cpu = {
          avgMs: c.avgMs,
          p50Ms: c.p50Ms,
          p99Ms: c.p99Ms,
          maxMs: c.maxMs,
        };
        const w = stats(swapWait, count);
        result.swapWait = {
          avgMs: w.avgMs,
          p50Ms: w.p50Ms,
          p99Ms: w.p99Ms,
          maxMs: w.maxMs,
        };
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    startWarm = performance.now();
    requestAnimationFrame(tick);
  });

  const endBytes = heap();
  if (adapter.finish) {
    phase('finish');
    await adapter.finish(ctx);
  }
  result.heap = {
    precise: !!window.gc,
    baselineBytes,
    afterInitBytes,
    afterPopulateBytes,
    endBytes,
    perObjectBytes: (afterPopulateBytes - afterInitBytes) / params.count,
    growthPerFrameBytes:
      (endBytes - measureStartBytes) / Math.max(1, measuredFrames),
  };
  result.info = adapter.info();
  result.status = 'ok';
}

export function start(createAdapter: (ctx: BenchContext) => Adapter): void {
  const params = readParams(location.search);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.style.width = `${params.width}px`;
  canvas.style.height = `${params.height}px`;
  const result: BenchResult = { status: 'error', params };
  let adapter: Adapter | undefined;

  const finish = async (): Promise<void> => {
    result.env = await env();
    window.__benchResult = result;
    const label = `${params.lib}/${params.renderer}/${params.variant} ${params.scenario} ${params.count}`;
    console.log(
      `[bench] ${label} → ${result.status}${result.frame ? ` ${result.frame.fps.toFixed(1)} fps` : ''}`,
    );
    // Not destroyed automatically: a slow or hanging destroy() must not block
    // the runner from reading the result (each case gets a fresh browser).
    // `window.__benchDestroy()` resolves with the destroy time in ms.
    window.__benchDestroy = async () => {
      const t = performance.now();
      adapter?.destroy?.();
      return performance.now() - t;
    };
  };

  (async () => {
    // Created before the heap baseline: identical for every library.
    const sim = new BounceSim(
      params.count,
      params.width,
      params.height,
      params.seed,
    );
    const ctx: BenchContext = {
      params,
      canvas,
      sim,
      pixels: circlePixels(SPRITE_TEXTURE_SIZE),
    };
    adapter = createAdapter(ctx);
    await run(adapter, ctx, result);
  })()
    .catch(err => {
      Object.assign(result, classify(err));
      try {
        if (adapter) result.info = adapter.info();
      } catch {
        /* ignore */
      }
    })
    .finally(finish);
}
