/**
 * Ticker — owner: "sprites". requestAnimationFrame-driven loop that calls
 * callbacks with (dt, time) and then renderer.render(). Optional helper.
 * Per tick it allocates nothing: the frame callback is bound once and the
 * callback list is only compacted after removals.
 */
import type { Renderer } from '../types/renderer';
import type { Ticker, TickerCallback, TickerOptions } from './types';

type RafHandle = number | ReturnType<typeof setTimeout>;

const FALLBACK_FRAME_MS = 1000 / 60;
const FPS_SMOOTHING = 0.1;
/** maxFPS tolerance so a 60 Hz display is not throttled to 30 by jitter. */
const FRAME_SLACK_MS = 1;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

class TickerImpl implements Ticker {
  maxFPS: number;
  private readonly renderer: Renderer | null;
  private readonly autoRender: boolean;
  private readonly maxDt: number;
  private callbacks: (TickerCallback | null)[] = [];
  private pendingRemovals = 0;
  private iterating = false;
  private handle: RafHandle | null = null;
  private lastMs = -1;
  /** Throttle phase for maxFPS; carries the remainder between frames. */
  private throttleMs = -1;
  private _running = false;
  private _dt = 0;
  private _time = 0;
  private _fps = 0;
  private readonly tick: (ms: number) => void;
  private readonly timeoutTick: () => void;

  constructor(renderer: Renderer | null, options?: TickerOptions) {
    this.renderer = renderer;
    this.autoRender = options?.autoRender ?? true;
    this.maxFPS = options?.maxFPS ?? 0;
    this.maxDt = options?.maxDt ?? 0.1;
    this.tick = ms => this.onFrame(ms);
    this.timeoutTick = () => this.onFrame(now());
    if (options?.autoStart ?? true) this.start();
  }

  get running(): boolean {
    return this._running;
  }
  get dt(): number {
    return this._dt;
  }
  get time(): number {
    return this._time;
  }
  get fps(): number {
    return this._fps;
  }

  add(callback: TickerCallback): () => void {
    this.callbacks.push(callback);
    return () => this.remove(callback);
  }

  remove(callback: TickerCallback): void {
    const list = this.callbacks;
    const i = list.indexOf(callback);
    if (i < 0) return;
    if (this.iterating) {
      list[i] = null;
      this.pendingRemovals++;
    } else {
      list.splice(i, 1);
    }
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.lastMs = -1;
    this.throttleMs = -1;
    this.schedule();
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    this.cancel();
  }

  destroy(): void {
    this.stop();
    this.callbacks.length = 0;
  }

  private schedule(): void {
    const g = globalThis as {
      requestAnimationFrame?: (cb: (ms: number) => void) => number;
    };
    this.handle = g.requestAnimationFrame
      ? g.requestAnimationFrame(this.tick)
      : setTimeout(this.timeoutTick, FALLBACK_FRAME_MS);
  }

  private cancel(): void {
    if (this.handle === null) return;
    const g = globalThis as { cancelAnimationFrame?: (h: number) => void };
    if (typeof this.handle === 'number' && g.cancelAnimationFrame) {
      g.cancelAnimationFrame(this.handle);
    } else {
      clearTimeout(this.handle as ReturnType<typeof setTimeout>);
    }
    this.handle = null;
  }

  private onFrame(ms: number): void {
    this.handle = null;
    if (!this._running) return;
    this.schedule();

    if (this.lastMs < 0) {
      this.lastMs = ms;
      this.throttleMs = ms;
      return;
    }
    const elapsed = ms - this.lastMs;
    if (this.maxFPS > 0) {
      // Carry the phase (as Pixi does) so a display period that does not
      // divide the cap does not add a whole extra display frame per tick.
      // dt still uses lastMs, so `time` keeps tracking wall time.
      const interval = 1000 / this.maxFPS;
      const sinceTick = ms - this.throttleMs;
      if (sinceTick < interval - FRAME_SLACK_MS) return;
      let rem = sinceTick % interval;
      if (rem > interval - FRAME_SLACK_MS) rem -= interval;
      this.throttleMs = ms - rem;
    } else {
      this.throttleMs = ms;
    }
    this.lastMs = ms;
    if (elapsed <= 0) return;

    const rawDt = elapsed / 1000;
    const dt = rawDt > this.maxDt ? this.maxDt : rawDt;
    this._dt = dt;
    this._time += dt;
    const fps = 1 / rawDt;
    this._fps =
      this._fps === 0 ? fps : this._fps + (fps - this._fps) * FPS_SMOOTHING;

    this.iterating = true;
    const list = this.callbacks;
    try {
      for (let i = 0; i < list.length; i++) {
        const cb = list[i];
        if (cb !== null) cb(dt, this._time);
      }
    } finally {
      this.iterating = false;
      if (this.pendingRemovals > 0) this.compact();
    }

    const r = this.renderer;
    if (r && this.autoRender) {
      if (r.destroyed) this.stop();
      else r.render();
    }
  }

  private compact(): void {
    const list = this.callbacks;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] !== null) list[w++] = list[i];
    }
    list.length = w;
    this.pendingRemovals = 0;
  }
}

/** `GPU.ticker(renderer)`; pass `null` for a render-less loop. */
export function ticker(
  renderer: Renderer | null,
  options?: TickerOptions,
): Ticker {
  return new TickerImpl(renderer, options);
}
