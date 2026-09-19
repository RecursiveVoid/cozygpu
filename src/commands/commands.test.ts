import { CozyGPUError } from '../types/errors';
import {
  SPRITE_INSTANCE_BYTES,
  SWARM_COLD_BYTES,
  SWARM_HOT_BYTES,
  SWARM_SPAWN_BYTES,
} from '../types/layouts';
import {
  COMMAND_HEADER_BYTES,
  CommandFlag,
  Op,
  PACKET_HEADER_BYTES,
  PACKET_MAGIC,
  createCommandDecoder,
  createCommandEncoder,
  opcodeRange,
  utf8ByteLength,
} from './index';
import type { CommandEncoder, CommandReader, FramePacket } from './types';

type Field =
  | { k: 'u32'; v: number }
  | { k: 'i32'; v: number }
  | { k: 'f32'; v: number }
  | { k: 'bytes'; v: Uint8Array }
  | { k: 'utf8'; v: string };

const u = (v: number): Field => ({ k: 'u32', v });
const f = (v: number): Field => ({ k: 'f32', v });
const b = (n: number, seed = 1): Field => {
  const v = new Uint8Array(n);
  for (let i = 0; i < n; i++) v[i] = (i * 31 + seed) & 0xff;
  return { k: 'bytes', v };
};
const s = (v: string): Field => ({ k: 'utf8', v });

function fieldBytes(field: Field): number {
  switch (field.k) {
    case 'bytes':
      return (field.v.byteLength + 3) & ~3;
    case 'utf8':
      return (utf8ByteLength(field.v) + 3) & ~3;
    default:
      return 4;
  }
}

const computeSrc = '@compute @workgroup_size(64) fn main() { /* ü → 🚀 */ }';
const renderSrc =
  '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(); }';

