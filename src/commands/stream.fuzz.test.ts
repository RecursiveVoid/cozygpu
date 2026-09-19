/**
 * Tester: randomized round-trips and corruption fuzzing for the command
 * stream (ARCHITECTURE §3). Deterministic (seeded PRNG).
 */
import { CozyGPUError } from '../types/errors';
import {
  COMMAND_HEADER_BYTES,
  PACKET_HEADER_BYTES,
  createCommandDecoder,
  createCommandEncoder,
  utf8ByteLength,
} from './index';
import type { CommandEncoder, FramePacket } from './types';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Field =
  | { k: 'u32'; v: number }
  | { k: 'i32'; v: number }
  | { k: 'f32'; v: number }
  | { k: 'bytes'; v: Uint8Array; off: number; len: number }
  | { k: 'utf8'; v: string };

interface Cmd {
  opcode: number;
  flags: number;
  fields: Field[];
  /** Extra reserved bytes the writer leaves untouched (bulk-writer style). */
  slack: number;
}

const SPECIAL_F32 = [0, -0, 1, -1, Infinity, -Infinity, NaN, 3.4e38, 1e-45];

function randomString(r: () => number): string {
  let s = '';
  const n = Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const pick = r();
    if (pick < 0.5) s += String.fromCharCode(32 + Math.floor(r() * 90));
    else if (pick < 0.7)
      s += String.fromCharCode(0x80 + Math.floor(r() * 0x700));
    else if (pick < 0.85)
      s += String.fromCharCode(0x800 + Math.floor(r() * 0xd000));
    else if (pick < 0.95)
      s += String.fromCodePoint(0x10000 + Math.floor(r() * 0xfffff));
    else s += String.fromCharCode(0xd800 + Math.floor(r() * 0x800)); // lone surrogate
  }
  return s;
}

function randomCommand(r: () => number): Cmd {
  const fields: Field[] = [];
  const n = Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(r() * 5);
    if (kind === 0) fields.push({ k: 'u32', v: Math.floor(r() * 0x100000000) });
    else if (kind === 1)
      fields.push({ k: 'i32', v: Math.floor(r() * 0x100000000) - 0x80000000 });
    else if (kind === 2)
      fields.push({
        k: 'f32',
        v:
          r() < 0.3
            ? SPECIAL_F32[Math.floor(r() * SPECIAL_F32.length)]
            : Math.fround((r() - 0.5) * 1e6),
      });
    else if (kind === 3) {
      const total = Math.floor(r() * 300);
      const v = new Uint8Array(total);
      for (let j = 0; j < total; j++) v[j] = Math.floor(r() * 256);
      const off = Math.floor(r() * (total + 1));
      const len = Math.floor(r() * (total - off + 1));
      fields.push({ k: 'bytes', v, off, len });
    } else fields.push({ k: 'utf8', v: randomString(r) });
  }
  return {
    opcode: Math.floor(r() * 0x10000),
    flags: Math.floor(r() * 4),
    fields,
    slack: r() < 0.2 ? Math.floor(r() * 9) : 0,
  };
}

function fieldBytes(f: Field): number {
  if (f.k === 'bytes') return (f.len + 3) & ~3;
  if (f.k === 'utf8') return (utf8ByteLength(f.v) + 3) & ~3;
  return 4;
}

function encode(enc: CommandEncoder, cmd: Cmd): number {
  let payload = cmd.slack;
  for (const f of cmd.fields) payload += fieldBytes(f);
  const at = enc.begin(cmd.opcode, payload, cmd.flags);
  for (const f of cmd.fields) {
    if (f.k === 'u32') enc.u32(f.v);
    else if (f.k === 'i32') enc.i32(f.v);
    else if (f.k === 'f32') enc.f32(f.v);
    else if (f.k === 'bytes') enc.bytes(f.v, f.off, f.len);
    else expect(enc.utf8(f.v)).toBe(utf8ByteLength(f.v));
  }
  enc.end();
  return at;
}

