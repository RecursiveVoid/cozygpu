/**
 * Optional RhiBuffer extension — owner: "backend".
 *
 * GPU memory allocation failures (out-of-memory) are reported asynchronously
 * by WebGPU: `createBuffer` returns an invalid buffer at once, and every
 * command buffer that later uses it fails. Backends that can detect this
 * attach an `allocated` promise to the buffers they create. Callers that
 * allocate very large buffers (Swarm hot/cold storage) wait for it before
 * binding the buffer, so one failed allocation cannot break every frame.
 */
import type { RhiBuffer } from './types';

export interface AllocationTracked {
  /** Resolves true when the GPU allocation succeeded, false on out-of-memory. */
  readonly allocated?: Promise<boolean>;
}

/** The buffer's allocation result, or undefined when the backend cannot tell. */
export function bufferAllocated(
  buffer: RhiBuffer,
): Promise<boolean> | undefined {
  return (buffer as RhiBuffer & AllocationTracked).allocated;
}
