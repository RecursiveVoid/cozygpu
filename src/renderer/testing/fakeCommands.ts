/**
 * TEST-ONLY minimal implementations of the command stream
 * contracts (src/commands/types.ts), used to test RenderCore / Renderer in
 * isolation from the worker owner's encoder. Not part of the library.
 * Follows ARCHITECTURE §3 byte rules (16 B packet header, 8 B command header,
 * 4-byte aligned payloads).
 */
import {
  COMMAND_HEADER_BYTES,
  CH_FLAGS,
  CH_OPCODE,
  CH_PAYLOAD_BYTES,
  PACKET_HEADER_BYTES,
  PACKET_MAGIC,
  PH_BYTE_LENGTH,
  PH_COMMAND_COUNT,
  PH_FRAME_ID,
  PH_MAGIC,
} from '../../commands/opcodes';
import type {
  CommandDecoder,
  CommandEncoder,
  CommandReader,
  FramePacket,
  PacketObject,
} from '../../commands/types';
import { CozyGPUError } from '../../types/errors';

const align4 = (n: number): number => (n + 3) & ~3;

export class TestEncoder implements CommandEncoder {
  u8!: Uint8Array;
  u32View!: Uint32Array;
  f32View!: Float32Array;
  cursor = PACKET_HEADER_BYTES;
  commandCount = 0;
  transferList: Transferable[] = [];
  private buffer!: ArrayBuffer;
  private objects: PacketObject[] = [];
  private headerOffset = 0;

  constructor(bytes = 1024) {
    this.adopt(new ArrayBuffer(bytes));
  }

  get byteLength(): number {
    return this.cursor;
  }

  get empty(): boolean {
    return this.commandCount === 0;
  }

  begin(opcode: number, payloadBytes: number, flags = 0): number {
    const padded = align4(payloadBytes);
    this.ensure(this.cursor + COMMAND_HEADER_BYTES + padded);
    const at = this.cursor;
    this.headerOffset = at;
    this.u8[at + CH_OPCODE] = opcode & 0xff;
    this.u8[at + CH_OPCODE + 1] = (opcode >> 8) & 0xff;
    this.u8[at + CH_FLAGS] = flags & 0xff;
    this.u8[at + CH_FLAGS + 1] = (flags >> 8) & 0xff;
    this.u32View[(at + CH_PAYLOAD_BYTES) >> 2] = padded;
    this.cursor = at + COMMAND_HEADER_BYTES;
    this.commandCount++;
    return this.cursor;
  }

  u32(value: number): void {
    this.u32View[this.cursor >> 2] = value >>> 0;
    this.cursor += 4;
  }

  i32(value: number): void {
    this.u32View[this.cursor >> 2] = value | 0;
    this.cursor += 4;
  }

  f32(value: number): void {
    this.f32View[this.cursor >> 2] = value;
    this.cursor += 4;
  }

  bytes(src: ArrayBufferView, srcByteOffset = 0, byteLength?: number): void {
    const n = byteLength ?? src.byteLength - srcByteOffset;
    this.u8.set(
      new Uint8Array(src.buffer, src.byteOffset + srcByteOffset, n),
      this.cursor,
    );
    this.cursor += align4(n);
  }

  utf8(text: string): number {
    const encoded = new TextEncoder().encode(text);
    this.bytes(encoded);
    return encoded.byteLength;
  }

  end(): void {
    const expected =
      this.headerOffset +
      COMMAND_HEADER_BYTES +
      this.u32View[(this.headerOffset + CH_PAYLOAD_BYTES) >> 2];
    if (this.cursor !== expected) {
      throw new Error(`payload mismatch: cursor ${this.cursor} != ${expected}`);
    }
  }

  addObject(obj: PacketObject, transfer: boolean): number {
    this.objects.push(obj);
    if (transfer) this.transferList.push(obj as Transferable);
    return this.objects.length - 1;
  }

  finish(frameId: number): FramePacket {
    this.u32View[PH_MAGIC >> 2] = PACKET_MAGIC;
    this.u32View[PH_BYTE_LENGTH >> 2] = this.cursor;
    this.u32View[PH_FRAME_ID >> 2] = frameId;
    this.u32View[PH_COMMAND_COUNT >> 2] = this.commandCount;
    return {
      buffer: this.buffer,
      byteLength: this.cursor,
      frameId,
      commandCount: this.commandCount,
      objects: this.objects,
    };
  }

