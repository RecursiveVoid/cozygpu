/**
 * M2.5 WebGPU readback ring (ARCHITECTURE §19.6) against a fake device:
 * persistent staging buffers, maps started by the submit, polled without
 * awaiting, 256-byte row padding stripped.
 */
import type { CommandList } from '../types';
import { ReadbackState } from '../types';
import { WebGPUReadbackRing, type RingHost } from './readbackRing';
import { WebGPUTexture } from './resources';
import { WebGPUBackend } from './WebGPUBackend';

class FakeGPUBuffer {
  mapState: 'unmapped' | 'pending' | 'mapped' = 'unmapped';
  destroyed = false;
  maps = 0;
  bytes: Uint8Array;
  private reject: ((e: Error) => void) | null = null;
  constructor(
    readonly size: number,
    readonly usage: number,
  ) {
    this.bytes = new Uint8Array(size);
  }
  mapAsync(): Promise<void> {
    this.maps++;
    this.mapState = 'pending';
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
  private resolve: (() => void) | null = null;
  /** Test: the GPU finished. */
  land(): void {
    this.mapState = 'mapped';
    this.resolve?.();
  }
  getMappedRange(): ArrayBuffer {
    return this.bytes.slice().buffer;
  }
  unmap(): void {
    if (this.mapState === 'pending') this.reject?.(new Error('aborted'));
    this.mapState = 'unmapped';
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function setup() {
  const created: FakeGPUBuffer[] = [];
  const device = {
    createBuffer: (d: { size: number; usage: number }) => {
      const b = new FakeGPUBuffer(d.size, d.usage);
      created.push(b);
      return b;
    },
  } as unknown as GPUDevice;
  const host: RingHost & { landings: number } = {
    device,
    lost: false,
    reads: 0,
    rings: [],
    landings: 0,
    readStarted() {
      this.reads++;
    },
    landed() {
      this.landings++;
    },
  };
  const copies: { bytesPerRow?: number; width: number; height: number }[] = [];
  const list = {
    copyTextureToBuffer: (
      _src: unknown,
      dst: { bytesPerRow?: number },
      size: { width: number; height: number },
    ) =>
      copies.push({
        bytesPerRow: dst.bytesPerRow,
        width: size.width,
        height: size.height,
      }),
  } as unknown as CommandList;
  const texture = (w: number, h: number) =>
    new WebGPUTexture(
      { createView: () => ({}) } as unknown as GPUTexture,
      w,
      h,
      'rgba32uint',
      1,
      1,
      't',
    );
  return { created, host, list, copies, texture };
}

describe('WebGPUReadbackRing', () => {
  it('maps after submit and polls READY without awaiting; no buffer per read', async () => {
    const { created, host, list, copies, texture } = setup();
    const ring = new WebGPUReadbackRing(host, 4, 16, 'pick');
    expect(created.length).toBe(4);
    expect(created[0].usage).toBe(0x1 | 0x8); // MAP_READ | COPY_DST
    expect(host.rings).toEqual([ring]);

    const slot = ring.acquire();
    ring.copyTexture(list, slot, texture(1, 1), 0, 0, 1, 1);
    expect(copies).toEqual([{ bytesPerRow: undefined, width: 1, height: 1 }]);
    expect(ring.poll(slot)).toBe(ReadbackState.PENDING);
    expect(created[slot].maps).toBe(0); // not before the submit
    ring.submitted();
    expect(created[slot].maps).toBe(1);
    expect(host.reads).toBe(1);
    expect(ring.poll(slot)).toBe(ReadbackState.PENDING);
    created[slot].bytes.set(
      new Uint8Array(new Uint32Array([3, 1, 9, 0]).buffer),
    );
    created[slot].land();
    await Promise.resolve();
    // The landed map stops counting for pacing before it is polled.
    expect(host.reads).toBe(0);
    expect(host.landings).toBe(1);
    const view = ring.data(slot);
    expect(ring.poll(slot)).toBe(ReadbackState.READY);
    expect(Array.from(view)).toEqual([3, 1, 9, 0]);
    expect(created[slot].mapState).toBe('unmapped');
    expect(host.reads).toBe(0);
    ring.release(slot);
    expect(ring.poll(slot)).toBe(ReadbackState.FREE);
    expect(created.length).toBe(4);

    // Releasing a mapping slot aborts the map and fixes the pacing count.
    const again = ring.acquire();
    ring.copyTexture(list, again, texture(1, 1), 0, 0, 1, 1);
    ring.submitted();
    expect(host.reads).toBe(1);
    ring.release(again);
    expect(host.reads).toBe(0);
    await Promise.resolve();

    ring.destroy();
    expect(host.rings).toEqual([]);
    expect(created.every(b => b.destroyed)).toBe(true);
  });

  it('pads multi-row copies to 256 bytes and strips the padding on poll', () => {
    const { created, host, list, copies, texture } = setup();
    const ring = new WebGPUReadbackRing(host, 1, 32, undefined);
    const slot = ring.acquire();
    ring.copyTexture(list, slot, texture(1, 2), 0, 0, 1, 2);
    expect(copies[0].bytesPerRow).toBe(256);
    // The staging buffer grew once to hold the padded rows.
    const staging = created[created.length - 1];
    expect(staging.size).toBe(256 + 16);
    staging.bytes.set(new Uint8Array(new Uint32Array([1, 2, 3, 4]).buffer), 0);
    staging.bytes.set(
      new Uint8Array(new Uint32Array([5, 6, 7, 8]).buffer),
      256,
    );
    ring.submitted();
    staging.land();
    expect(ring.poll(slot)).toBe(ReadbackState.READY);
    expect(Array.from(ring.data(slot))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('fails slots after a device loss or a failed map', () => {
    const { host, list, texture, created } = setup();
    const ring = new WebGPUReadbackRing(host, 2, 16, undefined);
    const a = ring.acquire();
    const b = ring.acquire();
    ring.copyTexture(list, a, texture(1, 1), 0, 0, 1, 1);
    ring.copyTexture(list, b, texture(1, 1), 0, 0, 1, 1);
    ring.submitted();
    // A map that ended unmapped (rejected) → FAILED.
    created[b].mapState = 'unmapped';
    expect(ring.poll(b)).toBe(ReadbackState.FAILED);
    (host as { lost: boolean }).lost = true;
    expect(ring.poll(a)).toBe(ReadbackState.FAILED);
    expect(host.reads).toBe(0);
    expect(() => ring.copyTexture(list, a, texture(1, 1), 0, 0, 1, 1)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('WebGPUReadbackRing aborted maps', () => {
  it("an aborted map's late callback does not count the slot's next map as landed", async () => {
    const { created, host, list, texture } = setup();
    const ring = new WebGPUReadbackRing(host, 1, 16, undefined);
    const slot = ring.acquire();
    ring.copyTexture(list, slot, texture(1, 1), 0, 0, 1, 1);
    ring.submitted();
    ring.release(slot); // unmap() rejects the pending map; its callback is late
    expect(host.reads).toBe(0);
    const again = ring.acquire();
    expect(again).toBe(slot);
    ring.copyTexture(list, again, texture(1, 1), 0, 0, 1, 1);
    ring.submitted();
    expect(host.reads).toBe(1);
    const landings = host.landings;
    await Promise.resolve();
    await Promise.resolve();
    // The old callback ran: the new map still counts and has not landed.
    expect(host.reads).toBe(1);
    expect(host.landings).toBe(landings);
    created[again].land();
    await Promise.resolve();
    expect(host.reads).toBe(0);
    expect(host.landings).toBe(landings + 1);
    expect(ring.poll(again)).toBe(ReadbackState.READY);
    ring.destroy();
  });
});

describe('WebGPUBackend readback pacing', () => {
  // The pacing methods only touch plain fields: exercise them without a device.
  function pacer() {
    const b = Object.create(WebGPUBackend.prototype) as {
      reads: number;
      submits: number;
      readSubmit: number;
      caughtUp: (() => void) | null;
      lost: boolean;
      rings: unknown[];
      readStarted(): void;
      landed(): void;
      backlogged(): boolean;
      whenCaughtUp(cb: () => void): void;
    };
    Object.assign(b, {
      reads: 0,
      submits: 0,
      readSubmit: 0,
      caughtUp: null,
      lost: false,
      rings: [],
    });
    return b;
  }

  it('holds only while a readback is in flight for PACE_FRAMES submits, and releases when it lands', () => {
    const b = pacer();
    b.submits = 10;
    expect(b.backlogged()).toBe(false); // nothing in flight: never paced
    b.readStarted();
    b.submits += 2;
    expect(b.backlogged()).toBe(false);
    b.submits += 1; // PACE_FRAMES = 3
    expect(b.backlogged()).toBe(true);
    const held = jest.fn();
    b.whenCaughtUp(held);
    expect(held).not.toHaveBeenCalled();
    b.reads--;
    b.landed();
    expect(held).toHaveBeenCalledTimes(1);
    expect(b.backlogged()).toBe(false);
    // Nothing in flight: whenCaughtUp calls back at once.
    const now = jest.fn();
    b.whenCaughtUp(now);
    expect(now).toHaveBeenCalledTimes(1);
  });
});
