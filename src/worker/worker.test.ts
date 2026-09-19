import type { Capabilities } from '../backend/types';
import {
  CommandFlag,
  Op,
  createCommandDecoder,
  createCommandEncoder,
} from '../commands';
import type { FramePacket } from '../commands/types';
import type { CoreInitOptions, RenderCore } from '../types/core';
import { CozyGPUError } from '../types/errors';
import {
  RING_CONTROL_BYTES,
  RingControl,
  type CoreMessage,
  type Transport,
  type WorkerInboundMessage,
} from '../types/transport';
import { BufferRing } from './BufferRing';
import { startWorkerHost } from './host';
import type { WorkerHostDeps, WorkerScopeLike } from './host';
import { LocalTransport } from './LocalTransport';
import { connectWorkerTransport } from './WorkerTransport';
import type { WorkerLike } from './WorkerTransport';

const caps = {
  backend: 'webgpu',
  compute: true,
  canvasFormat: 'bgra8unorm',
} as unknown as Capabilities;
const options: CoreInitOptions = { backend: 'auto', antialias: false };
const size = { cssWidth: 300, cssHeight: 200, resolution: 2 };

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/** A RenderCore fake that decodes packets like the real one and acks with the buffer. */
class FakeCore implements RenderCore {
  readonly caps = caps;
  readonly seen: number[][] = [];
  destroyed = false;
  throwNext = false;
  private readonly decoder = createCommandDecoder();

  constructor(
    private readonly post: (m: CoreMessage, t?: Transferable[]) => void,
  ) {}

  execute(packet: FramePacket): void {
    if (this.throwNext) {
      this.throwNext = false;
      throw new CozyGPUError('INVALID_ARGUMENT', 'boom');
    }
    this.decoder.reset(packet);
    const ops: number[] = [];
    while (this.decoder.next()) ops.push(this.decoder.reader.opcode);
    this.seen.push(ops);
    this.post(
      { type: 'frameDone', frameId: packet.frameId, buffer: packet.buffer },
      [packet.buffer],
    );
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** The decoder's current u8 view (identity checks for view caching). */
  decoderView(): Uint8Array {
    return this.decoder.reader.u8;
  }
}

/** Clones like postMessage: ArrayBuffers in the transfer list are detached on the sender. */
function cloneMessage(message: unknown, transfer: Transferable[]): unknown {
  const buffers = transfer.filter(
    t => t instanceof ArrayBuffer,
  ) as ArrayBuffer[];
  // OffscreenCanvas is not available in Node: pass the fake canvas through by reference.
  const init = message as { type?: string; canvas?: unknown };
  if (init.type === 'init') return { ...init };
  return structuredClone(message, { transfer: buffers });
}

/** In-process worker pair: front ↔ host with asynchronous, cloning delivery. */
function createFakeWorkerPair(deps: WorkerHostDeps) {
  const scope: WorkerScopeLike & { closed: boolean } = {
    onmessage: null,
    closed: false,
    postMessage(message, transfer) {
      const data = cloneMessage(message, transfer);
      setTimeout(() => worker.onmessage?.({ data } as MessageEvent), 0);
    },
    close() {
      this.closed = true;
    },
  };
  const worker: WorkerLike & { terminated: boolean } = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminated: false,
    postMessage(message, transfer) {
      const data = cloneMessage(message, transfer) as WorkerInboundMessage;
      setTimeout(() => scope.onmessage?.({ data }), 0);
    },
    terminate() {
      this.terminated = true;
    },
  };
  const host = startWorkerHost(scope, deps);
  return { scope, worker, host };
}

function encodeFrame(
  transport: Transport,
  encoder = createCommandEncoder(1024),
  frameId = 1,
) {
  encoder.reset(transport.takeRecycledBuffer());
  const at = encoder.begin(Op.FRAME_BEGIN, 8);
  encoder.f32View[at >> 2] = 0;
  encoder.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
  encoder.begin(Op.FRAME_END, 0);
  const packet = encoder.finish(frameId);
  return { encoder, packet };
}

