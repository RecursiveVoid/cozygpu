/**
 * M2.5 review: WebGPU readback pacing driven by a real readback ring
 * (ARCHITECTURE §7.1, §19.5). Frames are held only while a ring slot's map
 * is in flight and PACE_FRAMES submits ran since the oldest read started;
 * a landed map releases the held frame; an idle backend never holds.
 */
import type { CommandList } from '../types';
import { ReadbackState } from '../types';
import { WebGPUReadbackRing, type RingHost } from './readbackRing';
import { WebGPUTexture } from './resources';
import { WebGPUBackend } from './WebGPUBackend';

class FakeGPUBuffer {
  mapState: 'unmapped' | 'pending' | 'mapped' = 'unmapped';
  private resolve: (() => void) | null = null;
  private reject: ((e: Error) => void) | null = null;
  constructor(readonly size: number) {}
  mapAsync(): Promise<void> {
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
    return new ArrayBuffer(this.size);
  }
  unmap(): void {
    if (this.mapState === 'pending') this.reject?.(new Error('aborted'));
    this.mapState = 'unmapped';
  }
  destroy(): void {}
}

type Pacer = RingHost & {
  submits: number;
  onReadbackLanded: (() => void) | null;
  afterSubmit(): void;
  backlogged(): boolean;
  whenCaughtUp(cb: () => void): void;
};

function setup() {
  const buffers: FakeGPUBuffer[] = [];
  const device = {
    createBuffer: (d: { size: number }) => {
      const b = new FakeGPUBuffer(d.size);
      buffers.push(b);
      return b;
    },
  } as unknown as GPUDevice;
  // The pacing and afterSubmit paths only touch plain fields.
  const backend = Object.create(WebGPUBackend.prototype) as Pacer;
  Object.assign(backend, {
    device,
    reads: 0,
    submits: 0,
    readSubmit: 0,
    caughtUp: null,
    lost: false,
    rings: [],
    frameScoped: false,
    canvasTexture: null,
    canvasTextureView: null,
    onReadbackLanded: null,
  });
  const ring = new WebGPUReadbackRing(backend, 4, 16, 'pick');
  const list = { copyTextureToBuffer: () => {} } as unknown as CommandList;
  const tex = new WebGPUTexture(
    { createView: () => ({}) } as unknown as GPUTexture,
    1,
    1,
    'rgba32uint',
    1,
    1,
    't',
  );
  const read = (): number => {
    const s = ring.acquire();
    ring.copyTexture(list, s, tex, 0, 0, 1, 1);
    return s;
  };
  return { backend, ring, buffers, read };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('WebGPU pacing with the readback ring', () => {
  it('an idle backend never holds, however many submits ran', () => {
    const { backend } = setup();
    for (let i = 0; i < 1000; i++) backend.afterSubmit();
    expect(backend.backlogged()).toBe(false);
    const held = jest.fn();
    backend.whenCaughtUp(held);
    expect(held).toHaveBeenCalledTimes(1);
  });

  it('a read counts from its own submit, not from earlier idle submits', () => {
    const { backend, read } = setup();
    for (let i = 0; i < 100; i++) backend.afterSubmit();
    read();
    backend.afterSubmit(); // maps the slot: the read starts here
    expect(backend.reads).toBe(1);
    expect(backend.backlogged()).toBe(false);
    backend.afterSubmit();
    backend.afterSubmit();
    expect(backend.backlogged()).toBe(false);
    backend.afterSubmit(); // PACE_FRAMES = 3 submits after the read started
    expect(backend.backlogged()).toBe(true);
  });

  it('holds while the map is in flight; the landed map releases the frame and pacing stops', async () => {
    const { backend, ring, buffers, read } = setup();
    const landed = jest.fn();
    backend.onReadbackLanded = landed;
    const s = read();
    for (let i = 0; i < 4; i++) backend.afterSubmit();
    expect(backend.backlogged()).toBe(true);
    const held = jest.fn();
    backend.whenCaughtUp(held);
    expect(held).not.toHaveBeenCalled();
    buffers[s].land();
    await settle();
    expect(held).toHaveBeenCalledTimes(1);
    // The held frame's release polls picks (RenderCore.releaseHeld), so the
    // landing itself does not also call onReadbackLanded (only the
    // whenCaughtUp check did, while the map was still in flight).
    expect(landed).toHaveBeenCalledTimes(1);
    expect(backend.backlogged()).toBe(false);
    expect(ring.poll(s)).toBe(ReadbackState.READY);
    ring.release(s);
    for (let i = 0; i < 10; i++) backend.afterSubmit();
    expect(backend.backlogged()).toBe(false);
  });

  it('a landing with no held frame calls onReadbackLanded (answers picks between packets)', async () => {
    const { backend, buffers, read } = setup();
    const landed = jest.fn();
    backend.onReadbackLanded = landed;
    const s = read();
    backend.afterSubmit();
    buffers[s].land();
    await settle();
    expect(landed).toHaveBeenCalledTimes(1);
    expect(backend.reads).toBe(0);
  });

  it('with overlapping reads a held frame waits for the last one; the oldest read sets the window', async () => {
    const { backend, buffers, read } = setup();
    const a = read();
    backend.afterSubmit(); // a starts
    backend.afterSubmit();
    const b = read();
    backend.afterSubmit(); // b starts
    backend.afterSubmit(); // 3 submits since a started
    expect(backend.reads).toBe(2);
    expect(backend.backlogged()).toBe(true);
    const held = jest.fn();
    backend.whenCaughtUp(held);
    buffers[a].land();
    await settle();
    expect(held).not.toHaveBeenCalled(); // b is still in flight
    buffers[b].land();
    await settle();
    expect(held).toHaveBeenCalledTimes(1);
    expect(backend.reads).toBe(0);
  });

  it('a lost device releases a held frame at once', () => {
    const { backend, read } = setup();
    read();
    for (let i = 0; i < 4; i++) backend.afterSubmit();
    const held = jest.fn();
    backend.whenCaughtUp(held);
    expect(held).not.toHaveBeenCalled();
    (backend as { lost: boolean }).lost = true;
    backend.landed();
    expect(held).toHaveBeenCalledTimes(1);
  });
});
