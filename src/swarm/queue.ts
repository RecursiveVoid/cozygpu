/**
 * Owner: "swarm". A swarm's own small growable command queue (front side).
 *
 * Mutating Swarm calls (spawn/kill/write) encode here in the normal binary
 * command format (8-byte header + 4-aligned payload). `_emitDraw` copies the
 * queue into the frame encoder, so a swarm that is not drawn keeps its queue.
 */
import { COMMAND_HEADER_BYTES } from '../commands/opcodes';
import type { CommandWriter } from '../commands/types';

const INITIAL_BYTES = 1024;
/** Payloads up to this size are copied word by word (no subarray). */
const WORD_COPY_LIMIT = 512;

export class CommandQueue {
  private buffer = new ArrayBuffer(INITIAL_BYTES);
  u8 = new Uint8Array(this.buffer);
  u32 = new Uint32Array(this.buffer);
  f32 = new Float32Array(this.buffer);
  /** Used bytes. */
  length = 0;

  get empty(): boolean {
    return this.length === 0;
  }

  /**
   * Appends a command header, reserves `payloadBytes` (rounded up to 4,
   * zero-filled) and returns the WORD index of the payload start. Views may
   * be replaced: re-read `u8`/`u32`/`f32` after calling.
   */
  begin(opcode: number, payloadBytes: number, flags = 0): number {
    const padded = (payloadBytes + 3) & ~3;
    const start = this.length;
    const end = start + COMMAND_HEADER_BYTES + padded;
    if (end > this.buffer.byteLength) this.grow(end);
    this.u32[start >> 2] = (opcode & 0xffff) | ((flags & 0xffff) << 16);
    this.u32[(start >> 2) + 1] = padded;
    this.u8.fill(0, start + COMMAND_HEADER_BYTES, end);
    this.length = end;
    return (start + COMMAND_HEADER_BYTES) >> 2;
  }

  reset(): void {
    this.length = 0;
  }

  /** Re-encodes every queued command into `writer`, then clears the queue. */
  flushInto(writer: CommandWriter): void {
    const u32 = this.u32;
    let offset = 0;
    while (offset < this.length) {
      const w = offset >> 2;
      const header = u32[w];
      const payload = u32[w + 1];
      writer.begin(header & 0xffff, payload, header >>> 16);
      if (payload > WORD_COPY_LIMIT) {
        writer.bytes(this.u8, offset + COMMAND_HEADER_BYTES, payload);
      } else {
        const words = payload >> 2;
        for (let k = 0; k < words; k++) writer.u32(u32[w + 2 + k]);
      }
      writer.end();
      offset += COMMAND_HEADER_BYTES + payload;
    }
    this.length = 0;
  }

  private grow(minBytes: number): void {
    let size = this.buffer.byteLength * 2;
    while (size < minBytes) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8.subarray(0, this.length));
    this.buffer = next;
    this.u8 = new Uint8Array(next);
    this.u32 = new Uint32Array(next);
    this.f32 = new Float32Array(next);
  }
}