/** One representative payload per opcode, following docs/ARCHITECTURE.md §3.4. */
const specs: Array<[number, number, Field[]]> = [
  [Op.NOP, 0, []],
  [Op.FRAME_BEGIN, 0, [f(1.5), f(1 / 60)]],
  [Op.RESIZE, 0, [f(800), f(600), f(2)]],
  [Op.SET_CLEAR_COLOR, 0, [f(0.1), f(0.2), f(0.3), f(1)]],
  [Op.SET_VIEW, 0, [f(1), f(0), f(0), f(1), f(10), f(-20)]],
  [Op.TEXTURE_CREATE, 0, [u(3), u(64), u(32), u(0), u(16)]],
  [Op.TEXTURE_UPLOAD_PIXELS, 0, [u(3), u(0), u(0), u(3), u(1), b(12)]],
  [Op.TEXTURE_UPLOAD_BITMAP, 0, [u(3), u(0), u(1)]],
  [Op.TEXTURE_DESTROY, 0, [u(3)]],
  // M2 (payloads frozen by the architect; ARCHITECTURE §3.4)
  [Op.TEXTURE_UPLOAD_BITMAP_REGION, 0, [u(3), u(0), u(16), u(32), u(0)]],
  [
    Op.TEXTURE_UPLOAD_COMPRESSED,
    0,
    [u(3), u(1), u(32), u(16), u(0), u(0), u(128)],
  ],
  [Op.TEXTURE_GENERATE_MIPMAPS, 0, [u(3)]],
  [Op.SHARED_REGISTER, 0, [u(1), u(0)]],
  [Op.SHARED_RELEASE, 0, [u(1)]],
  [Op.READBACK, 0, [u(9), u(1), u(2), u(0), u(10)]],
  [Op.PICK, 0, [u(10), f(120.5), f(64.25)]],
  [Op.SPRITE_BUFFER_ALLOC, 0, [u(1), u(100000)]],
  [Op.SPRITE_BUFFER_DESTROY, 0, [u(1)]],
  [Op.SPRITE_UPLOAD, 0, [u(1), u(5), u(3), b(3 * SPRITE_INSTANCE_BYTES)]],
  [Op.SPRITE_UPLOAD_SHARED, 0, [u(1), u(0), u(100), u(2), u(400)]],
  [Op.SPRITE_DRAW, CommandFlag.DRAW, [u(1), u(0), u(500), u(3), u(0)]],
  [
    Op.SWARM_CREATE,
    0,
    [
      u(7),
      u(1_000_000),
      u(0xffffffff),
      u(1),
      u(8),
      u(64),
      u(utf8ByteLength(computeSrc)),
      u(utf8ByteLength(renderSrc)),
      s(computeSrc),
      s(renderSrc),
    ],
  ],
  [Op.SWARM_DESTROY, 0, [u(7)]],
  [
    Op.SWARM_SET_PIPELINE,
    0,
    [
      u(7),
      u(2),
      u(1),
      u(0),
      u(32),
      u(utf8ByteLength(computeSrc)),
      u(utf8ByteLength(renderSrc)),
      s(computeSrc),
      s(renderSrc),
    ],
  ],
  [Op.SWARM_WRITE_HOT, 0, [u(7), u(0), u(2), b(2 * SWARM_HOT_BYTES)]],
  [Op.SWARM_WRITE_COLD, 0, [u(7), u(0), u(2), b(2 * SWARM_COLD_BYTES)]],
  [Op.SWARM_SPAWN, CommandFlag.COMPUTE, [u(7), b(SWARM_SPAWN_BYTES)]],
  [Op.SWARM_KILL_RANGE, CommandFlag.COMPUTE, [u(7), u(10), u(20)]],
  [Op.SWARM_KILL_LIST, CommandFlag.COMPUTE, [u(7), u(3), u(1), u(5), u(9)]],
  [Op.SWARM_SET_PARAMS, 0, [u(7), u(8), u(5), b(5)]],
  [Op.SWARM_STEP, CommandFlag.COMPUTE, [u(7), f(0.016), u(2), u(1000)]],
  [
    Op.SWARM_DRAW,
    CommandFlag.DRAW,
    [u(7), f(1), f(0), f(0), f(1), f(0), f(0), f(0.5), u(1000)],
  ],
  [Op.SWARM_SET_FRAMES, 0, [u(7), u(1), f(0), f(0), f(0.5), f(0.5)]],
  [Op.SWARM_SET_PICK, 0, [u(7), u(42)]],
  [Op.FRAME_END, 0, []],
];

function encodeSpec(
  enc: CommandEncoder,
  op: number,
  flags: number,
  fields: Field[],
): void {
  let bytes = 0;
  for (const field of fields) bytes += fieldBytes(field);
  const payload = enc.begin(op, bytes, flags);
  expect(payload % 4).toBe(0);
  for (const field of fields) {
    switch (field.k) {
      case 'u32':
        enc.u32(field.v);
        break;
      case 'i32':
        enc.i32(field.v);
        break;
      case 'f32':
        enc.f32(field.v);
        break;
      case 'bytes':
        enc.bytes(field.v);
        break;
      case 'utf8':
        expect(enc.utf8(field.v)).toBe(utf8ByteLength(field.v));
        break;
    }
    expect(enc.cursor % 4).toBe(0);
  }
  expect(enc.cursor).toBe(payload + bytes);
  enc.end();
}

function checkSpec(
  r: CommandReader,
  op: number,
  flags: number,
  fields: Field[],
): void {
  expect(r.opcode).toBe(op);
  expect(r.flags).toBe(flags);
  expect(r.payloadOffset).toBe(r.commandOffset + COMMAND_HEADER_BYTES);
  expect(r.payloadOffset % 4).toBe(0);
  expect(r.payloadBytes % 4).toBe(0);
  for (const field of fields) {
    switch (field.k) {
      case 'u32':
        expect(r.u32()).toBe(field.v >>> 0);
        break;
      case 'i32':
        expect(r.i32()).toBe(field.v | 0);
        break;
      case 'f32':
        expect(r.f32()).toBeCloseTo(field.v, 6);
        break;
      case 'bytes': {
        const n = field.v.byteLength;
        const at = r.blob(n);
        expect(Array.from(r.u8.subarray(at, at + n))).toEqual(
          Array.from(field.v),
        );
        for (let i = n; i < ((n + 3) & ~3); i++) expect(r.u8[at + i]).toBe(0);
        break;
      }
      case 'utf8':
        expect(r.utf8(utf8ByteLength(field.v))).toBe(field.v);
        break;
    }
  }
}

