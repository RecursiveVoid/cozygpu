/**
 * Error codes surfaced by cozygpu. Stable strings: tests and users may switch
 * on them.
 */
export type CozyGPUErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'UNSUPPORTED' // backend / browser lacks a required capability
  | 'DEVICE_LOST' // GPU device lost and could not be restored
  | 'INVALID_ARGUMENT'
  | 'OUT_OF_CAPACITY' // e.g. Swarm capacity or buffer limit exceeded
  | 'SHADER_COMPILE' // WGSL/GLSL compilation or pipeline creation failed
  | 'DESTROYED' // object used after destroy()
  | 'INTERNAL' // unexpected non-cozygpu exception inside the core or worker (a bug)
  | 'ABORTED' // M2: an asset load was cancelled through its AbortSignal
  | 'LOAD_FAILED'; // M2: network / HTTP / decode / container parse failure (assets)

export class CozyGPUError extends Error {
  public readonly code: CozyGPUErrorCode;

  constructor(code: CozyGPUErrorCode, message: string) {
    super(`[cozygpu:${code}] ${message}`);
    this.name = 'CozyGPUError';
    this.code = code;
  }
}

/** Helper for M1 skeletons. Implementers replace every call site. */
export function notImplemented(what: string): never {
  throw new CozyGPUError('NOT_IMPLEMENTED', `${what} is not implemented yet`);
}
