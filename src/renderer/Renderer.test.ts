import { CommandFlag, Op } from '../commands/opcodes';
import type { FramePacket } from '../commands/types';
import type { FrontFrame, ScenePacker } from '../types/core';
import type { CoreMessage, Transport } from '../types/transport';
import { ensureTextureUploaded, Texture } from '../scene/Texture';
import { queueSwarmDestroy } from '../swarm/destroyQueue';
import { RendererImpl, type RendererConfig } from './Renderer';
import { FAKE_CAPS } from './testing/fakeBackend';
import { TestDecoder } from './testing/fakeCommands';

const packs: FrontFrame[] = [];
let packHook: ((frame: FrontFrame) => void) | null = null;

jest.mock('../commands', () => {
  const actual = jest.requireActual('../commands/opcodes');
  const fakes = jest.requireActual('./testing/fakeCommands');
  return {
    ...actual,
    createCommandDecoder: () => new fakes.TestDecoder(),
    createCommandEncoder: () => new fakes.TestEncoder(),
  };
});

jest.mock('../scene/Container', () => ({
  Container: class {
    destroyed = false;
    destroy(): void {
      this.destroyed = true;
    }
  },
}));

jest.mock('../sprites/front', () => ({
  createScenePacker: (): ScenePacker => ({
    pack: (_stage, frame) => {
      packs.push(frame);
      packHook?.(frame);
    },
    destroy: () => {},
  }),
}));

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  readonly caps = FAKE_CAPS;
  readonly sharedMemory = true;
  readonly useSharedArrayBuffer = false;
  readonly ring = false;
  busy = false;
  destroyed = false;
  packets: FramePacket[] = [];
  listener: ((message: CoreMessage) => void) | null = null;
  submit(packet: FramePacket): void {
    // Copy: the encoder reuses its buffer for the next frame.
    this.packets.push({
      ...packet,
      buffer: packet.buffer.slice(0),
      objects: packet.objects.slice(),
    });
  }
  takeRecycledBuffer(): ArrayBuffer | undefined {
    return undefined;
  }
  setListener(listener: (message: CoreMessage) => void): void {
    this.listener = listener;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** Lets a lazy chunk's dynamic import resolve. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function config(overrides: Partial<RendererConfig> = {}): RendererConfig {
  return {
    canvas: { width: 300, height: 150 } as unknown as OffscreenCanvas,
    worker: false,
    cssWidth: 300,
    cssHeight: 150,
    resolution: 2,
    autoResize: false,
    background: 0xff8000,
    backgroundAlpha: 1,
    ...overrides,
  };
}

/** Decodes a packet into [opcode, flags, payload-as-f32/u32] tuples. */
function decode(
  packet: FramePacket,
): { op: number; flags: number; f32: number[]; u32: number[] }[] {
  const decoder = new TestDecoder();
  decoder.reset(packet);
  const out = [];
  while (decoder.next()) {
    const r = decoder.reader;
    const n = r.payloadBytes / 4;
    const f32 = Array.from(
      r.f32View.subarray(r.payloadOffset >> 2, (r.payloadOffset >> 2) + n),
    );
    const u32 = Array.from(
      r.u32View.subarray(r.payloadOffset >> 2, (r.payloadOffset >> 2) + n),
    );
    out.push({ op: r.opcode, flags: r.flags, f32, u32 });
  }
  return out;
}

beforeEach(() => {
  packs.length = 0;
  packHook = null;
});