describe('BufferRing', () => {
  it('is a bounded FIFO that skips detached buffers', () => {
    const ring = new BufferRing(2);
    const a = new ArrayBuffer(4);
    const b = new ArrayBuffer(4);
    const c = new ArrayBuffer(4);
    ring.push(a);
    ring.push(b);
    ring.push(c); // drops a
    expect(ring.size).toBe(2);
    structuredClone(b, { transfer: [b] });
    expect(ring.shift()).toBe(c);
    expect(ring.shift()).toBeUndefined();
    ring.push(new ArrayBuffer(0));
    expect(ring.size).toBe(0);
  });
});

describe('worker transport + host', () => {
  let core: FakeCore | null;
  let canvas: { width: number; height: number };
  const deps: WorkerHostDeps = {
    async createRenderCore(_canvas, _options, systems, post) {
      expect(systems).toEqual([]);
      core = new FakeCore(post);
      return core;
    },
    createSystems: () => [],
  };

  beforeEach(() => {
    core = null;
    canvas = { width: 0, height: 0 };
  });

  it('handshakes, ping-pongs one frame at a time and recycles the buffer', async () => {
    const { worker, scope } = createFakeWorkerPair(deps);
    const transport = await connectWorkerTransport(
      worker,
      canvas as unknown as OffscreenCanvas,
      options,
      size,
    );
    expect(transport.kind).toBe('worker');
    expect(transport.caps).toEqual(caps); // structured clone
    expect(canvas).toEqual({ width: 600, height: 400 });
    const messages: CoreMessage[] = [];
    transport.setListener(m => messages.push(m));

    const { encoder, packet } = encodeFrame(transport);
    const sent = packet.buffer;
    expect(transport.busy).toBe(false);
    transport.submit(packet, encoder.transferList);
    expect(sent.byteLength).toBe(0); // transferred, not copied
    expect(transport.busy).toBe(true);
    expect(() => transport.submit(packet, encoder.transferList)).toThrow(
      CozyGPUError,
    );

    while (transport.busy) await flush();
    expect(core!.seen).toEqual([
      [Op.FRAME_BEGIN, Op.SPRITE_DRAW, Op.FRAME_END],
    ]);
    expect(messages.map(m => m.type)).toEqual(['frameDone']);

    // Steady state: the returned buffer is adopted by the encoder.
    const recycled = transport.takeRecycledBuffer();
    expect(recycled?.byteLength).toBe(1024);
    const second = encodeFrame(
      { takeRecycledBuffer: () => recycled } as Transport,
      encoder,
      2,
    );
    expect(second.packet.buffer).toBe(recycled);
    transport.submit(second.packet, encoder.transferList);
    while (transport.busy) await flush();
    expect(core!.seen.length).toBe(2);

    transport.destroy();
    await flush();
    await flush();
    expect(core!.destroyed).toBe(true);
    expect(scope.closed).toBe(true);
  });

  // Regression: under a busy main thread the frameDone message task runs after
  // the next rAF callback, so about every other frame was skipped although the
  // worker had finished. With crossOriginIsolated the ack is also shared.
  it('clears busy from the shared frame signal before the frameDone message is delivered', async () => {
    const g = globalThis as {
      crossOriginIsolated?: boolean;
      __COZYGPU_RING__?: boolean;
    };
    const saved = g.crossOriginIsolated;
    g.crossOriginIsolated = true;
    g.__COZYGPU_RING__ = false; // transfer path + frame signal (M1 behavior)
    try {
      const { worker, scope } = createFakeWorkerPair(deps);
      let signal: SharedArrayBuffer | undefined;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        const init = message as {
          type: string;
          frameSignal?: SharedArrayBuffer;
        };
        if (init.type === 'init') signal = init.frameSignal;
        post(message, transfer);
      };
      // Hold back worker → front messages to model a busy main thread.
      const held: (() => void)[] = [];
      const scopePost = scope.postMessage.bind(scope);
      let hold = false;
      scope.postMessage = (message, transfer) => {
        if (hold) {
          const data = cloneMessage(message, transfer);
          held.push(() => worker.onmessage?.({ data } as MessageEvent));
        } else {
          scopePost(message, transfer);
        }
      };
      const transport = await connectWorkerTransport(
        worker,
        canvas as unknown as OffscreenCanvas,
        options,
        size,
      );
      expect(signal).toBeInstanceOf(SharedArrayBuffer);
      expect(transport.ring).toBe(false);
      const messages: CoreMessage[] = [];
      transport.setListener(m => messages.push(m));
      hold = true;

      const encoder = createCommandEncoder(1024);
      const first = encodeFrame(transport, encoder, 1);
      transport.submit(first.packet, encoder.transferList);
      expect(transport.busy).toBe(true);
      while (core === null || core.seen.length < 1) await flush();
      expect(messages).toEqual([]); // frameDone not delivered yet
      expect(transport.busy).toBe(false); // but the shared ack is visible

      // The next frame uses a fresh buffer (the old one has not returned).
      const second = encodeFrame(transport, encoder, 2);
      expect(second.packet.buffer.byteLength).toBeGreaterThan(0);
      transport.submit(second.packet, encoder.transferList);
      expect(transport.busy).toBe(true);
      while (core!.seen.length < 2) await flush();
      expect(transport.busy).toBe(false);

      // Late messages still recycle both buffers and never clear a newer frame.
      hold = false;
      const third = encodeFrame(transport, encoder, 3);
      transport.submit(third.packet, encoder.transferList);
      held.splice(0).forEach(deliver => deliver());
      expect(messages.map(m => m.type)).toEqual(['frameDone', 'frameDone']);
      expect(transport.busy).toBe(true);
      while (transport.busy) await flush();
      expect(core!.seen.length).toBe(3);
      transport.destroy();
    } finally {
      g.crossOriginIsolated = saved;
      delete g.__COZYGPU_RING__;
    }
  });

  describe('command ring (SharedArrayBuffer, §17)', () => {
    const g = globalThis as { crossOriginIsolated?: boolean };
    let saved: boolean | undefined;
    beforeEach(() => {
      saved = g.crossOriginIsolated;
      g.crossOriginIsolated = true;
    });
    afterEach(() => {
      g.crossOriginIsolated = saved;
    });

    /** Connects and records every front → worker message. */
    async function connectRing() {
      const pair = createFakeWorkerPair(deps);
      const sent: unknown[] = [];
      let init: Extract<WorkerInboundMessage, { type: 'init' }> | undefined;
      const post = pair.worker.postMessage.bind(pair.worker);
      pair.worker.postMessage = (message, transfer) => {
        const m = message as { type?: string };
        if (m.type === 'init') init = message as typeof init;
        else sent.push(typeof message === 'number' ? message : m.type);
        post(message, transfer);
      };
      const transport = await connectWorkerTransport(
        pair.worker,
        canvas as unknown as OffscreenCanvas,
        options,
        size,
      );
      const messages: CoreMessage[] = [];
      transport.setListener(m => messages.push(m));
      return { ...pair, transport, sent, init: init!, messages };
    }

    it('sends doorbells, acks through the control block and reuses the slot', async () => {
      const { transport, sent, init, messages } = await connectRing();
      expect(transport.ring).toBe(true);
      expect(init.frameSignal?.byteLength).toBe(RING_CONTROL_BYTES);
      expect(init.ring).toHaveLength(2);

      const encoder = createCommandEncoder(1024);
      const views: Uint8Array[] = [];
      let slotBuffer: ArrayBuffer | SharedArrayBuffer | undefined;
      for (let frame = 1; frame <= 5; frame++) {
        expect(transport.busy).toBe(false);
        const { packet } = encodeFrame(transport, encoder, frame);
        expect(packet.buffer).toBeInstanceOf(SharedArrayBuffer);
        if (slotBuffer === undefined) slotBuffer = packet.buffer;
        expect(packet.buffer).toBe(slotBuffer);
        expect(encoder.transferList).toEqual([]);
        transport.submit(packet, encoder.transferList);
        expect(transport.busy).toBe(true);
        const control = new Int32Array(init.frameSignal!);
        expect(control[RingControl.SUBMITTED_FRAME_ID]).toBe(frame);
        expect(control[RingControl.SUBMITTED_BYTE_LENGTH]).toBe(
          packet.byteLength,
        );
        while (transport.busy) await flush();
        expect(control[RingControl.ACK_FRAME_ID]).toBe(frame);
        views.push(core!.decoderView());
      }
      expect(sent).toEqual([0, 0, 0, 0, 0]);
      expect(core!.seen).toHaveLength(5);
      expect(core!.seen[4]).toEqual([
        Op.FRAME_BEGIN,
        Op.SPRITE_DRAW,
        Op.FRAME_END,
      ]);
      // Decoder views are cached per slot: no new views after the first frame.
      expect(new Set(views).size).toBe(1);
      await flush();
      expect(messages).toEqual([]); // no frameDone for ring packets
      transport.destroy();
    });

    it('uses the other slot while the previous packet is not acked', async () => {
      const { transport } = await connectRing();
      const a = transport.takeRecycledBuffer();
      const encoder = createCommandEncoder(1024);
      const { packet } = encodeFrame(
        { takeRecycledBuffer: () => a } as Transport,
        encoder,
        1,
      );
      transport.submit(packet, encoder.transferList);
      // Not acked yet (the fake worker delivers asynchronously).
      const b = transport.takeRecycledBuffer();
      expect(b).toBeInstanceOf(SharedArrayBuffer);
      expect(b).not.toBe(a);
      while (transport.busy) await flush();
      expect(transport.takeRecycledBuffer()).toBe(b);
      transport.destroy();
    });

    it('sends packets with objects as a frame message over the shared slot', async () => {
      const { transport, sent, messages } = await connectRing();
      const encoder = createCommandEncoder(1024);
      encoder.reset(transport.takeRecycledBuffer());
      const level = new ArrayBuffer(8);
      const at = encoder.begin(Op.FRAME_BEGIN, 8);
      encoder.f32View[at >> 2] = 0;
      expect(encoder.addObject(level, true)).toBe(0);
      encoder.begin(Op.FRAME_END, 0);
      const packet = encoder.finish(1);
      expect(encoder.transferList).toEqual([level]);
      transport.submit(packet, encoder.transferList);
      expect(level.byteLength).toBe(0); // transferred
      while (transport.busy) await flush();
      expect(sent).toEqual(['frame']);
      expect(core!.seen).toEqual([[Op.FRAME_BEGIN, Op.FRAME_END]]);
      await flush();
      expect(messages).toEqual([]);
      transport.destroy();
    });

    it('falls back to the transfer path when a packet outgrows its slot, then grows the slot', async () => {
      const { transport, sent, init } = await connectRing();
      const encoder = createCommandEncoder(1024);
      encoder.reset(transport.takeRecycledBuffer());
      const big = 100 * 1024;
      encoder.begin(Op.FRAME_BEGIN, 8);
      encoder.begin(Op.SPRITE_DRAW, big, CommandFlag.DRAW);
      encoder.begin(Op.FRAME_END, 0);
      const packet = encoder.finish(1);
      expect(packet.buffer).toBeInstanceOf(ArrayBuffer);
      expect(encoder.transferList).toEqual([packet.buffer]);
      transport.submit(packet, encoder.transferList);
      expect(sent).toEqual(['frame', 'ringSlot']);
      while (transport.busy) await flush();
      expect(core!.seen).toHaveLength(1);

      const slot = transport.takeRecycledBuffer()!;
      expect(slot).toBeInstanceOf(SharedArrayBuffer);
      expect(slot.byteLength).toBeGreaterThanOrEqual(packet.byteLength);
      expect(init.ring![0]).not.toBe(slot);
      encoder.reset(slot);
      encoder.begin(Op.FRAME_BEGIN, 8);
      encoder.begin(Op.SPRITE_DRAW, big, CommandFlag.DRAW);
      encoder.begin(Op.FRAME_END, 0);
      const second = encoder.finish(2);
      expect(second.buffer).toBe(slot);
      transport.submit(second, encoder.transferList);
      while (transport.busy) await flush();
      expect(sent).toEqual(['frame', 'ringSlot', 0]);
      expect(core!.seen).toHaveLength(2);
      transport.destroy();
    });

    it('keeps the grown slot for the frame after a transfer-path submit', async () => {
      const { transport } = await connectRing();
      const encoder = createCommandEncoder(1024);
      // Frame 1: ring packet on slot 0.
      const first = encodeFrame(transport, encoder, 1);
      const slot0 = first.packet.buffer;
      transport.submit(first.packet, encoder.transferList);
      while (transport.busy) await flush();
      // Frame 2 outgrows slot 0 and travels by transfer; slot 0 is regrown.
      encoder.reset(transport.takeRecycledBuffer());
      encoder.begin(Op.FRAME_BEGIN, 8);
      encoder.begin(Op.SPRITE_DRAW, 100 * 1024, CommandFlag.DRAW);
      encoder.begin(Op.FRAME_END, 0);
      const second = encoder.finish(2);
      expect(second.buffer).toBeInstanceOf(ArrayBuffer);
      transport.submit(second, encoder.transferList);
      // No ring slot is in flight, so the next frame gets the grown slot 0
      // even before frame 2 is acked (not the colder slot 1).
      const next = transport.takeRecycledBuffer()!;
      expect(next).not.toBe(slot0);
      expect(next.byteLength).toBeGreaterThanOrEqual(second.byteLength);
      while (transport.busy) await flush();
      transport.destroy();
    });

    it('acks ring packets when the core throws', async () => {
      const { transport, messages } = await connectRing();
      core!.throwNext = true;
      const { encoder, packet } = encodeFrame(transport);
      transport.submit(packet, encoder.transferList);
      while (transport.busy) await flush();
      await flush();
      expect(messages.map(m => m.type)).toEqual(['error']);
      const next = encodeFrame(transport, encoder, 2);
      transport.submit(next.packet, encoder.transferList);
      while (transport.busy) await flush();
      expect(core!.seen).toHaveLength(1);
      transport.destroy();
    });
  });

  it('holds a packet that needs a lazily loaded core system until it loads', async () => {
    let release!: () => void;
    const loading = new Promise<void>(r => (release = r));
    let asked = 0;
    const lazyDeps: WorkerHostDeps = {
      ...deps,
      pendingLoad: () => (asked++ === 0 ? loading : null),
    };
    const { worker } = createFakeWorkerPair(lazyDeps);
    const transport = await connectWorkerTransport(
      worker,
      canvas as unknown as OffscreenCanvas,
      options,
      size,
    );
    const { encoder, packet } = encodeFrame(transport);
    transport.submit(packet, encoder.transferList);
    for (let i = 0; i < 5; i++) await flush();
    // Not executed, not acknowledged: the front keeps skipping frames.
    expect(core!.seen).toHaveLength(0);
    expect(transport.busy).toBe(true);
    release();
    while (transport.busy) await flush();
    expect(core!.seen).toHaveLength(1);
    const next = encodeFrame(transport, encoder, 2);
    transport.submit(next.packet, encoder.transferList);
    while (transport.busy) await flush();
    expect(core!.seen).toHaveLength(2);
    transport.destroy();
  });

  it('acks the frame and reports an error when the core throws', async () => {
    const { worker } = createFakeWorkerPair(deps);
    const transport = await connectWorkerTransport(
      worker,
      canvas as unknown as OffscreenCanvas,
      options,
      size,
    );
    const messages: CoreMessage[] = [];
    transport.setListener(m => messages.push(m));
    core!.throwNext = true;
    const { encoder, packet } = encodeFrame(transport);
    transport.submit(packet, encoder.transferList);
    while (transport.busy) await flush();
    expect(messages.map(m => m.type)).toEqual(['error', 'frameDone']);
    expect((messages[0] as { code: string }).code).toBe('INVALID_ARGUMENT');
    expect(transport.takeRecycledBuffer()?.byteLength).toBe(1024);
    transport.destroy();
  });

  it('rejects with the core error code when init fails', async () => {
    const failing: WorkerHostDeps = {
      createRenderCore: async () => {
        throw new CozyGPUError('UNSUPPORTED', 'no WebGPU adapter');
      },
      createSystems: () => [],
    };
    const { worker } = createFakeWorkerPair(failing);
    await expect(
      connectWorkerTransport(
        worker,
        canvas as unknown as OffscreenCanvas,
        options,
        size,
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: '[cozygpu:UNSUPPORTED] no WebGPU adapter',
    });
    expect((worker as unknown as { terminated: boolean }).terminated).toBe(
      true,
    );
  });

  it('rejects on script load errors and on timeout', async () => {
    const silent: WorkerLike & { terminated: boolean } = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      postMessage() {},
      terminate() {
        this.terminated = true;
      },
    };
    const pending = connectWorkerTransport(
      silent,
      {} as OffscreenCanvas,
      options,
      size,
      5000,
    );
    silent.onerror?.({ message: '404' } as ErrorEvent);
    await expect(pending).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(silent.terminated).toBe(true);

    const slow = { ...silent, terminated: false };
    await expect(
      connectWorkerTransport(slow, {} as OffscreenCanvas, options, size, 10),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('host drops frames without a core but still returns the buffer', async () => {
    const posted: Array<{ message: CoreMessage; transfer: Transferable[] }> =
      [];
    const scope: WorkerScopeLike = {
      onmessage: null,
      postMessage: (message, transfer) =>
        posted.push({
          message: message as CoreMessage,
          transfer: transfer.slice(),
        }),
    };
    startWorkerHost(scope, deps);
    const encoder = createCommandEncoder(256);
    encoder.begin(Op.NOP, 0);
    const packet = encoder.finish(9);
    scope.onmessage?.({ data: { type: 'frame', packet } });
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toMatchObject({
      type: 'frameDone',
      frameId: 9,
      buffer: packet.buffer,
    });
    expect(posted[0].transfer).toEqual([packet.buffer]);
  });
});

describe('LocalTransport', () => {
  it('executes synchronously with zero copies and hands the same buffer back', () => {
    const transport = new LocalTransport();
    const fake = new FakeCore(transport.receive);
    transport.attach(fake);
    const messages: CoreMessage[] = [];
    transport.setListener(m => messages.push(m));
    expect(transport.busy).toBe(false);
    expect(transport.sharedMemory).toBe(true);
    expect(transport.caps).toBe(caps);

    const encoder = createCommandEncoder(1024);
    const first = encodeFrame(transport, encoder, 1);
    const buffer = first.packet.buffer;
    // The fake "transfers" nothing in local mode: the post callback just receives the buffer.
    transport.submit(first.packet, encoder.transferList);
    expect(fake.seen).toHaveLength(1);
    expect(messages.map(m => m.type)).toEqual(['frameDone']);
    expect(transport.takeRecycledBuffer()).toBe(buffer);

    const second = encodeFrame(transport, encoder, 2);
    expect(second.packet.buffer).toBe(buffer);
    fake.throwNext = true;
    transport.submit(second.packet, encoder.transferList);
    expect(messages.map(m => m.type)).toEqual(['frameDone', 'error']);
    expect(transport.takeRecycledBuffer()).toBe(buffer);

    transport.destroy();
    expect(fake.destroyed).toBe(true);
    expect(() => transport.submit(second.packet, [])).toThrow(CozyGPUError);
  });

  it('stays busy while the core holds its ack (frame pacing)', () => {
    const transport = new LocalTransport();
    let held: FramePacket | null = null;
    const core: RenderCore = {
      caps,
      execute: p => {
        held = p;
      },
      destroy: () => {},
    };
    transport.attach(core);
    const { encoder, packet } = encodeFrame(transport);
    transport.submit(packet, encoder.transferList);
    expect(transport.busy).toBe(true);
    transport.receive({
      type: 'frameDone',
      frameId: held!.frameId,
      buffer: held!.buffer as ArrayBuffer,
    });
    expect(transport.busy).toBe(false);
    expect(transport.takeRecycledBuffer()).toBe(packet.buffer);
  });

  it('recycles the submitted buffer when the core acks with buffer: null', () => {
    const transport = new LocalTransport();
    const core: RenderCore = {
      caps,
      execute: p =>
        transport.receive({
          type: 'frameDone',
          frameId: p.frameId,
          buffer: null,
        }),
      destroy: () => {},
    };
    transport.attach(core);
    const pending: CoreMessage[] = [];
    const { encoder, packet } = encodeFrame(transport);
    transport.submit(packet, encoder.transferList);
    // Messages posted before a listener exists are delivered on setListener.
    transport.setListener(m => pending.push(m));
    expect(pending).toHaveLength(1);
    expect(transport.takeRecycledBuffer()).toBe(packet.buffer);
  });
});
