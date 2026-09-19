/**
 * Command stream encoder / decoder contracts — owner: "worker".
 * Spec: docs/ARCHITECTURE.md §3.
 *
 * Performance contract:
 *  - Encoder and decoder allocate nothing per command in steady state.
 *  - Buffers come from a small pool and are recycled (worker mode: buffers
 *    ping-pong between threads via transfer).
 *  - Readers expose whole-packet typed views + absolute offsets (no subarray
 *    allocation per command).
 */

import type { Opcode } from './opcodes';

/** An object carried next to the bytes (transferred in worker mode). */
export type PacketObject = ImageBitmap | ArrayBuffer | SharedArrayBuffer;

export interface FramePacket {
  /**
   * Owns the bytes.
   *  - ArrayBuffer: local mode (same heap), or the worker transfer path (the
   *    buffer is transferred and detached on the sender).
   *  - SharedArrayBuffer (M2): a slot of the worker command ring
   *    (ARCHITECTURE §17). Nothing is transferred; the core must not keep
   *    views past `execute()` because the front re-encodes into the slot.
   */
  buffer: ArrayBuffer | SharedArrayBuffer;
  /** Used bytes, including the 16-byte packet header. */
  byteLength: number;
  frameId: number;
  commandCount: number;
  /** Side table referenced by objectIndex fields. Reused array; cleared on reset. */
  objects: PacketObject[];
}

export interface CommandWriter {
  /**
   * Starts a command and reserves `payloadBytes` (rounded up to 4).
   * Grows the underlying buffer if needed — views obtained earlier become stale.
   * Returns the absolute byte offset of the payload start.
   */
  begin(opcode: Opcode | number, payloadBytes: number, flags?: number): number;
  u32(value: number): void;
  i32(value: number): void;
  f32(value: number): void;
  /**
   * Copies `byteLength` bytes of `src` (starting at `srcByteOffset`, relative
   * to the view) and pads to a 4-byte boundary. May create one temporary
   * subarray view per call: allowed for bulk uploads, never per object.
   */
  bytes(
    src: ArrayBufferView,
    srcByteOffset?: number,
    byteLength?: number,
  ): void;
  /**
   * UTF-8 encodes `text` (no allocation beyond TextEncoder.encodeInto) and pads. Returns byte length.
   * Size the payload first with `utf8ByteLength(text)` from src/commands (allocation-free).
   */
  utf8(text: string): number;
  /**
   * Bulk writes: views over the whole encoder buffer. Valid until the next
   * `begin()`. Use with the payload offset returned by `begin()`.
   */
  readonly u8: Uint8Array;
  readonly u32View: Uint32Array;
  readonly f32View: Float32Array;
  /** Current absolute write offset. */
  readonly cursor: number;
  /**
   * Optional no-op marker. Bulk writers fill the payload through the views
   * without moving the cursor; unwritten reserved payload bytes are unspecified.
   */
  end(): void;
  /** Adds to the packet side table; returns its index. */
  addObject(obj: PacketObject, transfer: boolean): number;
}

export interface CommandEncoder extends CommandWriter {
  readonly byteLength: number;
  readonly commandCount: number;
  /** True when no command has been written since the last reset. */
  readonly empty: boolean;
  /** Writes the packet header and hands the packet out. Encoder must be reset before reuse. */
  finish(frameId: number): FramePacket;
  /** Objects that must be put in postMessage's transfer list for the last finished packet. */
  readonly transferList: Transferable[];
  /**
   * Starts a new packet, optionally adopting a recycled buffer (M2: or a
   * command-ring SharedArrayBuffer slot). If a packet outgrows an adopted
   * SharedArrayBuffer the encoder switches to a new, larger ArrayBuffer; the
   * transport then sends that frame on the transfer path.
   */
  reset(recycled?: ArrayBuffer | SharedArrayBuffer): void;
}

export interface CommandReader {
  readonly opcode: number;
  readonly flags: number;
  /** Absolute offset of the command header (for `CommandDecoder.seek`). */
  readonly commandOffset: number;
  readonly payloadOffset: number;
  readonly payloadBytes: number;
  u32(): number;
  i32(): number;
  f32(): number;
  /**
   * Zero-allocation bulk access: whole-packet views (valid until the next
   * `CommandDecoder.reset`). `blob(n)` returns the ABSOLUTE byte offset of the
   * next n bytes in these views and advances past them (+ padding), e.g.
   *   const at = reader.blob(count * 40);
   *   backend.writeBuffer(buf, first * 40, reader.u8, at, count * 40);
   * For f32/u32 arrays use `f32View[at >> 2]` / `u32View[at >> 2]`.
   */
  readonly u8: Uint8Array;
  readonly u32View: Uint32Array;
  readonly f32View: Float32Array;
  blob(byteLength: number): number;
  /** Allocates a string: only for rare commands (SWARM_CREATE). */
  utf8(byteLength: number): string;
  skip(byteLength: number): void;
  object<T extends PacketObject>(index: number): T;
}

export interface CommandDecoder {
  /** Validates magic/length; throws CozyGPUError('INVALID_ARGUMENT') on corruption. */
  reset(packet: FramePacket): void;
  readonly frameId: number;
  readonly commandCount: number;
  /** Advances to the next command; false at the end. */
  next(): boolean;
  /** Jumps to a command previously seen at `commandOffset` (used to replay DRAW commands). */
  seek(commandOffset: number): void;
  readonly reader: CommandReader;
}
