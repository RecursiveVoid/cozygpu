/**
 * Public Renderer API. SHARED + FROZEN during build.
 * Implementation: src/renderer/Renderer.ts (frozen, integrator) and
 * src/renderer/createRenderer.ts (owner "worker+build" in M2).
 */
import type { AssetsOptions, AssetsApi } from '../assets/types';
import type { BackendPreference, Capabilities } from '../backend/types';
import type { ContainerNode, SceneNode } from '../scene/types';

export interface RendererOptions {
  /**
   * Target canvas. In worker mode it must be an HTMLCanvasElement that has
   * never had a context (it is transferred with transferControlToOffscreen()).
   */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Render in a Web Worker via OffscreenCanvas. `true` uses the default worker
   * URL (new URL('./cozygpu.worker.js', import.meta.url)); pass `{ url }` when
   * a bundler moves the file.
   */
  worker?: boolean | { url: string | URL };
  /**
   * Default 'auto': WebGPU, then WebGL2 when WebGPU is missing or fails to
   * initialise (ARCHITECTURE §13.5). 'webgpu' / 'webgl2' never fall back.
   */
  backend?: BackendPreference;
  /** Device pixel ratio. Default 'device' (window.devicePixelRatio, tracked on change). */
  resolution?: number | 'device';
  /**
   * Track the canvas CSS size with a ResizeObserver and resize automatically.
   * Default true for HTMLCanvasElement, false for OffscreenCanvas.
   */
  autoResize?: boolean;
  /** Initial CSS size when autoResize is false. Defaults to the canvas attributes. */
  width?: number;
  height?: number;
  /** 0xRRGGBB. Default 0x000000. */
  background?: number;
  /** 0..1. Default 1. With < 1 the canvas uses premultiplied alpha. */
  backgroundAlpha?: number;
  /** 4× MSAA on the main pass. Default false. */
  antialias?: boolean;
  powerPreference?: 'low-power' | 'high-performance';
  /** 'max' requests adapter maximum buffer limits (needed for multi-million Swarms). Default 'default'. */
  limits?: 'default' | 'max';
  /**
   * WebGPU error scopes + shader warnings (slower; for development).
   * Default false, or `globalThis.__COZYGPU_DEBUG__ === true`.
   */
  debug?: boolean;
  /** Called when the GPU device is lost; `willRestore` false means the renderer is dead. */
  onDeviceLost?: (info: { message: string; willRestore: boolean }) => void;
  /** Called after a successful restore. GPU-only state (Swarm contents) is gone. */
  onDeviceRestored?: () => void;
  /** M2. Options for `renderer.assets` (created lazily on first use). */
  assets?: AssetsOptions;
}

/** M2. Result of `renderer.pick()`. */
export interface PickHit {
  /** The Sprite or Swarm that owns the topmost opaque pixel. */
  readonly node: SceneNode;
  /** Swarm instance index (slot), or -1 for sprites. */
  readonly instance: number;
  /** The queried point (css px). */
  readonly x: number;
  readonly y: number;
}

export interface RendererInfo {
  readonly backend: 'webgpu' | 'webgl2';
  /**
   * M2. Set only when `backend: 'auto'` asked for WebGPU and ended up on
   * WebGL2: why WebGPU was not used (ARCHITECTURE §13.5). Undefined on WebGPU
   * and when the backend was requested explicitly. For diagnostics — do not
   * branch on the text.
   */
  readonly fallbackReason?: string;
  readonly worker: boolean;
  /** Zero-copy uploads available (main thread, or worker + crossOriginIsolated). */
  readonly sharedMemory: boolean;
  readonly capabilities: Capabilities;
}

export interface RendererStats {
  readonly frameId: number;
  /** Draw commands emitted last frame. */
  readonly drawCalls: number;
  /** Bytes of the last packet. */
  readonly packetBytes: number;
  /** CPU ms spent in the last render() (front side only). */
  readonly cpuMs: number;
  /** render() calls skipped because the worker had not finished the previous frame. */
  readonly skippedFrames: number;
}

export interface Renderer {
  readonly stage: ContainerNode;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly info: RendererInfo;
  readonly stats: RendererStats;
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  /** 0xRRGGBB. */
  background: number;
  backgroundAlpha: number;

  /**
   * Encodes the stage + pending resource/Swarm commands into one packet and
   * submits it (main thread: executes synchronously; worker: posts). Never
   * blocks; in worker mode a busy core makes this call a no-op (the latest
   * state goes out with the next submitted frame).
   */
  render(): void;
  /** CSS size; `resolution` optional. Recreates size-dependent targets on the core. */
  resize(width: number, height: number, resolution?: number): void;
  /**
   * M2. GPU picking at css px (x, y), canvas space. Queues a request that the
   * next render() sends; resolves after the core has read back one pixel
   * (1–2 frames). Considers nodes with `pickable === true` whose texel alpha
   * is >= 0.5 at that point. Resolves null on a miss or when the hit node was
   * destroyed meanwhile. Rejects with DEVICE_LOST / DESTROYED.
   */
  pick(x: number, y: number): Promise<PickHit | null>;
  /**
   * M2. The renderer's asset manager (ARCHITECTURE §15). A tiny facade: the
   * implementation chunk is imported on the first call that needs it.
   */
  readonly assets: AssetsApi;
  destroy(): void;
  readonly destroyed: boolean;
}