describe('command stream: randomized round-trips', () => {
  it('decodes exactly what was encoded (80 packets, tiny start buffer)', () => {
    const r = rng(42);
    const enc = createCommandEncoder(256);
    const dec = createCommandDecoder();
    for (let p = 0; p < 80; p++) {
      enc.reset();
      const cmds: Cmd[] = [];
      const payloadAt: number[] = [];
      const n = Math.floor(r() * 25);
      for (let i = 0; i < n; i++) {
        const c = randomCommand(r);
        cmds.push(c);
        payloadAt.push(encode(enc, c));
      }
      expect(enc.commandCount).toBe(n);
      expect(enc.empty).toBe(n === 0);
      const packet = enc.finish(p);
      expect(packet.byteLength % 4).toBe(0);
      expect(packet.byteLength).toBe(enc.byteLength);
      dec.reset(packet);
      expect(dec.frameId).toBe(p);
      expect(dec.commandCount).toBe(n);
      const rd = dec.reader;
      const offsets: number[] = [];
      for (let i = 0; i < n; i++) {
        expect(dec.next()).toBe(true);
        const c = cmds[i];
        expect(rd.opcode).toBe(c.opcode);
        expect(rd.flags).toBe(c.flags);
        expect(rd.payloadOffset).toBe(payloadAt[i]);
        expect(rd.payloadOffset % 4).toBe(0);
        expect(rd.commandOffset).toBe(rd.payloadOffset - COMMAND_HEADER_BYTES);
        expect(rd.payloadBytes % 4).toBe(0);
        offsets.push(rd.commandOffset);
        for (const f of c.fields) {
          if (f.k === 'u32') expect(rd.u32()).toBe(f.v >>> 0);
          else if (f.k === 'i32') expect(rd.i32()).toBe(f.v | 0);
          else if (f.k === 'f32')
            expect(Object.is(rd.f32(), Math.fround(f.v))).toBe(true);
          else if (f.k === 'bytes') {
            const at = rd.blob(f.len);
            expect(at % 4).toBe(0);
            expect(Array.from(rd.u8.subarray(at, at + f.len))).toEqual(
              Array.from(f.v.subarray(f.off, f.off + f.len)),
            );
            // padding is zero
            for (let z = at + f.len; z < ((at + f.len + 3) & ~3); z++) {
              expect(rd.u8[z]).toBe(0);
            }
          } else {
            const len = utf8ByteLength(f.v);
            const start = (rd as unknown as { cursor: number }).cursor;
            expect(rd.utf8(len)).toBe(
              new TextDecoder().decode(new TextEncoder().encode(f.v)),
            );
            for (let z = start + len; z < ((start + len + 3) & ~3); z++) {
              expect(rd.u8[z]).toBe(0);
            }
          }
        }
      }
      expect(dec.next()).toBe(false);
      // replay in reverse with seek (DRAW replay pattern)
      for (let i = n - 1; i >= 0; i--) {
        dec.seek(offsets[i]);
        expect(rd.opcode).toBe(cmds[i].opcode);
        expect(rd.payloadOffset).toBe(payloadAt[i]);
      }
    }
  });

  it('steady state: recycled buffer keeps the same views and allocates nothing', () => {
    const enc = createCommandEncoder(1024);
    const dec = createCommandDecoder();
    const r = rng(7);
    let recycled: ArrayBuffer | undefined;
    let views: unknown[] | null = null;
    for (let frame = 0; frame < 50; frame++) {
      enc.reset(recycled);
      for (let i = 0; i < 20; i++) {
        enc.begin(0x0210, 20, 1);
        for (let k = 0; k < 5; k++) enc.u32(Math.floor(r() * 1000));
      }
      const packet = enc.finish(frame);
      dec.reset(packet);
      while (dec.next()) {
        /* consume */
      }
      recycled = packet.buffer as ArrayBuffer;
      const now = [
        enc.u8,
        enc.u32View,
        enc.f32View,
        dec.reader.u8,
        dec.reader.u32View,
      ];
      if (frame > 1) {
        for (let v = 0; v < now.length; v++) expect(now[v]).toBe(views![v]);
      }
      views = now;
      expect(enc.transferList).toEqual([packet.buffer]);
    }
  });

  it('i32/f32 bit patterns survive exactly', () => {
    const enc = createCommandEncoder(256);
    enc.reset();
    const ints = [-1, -0x80000000, 0x7fffffff, 0, 1.9, -1.9];
    enc.begin(1, ints.length * 4 + SPECIAL_F32.length * 4);
    for (const v of ints) enc.i32(v);
    for (const v of SPECIAL_F32) enc.f32(v);
    const dec = createCommandDecoder();
    dec.reset(enc.finish(0));
    dec.next();
    for (const v of ints) expect(dec.reader.i32()).toBe(v | 0);
    for (const v of SPECIAL_F32) {
      expect(Object.is(dec.reader.f32(), Math.fround(v))).toBe(true);
    }
  });
});

