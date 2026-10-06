/**
 * Owner: "worker". Binary command encoder (docs/ARCHITECTURE.md §3.6).
 *
 * One growable ArrayBuffer with cached u8/u32/f32 views. Views are rebuilt
 * only when the buffer grows or a different (recycled) buffer is adopted.
 * M2: `reset()` also adopts a command-ring SharedArrayBuffer slot
 * (ARCHITECTURE §17). A shared buffer is never put in `transferList`; a
 * packet that outgrows its slot moves to a new, larger ArrayBuffer, which the
 * transport then sends on the transfer path.
 * `begin()` reserves the whole padded payload up front, so scalar writes
 * never grow the buffer; they only bounds-check against the reservation.
 */
import { CozyGPUError } from '../types/errors';
import type { CommandEncoder, FramePacket, PacketObject } from './types';
import {
  COMMAND_HEADER_BYTES,
  CH_PAYLOAD_BYTES,
  PACKET_HEADER_BYTES,
  PACKET_MAGIC,
  PH_BYTE_LENGTH,
  PH_COMMAND_COUNT,
  PH_FRAME_ID,
  PH_MAGIC,
} from './opcodes';
import { align4, sharedTextEncoder } from './utf8';

export const DEFAULT_ENCODER_BYTES = 64 * 1024;

const isLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class CommandEncoderImpl implements CommandEncoder {
  public u8!: Uint8Array;
  public u32View!: Uint32Array;
  public f32View!: Float32Array;
  public cursor = PACKET_HEADER_BYTES;
  public commandCount = 0;
  public readonly transferList: Transferable[] = [];

  private buffer!: ArrayBuffer | SharedArrayBuffer;
  /** `buffer` is a SharedArrayBuffer (ring slot): not transferable. */
  private shared = false;
  /** Scratch for utf8() on a shared slot (see there). Grows, never shrinks. */
  private utf8Scratch: Uint8Array | null = null;
  /** transferList[0] is the packet buffer. */
  private listHasBuffer = true;
  /** High-water capacity: recycled buffers smaller than this are dropped. */
  private capacity: number;
  /** End of the current command's reserved payload (= used bytes). */
  private reservedEnd = PACKET_HEADER_BYTES;
  private finished = false;
  private readonly objects: PacketObject[] = [];
  private readonly packet: FramePacket;

  constructor(initialBytes: number = DEFAULT_ENCODER_BYTES) {
    if (!isLittleEndian) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'cozygpu requires a little-endian platform',
      );
    }
    this.capacity = Math.max(align4(initialBytes | 0), 256);
    this.adopt(new ArrayBuffer(this.capacity));
    this.transferList.push(this.buffer as ArrayBuffer);
    this.packet = {
      buffer: this.buffer,
      byteLength: 0,
      frameId: 0,
      commandCount: 0,
      objects: this.objects,
    };
  }

  get byteLength(): number {
    return this.reservedEnd;
  }

  get empty(): boolean {
    return this.commandCount === 0;
  }

  begin(opcode: number, payloadBytes: number, flags = 0): number {
    if (this.finished) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'encoder.begin() after finish(); call reset() first',
      );
    }
    const padded = align4(payloadBytes);
    const at = this.reservedEnd;
    const end = at + COMMAND_HEADER_BYTES + padded;
    if (end > this.u8.byteLength) this.grow(end);
    const h = at >> 2;
    const u32 = this.u32View;
    u32[h] = ((opcode & 0xffff) | ((flags & 0xffff) << 16)) >>> 0;
    u32[h + (CH_PAYLOAD_BYTES >> 2)] = padded;
    const payload = at + COMMAND_HEADER_BYTES;
    this.cursor = payload;
    this.reservedEnd = end;
    this.commandCount++;
    return payload;
  }

  u32(value: number): void {
    const c = this.cursor;
    if (c + 4 > this.reservedEnd) this.overflow(4);
    this.u32View[c >> 2] = value;
    this.cursor = c + 4;
  }

  i32(value: number): void {
    // Uint32Array stores ToUint32(value): the two's-complement bit pattern.
    const c = this.cursor;
    if (c + 4 > this.reservedEnd) this.overflow(4);
    this.u32View[c >> 2] = value | 0;
    this.cursor = c + 4;
  }

  f32(value: number): void {
    const c = this.cursor;
    if (c + 4 > this.reservedEnd) this.overflow(4);
    this.f32View[c >> 2] = value;
    this.cursor = c + 4;
  }

  bytes(
    src: ArrayBufferView,
    srcByteOffset = 0,
    byteLength = src.byteLength - srcByteOffset,
  ): void {
    const c = this.cursor;
    const padded = align4(byteLength);
    if (c + padded > this.reservedEnd) this.overflow(padded);
    if (
      srcByteOffset === 0 &&
      byteLength === src.byteLength &&
      src instanceof Uint8Array
    ) {
      this.u8.set(src, c);
    } else {
      // One temporary view per bulk upload (allowed by the performance rules).
      this.u8.set(
        new Uint8Array(src.buffer, src.byteOffset + srcByteOffset, byteLength),
        c,
      );
    }
    this.zero(c + byteLength, c + padded);
    this.cursor = c + padded;
  }

  utf8(text: string): number {
    const c = this.cursor;
    const room = this.reservedEnd - c;
    // encodeInto refuses a view over a SharedArrayBuffer ("must not be
    // shared"), which is exactly what a command-ring slot is. Encode into a
    // plain scratch buffer and copy. The scratch is kept and only grows, so
    // it costs at most one allocation per size, never one per frame.
    let written: number;
    if (this.shared) {
      let scratch = this.utf8Scratch;
      if (scratch === null || scratch.length < room) {
        scratch = new Uint8Array(room);
        this.utf8Scratch = scratch;
      }
      const result = sharedTextEncoder().encodeInto(
        text,
        room === scratch.length ? scratch : scratch.subarray(0, room),
      );
      if ((result.read ?? 0) < text.length) this.overflow(room + 1);
      written = result.written ?? 0;
      if (written > 0) this.u8.set(scratch.subarray(0, written), c);
    } else {
      const result = sharedTextEncoder().encodeInto(
        text,
        this.u8.subarray(c, c + room),
      );
      if ((result.read ?? 0) < text.length) this.overflow(room + 1);
      written = result.written ?? 0;
    }
    const padded = align4(written);
    this.zero(c + written, c + padded);
    this.cursor = c + padded;
    return written;
  }

  end(): void {
    // Bulk writers fill the payload through the views without moving the
    // cursor, so the cursor is not required to reach the reservation.
    // Unwritten reserved bytes are simply left as they are.
  }

  addObject(obj: PacketObject, transfer: boolean): number {
    const index = this.objects.length;
    this.objects.push(obj);
    // SharedArrayBuffers are shared, never transferred (it would throw).
    const list = this.transferList;
    if (
      transfer &&
      !isSharedArrayBuffer(obj) &&
      list.indexOf(obj as Transferable) < 0 &&
      obj !== this.buffer
    ) {
      list.push(obj as Transferable);
    }
    return index;
  }

  /**
   * Writes the packet header and returns the (reused) packet object.
   * `transferList` then holds `[packet.buffer, ...transferable objects]`, or
   * only the transferable objects when the buffer is a SharedArrayBuffer.
   */
  finish(frameId: number): FramePacket {
    if (this.finished) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'encoder.finish() called twice; call reset() first',
      );
    }
    const u32 = this.u32View;
    const byteLength = this.reservedEnd;
    u32[PH_MAGIC >> 2] = PACKET_MAGIC;
    u32[PH_BYTE_LENGTH >> 2] = byteLength;
    u32[PH_FRAME_ID >> 2] = frameId >>> 0;
    u32[PH_COMMAND_COUNT >> 2] = this.commandCount;

    const packet = this.packet;
    packet.buffer = this.buffer;
    packet.byteLength = byteLength;
    packet.frameId = frameId >>> 0;
    packet.commandCount = this.commandCount;
    this.syncTransferList();
    this.finished = true;
    return packet;
  }

  reset(recycled?: ArrayBuffer | SharedArrayBuffer): void {
    if (
      recycled !== undefined &&
      recycled !== this.buffer &&
      recycled.byteLength >= this.capacity &&
      (recycled.byteLength & 3) === 0
    ) {
      this.adopt(recycled);
    } else if (this.buffer.byteLength === 0) {
      // Our buffer was transferred and nothing came back: allocate a fresh one.
      this.adopt(new ArrayBuffer(this.capacity));
    }
    // Truncate only when needed: `length = 0` releases the backing store, so
    // the push that follows would allocate a new one every frame.
    if (this.objects.length !== 0) this.objects.length = 0;
    const list = this.transferList;
    const base = this.shared ? 0 : 1;
    if (list.length !== base) list.length = base;
    if (!this.shared) list[0] = this.buffer as ArrayBuffer;
    this.listHasBuffer = !this.shared;
    this.cursor = PACKET_HEADER_BYTES;
    this.reservedEnd = PACKET_HEADER_BYTES;
    this.commandCount = 0;
    this.finished = false;
  }

  private adopt(buffer: ArrayBuffer | SharedArrayBuffer): void {
    this.buffer = buffer;
    this.shared = isSharedArrayBuffer(buffer);
    this.u8 = new Uint8Array(buffer);
    this.u32View = new Uint32Array(buffer);
    this.f32View = new Float32Array(buffer);
  }

  private grow(minBytes: number): void {
    if (this.buffer.byteLength === 0) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'encoder buffer was transferred; call reset() before writing',
      );
    }
    let next = this.u8.byteLength * 2;
    while (next < minBytes) next *= 2;
    const old = this.u8;
    this.capacity = next;
    this.adopt(new ArrayBuffer(next));
    this.u8.set(old.subarray(0, this.reservedEnd));
  }

  /**
   * `transferList` starts with the packet buffer only when it is an
   * ArrayBuffer. A ring slot outgrown by `grow()` turns into an ArrayBuffer
   * mid-packet, so the head is inserted here (rare: growth only).
   */
  private syncTransferList(): void {
    const list = this.transferList;
    if (this.shared) return;
    if (this.listHasBuffer) {
      list[0] = this.buffer as ArrayBuffer;
    } else {
      list.unshift(this.buffer as ArrayBuffer);
      this.listHasBuffer = true;
    }
  }

  private zero(from: number, to: number): void {
    const u8 = this.u8;
    for (let i = from; i < to; i++) u8[i] = 0;
  }

  private overflow(bytes: number): never {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `payload overflow: ${bytes} B at ${this.cursor} > ${this.reservedEnd}`,
    );
  }
}

function isSharedArrayBuffer(obj: unknown): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (obj instanceof SharedArrayBuffer) return true;
  // Cross-realm check (rare path: only for objects that are not ArrayBuffers).
  return (
    typeof obj === 'object' &&
    obj !== null &&
    !(obj instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(obj) &&
    Object.prototype.toString.call(obj) === '[object SharedArrayBuffer]'
  );
}
