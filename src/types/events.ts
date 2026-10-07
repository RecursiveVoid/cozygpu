/**
 * M2.5 events sink (ARCHITECTURE §19.2). Emitted from src/renderer/** and,
 * for asset events, from src/assets/Assets.ts.
 *
 * cozygpu has no event system of its own. `createRenderer({ events })` takes
 * any object with `emit(name, payload)` (an EventEmitter, a cozyEvent bus, a
 * logger, a test spy) and calls it for RARE lifecycle events only. Nothing
 * is emitted per frame, so the sink costs nothing in the render loop.
 *
 * Rules (normative):
 *  - Emitted on the main thread, in both renderer modes, synchronously from
 *    the code path that observed the event (after the matching
 *    `onDeviceLost` / `onDeviceRestored` callback, when there is one).
 *  - Each call gets a fresh, plain payload object the sink may keep.
 *  - A sink that throws is caught; the error is logged once per event name
 *    and rendering continues.
 *  - Names are stable strings; payload fields are only ever added.
 */
import type { BackendKind } from '../backend/types';
import type { CozyGPUErrorCode } from './errors';

/** Anything with an `emit` method. cozygpu never calls anything else on it. */
export interface EventSink {
  emit(name: string, payload: unknown): void;
}

/**
 * Event name → payload map. Exported as `GPU.Events` (type only) so a typed
 * bus can be declared as, for example, `Bus<GPU.Events>`.
 */
export interface Events {
  /** Once, just before `createRenderer()` resolves. */
  ready: {
    readonly backend: BackendKind;
    readonly worker: boolean;
    readonly sharedMemory: boolean;
    /** Same as `renderer.info.fallbackReason`. */
    readonly fallbackReason?: string;
  };
  /**
   * Once, before `ready`, when `backend: 'auto'` asked for WebGPU and ended on
   * WebGL2. `reason` is diagnostic text; do not branch on it.
   */
  fallback: {
    readonly from: 'webgpu';
    readonly to: 'webgl2';
    readonly reason: string;
  };
  /**
   * GPU device lost (WebGPU) or WebGL context lost (WebGL2; there is no
   * separate contextLost event). `willRestore: false` means the renderer is
   * dead (restore failed; it is destroyed).
   */
  deviceLost: {
    readonly backend: BackendKind;
    readonly message: string;
    readonly willRestore: boolean;
  };
  /**
   * The device or context is back. GPU-only data (Swarm contents, external
   * buffers registered through `interop()`) is gone and must be recreated.
   */
  deviceRestored: {
    readonly backend: BackendKind;
    /** Bumped once per successful restore. */
    readonly generation: number;
  };
  /**
   * The renderer's css size or resolution changed (`resize()` or autoResize).
   * Emitted when the change is accepted on the front, not per frame.
   */
  resize: {
    readonly width: number;
    readonly height: number;
    readonly resolution: number;
  };
  /**
   * An asset or bundle entry finished loading (`renderer.assets`). `bundle`
   * is the bundle name for `loadBundle` entries, else null.
   */
  assetProgress: {
    readonly key: string;
    readonly bundle: string | null;
    readonly loaded: number;
    readonly total: number;
    readonly ratio: number;
  };
  /** An asset load failed (the promise rejects with the same code). */
  assetError: {
    readonly key: string;
    readonly url: string;
    readonly code: CozyGPUErrorCode;
    readonly message: string;
  };
  /**
   * A non-fatal error reported by the core (the same `[cozygpu:CODE]` text
   * that is logged): OUT_OF_CAPACITY, UNSUPPORTED, SHADER_COMPILE, INTERNAL.
   * Fatal device loss is `deviceLost` with `willRestore: false`.
   */
  error: {
    readonly code: CozyGPUErrorCode;
    readonly message: string;
  };
}

export type EventName = keyof Events;