describe('command stream: corruption fuzzing', () => {
  function buildPacket(r: () => number): FramePacket {
    const enc = createCommandEncoder(256);
    enc.reset();
    const n = 1 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) encode(enc, randomCommand(r));
    const packet = enc.finish(1);
    // copy so mutations do not affect the encoder
    return { ...packet, buffer: packet.buffer.slice(0), objects: [] };
  }

  it('random byte flips either throw INVALID_ARGUMENT or stay in bounds', () => {
    const r = rng(99);
    const dec = createCommandDecoder();
    let rejected = 0;
    for (let iter = 0; iter < 400; iter++) {
      const packet = buildPacket(r);
      const u8 = new Uint8Array(packet.buffer);
      const flips = 1 + Math.floor(r() * 3);
      for (let f = 0; f < flips; f++) {
        // bias towards headers, where corruption matters
        const at =
          r() < 0.5
            ? Math.floor(r() * PACKET_HEADER_BYTES + COMMAND_HEADER_BYTES)
            : Math.floor(r() * packet.byteLength);
        u8[at] ^= 1 << Math.floor(r() * 8);
      }
      try {
        dec.reset(packet);
      } catch (e) {
        expect(e).toBeInstanceOf(CozyGPUError);
        expect((e as CozyGPUError).code).toBe('INVALID_ARGUMENT');
        rejected++;
        // decoder must be inert after a rejected packet
        expect(dec.next()).toBe(false);
        continue;
      }
      const byteLength = new Uint32Array(packet.buffer)[1];
      let count = 0;
      const rd = dec.reader;
      while (dec.next()) {
        count++;
        expect(rd.payloadOffset + rd.payloadBytes).toBeLessThanOrEqual(
          byteLength,
        );
        // reading past the payload throws instead of reading neighbours
        expect(() => rd.skip(rd.payloadBytes + 4)).toThrow(CozyGPUError);
      }
      expect(count).toBe(dec.commandCount);
    }
    expect(rejected).toBeGreaterThan(20);
  });

  it('rejects a buffer whose byte length is not 4-aligned or too small', () => {
    const dec = createCommandDecoder();
    const packet: FramePacket = {
      buffer: new ArrayBuffer(18),
      byteLength: 16,
      frameId: 0,
      commandCount: 0,
      objects: [],
    };
    expect(() => dec.reset(packet)).toThrow(CozyGPUError);
    packet.buffer = new ArrayBuffer(8);
    expect(() => dec.reset(packet)).toThrow(CozyGPUError);
  });

  it('a payloadBytes that wraps past 2^32 is rejected', () => {
    const enc = createCommandEncoder(256);
    enc.reset();
    enc.begin(1, 4);
    enc.u32(5);
    const packet = enc.finish(0);
    // payloadBytes = 0xFFFFFFFC: offset + 8 + payload overflows 2^32 in u32 math
    new Uint32Array(packet.buffer)[(PACKET_HEADER_BYTES >> 2) + 1] = 0xfffffffc;
    expect(() => createCommandDecoder().reset(packet)).toThrow(CozyGPUError);
  });

  it('seek() refuses offsets that are not a command of this packet', () => {
    const enc = createCommandEncoder(256);
    enc.reset();
    enc.begin(1, 8);
    enc.u32(0xffffffff); // looks like an opcode/flags word
    enc.u32(0x7ffffff0); // looks like a huge payloadBytes
    enc.begin(2, 0);
    const dec = createCommandDecoder();
    dec.reset(enc.finish(0));
    expect(() => dec.seek(PACKET_HEADER_BYTES + 2)).toThrow(CozyGPUError); // misaligned
    expect(() => dec.seek(4)).toThrow(CozyGPUError); // inside the packet header
    expect(() => dec.seek(1 << 20)).toThrow(CozyGPUError); // past the end
  });

  // Regression (M1 low bug): seek() used to accept an aligned offset INSIDE
  // a payload and take the reader's end from garbage (here 0x7ffffff0 B).
  it('seek() into the middle of a payload keeps the reader within byteLength', () => {
    const enc = createCommandEncoder(256);
    enc.reset();
    enc.begin(1, 8);
    enc.u32(0xffffffff);
    enc.u32(0x7ffffff0);
    enc.begin(2, 0);
    const packet = enc.finish(0);
    const dec = createCommandDecoder();
    dec.reset(packet);
    expect(() => dec.seek(PACKET_HEADER_BYTES + COMMAND_HEADER_BYTES)).toThrow(
      CozyGPUError,
    );
    // real command offsets still work, and next() continues after them
    dec.seek(PACKET_HEADER_BYTES + COMMAND_HEADER_BYTES + 8);
    expect(dec.reader.opcode).toBe(2);
    expect(dec.next()).toBe(false);
    dec.seek(PACKET_HEADER_BYTES);
    expect(dec.reader.opcode).toBe(1);
    expect(dec.reader.payloadBytes).toBe(8);
    expect(dec.next()).toBe(true);
    expect(dec.reader.opcode).toBe(2);
  });

  it('seek() with a random aligned offset never reads past the packet', () => {
    const r = rng(11);
    for (let t = 0; t < 500; t++) {
      const enc = createCommandEncoder(256);
      enc.reset();
      const n = 1 + Math.floor(r() * 6);
      for (let c = 0; c < n; c++) {
        const words = Math.floor(r() * 5);
        enc.begin(1 + c, words * 4);
        for (let k = 0; k < words; k++) enc.u32((r() * 0x100000000) >>> 0);
      }
      const packet = enc.finish(0);
      const dec = createCommandDecoder();
      dec.reset(packet);
      const off = PACKET_HEADER_BYTES + 4 * Math.floor(r() * 16);
      try {
        dec.seek(off);
      } catch (e) {
        expect(e).toBeInstanceOf(CozyGPUError);
        continue;
      }
      const rd = dec.reader;
      expect(rd.payloadOffset + rd.payloadBytes).toBeLessThanOrEqual(
        packet.byteLength,
      );
    }
  });
});

describe('utf8ByteLength', () => {
  it('matches TextEncoder on 2000 random strings (incl. lone surrogates)', () => {
    const r = rng(5);
    const te = new TextEncoder();
    for (let i = 0; i < 2000; i++) {
      const s = randomString(r);
      expect(utf8ByteLength(s)).toBe(te.encode(s).byteLength);
    }
    // trailing high surrogate, reversed pair
    expect(utf8ByteLength('a\ud800')).toBe(te.encode('a\ud800').byteLength);
    expect(utf8ByteLength('\udc00\ud800')).toBe(
      te.encode('\udc00\ud800').byteLength,
    );
  });

  it('utf8() into a too-small reservation throws instead of truncating', () => {
    const enc = createCommandEncoder(256);
    enc.reset();
    enc.begin(1, 4);
    expect(() => enc.utf8('héllo')).toThrow(CozyGPUError);
  });
});
