/**
 * Shared benchmark types and helpers. Every library adapter gets exactly the
 * same inputs (seeded positions/velocities, the same 16x16 texture, the same
 * canvas size and fixed simulation dt) so only the rendering path differs.
 */

export type ScenarioId =
  | 'sprites-moving'
  | 'swarm'
  | 'sprites-static'
  /** M2 A1: load + upload `count` 64×64 PNGs (served from dist/a1/png). */
  | 'assets-png'
  /** M2 A1: the same images as BC1 KTX2 (dist/a1/ktx2). */
  | 'assets-ktx2'
  /** M2 A2: S3 (static sprites) + one outstanding pick at a time. */
  | 'picking'
  /** M2 A3: GPU-simulated mortal objects, spawn/kill churn every frame. */
  | 'swarm-churn'
  /** M3 T1: `count` glyphs in T1_LABELS labels, 10 % of them replaced per frame. */
  | 'text'
  /** M3 F1: blur + color-matrix chain over a container of `count` static sprites. */
  | 'filtered'
  /** M3 M1m: a masked container of `count` sprites moving under a fixed mask. */
  | 'masked-moving'
  /** M3 P1: emitter-driven particles, ~`count` alive in steady state. */
  | 'particles';
export type LibId = 'cozygpu' | 'pixi' | 'three';

export interface BenchParams {
  lib: LibId;
  /** cozygpu: webgpu | webgl2 | worker. pixi: webgpu | webgl. three: webgl | webgpu. */
  renderer: string;
  /**
   * pixi: sprite | particle. three: instanced | compute.
   * cozygpu: auto; A1 png also noatlas; A3 gpu | ring (allocation).
   */
  variant: string;
  scenario: ScenarioId;
  count: number;
  warmupSec: number;
  durationSec: number;
  width: number;
  height: number;
  seed: number;
}

/** Fixed simulation step so every library does identical CPU work per frame. */
export const SIM_DT = 1 / 60;
export const SPRITE_TEXTURE_SIZE = 16;
/** On-screen quad size (px) for sprite scenarios. */
export const SPRITE_SIZE = 8;
/** On-screen quad size (px) for swarm scenarios. */
export const SWARM_SIZE = 2;
export const SPEED_MIN = 20;
export const SPEED_MAX = 120;
export const BACKGROUND = 0x101018;

/** A1: image edge (px) and URL of image `i` (see benchmarks/assets.mjs). */
export const A1_SIZE = 64;
export function assetUrl(kind: 'png' | 'ktx2' | 'ktx', i: number): string {
  return `./dist/a1/${kind}/img-${String(i).padStart(3, '0')}.${kind}`;
}
/** A1: grid placement of image `i` (20 columns of 64 px). */
export function assetCell(i: number): { x: number; y: number } {
  return { x: (i % 20) * A1_SIZE, y: Math.floor(i / 20) * A1_SIZE };
}

/** A3: objects spawned per frame and their life range (sim seconds). */
export const CHURN_SPAWN_PER_FRAME = 8000;
export const CHURN_LIFE_MIN = 0.5;
export const CHURN_LIFE_MAX = 1.5;

/** T1: labels × glyphs per label = count (10k); T1_CHANGE labels change per frame. */
export const T1_LABELS = 200;
export const T1_CHANGE = 20;
export const T1_SIZE = 10;
export const T1_COLUMNS = 4;
export const T1_ROW = 14;
export const T1_FILL = 0xc8d4f0;
const T1_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** T1: `n` seeded strings of `len` glyphs (no spaces: every char draws). */
export function textPool(seed: number, n: number, len: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let k = 0; k < len; k++)
      s += T1_ALPHABET[Math.floor(r() * T1_ALPHABET.length)];
    out.push(s);
  }
  return out;
}
export const T1_POOL = 1024;

/** F1: Gaussian radius in stage px (Pixi's BlurFilter default strength). */
export const F1_BLUR = 8;
export const F1_SATURATE = 0.5;
export const F1_HUE = 15;

/** M1m: the mask stays put while the masked container slides along x. */
export const M1_RECT = { x: 320, y: 180, width: 640, height: 360 };
export const M1_RADIUS = 300;
export const M1_SWING = 120;
/** M1m: container x offset at frame `f` (fixed step, so every library matches). */
export function m1Offset(f: number): number {
  return Math.sin(f * SIM_DT * 2) * M1_SWING;
}

/** P1: life range (s), spawn rate (/s) ⇒ alive ≈ rate × mean life = count. */
export const P1_LIFE_MIN = 1;
export const P1_LIFE_MAX = 2;
export const P1_SPEED: readonly [number, number] = [20, 120];
export const P1_SIZE: readonly [number, number] = [2, 6];
export const P1_RADIUS = 200;
/** Over life: alpha 1 → 0, size × 1 → 0.25 (linear). */
export const P1_END_SCALE = 0.25;
export function p1Rate(alive: number): number {
  return alive / ((P1_LIFE_MIN + P1_LIFE_MAX) / 2);
}
/** Capacity with head-room so a ring never overwrites a live particle. */
export function p1Capacity(alive: number): number {
  return Math.ceil(p1Rate(alive) * P1_LIFE_MAX * 1.05);
}

/**
 * A2: pick statistics collected by the adapters. `latencyMs` = pick call →
 * result in hand (async for cozygpu GPU picking; the synchronous hit test
 * duration for Pixi / Three), `frames` = frames rendered in between.
 */
