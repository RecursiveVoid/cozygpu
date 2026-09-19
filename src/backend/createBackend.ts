import { CozyGPUError } from '../types/errors';
import type { Canvas } from '../types/types';
import type { Backend, BackendKind, BackendOptions } from './types';

/**
 * Picks and initialises a backend for `canvas` (ARCHITECTURE §13.5).
 *
 *  - 'webgpu' / 'webgl2': that backend only; its error propagates.
 *  - 'auto': WebGPU first, then WebGL2 when `navigator.gpu` is missing, no
 *    adapter is found, or WebGPU init throws (UNSUPPORTED / INTERNAL). The
 *    WebGPU backend must not call `canvas.getContext('webgpu')` before it
 *    holds a device: a canvas that has a context can never get another kind.
 *    If WebGPU got as far as creating its context, fallback is impossible and
 *    its error propagates.
 *
 * Each backend is a separate dynamic import, so a WebGPU page never loads
 * WebGL2 code and vice versa (ARCHITECTURE §18.1). Works identically on the
 * main thread and inside a worker (OffscreenCanvas).
 */
export async function createBackend(
  canvas: Canvas,
  options: BackendOptions,
): Promise<Backend> {
  if (!canvas) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      'createBackend: canvas is required',
    );
  }
  const preference = options.preference;
  if (preference === 'webgpu' || preference === 'webgl2') {
    return createKind(preference, canvas, options);
  }
  let webgpuError: unknown = null;
  let reason = 'navigator.gpu is not available';
  if (hasWebGPU()) {
    try {
      return await createKind('webgpu', canvas, options);
    } catch (err) {
      if (err instanceof CozyGPUError && err.code === 'INVALID_ARGUMENT') {
        throw err;
      }
      webgpuError = err;
      reason = `WebGPU init failed: ${(err as Error)?.message ?? String(err)}`;
    }
  }
  try {
    const backend = await createKind('webgl2', canvas, options);
    // Say why 'auto' landed here; a run is otherwise indistinguishable from
    // an explicit `backend: 'webgl2'`.
    backend.fallbackReason = reason;
    return backend;
  } catch (err) {
    // Surface the more useful error: a missing/unfinished WebGL2 backend
    // should not hide why WebGPU failed.
    if (
      webgpuError !== null &&
      (!(err instanceof CozyGPUError) ||
        err.code === 'NOT_IMPLEMENTED' ||
        err.code === 'UNSUPPORTED')
    ) {
      throw webgpuError;
    }
    if (
      webgpuError === null &&
      err instanceof CozyGPUError &&
      err.code === 'NOT_IMPLEMENTED'
    ) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'WebGPU is not available in this browser',
      );
    }
    throw err;
  }
}

function hasWebGPU(): boolean {
  return !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
}

async function createKind(
  kind: BackendKind,
  canvas: Canvas,
  options: BackendOptions,
): Promise<Backend> {
  if (kind === 'webgpu') {
    const { WebGPUBackend } = await import('./webgpu/WebGPUBackend');
    return WebGPUBackend.create(canvas, options);
  }
  const { WebGL2Backend } = await import('./webgl2/WebGL2Backend');
  return WebGL2Backend.create(canvas, options);
}
