/** Ticker public API — owner: "sprites". Optional helper; not required to use a Renderer. */

export interface TickerOptions {
  /** Start immediately (default true). */
  autoStart?: boolean;
  /** Call renderer.render() after all callbacks each tick (default true). */
  autoRender?: boolean;
  /** 0 = uncapped (display refresh rate). */
  maxFPS?: number;
  /** Upper clamp for dt in seconds (default 0.1). */
  maxDt?: number;
}

/** dt and time in seconds. */
export type TickerCallback = (dt: number, time: number) => void;

export interface Ticker {
  /** Returns a disposer. Callbacks run in insertion order. No allocation per tick. */
  add(callback: TickerCallback): () => void;
  remove(callback: TickerCallback): void;
  start(): void;
  stop(): void;
  readonly running: boolean;
  readonly dt: number;
  readonly time: number;
  /** Smoothed. */
  readonly fps: number;
  maxFPS: number;
  destroy(): void;
}
