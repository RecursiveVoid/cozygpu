/** Fixed-size FIFO of recycled packet buffers (no allocation after construction). */

/** ARCHITECTURE §3.6: the packet buffer pool holds up to 3 buffers. */
export const PACKET_POOL_SIZE = 3;

export class BufferRing {
  private readonly slots: Array<ArrayBuffer | undefined>;
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number = PACKET_POOL_SIZE) {
    this.slots = new Array<ArrayBuffer | undefined>(capacity).fill(undefined);
  }

  get size(): number {
    return this.count;
  }

  /** Adds a buffer; when full, the oldest one is dropped. Detached buffers are ignored. */
  push(buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0) return;
    const cap = this.capacity;
    if (this.count === cap) {
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % cap;
      this.count--;
    }
    this.slots[(this.head + this.count) % cap] = buffer;
    this.count++;
  }

  shift(): ArrayBuffer | undefined {
    while (this.count > 0) {
      const buffer = this.slots[this.head];
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
      // A buffer may have been transferred again after being queued.
      if (buffer !== undefined && buffer.byteLength !== 0) return buffer;
    }
    return undefined;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
