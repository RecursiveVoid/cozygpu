// Shared shape of the graphics example scenes (examples/graphics/main.ts
// picks one with ?scene=).
import type * as GPU from 'cozygpu';

/** Read by the headless check (puppeteer-core) as `globalThis.__graphics`. */
export interface SceneStatus {
  scene: string;
  backend: string;
  worker: boolean;
  frames: number;
  ready: boolean;
  errors: string[];
  /** Scene-specific results (mask modes, pick hits, restores, ...). */
  [key: string]: unknown;
}

export interface Scene {
  /** Called once per frame by the example's ticker. */
  update(dt: number, time: number): void;
  /** Lines for the HUD. */
  hud(): string;
}

export type SceneFactory = (
  renderer: GPU.Renderer,
  params: URLSearchParams,
  status: SceneStatus,
) => Scene | Promise<Scene>;
