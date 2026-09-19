/**
 * SpriteInstanceStore (ARCHITECTURE §5.1). One buffer of
 * `capacity × SPRITE_INSTANCE_BYTES` with cached views. Instance index = draw
 * order. Views are rebuilt only when the buffer is replaced.
 */
import { SPRITE_INSTANCE_BYTES } from '../types/layouts';

const MIN_CAPACITY = 1024;

export class InstanceStore {
  buffer: ArrayBuffer | SharedArrayBuffer = new ArrayBuffer(0);
  capacity = 0;
  shared = false;
  f32: Float32Array = new Float32Array(0);
  u32: Uint32Array = new Uint32Array(0);
  u16: Uint16Array = new Uint16Array(0);
  u8: Uint8Array = new Uint8Array(0);

  /**
   * Makes room for `count` instances in the requested memory kind. Keeps the
   * existing contents. Returns true when the buffer was replaced.
   */
  ensure(count: number, useSharedArrayBuffer: boolean): boolean {
    const wantShared =
      useSharedArrayBuffer && typeof SharedArrayBuffer !== 'undefined';
    if (count <= this.capacity && wantShared === this.shared) return false;
    let cap = Math.max(MIN_CAPACITY, this.capacity);
    while (cap < count) cap *= 2;
    const bytes = cap * SPRITE_INSTANCE_BYTES;
    const next = wantShared
      ? new SharedArrayBuffer(bytes)
      : new ArrayBuffer(bytes);
    const u8 = new Uint8Array(next);
    u8.set(this.u8);
    this.buffer = next;
    this.capacity = cap;
    this.shared = wantShared;
    this.u8 = u8;
    this.u16 = new Uint16Array(next);
    this.u32 = new Uint32Array(next);
    this.f32 = new Float32Array(next);
    return true;
  }
}
