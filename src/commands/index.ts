/** Owner: "worker". Factories for the binary command stream. */
import { CommandDecoderImpl } from './decoder';
import { CommandEncoderImpl, DEFAULT_ENCODER_BYTES } from './encoder';
import type { CommandDecoder, CommandEncoder } from './types';

export * from './opcodes';
export type * from './types';
export { align4, utf8ByteLength } from './utf8';

/** @param initialBytes starting capacity (default 64 KiB); grows ×2. */
export function createCommandEncoder(
  initialBytes: number = DEFAULT_ENCODER_BYTES,
): CommandEncoder {
  return new CommandEncoderImpl(initialBytes);
}

export function createCommandDecoder(): CommandDecoder {
  return new CommandDecoderImpl();
}
