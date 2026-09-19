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

  it('rejects pending picks on device loss', async () => {
    const transport = new FakeTransport();
    const renderer = new RendererImpl(transport, config());
    const pending = renderer.pick(5, 5);
    renderer.render();
    transport.listener?.({ type: 'deviceLost', message: 'gpu went away' });
    await expect(pending).rejects.toMatchObject({ code: 'DEVICE_LOST' });
  });
});