  reset(recycled?: ArrayBuffer): void {
    if (recycled && recycled.byteLength >= this.buffer.byteLength) {
      this.adopt(recycled);
    }
    this.cursor = PACKET_HEADER_BYTES;
    this.commandCount = 0;
    this.objects = [];
    this.transferList = [];
  }

  private ensure(bytes: number): void {
    if (bytes <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength;
    while (size < bytes) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8);
    this.adopt(next);
  }

  private adopt(buffer: ArrayBuffer): void {
    this.buffer = buffer;
    this.u8 = new Uint8Array(buffer);
    this.u32View = new Uint32Array(buffer, 0, buffer.byteLength >> 2);
    this.f32View = new Float32Array(buffer, 0, buffer.byteLength >> 2);
  }
}

class TestReader implements CommandReader {
  opcode = 0;
  flags = 0;
  commandOffset = 0;
  payloadOffset = 0;
  payloadBytes = 0;
  u8 = new Uint8Array(0);
  u32View = new Uint32Array(0);
  f32View = new Float32Array(0);
  cursor = 0;
  packet: FramePacket | null = null;

  u32(): number {
    const v = this.u32View[this.cursor >> 2];
    this.cursor += 4;
    return v;
  }

  i32(): number {
    const v = this.u32View[this.cursor >> 2] | 0;
    this.cursor += 4;
    return v;
  }

  f32(): number {
    const v = this.f32View[this.cursor >> 2];
    this.cursor += 4;
    return v;
  }

  blob(byteLength: number): number {
    const at = this.cursor;
    this.cursor += align4(byteLength);
    return at;
  }

  utf8(byteLength: number): string {
    const at = this.blob(byteLength);
    return new TextDecoder().decode(this.u8.subarray(at, at + byteLength));
  }

  skip(byteLength: number): void {
    this.cursor += align4(byteLength);
  }

  object<T extends PacketObject>(index: number): T {
    return this.packet!.objects[index] as T;
  }

  load(offset: number): void {
    this.commandOffset = offset;
    this.opcode =
      this.u8[offset + CH_OPCODE] | (this.u8[offset + CH_OPCODE + 1] << 8);
    this.flags =
      this.u8[offset + CH_FLAGS] | (this.u8[offset + CH_FLAGS + 1] << 8);
    this.payloadBytes = this.u32View[(offset + CH_PAYLOAD_BYTES) >> 2];
    this.payloadOffset = offset + COMMAND_HEADER_BYTES;
    this.cursor = this.payloadOffset;
  }
}

export class TestDecoder implements CommandDecoder {
  readonly reader = new TestReader();
  frameId = 0;
  commandCount = 0;
  private next_ = PACKET_HEADER_BYTES;
  private byteLength = 0;

  reset(packet: FramePacket): void {
    const u32 = new Uint32Array(
      packet.buffer as ArrayBuffer,
      0,
      packet.buffer.byteLength >> 2,
    );
    if (u32[PH_MAGIC >> 2] !== PACKET_MAGIC) {
      throw new CozyGPUError('INVALID_ARGUMENT', 'bad packet magic');
    }
    const r = this.reader;
    r.packet = packet;
    r.u8 = new Uint8Array(packet.buffer as ArrayBuffer);
    r.u32View = u32;
    r.f32View = new Float32Array(
      packet.buffer as ArrayBuffer,
      0,
      packet.buffer.byteLength >> 2,
    );
    this.frameId = u32[PH_FRAME_ID >> 2];
    this.commandCount = u32[PH_COMMAND_COUNT >> 2];
    this.byteLength = u32[PH_BYTE_LENGTH >> 2];
    this.next_ = PACKET_HEADER_BYTES;
  }

  next(): boolean {
    if (this.next_ + COMMAND_HEADER_BYTES > this.byteLength) return false;
    this.reader.load(this.next_);
    this.next_ = this.reader.payloadOffset + this.reader.payloadBytes;
    return true;
  }

  seek(commandOffset: number): void {
    this.reader.load(commandOffset);
    this.next_ = this.reader.payloadOffset + this.reader.payloadBytes;
  }
}
