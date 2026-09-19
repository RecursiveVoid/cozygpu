/**
 * Tester (logic, round 1): reader bounds checks with lengths near 2^32 and
 * decoder behavior on a buffer that was detached after a successful reset.
 * These are lengths a corrupted payload can carry (u32 fields read from the
 * stream and multiplied by a record size in the core systems).
 */
import { CozyGPUError } from '../types/errors';
import { createCommandDecoder, createCommandEncoder } from './index';
import { Op } from './opcodes';
import { align4 } from './utf8';

function packetWithPayload(words: number) {
  const enc = createCommandEncoder(256);
  enc.begin(Op.SWARM_KILL_LIST, words * 4);
  for (let k = 0; k < words; k++) enc.u32(k + 1);
  enc.begin(Op.NOP, 0);
  return enc.finish(9);
}

describe('align4', () => {
  it('rounds up small lengths', () => {
    expect([0, 1, 2, 3, 4, 5, 8, 1023].map(align4)).toEqual([
      0, 4, 4, 4, 4, 8, 8, 1024,
    ]);
  });
});

describe('CommandReader bounds with huge lengths', () => {
  it('blob() of a normal oversize length throws', () => {
    const dec = createCommandDecoder();
    dec.reset(packetWithPayload(3));
    expect(dec.next()).toBe(true);
    expect(() => dec.reader.blob(16)).toThrow(CozyGPUError);
  });

  // Regression: align4 uses 32-bit bitwise ops, so for n >= 2^31 - 3 the
  // padded length used to wrap and blob()/skip() passed the bounds check
  // (a corrupt u32 count times a record size). blob() now checks the raw
  // length against the remaining payload before aligning.
  it.each([
    ['2^32 (n = 0x40000000 words)', 2 ** 32],
    ['0xFFFFFFFF', 0xffffffff],
    ['0xFFFFFFFC (moves the cursor back)', 0xfffffffc],
    ['40 * 0x10000000 (hot records)', 40 * 0x10000000],
  ])('blob(%s) throws INVALID_ARGUMENT', (_label, length) => {
    const dec = createCommandDecoder();
    dec.reset(packetWithPayload(3));
    expect(dec.next()).toBe(true);
    const r = dec.reader;
    r.u32();
    const before = r.u8.byteLength;
    expect(before).toBeGreaterThan(0);
    expect(() => r.blob(length)).toThrow(CozyGPUError);
    expect(() => r.skip(length)).toThrow(CozyGPUError);
  });

  // Regression: reset() used to skip re-validation when the packet reused the
  // previous (now detached) ArrayBuffer, since both lengths were 0, and threw
  // a TypeError from the magic check instead of CozyGPUError.
  it('reset() on the same buffer after it was detached throws CozyGPUError', () => {
    const enc = createCommandEncoder(256);
    enc.begin(Op.NOP, 0);
    const p = enc.finish(1);
    const dec = createCommandDecoder();
    dec.reset(p);
    structuredClone(p.buffer, { transfer: [p.buffer] });
    expect(() => dec.reset(p)).toThrow(CozyGPUError);
  });

  it('reset() on the same detached buffer never leaves a readable packet', () => {
    const enc = createCommandEncoder(256);
    enc.begin(Op.NOP, 0);
    const p = enc.finish(1);
    const dec = createCommandDecoder();
    dec.reset(p);
    structuredClone(p.buffer, { transfer: [p.buffer] });
    expect(() => dec.reset(p)).toThrow();
    expect(dec.next()).toBe(false);
  });
});