describe('Renderer', () => {
  it('encodes FRAME_BEGIN, pending control commands, the scene and FRAME_END', () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    renderer.render();
    const cmds = decode(transport.packets[0]);
    expect(cmds.map(c => c.op)).toEqual([
      Op.FRAME_BEGIN,
      Op.RESIZE,
      Op.SET_CLEAR_COLOR,
      Op.SET_VIEW,
      Op.FRAME_END,
    ]);
    expect(cmds[1].f32).toEqual([300, 150, 2]);
    expect(cmds[2].f32[0]).toBeCloseTo(1);
    expect(cmds[2].f32[1]).toBeCloseTo(128 / 255);
    expect(cmds[2].f32[2]).toBe(0);
    expect(cmds[2].f32[3]).toBe(1);
    expect(packs).toHaveLength(1);
    expect(renderer.stats.frameId).toBe(1);
    expect(renderer.stats.packetBytes).toBe(transport.packets[0].byteLength);

    // Second frame: control commands are only re-sent on change.
    renderer.render();
    expect(decode(transport.packets[1]).map(c => c.op)).toEqual([
      Op.FRAME_BEGIN,
      Op.FRAME_END,
    ]);

    renderer.background = 0x0000ff;
    renderer.resize(300, 150); // unchanged → no RESIZE
    renderer.render();
    expect(decode(transport.packets[2]).map(c => c.op)).toEqual([
      Op.FRAME_BEGIN,
      Op.SET_CLEAR_COLOR,
      Op.FRAME_END,
    ]);

    renderer.resize(640, 480, 1);
    renderer.render();
    const resize = decode(transport.packets[3]).find(c => c.op === Op.RESIZE)!;
    expect(resize.f32).toEqual([640, 480, 1]);
    expect(renderer.width).toBe(640);
    expect(renderer.resolution).toBe(1);
  });

  it('flushes queued SWARM_DESTROY every frame, even with no Swarm in the tree', () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    renderer.render();
    const rendererId = packs[0].rendererId;
    queueSwarmDestroy(rendererId, 7);
    renderer.render();
    const cmds = decode(transport.packets[1]);
    const destroy = cmds.filter(c => c.op === Op.SWARM_DESTROY);
    expect(destroy).toHaveLength(1);
    expect(destroy[0].u32[0]).toBe(7);
    renderer.render();
    expect(
      decode(transport.packets[2]).some(c => c.op === Op.SWARM_DESTROY),
    ).toBe(false);
  });

  it('skips frames while the transport is busy and counts them', () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    transport.busy = true;
    renderer.render();
    renderer.render();
    expect(transport.packets).toHaveLength(0);
    expect(renderer.stats.skippedFrames).toBe(2);
    expect(packs).toHaveLength(0);
    transport.busy = false;
    renderer.render();
    expect(transport.packets).toHaveLength(1);
    // Pending RESIZE survives skipped frames.
    expect(decode(transport.packets[0]).some(c => c.op === Op.RESIZE)).toBe(
      true,
    );
  });

  it('clamps dt to [0, 0.1] and reports time since creation', () => {
    const transport = new FakeTransport();
    let t = 1000;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => t);
    const renderer = new RendererImpl(transport, config());
    t = 1016;
    renderer.render();
    expect(packs[0].dt).toBeCloseTo(0.016);
    t = 3000;
    renderer.render();
    expect(packs[1].dt).toBe(0.1);
    expect(packs[1].time).toBeCloseTo(2);
    spy.mockRestore();
  });

  it('counts DRAW commands emitted by the packer', () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    packHook = frame => {
      for (let i = 0; i < 3; i++) {
        frame.encoder.begin(0x0210, 20, CommandFlag.DRAW);
        for (let j = 0; j < 5; j++) frame.encoder.u32(j);
        frame.encoder.end();
      }
    };
    renderer.render();
    expect(renderer.stats.drawCalls).toBe(3);
  });

  it('passes RendererOptions.retained to the packer and reports segment counts', () => {
    type Packer = {
      retained?: boolean;
      segState?: { stats: { replayed: number; recorded: number } };
    };
    const off = new RendererImpl(
      new FakeTransport(),
      config({ retained: false }),
    );
    expect((off as unknown as { packer: Packer }).packer.retained).toBe(false);
    const on = new RendererImpl(new FakeTransport(), config());
    const packer = (on as unknown as { packer: Packer }).packer;
    expect(packer.retained).toBeUndefined(); // the packer's default (true)
    on.render();
    expect(on.stats.retainedSegments).toBeUndefined();
    packer.segState = { stats: { replayed: 3, recorded: 1 } };
    on.render();
    expect(on.stats.retainedSegments).toEqual({ replayed: 3, recorded: 1 });
  });

  it('registers shared buffers once per generation and re-sends state after restore', () => {
    const transport = new FakeTransport();
    const onDeviceLost = jest.fn();
    const onDeviceRestored = jest.fn();
    const renderer = new RendererImpl(
      transport,
      config({ onDeviceLost, onDeviceRestored }),
    );
    const store = new ArrayBuffer(80);
    const ids: number[] = [];
    packHook = frame => {
      ids.push(frame.registerShared(store));
      ids.push(frame.registerShared(store));
    };
    renderer.render();
    renderer.render();
    const registers = (i: number) =>
      decode(transport.packets[i]).filter(c => c.op === Op.SHARED_REGISTER);
    expect(registers(0)).toHaveLength(1);
    expect(registers(1)).toHaveLength(0);
    expect(transport.packets[0].objects[registers(0)[0].u32[1]]).toBe(store);
    expect(new Set(ids).size).toBe(1);

    transport.listener!({ type: 'deviceLost', message: 'gone' });
    expect(onDeviceLost).toHaveBeenCalledWith({
      message: 'gone',
      willRestore: true,
    });
    transport.listener!({ type: 'deviceRestored' });
    expect(onDeviceRestored).toHaveBeenCalled();
    renderer.render();
    expect(packs[2].generation).toBe(1);
    const ops = decode(transport.packets[2]).map(c => c.op);
    expect(ops).toEqual(
      expect.arrayContaining([
        Op.RESIZE,
        Op.SET_CLEAR_COLOR,
        Op.SET_VIEW,
        Op.SHARED_REGISTER,
      ]),
    );
  });

  it('resolves readbacks requested outside a frame on the next frame', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const promise = (
      renderer as unknown as { _readback: RendererImpl['_readback'] }
    )._readback(1, 2, 3, 4);
    renderer.render();
    const readback = decode(transport.packets[0]).find(
      c => c.op === Op.READBACK,
    )!;
    const [requestId, kind, id, first, count] = readback.u32;
    expect([kind, id, first, count]).toEqual([1, 2, 3, 4]);
    const data = new Uint8Array([9]).buffer;
    transport.listener!({ type: 'readback', requestId, data });
    await expect(promise).resolves.toBe(data);
  });

  // Regression: a readback in flight when the device was lost never settled.
  it('rejects in-flight readbacks with DEVICE_LOST and ignores their late answers', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const lost = renderer._readback(1, 2, 0, 1);
    renderer.render();
    const [lostId] = decode(transport.packets[0]).find(
      c => c.op === Op.READBACK,
    )!.u32;

    transport.listener!({ type: 'deviceLost', message: 'gone' });
    await expect(lost).rejects.toMatchObject({ code: 'DEVICE_LOST' });

    // The rejected request keeps its id until the core answers it, so a late
    // answer can never settle a newer request.
    const fresh = renderer._readback(1, 2, 0, 1);
    renderer.render();
    const [freshId] = decode(transport.packets[1]).find(
      c => c.op === Op.READBACK,
    )!.u32;
    expect(freshId).not.toBe(lostId);
    transport.listener!({
      type: 'readback',
      requestId: lostId,
      data: new ArrayBuffer(0),
    });
    const data = new Uint8Array([7]).buffer;
    transport.listener!({ type: 'readback', requestId: freshId, data });
    await expect(fresh).resolves.toBe(data);
    renderer.destroy();
  });

  // Regression: every empty answer was rejected as UNSUPPORTED.
  it('rejects failed readbacks with the code the core sent', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const failed = renderer._readback(1, 2, 0, 1);
    const empty = renderer._readback(1, 2, 0, 0);
    renderer.render();
    const [failedId, emptyId] = decode(transport.packets[0])
      .filter(c => c.op === Op.READBACK)
      .map(c => c.u32[0]);
    transport.listener!({
      type: 'readback',
      requestId: failedId,
      data: new ArrayBuffer(0),
      code: 'OUT_OF_CAPACITY',
      message: 'refused',
    });
    await expect(failed).rejects.toMatchObject({ code: 'OUT_OF_CAPACITY' });
    transport.listener!({
      type: 'readback',
      requestId: emptyId,
      data: new ArrayBuffer(0),
    });
    await expect(empty).resolves.toHaveProperty('byteLength', 0);
    renderer.destroy();
  });

  it('becomes destroyed when the core reports an unrecoverable device loss', () => {
    const transport = new FakeTransport();
    const onDeviceLost = jest.fn();
    const renderer = new RendererImpl(transport, config({ onDeviceLost }));
    transport.listener!({
      type: 'error',
      code: 'DEVICE_LOST',
      message: 'no GPU',
    });
    expect(onDeviceLost).toHaveBeenCalledWith({
      message: 'no GPU',
      willRestore: false,
    });
    expect(renderer.destroyed).toBe(true);
    expect(transport.destroyed).toBe(true);
    renderer.render();
    expect(transport.packets).toHaveLength(0);
  });

  it('destroy() destroys the stage before the frame hooks see it go', () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const order: string[] = [];
    renderer._addFrameHook({
      encodeFrame() {},
      onRendererDestroyed: () => order.push('hook'),
    });
    const stage = renderer.stage as unknown as { destroy(): void };
    const destroy = stage.destroy.bind(stage);
    stage.destroy = () => {
      // A node queueing a release here relies on the hook to drop it.
      order.push('stage');
      destroy();
    };
    renderer.destroy();
    expect(order).toEqual(['stage', 'hook']);
  });

  it('destroy() releases textures uploaded to it, so their ids are freed', () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const t = Texture.fromPixels(1, 1, new Uint8Array(4).fill(255));
    packHook = frame => {
      ensureTextureUploaded(frame, t);
    };
    try {
      renderer.render();
    } finally {
      packHook = null;
    }
    const id = t.sourceId;
    renderer.destroy();
    t.destroy(); // no live renderer holds it: the id is free at once
    const next = Texture.fromPixels(1, 1, new Uint8Array(4));
    expect(next.sourceId).toBe(id);
    next.destroy();
  });

  it('encodes pick() as PICK and resolves it from the core answer', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const pending = renderer.pick(12, 34);
    await settle(); // the pick client is a lazy chunk (§18.1)
    renderer.render();
    const pickCmd = decode(transport.packets[0]).find(c => c.op === Op.PICK);
    expect(pickCmd).toBeDefined();
    const requestId = pickCmd!.u32[0];
    expect(requestId).toBeGreaterThan(0);
    expect(pickCmd!.f32[1]).toBe(12);
    expect(pickCmd!.f32[2]).toBe(34);
    // A second render must not re-send an answered-or-sent request.
    renderer.render();
    expect(decode(transport.packets[1]).some(c => c.op === Op.PICK)).toBe(
      false,
    );
    // objectId 0 = nothing pickable under the cursor.
    transport.listener?.({
      type: 'pick',
      requestId,
      objectId: 0,
      instance: -1,
    });
    await expect(pending).resolves.toBeNull();
  });

  it('rejects a pick the core reports as failed', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const pending = renderer.pick(1, 2);
    await settle();
    renderer.render();
    const pickCmd = decode(transport.packets[0]).find(c => c.op === Op.PICK);
    transport.listener?.({
      type: 'pick',
      requestId: pickCmd!.u32[0],
      objectId: 0,
      instance: -1,
      code: 'UNSUPPORTED',
      message: 'picking needs integer render targets',
    });
    await expect(pending).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('rejects pending picks and readbacks on destroy, and picks after it', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const sent = renderer.pick(0, 0);
    await settle();
    renderer.render(); // encoded, waiting for the core
    const queued = renderer.pick(1, 1); // not encoded yet
    const pending = renderer._readback(0, 1, 0, 1);
    renderer.destroy();
    await expect(sent).rejects.toMatchObject({ code: 'DESTROYED' });
    await expect(queued).rejects.toMatchObject({ code: 'DESTROYED' });
    await expect(pending).rejects.toMatchObject({ code: 'DESTROYED' });
    await expect(renderer.pick(0, 0)).rejects.toMatchObject({
      code: 'DESTROYED',
    });
  });

  it('rejects a pick made before the pick chunk loaded when destroyed meanwhile', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const early = renderer.pick(3, 4);
    renderer.destroy();
    await expect(early).rejects.toMatchObject({ code: 'DESTROYED' });
  });

  it('rejects pending picks on device loss', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const pending = renderer.pick(5, 5);
    await settle();
    renderer.render();
    transport.listener?.({ type: 'deviceLost', message: 'gpu went away' });
    await expect(pending).rejects.toMatchObject({ code: 'DEVICE_LOST' });
  });

  it('emits fallback then ready before it is returned, each with a fresh payload', () => {
    const transport = new FakeTransport();
    Object.assign(transport, { fallbackReason: 'no adapter' });
    const events: [string, unknown][] = [];
    const sink = { emit: (name: string, p: unknown) => events.push([name, p]) };
    new RendererImpl(transport, config({ events: sink }));
    expect(events).toEqual([
      ['fallback', { from: 'webgpu', to: 'webgl2', reason: 'no adapter' }],
      [
        'ready',
        {
          backend: 'webgpu',
          worker: false,
          sharedMemory: true,
          fallbackReason: 'no adapter',
        },
      ],
    ]);
    const plain: string[] = [];
    new RendererImpl(
      new FakeTransport(),
      config({
        events: { emit: name => plain.push(name) },
      }),
    );
    expect(plain).toEqual(['ready']);
  });

  it('emits resize, deviceLost, deviceRestored and error; never per frame', () => {
    const transport = new FakeTransport();
    const events: [string, unknown][] = [];
    const order: string[] = [];
    const renderer = new RendererImpl(
      transport,
      config({
        events: {
          emit: (name, p) => {
            events.push([name, p]);
            order.push(name);
          },
        },
        onDeviceLost: () => order.push('onDeviceLost'),
        onDeviceRestored: () => order.push('onDeviceRestored'),
      }),
    );
    events.length = 0;
    order.length = 0;
    for (let i = 0; i < 5; i++) renderer.render();
    expect(events).toEqual([]);
    renderer.resize(300, 150); // unchanged: no event
    renderer.resize(640, 480, 1.5);
    transport.listener?.({ type: 'deviceLost', message: 'reset' });
    transport.listener?.({ type: 'deviceRestored' });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    transport.listener?.({ type: 'error', code: 'UNSUPPORTED', message: 'm' });
    log.mockRestore();
    expect(events).toEqual([
      ['resize', { width: 640, height: 480, resolution: 1.5 }],
      [
        'deviceLost',
        { backend: 'webgpu', message: 'reset', willRestore: true },
      ],
      ['deviceRestored', { backend: 'webgpu', generation: 1 }],
      ['error', { code: 'UNSUPPORTED', message: 'm' }],
    ]);
    expect(order).toEqual([
      'resize',
      'onDeviceLost',
      'deviceLost',
      'onDeviceRestored',
      'deviceRestored',
      'error',
    ]);
    // Fatal loss: willRestore false, then the renderer is destroyed.
    events.length = 0;
    transport.listener?.({
      type: 'error',
      code: 'DEVICE_LOST',
      message: 'dead',
    });
    expect(events).toEqual([
      [
        'deviceLost',
        { backend: 'webgpu', message: 'dead', willRestore: false },
      ],
    ]);
    expect(renderer.destroyed).toBe(true);
  });

  it('catches a throwing events sink and logs once per event name', () => {
    const transport = new FakeTransport();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = new RendererImpl(
      transport,
      config({
        events: {
          emit: () => {
            throw new Error('sink');
          },
        },
      }),
    );
    renderer.resize(10, 10);
    renderer.resize(20, 20);
    expect(log).toHaveBeenCalledTimes(2); // ready, resize
    log.mockRestore();
    renderer.render();
    expect(transport.packets.length).toBe(1);
  });

  it('interop(): UNSUPPORTED without a local core, DESTROYED after destroy, else a handle', async () => {
    const worker = new RendererImpl(new FakeTransport(), config());
    await expect(worker.interop()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });

    const registered: [number, unknown, unknown][] = [];
    const released: number[] = [];
    let epoch = 0;
    const core = {
      backend: 'webgpu' as const,
      device: () => 'DEVICE',
      get lossEpoch() {
        return epoch;
      },
      registerBuffer: (id: number, native: unknown, desc: unknown) =>
        void registered.push([id, native, desc]),
      releaseBuffer: (id: number) => void released.push(id),
      invalidateState: () => {},
    };
    const transport = Object.assign(new FakeTransport(), {
      interop: () => core,
    });
    const renderer = new RendererImpl(transport, config());
    const interop = await renderer.interop();
    expect(await renderer.interop()).toBe(interop);
    expect(interop.backend).toBe('webgpu');
    expect(interop.device).toBe('DEVICE');
    const native = { size: 400 };
    const ext = interop.registerInstanceBuffer(native, {
      layout: 'swarm-hot',
      capacity: 10,
    });
    expect(registered).toEqual([
      [ext.id, native, { label: undefined, size: 400, usage: 8 }],
    ]);
    expect(ext).toMatchObject({
      layout: 'swarm-hot',
      capacity: 10,
      valid: true,
    });
    expect(() =>
      interop.registerInstanceBuffer(native, {
        layout: 'sprite-instance',
        capacity: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED' }));
    expect(() =>
      interop.registerInstanceBuffer(native, {
        layout: 'swarm-cold',
        capacity: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    epoch++; // a device loss dropped every registration
    expect(ext.valid).toBe(false);
    ext.release();
    expect(released).toEqual([ext.id]);
    renderer.destroy();
    await expect(renderer.interop()).rejects.toMatchObject({
      code: 'DESTROYED',
    });
    expect(() =>
      interop.registerInstanceBuffer(native, {
        layout: 'swarm-hot',
        capacity: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'DESTROYED' }));
  });

  it('interop(): a failed setup is not cached; the next call retries', async () => {
    let calls = 0;
    const core = {
      backend: 'webgpu' as const,
      device: () => 'DEVICE',
      lossEpoch: 0,
      registerBuffer: () => {},
      releaseBuffer: () => {},
      invalidateState: () => {},
    };
    const transport = Object.assign(new FakeTransport(), {
      interop: () => {
        if (calls++ === 0) throw new Error('chunk failed');
        return core;
      },
    });
    const renderer = new RendererImpl(transport, config());
    await expect(renderer.interop()).rejects.toThrow('chunk failed');
    const interop = await renderer.interop();
    expect(interop.device).toBe('DEVICE');
    expect(await renderer.interop()).toBe(interop);
    expect(calls).toBe(2);
    renderer.destroy();
  });
});
