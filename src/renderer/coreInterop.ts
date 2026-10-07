/**
 * Core half of device interop (ARCHITECTURE §19.4),
 * main-thread mode only: LocalTransport.interop(create) builds it over the
 * core in the same heap. Only the lazy interop chunk (interopImpl.ts) imports
 * it, so neither the minimal program nor the worker bundle carries it.
 *
 * Registrations live in the core context's external table (read by
 * `CoreContext.getExternalBuffer`) until released or a device loss drops
 * them all (`lossEpoch` bumps).
 */
import type { CoreInterop, RenderCore } from '../types/core';
import { CozyGPUError } from '../types/errors';
import type { RenderCoreImpl } from './RenderCore';

export function createCoreInterop(local: RenderCore): CoreInterop {
  const core = local as RenderCoreImpl;
  const backend = core.backend;
  const ctx = core.context;
  return {
    backend: backend.kind,
    device: () => backend.native(),
    get lossEpoch() {
      return ctx.lossEpoch;
    },
    registerBuffer(externalId, native, desc) {
      if (!core.ready) {
        throw new CozyGPUError('DEVICE_LOST', 'the GPU device is lost');
      }
      ctx.ext.set(externalId, backend.importBuffer(native, desc));
    },
    releaseBuffer: externalId => void ctx.ext.delete(externalId),
    invalidateState: () => backend.resetState(),
  };
}
