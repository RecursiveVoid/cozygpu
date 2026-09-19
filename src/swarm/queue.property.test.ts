/**
 * Tester (logic, round 1): the swarm's front-side CommandQueue under random
 * command sequences, flushed through the real encoder and decoded again.
 * Covers growth, the word-copy / bytes-copy split at 512 B, high flag bits
 * and padding.
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { COMMAND_HEADER_BYTES } from '../commands/opcodes';
import { CommandQueue } from './queue';

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

interface Expected {
  opcode: number;
  flags: number;
  payload: Uint8Array;
}

describe('CommandQueue (random round-trips)', () => {
  it('flushInto re-encodes every command byte-exactly (40 rounds)', () => {
    const r = rng(1234);
    const q = new CommandQueue();
    const enc = createCommandEncoder(256);
    const dec = createCommandDecoder();
    for (let round = 0; round < 40; round++) {
      const expected: Expected[] = [];
      const n = Math.floor(r() * 30);
      for (let c = 0; c < n; c++) {
        const opcode = Math.floor(r() * 0x10000);
        const flags = Math.floor(r() * 0x10000); // includes bit 15
        // straddle the 512-byte word/bytes split, include odd sizes and 0
        const pick = r();
        const bytes =
          pick < 0.1
            ? 0
            : pick < 0.4
              ? 1 + Math.floor(r() * 16)
              : pick < 0.7
                ? 505 + Math.floor(r() * 16)
                : Math.floor(r() * 5000);
        const w = q.begin(opcode, bytes, flags);
        expect(q.u8.byteOffset).toBe(0);
        const padded = (bytes + 3) & ~3;
        // reserved payload must be zero-filled even when the queue reuses bytes
        let nonZero = 0;
        for (let k = 0; k < padded; k++) nonZero += q.u8[w * 4 + k] ? 1 : 0;
        expect(nonZero).toBe(0);
        const payload = new Uint8Array(padded);
        for (let k = 0; k < bytes; k++) payload[k] = 1 + Math.floor(r() * 255);
        q.u8.set(payload, w * 4);
        expect(q.length).toBe(w * 4 + padded);
        expect((w * 4 - COMMAND_HEADER_BYTES) % 4).toBe(0);
        expected.push({ opcode, flags, payload });
      }
      expect(q.empty).toBe(n === 0);

      enc.reset();
      q.flushInto(enc);
      expect(q.empty).toBe(true);
      dec.reset(enc.finish(round));
      const rd = dec.reader;
      let i = 0;
      while (dec.next()) {
        const e = expected[i++];
        expect(rd.opcode).toBe(e.opcode);
        expect(rd.flags).toBe(e.flags);
        expect(rd.payloadBytes).toBe(e.payload.byteLength);
        let diff = -1;
        for (let k = 0; k < rd.payloadBytes; k++) {
          if (rd.u8[rd.payloadOffset + k] !== e.payload[k]) {
            diff = k;
            break;
          }
        }
        expect(diff).toBe(-1);
      }
      expect(i).toBe(expected.length);
      expect(dec.commandCount).toBe(expected.length);

      // leave garbage in the queue buffer for the next round's zero-fill check
      q.u8.fill(0xaa, 0, Math.min(q.u8.byteLength, 2048));
    }
  });

  it('reset() discards queued commands without touching views', () => {
    const q = new CommandQueue();
    const u8 = q.u8;
    q.begin(1, 8);
    q.reset();
    expect(q.empty).toBe(true);
    expect(q.u8).toBe(u8);
    const enc = createCommandEncoder(256);
    q.flushInto(enc);
    expect(enc.commandCount).toBe(0);
  });
});
