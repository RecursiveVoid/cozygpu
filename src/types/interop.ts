/**
 * M2.5 device interop (ARCHITECTURE §19.4). SHARED + FROZEN during the M2.5
 * build. Implemented by owner "renderer-hooks" (front handle, core table,
 * both backends); consumed by owner "swarm-hooks" (Swarm external sources).
 *
 * Main-thread mode only. External GPU code (a compute simulation, a physics
 * step, a video decoder) can use the renderer's own device and hand cozygpu
 * buffers it filled, so rendering reads them with zero copies and no
 * readback. In worker mode the device lives in another thread:
 * `renderer.interop()` rejects with UNSUPPORTED.
 *
 * No WebGPU or WebGL type appears here: native objects are `unknown`.
 */
import type { BackendKind } from '../backend/types';

/**
 * Record layout of an external instance buffer. Records follow
 * ARCHITECTURE §4 byte for byte:
 *  - 'swarm-hot':  40 B SwarmHot records (§4.2; WebGL2: the interleaved form).
 *  - 'swarm-cold': 16 B SwarmCold records (§4.3).
 *  - 'sprite-instance': 40 B sprite instances (§4.1). Reserved: M2.5 has no
 *    consumer and `registerInstanceBuffer` rejects it with UNSUPPORTED.
 */
export type ExternalLayout = 'swarm-hot' | 'swarm-cold' | 'sprite-instance';

export interface ExternalInstanceBufferDesc {
  readonly layout: ExternalLayout;
  /** Records the buffer holds (bytes = capacity × record size). */
  readonly capacity: number;
  label?: string;
}

/**
 * A registered external buffer. cozygpu never writes, resizes or destroys the
 * native buffer; the caller must keep it alive until `release()`.
 */
export interface ExternalInstanceBuffer {
  /** u32 id (ids.external); the command stream refers to it by this id. */
  readonly id: number;
  readonly layout: ExternalLayout;
  readonly capacity: number;
  /**
   * False after `release()` or a device loss. After `deviceRestored`,
   * recreate the native buffer on the new device and register it again.
   */
  readonly valid: boolean;
  /** Unregisters it. Nodes still using it draw nothing until given a new source. */
  release(): void;
}

/** Opaque handle returned by `renderer.interop()`. */
export interface RendererInterop {
  readonly backend: BackendKind;
  /**
   * The renderer's device: a `GPUDevice` on WebGPU, a
   * `WebGL2RenderingContext` on WebGL2. Read it again after `deviceRestored`
   * (it is replaced). Submit external work on this device's queue before
   * `renderer.render()`; cozygpu submits inside render(), so queue order
   * makes external writes visible to that frame.
   */
  readonly device: unknown;
  /**
   * Registers a native buffer (`GPUBuffer` / `WebGLBuffer` of `device`) as an
   * instance source. WebGPU: needs STORAGE usage (plus COPY_SRC for
   * `readHot`/`readCold`) and at least `capacity × record` bytes. WebGL2:
   * an ARRAY_BUFFER-compatible buffer. Throws INVALID_ARGUMENT on a
   * mismatch, UNSUPPORTED for 'sprite-instance'. Rare (not per frame).
   */
  registerInstanceBuffer(
    buffer: unknown,
    desc: ExternalInstanceBufferDesc,
  ): ExternalInstanceBuffer;
  /**
   * WebGL2: call after your own GL calls on `device` and before the next
   * `render()`, so cozygpu drops its cached GL state (bindings, programs,
   * blend, viewport). No-op on WebGPU.
   */
  invalidateState(): void;
}
