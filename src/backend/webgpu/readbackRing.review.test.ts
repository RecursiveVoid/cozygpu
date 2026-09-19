/**
 * M2.5 review: WebGPU readback ring reuse and wraparound (ARCHITECTURE
 * §19.6). Slots are handed out lowest-free-first, a full ring answers -1,
 * released slots are reused in any order, and nothing (GPU buffer, view,
 * handler) is created per read over many cycles. The pacing count
 * (`host.reads`) returns to 0 after every cycle.
 */
import type { CommandList } from '../types';
import { ReadbackState } from '../types';
import { WebGPUReadbackRing, type RingHost } from './readbackRing';
import { WebGPUTexture } from './resources';

class FakeGPUBuffer {
  mapState: 'unmapped' | 'pending' | 'mapped' = 'unmapped';
  destroyed = false;
  maps = 0;
  bytes: Uint8Array;
  private resolve: (() => void) | null = null;
  private reject: ((e: Error) => void) | null = null;
  constructor(readonly size: number) {
    this.bytes = new Uint8Array(size);
  }
  mapAsync(): Promise<void> {
    if (this.mapState !== 'unmapped') {
      // WebGPU rejects a second map while one is pending or mapped.
      return Promise.reject(new Error('OperationError: already mapping'));
    }
    this.maps++;
    this.mapState = 'pending';
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
  land(): void {
    this.mapState = 'mapped';
    this.resolve?.();
  }
  getMappedRange(): ArrayBuffer {
    if (this.mapState !== 'mapped') throw new Error('not mapped');
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
    createBuffer: (d: { size: number }) => {
      const b = new FakeGPUBuffer(d.size);
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
  const list = {
    copyTextureToBuffer: () => {},
  } as unknown as CommandList;
  const tex = new WebGPUTexture(
    { createView: () => ({}) } as unknown as GPUTexture,
    4,
    4,
    'rgba32uint',
    1,
    1,
    't',
  );
  return { created, host, list, tex };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('WebGPUReadbackRing reuse and wraparound', () => {
  it('hands out the lowest free slot, answers -1 when full, reuses in any release order', () => {
    const { host } = setup();
    const ring = new WebGPUReadbackRing(host, 4, 16, 'r');
    expect([0, 1, 2, 3, 4].map(() => ring.acquire())).toEqual([0, 1, 2, 3, -1]);
    ring.release(2);
    ring.release(0);
    expect(ring.acquire()).toBe(0);
    expect(ring.acquire()).toBe(2);
    expect(ring.acquire()).toBe(-1);
    // Releasing a slot that is only acquired (no copy) is fine.
    ring.release(3);
    expect(ring.poll(3)).toBe(ReadbackState.FREE);
  });

  it('500 read cycles: no buffer or view per read, data per slot, reads back to 0', async () => {
    const { created, host, list, tex } = setup();
    const ring = new WebGPUReadbackRing(host, 4, 16, 'r');
    const buffers = created.length;
    const views = [0, 1, 2, 3].map(s => ring.data(s));
    let value = 1;
    for (let cycle = 0; cycle < 125; cycle++) {
      // Fill every slot, submit once, land them in reverse order.
      const slots: number[] = [];
      for (let k = 0; k < 4; k++) {
        const s = ring.acquire();
        ring.copyTexture(list, s, tex, k, 0, 1, 1);
        slots.push(s);
      }
      expect(ring.acquire()).toBe(-1);
      ring.submitted();
      expect(host.reads).toBe(4);
      const expected: number[] = [];
      for (let k = 3; k >= 0; k--) {
        const s = slots[k];
        const b = created[s];
        const word = value++;
        b.bytes.set(new Uint8Array(new Uint32Array([word, s, 0, 0]).buffer));
        expected[s] = word;
        b.land();
      }
      await settle();
      expect(host.reads).toBe(0);
      for (let s = 0; s < 4; s++) {
        expect(ring.poll(s)).toBe(ReadbackState.READY);
        expect(ring.data(s)).toBe(views[s]);
        expect(views[s][0]).toBe(expected[s]);
        expect(views[s][1]).toBe(s);
      }
      // Release out of order.
      for (const s of [1, 3, 0, 2]) ring.release(s);
    }
    expect(created.length).toBe(buffers);
    expect(created.every(b => b.maps === 125)).toBe(true);
    expect(created.every(b => b.mapState === 'unmapped')).toBe(true);
  });

  it('a slot reused for a 1-row copy after a padded multi-row copy reads tight rows', () => {
    const { created, host, list, tex } = setup();
    const ring = new WebGPUReadbackRing(host, 1, 32, 'r');
    const s = ring.acquire();
    ring.copyTexture(list, s, tex, 0, 0, 1, 2); // padded rows: buffer grows
    const grown = created[created.length - 1];
    grown.bytes.set(new Uint8Array(new Uint32Array([1, 2, 3, 4]).buffer), 0);
    grown.bytes.set(new Uint8Array(new Uint32Array([5, 6, 7, 8]).buffer), 256);
    ring.submitted();
    grown.land();
    expect(ring.poll(s)).toBe(ReadbackState.READY);
    expect(Array.from(ring.data(s))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    ring.release(s);

    const again = ring.acquire();
    expect(again).toBe(s);
    ring.copyTexture(list, again, tex, 0, 0, 1, 1);
    const count = created.length;
    grown.bytes.fill(0);
    grown.bytes.set(new Uint8Array(new Uint32Array([9, 9, 9, 9]).buffer), 0);
    ring.submitted();
    grown.land();
    expect(ring.poll(again)).toBe(ReadbackState.READY);
    // First texel rewritten; the second row is from the previous read (the
    // caller asked for one texel only).
    expect(Array.from(ring.data(again)).slice(0, 4)).toEqual([9, 9, 9, 9]);
    expect(created.length).toBe(count); // the grown buffer is kept
  });

  it('only slots copied since the last submit are mapped by the next submit', () => {
    const { created, host, list, tex } = setup();
    const ring = new WebGPUReadbackRing(host, 3, 16, 'r');
    const a = ring.acquire();
    ring.copyTexture(list, a, tex, 0, 0, 1, 1);
    ring.submitted();
    const b = ring.acquire();
    ring.copyTexture(list, b, tex, 0, 0, 1, 1);
    ring.acquire(); // acquired, never copied: not mapped
    ring.submitted();
    ring.submitted(); // nothing new recorded
    expect(created.map(x => x.maps)).toEqual([1, 1, 0]);
    expect(host.reads).toBe(2);
  });

  it('releasing a copied, not yet submitted slot is not mapped by the next submit', () => {
    const { created, host, list, tex } = setup();
    const ring = new WebGPUReadbackRing(host, 2, 16, 'r');
    const a = ring.acquire();
    ring.copyTexture(list, a, tex, 0, 0, 1, 1);
    ring.release(a);
    ring.submitted();
    expect(created[a].maps).toBe(0);
    expect(host.reads).toBe(0);
    // The recorded counter was fixed: a later copy still maps.
    const b = ring.acquire();
    ring.copyTexture(list, b, tex, 0, 0, 1, 1);
    ring.submitted();
    expect(created[b].maps).toBe(1);
    expect(host.reads).toBe(1);
  });
});
