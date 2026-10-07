/**
 * Minimal in-memory command writer/reader used by swarm unit
 * tests and the swarm GPU harness (examples/swarm/harness). Implements the
 * CommandWriter / CommandReader contracts from src/commands/types.ts well
 * enough for opcode range 0x03; the real implementation lives in
 * src/commands.
 */
import {
  COMMAND_HEADER_BYTES,
  PACKET_HEADER_BYTES,
} from '../../commands/opcodes';
import type {
  CommandEncoder,
  CommandReader,
  FramePacket,
  PacketObject,
} from '../../commands/types';

export class FakeEncoder implements CommandEncoder {
  private buffer = new ArrayBuffer(1 << 16);
  u8 = new Uint8Array(this.buffer);
  u32View = new Uint32Array(this.buffer);
  f32View = new Float32Array(this.buffer);
  cursor = PACKET_HEADER_BYTES;
  commandCount = 0;
  transferList: Transferable[] = [];
  private objects: PacketObject[] = [];
  private payloadEnd = 0;

  get byteLength(): number {
    return this.cursor;
  }
  get empty(): boolean {
    return this.commandCount === 0;
  }

  begin(opcode: number, payloadBytes: number, flags = 0): number {
    const padded = (payloadBytes + 3) & ~3;
    const start = this.cursor;
    this.ensure(start + COMMAND_HEADER_BYTES + padded);
    new DataView(this.buffer).setUint16(start, opcode, true);
    new DataView(this.buffer).setUint16(start + 2, flags, true);
    this.u32View[(start >> 2) + 1] = padded;
    this.cursor = start + COMMAND_HEADER_BYTES;
    this.payloadEnd = this.cursor + padded;
    this.u8.fill(0, this.cursor, this.payloadEnd);
    this.commandCount++;
    return this.cursor;
  }
  u32(value: number): void {
    this.u32View[this.cursor >> 2] = value;
    this.cursor += 4;
  }
  i32(value: number): void {
    this.u32View[this.cursor >> 2] = value >>> 0;
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
    this.cursor += (n + 3) & ~3;
  }
  utf8(text: string): number {
    const bytes = new TextEncoder().encode(text);
    this.bytes(bytes);
    return bytes.byteLength;
  }
  end(): void {
    if (this.cursor !== this.payloadEnd) {
      throw new Error(
        `payload size mismatch: wrote to ${this.cursor}, reserved ${this.payloadEnd}`,
      );
    }
  }
  addObject(obj: PacketObject): number {
    this.objects.push(obj);
    return this.objects.length - 1;
  }
  finish(frameId: number): FramePacket {
    const u32 = this.u32View;
    u32[0] = 0x31475a43;
    u32[1] = this.cursor;
    u32[2] = frameId;
    u32[3] = this.commandCount;
    return {
      buffer: this.buffer,
      byteLength: this.cursor,
      frameId,
      commandCount: this.commandCount,
      objects: this.objects,
    };
  }
  reset(): void {
    this.cursor = PACKET_HEADER_BYTES;
    this.commandCount = 0;
    this.objects = [];
  }

  private ensure(bytes: number): void {
    if (bytes <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < bytes) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8);
    this.buffer = next;
    this.u8 = new Uint8Array(next);
    this.u32View = new Uint32Array(next);
    this.f32View = new Float32Array(next);
  }
}

export interface DecodedCommand {
  opcode: number;
  flags: number;
  commandOffset: number;
  payloadOffset: number;
  payloadBytes: number;
}

/** Sequential reader over a finished packet. */
export class FakeReader implements CommandReader {
  opcode = 0;
  flags = 0;
  commandOffset = 0;
  payloadOffset = 0;
  payloadBytes = 0;
  readonly u8: Uint8Array;
  readonly u32View: Uint32Array;
  readonly f32View: Float32Array;
  private at = 0;
  private next = PACKET_HEADER_BYTES;
  private readonly end: number;
  private readonly packet: FramePacket;

  constructor(packet: FramePacket) {
    this.packet = packet;
    this.u8 = new Uint8Array(packet.buffer);
    this.u32View = new Uint32Array(packet.buffer);
    this.f32View = new Float32Array(packet.buffer);
    this.end = packet.byteLength;
  }

  /** Advances to the next command; false at the end. */
  advance(): boolean {
    if (this.next >= this.end) return false;
    this.seek(this.next);
    this.next = this.payloadOffset + this.payloadBytes;
    return true;
  }

  seek(commandOffset: number): void {
    const view = new DataView(this.u8.buffer);
    this.commandOffset = commandOffset;
    this.opcode = view.getUint16(commandOffset, true);
    this.flags = view.getUint16(commandOffset + 2, true);
    this.payloadBytes = this.u32View[(commandOffset >> 2) + 1];
    this.payloadOffset = commandOffset + COMMAND_HEADER_BYTES;
    this.at = this.payloadOffset;
  }

  /** All commands of the packet (test helper). */
  list(): DecodedCommand[] {
    const out: DecodedCommand[] = [];
    let offset = PACKET_HEADER_BYTES;
    while (offset < this.end) {
      this.seek(offset);
      out.push({
        opcode: this.opcode,
        flags: this.flags,
        commandOffset: this.commandOffset,
        payloadOffset: this.payloadOffset,
        payloadBytes: this.payloadBytes,
      });
      offset = this.payloadOffset + this.payloadBytes;
    }
    this.next = PACKET_HEADER_BYTES;
    return out;
  }

  u32(): number {
    const v = this.u32View[this.at >> 2];
    this.at += 4;
    return v;
  }
  i32(): number {
    const v = this.u32View[this.at >> 2] | 0;
    this.at += 4;
    return v;
  }
  f32(): number {
    const v = this.f32View[this.at >> 2];
    this.at += 4;
    return v;
  }
  blob(byteLength: number): number {
    const at = this.at;
    this.at += (byteLength + 3) & ~3;
    return at;
  }
  utf8(byteLength: number): string {
    const at = this.blob(byteLength);
    return new TextDecoder().decode(this.u8.subarray(at, at + byteLength));
  }
  skip(byteLength: number): void {
    this.at += (byteLength + 3) & ~3;
  }
  object<T extends PacketObject>(index: number): T {
    return this.packet.objects[index] as T;
  }
}
