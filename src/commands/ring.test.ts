/**
 * Owner: "worker+build". Encoder / decoder behavior with command-ring
 * SharedArrayBuffer slots (ARCHITECTURE §3.6, §17).
 */
import { CommandFlag, Op, createCommandDecoder, createCommandEncoder } from '.';
import { VIEW_CACHE_SIZE } from './decoder';

function encode(
  encoder: ReturnType<typeof createCommandEncoder>,
  buffer: ArrayBuffer | SharedArrayBuffer | undefined,
  frameId: number,
  drawBytes = 20,
) {
  encoder.reset(buffer);
  encoder.begin(Op.FRAME_BEGIN, 8);
  encoder.f32(frameId);
  encoder.f32(0);
  encoder.begin(Op.SPRITE_DRAW, drawBytes, CommandFlag.DRAW);
  encoder.begin(Op.FRAME_END, 0);
  return encoder.finish(frameId);
}

describe('encoder with SharedArrayBuffer slots', () => {
  it('adopts a slot and never lists it for transfer', () => {
    const encoder = createCommandEncoder(1024);
    const slot = new SharedArrayBuffer(4096);
    const packet = encode(encoder, slot, 1);
    expect(packet.buffer).toBe(slot);
    expect(encoder.transferList).toEqual([]);
    const bitmapLike = new ArrayBuffer(8);
    encoder.reset(slot);
    encoder.begin(Op.FRAME_BEGIN, 8);
    encoder.addObject(bitmapLike, true);
    encoder.addObject(new SharedArrayBuffer(8), true);
    encoder.finish(2);
    expect(encoder.transferList).toEqual([bitmapLike]);

    // Back to an ArrayBuffer: the buffer heads the list again.
    const ab = new ArrayBuffer(4096);
    const third = encode(encoder, ab, 3);
    expect(third.buffer).toBe(ab);
    expect(encoder.transferList).toEqual([ab]);
  });

  it('moves to an ArrayBuffer when a packet outgrows its slot', () => {
    const encoder = createCommandEncoder(1024);
    const slot = new SharedArrayBuffer(1024);
    encoder.reset(slot);
    const level = new ArrayBuffer(4);
    encoder.begin(Op.FRAME_BEGIN, 8);
    encoder.f32(7);
    encoder.f32(0);
    encoder.addObject(level, true);
    encoder.begin(Op.SPRITE_DRAW, 4000, CommandFlag.DRAW);
    const packet = encoder.finish(1);
    expect(packet.buffer).toBeInstanceOf(ArrayBuffer);
    expect(packet.buffer.byteLength).toBeGreaterThanOrEqual(packet.byteLength);
    expect(encoder.transferList).toEqual([packet.buffer, level]);
    const decoder = createCommandDecoder();
    decoder.reset(packet);
    expect(decoder.next()).toBe(true);
    expect(decoder.reader.f32()).toBe(7);
    // The old slot is now too small for the grown capacity: not adopted.
    encoder.reset(slot);
    encoder.begin(Op.FRAME_END, 0);
    expect(encoder.finish(2).buffer).not.toBe(slot);
  });
});

describe('decoder view cache', () => {
  it('reuses views for alternating buffers and evicts the least recently used', () => {
    const encoder = createCommandEncoder(1024);
    const decoder = createCommandDecoder();
    const slots = [new SharedArrayBuffer(2048), new SharedArrayBuffer(2048)];
    const seen = new Map<SharedArrayBuffer, Uint8Array>();
    for (let frame = 1; frame <= 10; frame++) {
      const slot = slots[frame % 2];
      const packet = encode(encoder, slot, frame);
      decoder.reset(packet);
      const view = decoder.reader.u8;
      if (seen.has(slot)) expect(view).toBe(seen.get(slot));
      else seen.set(slot, view);
      expect(view.buffer).toBe(slot);
      expect(decoder.frameId).toBe(frame);
      let ops = 0;
      while (decoder.next()) ops++;
      expect(ops).toBe(3);
    }

    // Fill the cache with other buffers: the first slot gets evicted.
    const u8Slot0 = seen.get(slots[0])!;
    for (let i = 0; i < VIEW_CACHE_SIZE; i++) {
      decoder.reset(encode(encoder, new ArrayBuffer(2048), 100 + i));
    }
    decoder.reset(encode(encoder, slots[0], 200));
    expect(decoder.reader.u8).not.toBe(u8Slot0);
    expect(decoder.reader.u8.buffer).toBe(slots[0]);
  });

  it('re-creates views when a cached buffer was detached and still rejects it', () => {
    const encoder = createCommandEncoder(1024);
    const decoder = createCommandDecoder();
    const buffer = new ArrayBuffer(1024);
    decoder.reset(encode(encoder, buffer, 1));
    structuredClone(buffer, { transfer: [buffer] });
    expect(() =>
      decoder.reset({
        buffer,
        byteLength: 16,
        frameId: 2,
        commandCount: 0,
        objects: [],
      }),
    ).toThrow(/detached/);
  });
});

describe('decoder utf8 on a shared slot', () => {
  it('decodes strings from a SharedArrayBuffer packet', () => {
    const encoder = createCommandEncoder(1024);
    const slot = new SharedArrayBuffer(1024);
    encoder.reset(slot);
    const text = 'swarm ✓ name';
    const bytes = new TextEncoder().encode(text).length;
    encoder.begin(Op.FRAME_BEGIN, bytes);
    expect(encoder.utf8(text)).toBe(bytes);
    const packet = encoder.finish(1);
    const decoder = createCommandDecoder();
    decoder.reset(packet);
    decoder.next();
    expect(decoder.reader.utf8(bytes)).toBe(text);
  });
});