export class PickStats {
  readonly latency = new Float64Array(1 << 16);
  readonly frames = new Float64Array(1 << 16);
  n = 0;
  hits = 0;
  add(ms: number, frames: number, hit: boolean): void {
    if (this.n < this.latency.length) {
      this.latency[this.n] = ms;
      this.frames[this.n] = frames;
    }
    this.n++;
    if (hit) this.hits++;
  }
  reset(): void {
    this.n = 0;
    this.hits = 0;
  }
  summary(): Record<string, number> {
    const n = Math.min(this.n, this.latency.length);
    if (n === 0) return { picks: 0 };
    const l = this.latency.slice(0, n).sort();
    const f = this.frames.slice(0, n).sort();
    let sl = 0;
    let sf = 0;
    for (let i = 0; i < n; i++) {
      sl += l[i];
      sf += f[i];
    }
    const pct = (a: Float64Array, p: number): number =>
      a[Math.min(n - 1, Math.floor(p * n))];
    return {
      picks: this.n,
      hitRate: this.hits / this.n,
      latencyAvgMs: sl / n,
      latencyP50Ms: pct(l, 0.5),
      latencyP99Ms: pct(l, 0.99),
      latencyMaxMs: l[n - 1],
      framesAvg: sf / n,
      framesP99: pct(f, 0.99),
    };
  }
}

/** Bytes of one texture level for the GPU-memory estimate (A1, Pixi). */
export function estimateTextureBytes(
  format: string,
  width: number,
  height: number,
): number {
  const blocks = Math.ceil(width / 4) * Math.ceil(height / 4);
  if (/^(bc1|bc4|etc2-rgb8|eac-r11)/.test(format)) return blocks * 8;
  if (/^(bc|etc2|eac|astc)/.test(format)) return blocks * 16;
  if (/16float/.test(format)) return width * height * 8;
  if (/32float/.test(format)) return width * height * 16;
  return width * height * 4;
}

export function readParams(search: string): BenchParams {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number): number => {
    const v = q.get(k);
    return v === null ? d : Number(v);
  };
  return {
    lib: (q.get('lib') ?? 'pixi') as LibId,
    renderer: q.get('renderer') ?? 'webgpu',
    variant: q.get('variant') ?? 'auto',
    scenario: (q.get('scenario') ?? 'sprites-moving') as ScenarioId,
    count: num('count', 10_000),
    warmupSec: num('warmup', 2),
    durationSec: num('duration', 5),
    width: num('width', 1280),
    height: num('height', 720),
    seed: num('seed', 1337),
  };
}

/** mulberry32: tiny deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Structure-of-arrays bouncing simulation (the "user code" part of S1/S2).
 * `step` is allocation-free.
 */
export class BounceSim {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;

  constructor(
    readonly count: number,
    readonly width: number,
    readonly height: number,
    seed: number,
  ) {
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      this.x[i] = r() * width;
      this.y[i] = r() * height;
      const speed = SPEED_MIN + r() * (SPEED_MAX - SPEED_MIN);
      const angle = r() * Math.PI * 2;
      this.vx[i] = Math.cos(angle) * speed;
      this.vy[i] = Math.sin(angle) * speed;
    }
  }

  step(dt: number): void {
    const { x, y, vx, vy, count, width: w, height: h } = this;
    for (let i = 0; i < count; i++) {
      let nx = x[i] + vx[i] * dt;
      let ny = y[i] + vy[i] * dt;
      if (nx < 0) {
        nx = 0;
        vx[i] = -vx[i];
      } else if (nx > w) {
        nx = w;
        vx[i] = -vx[i];
      }
      if (ny < 0) {
        ny = 0;
        vy[i] = -vy[i];
      } else if (ny > h) {
        ny = h;
        vy[i] = -vy[i];
      }
      x[i] = nx;
      y[i] = ny;
    }
  }
}

/** Soft white circle, straight (non-premultiplied) RGBA8. */
export function circlePixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = size / 2;
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const d = Math.hypot(xx + 0.5 - r, yy + 0.5 - r) / r;
      const a = d >= 1 ? 0 : Math.round(255 * Math.min(1, (1 - d) * 3));
      const o = (yy * size + xx) * 4;
      px[o] = 255;
      px[o + 1] = 255;
      px[o + 2] = 255;
      px[o + 3] = a;
    }
  }
  return px;
}

export function pixelsToCanvas(
  pixels: Uint8Array,
  size: number,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** What an adapter reports after populate(). */
export interface PopulateResult {
  /** True when the harness must run BounceSim.step each frame (CPU simulation). */
  cpuSim: boolean;
  /** Human-readable name of the tool used (e.g. "ParticleContainer"). */
  tool: string;
}

export interface BenchContext {
  params: BenchParams;
  canvas: HTMLCanvasElement;
  /**
   * Seeded initial state. Stepped by the harness only when populate() returned
   * cpuSim: true; GPU-simulated adapters may just read the initial values.
   */
  sim: BounceSim;
  pixels: Uint8Array;
}

export interface Adapter {
  /** Create the renderer/device. Measured as `rendererMs`. */
  init(ctx: BenchContext): Promise<void>;
  /** Create all scene objects. Measured as `populateMs`. */
  populate(ctx: BenchContext): Promise<PopulateResult>;
  /**
   * Called once per rAF: copy sim state into the library (if cpuSim) and
   * render. Must not allocate.
   */
  frame(ctx: BenchContext, cpuSim: boolean): void;
  /** Extra info merged into the result (actual backend name, stats, …). */
  info(): Record<string, unknown>;
  /**
   * Optional: runs after the measure window, before info() (async readbacks
   * such as Swarm.aliveCount(); never inside the measured frames).
   */
  finish?(ctx: BenchContext): Promise<void>;
  /** Optional: called once when the measure window starts (reset counters). */
  measureStart?(): void;
  destroy?(): void;
}

export class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipError';
  }
}
