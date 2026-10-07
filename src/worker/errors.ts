/** Converts thrown values into `error` CoreMessages. */
import { CozyGPUError } from '../types/errors';
import type { CozyGPUErrorCode } from '../types/errors';
import type { CoreMessage } from '../types/transport';

export function errorMessage(
  error: unknown,
  fallback: CozyGPUErrorCode,
): CoreMessage {
  if (error instanceof CozyGPUError) {
    return { type: 'error', code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', code: fallback, message };
}

/** Rebuilds a CozyGPUError from an `error` CoreMessage (codes are stable strings). */
export function toCozyGPUError(code: string, message: string): CozyGPUError {
  const err = new CozyGPUError(code as CozyGPUErrorCode, message);
  // The message already carries the "[cozygpu:CODE]" prefix when it came from a CozyGPUError.
  if (message.startsWith('[cozygpu:')) err.message = message;
  return err;
}