describe('command stream', () => {
  it('covers every opcode in the Op table', () => {
    const covered = new Set(specs.map(([op]) => op));
    for (const op of Object.values(Op)) expect(covered.has(op)).toBe(true);
  });

  it('round-trips every opcode with alignment and padding', () => {
    const enc = createCommandEncoder();
    for (const [op, flags, fields] of specs) encodeSpec(enc, op, flags, fields);
    expect(enc.commandCount).toBe(specs.length);
    expect(enc.byteLength % 4).toBe(0);
    const packet = enc.finish(42);
    expect(packet.frameId).toBe(42);
    expect(packet.byteLength).toBe(enc.byteLength);
    expect(enc.transferList[0]).toBe(packet.buffer);

    const dec = createCommandDecoder();
    dec.reset(packet);
    expect(dec.frameId).toBe(42);
    expect(dec.commandCount).toBe(specs.length);
    let i = 0;
    while (dec.next()) {
      const [op, flags, fields] = specs[i++];
      checkSpec(dec.reader, op, flags, fields);
    }
    expect(i).toBe(specs.length);
  });

  it('matches the SPRITE_DRAW hex example from ARCHITECTURE §3.3', () => {
    const enc = createCommandEncoder();
    const at = enc.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
    enc.u32(1);
    enc.u32(0);
    enc.u32(500);
    enc.u32(3);
    enc.u32(0);
    const packet = enc.finish(1);
    const hex = Array.from(new Uint8Array(packet.buffer, at - 8, 28))
      .map(x => x.toString(16).padStart(2, '0'))
      .join(' ');
    expect(hex).toBe(
      '10 02 01 00 14 00 00 00 01 00 00 00 00 00 00 00 f4 01 00 00 03 00 00 00 00 00 00 00',
    );
    const u32 = new Uint32Array(packet.buffer, 0, 4);
    expect(u32[0]).toBe(PACKET_MAGIC);
    expect(u32[1]).toBe(PACKET_HEADER_BYTES + 28);
    expect(opcodeRange(Op.SPRITE_DRAW)).toBe(2);
  });

  it('supports i32, bulk view writes and seek replay of DRAW commands', () => {
    const enc = createCommandEncoder();
    enc.begin(Op.NOP, 4);
    enc.i32(-123);
    const n = 1000;
    const at = enc.begin(Op.SWARM_KILL_LIST, 8 + n * 4, CommandFlag.COMPUTE);
    enc.u32(7);
    enc.u32(n);
    const list = enc.u32View;
    for (let i = 0; i < n; i++) list[(enc.cursor >> 2) + i] = i * 3;
    const draw1 = enc.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
    enc.f32View[draw1 >> 2] = 1; // bulk scalar writes without moving the cursor
    enc.begin(Op.SWARM_STEP, 16, CommandFlag.COMPUTE);
    const draw2 = enc.begin(Op.SWARM_DRAW, 36, CommandFlag.DRAW);
    enc.u32(99);
    const packet = enc.finish(5);

    const dec = createCommandDecoder();
    dec.reset(packet);
    const drawOffsets: number[] = [];
    while (dec.next()) {
      const r = dec.reader;
      if (r.flags & CommandFlag.DRAW) {
        drawOffsets.push(r.commandOffset);
        continue;
      }
      if (r.opcode === Op.NOP) expect(r.i32()).toBe(-123);
      if (r.opcode === Op.SWARM_KILL_LIST) {
        expect(r.payloadOffset).toBe(at);
        expect(r.u32()).toBe(7);
        const count = r.u32();
        const p = r.blob(count * 4);
        expect(r.u32View[(p >> 2) + 999]).toBe(2997);
      }
    }
    expect(drawOffsets).toEqual([draw1 - 8, draw2 - 8]);
    dec.seek(drawOffsets[1]);
    expect(dec.reader.opcode).toBe(Op.SWARM_DRAW);
    expect(dec.reader.u32()).toBe(99);
    dec.seek(drawOffsets[0]);
    expect(dec.reader.opcode).toBe(Op.SPRITE_DRAW);
    expect(dec.reader.f32()).toBe(1);
    // next() continues after the sought command
    expect(dec.next()).toBe(true);
    expect(dec.reader.opcode).toBe(Op.SWARM_STEP);
  });

  it('bytes() honours srcByteOffset/byteLength on any view type', () => {
    const enc = createCommandEncoder();
    const src = new Float32Array([1, 2, 3, 4]);
    enc.begin(Op.SWARM_SET_PARAMS, 8);
    enc.bytes(src, 4, 7); // bytes of [2] and 3 bytes of [3]
    const packet = enc.finish(0);
    const dec = createCommandDecoder();
    dec.reset(packet);
    dec.next();
    const at = dec.reader.blob(7);
    expect(dec.reader.f32View[at >> 2]).toBe(2);
    expect(dec.reader.u8[at + 7]).toBe(0);
  });

  it('grows ×2, keeps written data, and rebuilds views', () => {
    const enc = createCommandEncoder(256);
    const firstView = enc.u8;
    enc.begin(Op.TEXTURE_DESTROY, 4);
    enc.u32(77);
    const big = b(10_000, 7);
    enc.begin(Op.SPRITE_UPLOAD, 12 + 10_000);
    enc.u32(1);
    enc.u32(0);
    enc.u32(250);
    enc.bytes((big as { v: Uint8Array }).v);
    expect(enc.u8).not.toBe(firstView);
    expect(enc.u8.byteLength).toBe(16384);
    const packet = enc.finish(3);
    const dec = createCommandDecoder();
    dec.reset(packet);
    dec.next();
    expect(dec.reader.u32()).toBe(77);
    dec.next();
    checkSpec(dec.reader, Op.SPRITE_UPLOAD, 0, [u(1), u(0), u(250), big]);
    expect(dec.next()).toBe(false);
  });

  it('recycles buffers: same buffer reused, detached buffers replaced, small ones dropped', () => {
    const enc = createCommandEncoder(1024);
    enc.begin(Op.NOP, 0);
    const p1 = enc.finish(1);
    const buf1 = p1.buffer;
    enc.reset(buf1);
    const p2 = enc.finish(2);
    expect(p2.buffer).toBe(buf1);
    expect(enc.empty).toBe(true);

    // Simulate a transfer: buffer detached, nothing returned yet.
    const moved = structuredClone(p2.buffer, { transfer: [p2.buffer] });
    expect(buf1.byteLength).toBe(0);
    enc.reset();
    enc.begin(Op.NOP, 0);
    const p3 = enc.finish(3);
    expect(p3.buffer).not.toBe(buf1);
    expect(p3.buffer.byteLength).toBe(1024);

    // A returned buffer of sufficient size is adopted.
    enc.reset(moved);
    expect(enc.finish(4).buffer).toBe(moved);
    // Too-small buffers are ignored.
    enc.reset(new ArrayBuffer(512));
    expect(enc.finish(5).buffer).toBe(moved);
  });

  it('throws on payload overflow and misuse', () => {
    const enc = createCommandEncoder();
    enc.begin(Op.TEXTURE_DESTROY, 4);
    enc.u32(1);
    expect(() => enc.u32(2)).toThrow(CozyGPUError);
    enc.begin(Op.SWARM_SET_PARAMS, 3);
    expect(() => enc.bytes(new Uint8Array(5))).toThrow(CozyGPUError);
    enc.begin(Op.SWARM_CREATE, 4);
    expect(() => enc.utf8('hello')).toThrow(CozyGPUError);
    enc.finish(0);
    expect(() => enc.begin(Op.NOP, 0)).toThrow(CozyGPUError);
    expect(() => enc.finish(0)).toThrow(CozyGPUError);
  });

  it('tracks packet objects and the transfer list', () => {
    const enc = createCommandEncoder();
    const ab = new ArrayBuffer(8);
    const sab = new SharedArrayBuffer(8);
    expect(enc.addObject(ab, true)).toBe(0);
    expect(enc.addObject(sab, true)).toBe(1);
    expect(enc.addObject(ab, true)).toBe(2);
    const packet = enc.finish(0);
    expect(packet.objects).toEqual([ab, sab, ab]);
    expect(enc.transferList).toEqual([packet.buffer, ab]);
    const dec = createCommandDecoder();
    enc.reset();
    enc.addObject(sab, false);
    enc.begin(Op.SHARED_REGISTER, 8);
    enc.u32(1);
    enc.u32(0);
    dec.reset(enc.finish(1));
    dec.next();
    dec.reader.u32();
    expect(dec.reader.object(dec.reader.u32())).toBe(sab);
    expect(() => dec.reader.object(3)).toThrow(CozyGPUError);
  });

  describe('decoder validation', () => {
    function validPacket(): FramePacket {
      const enc = createCommandEncoder(256);
      enc.begin(Op.FRAME_BEGIN, 8);
      enc.f32(0);
      enc.f32(0);
      enc.begin(Op.FRAME_END, 0);
      return enc.finish(1);
    }

    it('rejects bad magic, lengths, truncated commands and count mismatch', () => {
      const dec = createCommandDecoder();
      const cases: Array<(u32: Uint32Array, p: FramePacket) => void> = [
        u32 => (u32[0] = 0xdeadbeef),
        (u32, p) => (u32[1] = p.buffer.byteLength + 4),
        u32 => (u32[1] = 6),
        u32 => (u32[3] = 5),
        u32 => (u32[5] = 1024), // FRAME_BEGIN payloadBytes past the end
        u32 => (u32[5] = 6), // not 4-aligned
        (u32, p) => (u32[1] = p.byteLength - 4), // truncates FRAME_END header
      ];
      for (const corruptIt of cases) {
        const p = validPacket();
        corruptIt(new Uint32Array(p.buffer), p);
        expect(() => dec.reset(p)).toThrow(CozyGPUError);
        expect(dec.next()).toBe(false);
      }
      const ok = validPacket();
      dec.reset(ok);
      expect(dec.next()).toBe(true);
      expect(() => dec.reader.blob(12)).toThrow(CozyGPUError);
      expect(() => dec.seek(3)).toThrow(CozyGPUError);
    });

    it('rejects detached buffers', () => {
      const dec = createCommandDecoder();
      const p = validPacket();
      structuredClone(p.buffer, { transfer: [p.buffer] });
      expect(() => dec.reset(p)).toThrow(CozyGPUError);
    });

    it('reuses views for the same buffer (main-thread mode)', () => {
      const dec = createCommandDecoder();
      const p = validPacket();
      dec.reset(p);
      const view = dec.reader.u32View;
      dec.reset(p);
      expect(dec.reader.u32View).toBe(view);
    });
  });

  it('utf8ByteLength matches TextEncoder', () => {
    const te = new TextEncoder();
    for (const t of ['', 'abc', 'ü', '€', '🚀', 'a\ud800b', computeSrc]) {
      expect(utf8ByteLength(t)).toBe(te.encode(t).byteLength);
    }
  });
});
