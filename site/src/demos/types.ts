import type * as GPU from 'cozygpu';

export type BackendChoice = 'webgpu' | 'webgl2';

/** What the page hands a demo when it starts one. */
export interface DemoContext {
  canvas: HTMLCanvasElement;
  backend: BackendChoice;
  /** Run the core in a Web Worker. */
  worker: boolean;
  /** Absolute URL of the worker bundle. */
  workerUrl: string;
  /** Absolute URL of the folder holding the font assets. */
  assetBase: string;
  /** Slider value (object count or intensity); demos without one ignore it. */
  count: number;
  /** Called once per frame by the demo's ticker (feeds the HUD). */
  tick: () => void;
}

/** A running demo. */
export interface DemoHandle {
  renderer: GPU.Renderer;
  ticker: GPU.Ticker;
  /** Objects currently simulated or drawn (shown in the HUD). */
  objects(): number;
  /** Applies a new slider value without restarting, when the demo can. */
  setCount?(value: number): void;
  destroy(): void;
}

export type DemoStart = (ctx: DemoContext) => Promise<DemoHandle>;

export function workerOption(ctx: DemoContext): { url: string } | false {
  return ctx.worker ? { url: ctx.workerUrl } : false;
}

/** Tears a renderer and its ticker down; never throws. */
export function teardown(ticker: GPU.Ticker, renderer: GPU.Renderer): void {
  try {
    ticker.destroy();
  } catch {
    // already gone
  }
  try {
    renderer.destroy();
  } catch {
    // already gone
  }
}
