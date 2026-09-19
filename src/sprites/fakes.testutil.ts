/**
 * Test fakes. A minimal CommandEncoder that records the
 * binary stream, a FrontFrame around it, and a tiny command parser. Node only;
 * never imported by library code.
 */
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import type {
  CommandEncoder,
  FramePacket,
  PacketObject,
} from '../commands/types';
import type { FrontFrame } from '../types/core';

export interface RecordedCommand {
  opcode: number;
  flags: number;
  /** Payload as u32 words (first 64 words at most). */
  words: number[];
  payloadOffset: number;
  payloadBytes: number;
}

export class FakeEncoder implements CommandEncoder {
  buf = new ArrayBuffer(1 << 16);
  u8 = new Uint8Array(this.buf);
  u32View = new Uint32Array(this.buf);
  f32View = new Float32Array(this.buf);
  cursor = 16;
  commandCount = 0;
  objects: PacketObject[] = [];
  transferList: Transferable[] = [];
  private payloadEnd = 0;

  get byteLength(): number {
    return this.cursor;
  }
  get empty(): boolean {
    return this.commandCount === 0;
  }

  private ensure(bytes: number): void {
    if (this.cursor + bytes <= this.buf.byteLength) return;
    let n = this.buf.byteLength;
    while (this.cursor + bytes > n) n *= 2;
    const next = new ArrayBuffer(n);
    new Uint8Array(next).set(this.u8);
    this.buf = next;
    this.u8 = new Uint8Array(next);
    this.u32View = new Uint32Array(next);
    this.f32View = new Float32Array(next);
  }

  begin(opcode: number, payloadBytes: number, flags = 0): number {
    const padded = (payloadBytes + 3) & ~3;
    this.ensure(8 + padded);
    const dv = new DataView(this.buf);
    dv.setUint16(this.cursor, opcode, true);
    dv.setUint16(this.cursor + 2, flags, true);
    dv.setUint32(this.cursor + 4, padded, true);
    this.cursor += 8;
    this.payloadEnd = this.cursor + padded;
    this.commandCount++;
    return this.cursor;
  }
  u32(v: number): void {
    this.u32View[this.cursor >> 2] = v;
    this.cursor += 4;
  }
  i32(v: number): void {
    this.u32View[this.cursor >> 2] = v | 0;
    this.cursor += 4;
  }
  f32(v: number): void {
    this.f32View[this.cursor >> 2] = v;
    this.cursor += 4;
  }
  bytes(src: ArrayBufferView, off = 0, len = src.byteLength - off): void {
    this.u8.set(
      new Uint8Array(src.buffer, src.byteOffset + off, len),
      this.cursor,
    );
    this.cursor = (this.cursor + len + 3) & ~3;
  }
  utf8(): number {
    throw new Error('unused');
  }
  end(): void {
    if (this.cursor !== this.payloadEnd) {
      throw new Error(`payload mismatch ${this.cursor} != ${this.payloadEnd}`);
    }
  }
  addObject(obj: PacketObject): number {
    this.objects.push(obj);
    return this.objects.length - 1;
  }
  finish(frameId: number): FramePacket {
    return {
      buffer: this.buf,
      byteLength: this.cursor,
      frameId,
      commandCount: this.commandCount,
      objects: this.objects,
    };
  }
  reset(): void {
    this.cursor = 16;
    this.commandCount = 0;
    this.objects = [];
  }

  commands(): RecordedCommand[] {
    const out: RecordedCommand[] = [];
    const dv = new DataView(this.buf);
    let at = 16;
    while (at < this.cursor) {
      const opcode = dv.getUint16(at, true);
      const flags = dv.getUint16(at + 2, true);
      const payloadBytes = dv.getUint32(at + 4, true);
      const words: number[] = [];
      for (let i = 0; i < Math.min(payloadBytes / 4, 64); i++) {
        words.push(dv.getUint32(at + 8 + i * 4, true));
      }
      out.push({ opcode, flags, words, payloadOffset: at + 8, payloadBytes });
      at += 8 + payloadBytes;
    }
    return out;
  }
}

export class FakeFrame implements FrontFrame {
  rendererId = 1;
  encoder = new FakeEncoder();
  frameId = 0;
  time = 0;
  dt = 1 / 60;
  cssWidth = 800;
  cssHeight = 600;
  resolution = 1;
  sharedMemory = false;
  useSharedArrayBuffer = false;
  generation = 0;
  caps = FAKE_CAPS;
  registered: (ArrayBuffer | SharedArrayBuffer)[] = [];

  isSystemReady(_range: number): boolean {
    return true;
  }

  registerShared(buffer: ArrayBuffer | SharedArrayBuffer): number {
    let i = this.registered.indexOf(buffer);
    if (i < 0) {
      this.registered.push(buffer);
      i = this.registered.length - 1;
    }
    return 100 + i;
  }
  readback(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('unused'));
  }

  next(): this {
    this.frameId++;
    this.encoder.reset();
    return this;
  }
}
