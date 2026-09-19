import {
  CommandFlag,
  Op,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import type { CoreContext, CoreSystem } from '../types/core';
import { CozyGPUError } from '../types/errors';
import type { CoreMessage } from '../types/transport';
import { RenderCoreImpl } from './RenderCore';
import { FakeBackend, FakeTexture } from './testing/fakeBackend';
import { TestDecoder, TestEncoder } from './testing/fakeCommands';

jest.mock('../commands', () => {
  const actual = jest.requireActual('../commands/opcodes');
  const fakes = jest.requireActual('./testing/fakeCommands');
  return {
    ...actual,
    createCommandDecoder: () => new fakes.TestDecoder(),
    createCommandEncoder: () => new fakes.TestEncoder(),
  };
});

const SPRITE_OP = 0x0202;
const SPRITE_DRAW = 0x0210;
const SWARM_STEP = 0x0309;
const SWARM_DRAW = 0x030a;

class RecordingSystem implements CoreSystem {
  inits = 0;
  restores = 0;
  readbacks = 0;
  constructor(
    readonly name: string,
    readonly range: number,
    private readonly log: string[],
  ) {}
  async init(_ctx: CoreContext): Promise<void> {
    this.inits++;
  }
  execute(reader: CommandReader): void {
    this.log.push(
      `${this.name}.execute ${reader.opcode.toString(16)} ${reader.u32()}`,
    );
  }
  compute(): void {
    this.log.push(`${this.name}.compute`);
  }
  draw(reader: CommandReader): void {
    this.log.push(
      `${this.name}.draw ${reader.opcode.toString(16)} ${reader.u32()}`,
    );
  }
  endFrame(): void {
    this.log.push(`${this.name}.endFrame`);
  }
  async restore(): Promise<void> {
    this.restores++;
  }
  destroy(): void {
    this.log.push(`${this.name}.destroy`);
  }
}

function setup(options: { antialias?: boolean } = {}) {
  const backend = new FakeBackend();
  const log = backend.calls;
  const messages: CoreMessage[] = [];
  const sprites = new RecordingSystem('sprites', 0x02, log);
  const swarm = new RecordingSystem('swarm', 0x03, log);
  const core = new RenderCoreImpl(
    backend,
    { backend: 'auto', antialias: options.antialias ?? false },
    [sprites, swarm],
    message => {
      // frameDone is a reused object: snapshot it like a real listener would read it.
      messages.push({ ...message } as CoreMessage);
    },
  );
  return { backend, log, messages, sprites, swarm, core };
}

function cmd(enc: TestEncoder, op: number, values: number[], flags = 0): void {
  enc.begin(op, values.length * 4, flags);
  for (const v of values) enc.u32(v);
  enc.end();
}

function f32cmd(enc: TestEncoder, op: number, values: number[]): void {
  enc.begin(op, values.length * 4);
  for (const v of values) enc.f32(v);
  enc.end();
}

describe('RenderCore', () => {
  it('runs execute → compute → draw replay → submit → endFrame and acks', async () => {
    const { core, log, messages, sprites } = setup();
    await core.init();
    expect(sprites.inits).toBe(1);
    log.length = 0;

    const enc = new TestEncoder();
    f32cmd(enc, Op.FRAME_BEGIN, [1.5, 0.016]);
    cmd(enc, SPRITE_OP, [11]);
    cmd(enc, SPRITE_DRAW, [21], CommandFlag.DRAW);
    cmd(enc, SWARM_STEP, [12], CommandFlag.COMPUTE);
    cmd(enc, SWARM_DRAW, [22], CommandFlag.DRAW);
    cmd(enc, SPRITE_DRAW, [23], CommandFlag.DRAW);
    cmd(enc, Op.FRAME_END, []);
    const packet = enc.finish(7);
    core.execute(packet);

    expect(log.filter(l => !l.startsWith('writeBuffer'))).toEqual([
      'sprites.execute 202 11',
      'swarm.execute 309 12',
      'beginCommands',
      'sprites.compute',
      'swarm.compute',
      'beginRenderPass',
      'sprites.draw 210 21',
      'swarm.draw 30a 22',
      'sprites.draw 210 23',
      'pass.end',
      'submit',
      'sprites.endFrame',
      'swarm.endFrame',
    ]);
    expect(messages).toEqual([
      { type: 'frameDone', frameId: 7, buffer: packet.buffer },
    ]);
  });

  it('holds frameDone while a pacing backend is backlogged', async () => {
    const { core, backend, messages } = setup();
    await core.init();
    let behind = true;
    let caughtUp: (() => void) | null = null;
    let paced = 0;
    Object.assign(backend, {
      paceReadbacks: () => paced++,
      backlogged: () => behind,
      whenCaughtUp: (cb: () => void) => (caughtUp = cb),
    });
    const enc = new TestEncoder();
    cmd(enc, SPRITE_DRAW, [1], CommandFlag.DRAW);
    const packet = enc.finish(9);
    core.execute(packet);
    expect(messages.filter(m => m.type === 'frameDone')).toEqual([]);
    behind = false;
    caughtUp!();
    expect(messages.filter(m => m.type === 'frameDone')).toEqual([
      { type: 'frameDone', frameId: 9, buffer: packet.buffer },
    ]);
    // A PICK turns readback pacing on.
    const pick = new TestEncoder();
    pick.begin(Op.PICK, 12);
    pick.u32(1);
    pick.f32(0);
    pick.f32(0);
    pick.end();
    core.execute(pick.finish(10));
    expect(paced).toBe(1);
  });

  it('posts exactly one frameDone when systems throw in every phase', async () => {
    const { core, log, messages, sprites } = setup();
    await core.init();
    const boom = (): never => {
      throw new Error('boom');
    };
    sprites.execute = boom;
    sprites.compute = boom;
    sprites.draw = boom;
    sprites.endFrame = boom;
    log.length = 0;

    const enc = new TestEncoder();
    cmd(enc, SPRITE_OP, [1]);
    cmd(enc, SPRITE_DRAW, [2], CommandFlag.DRAW);
    const packet = enc.finish(3);
    core.execute(packet);

    expect(log).toContain('submit');
    const done = messages.filter(m => m.type === 'frameDone');
    expect(done).toEqual([
      { type: 'frameDone', frameId: 3, buffer: packet.buffer },
    ]);
    expect(
      messages.filter(m => m.type === 'error').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('writes the view uniform with time, dt, resolution and dpr', async () => {
    const { core, backend } = setup();
    await core.init();
    const enc = new TestEncoder();
    f32cmd(enc, Op.FRAME_BEGIN, [2, 0.5]);
    f32cmd(enc, Op.RESIZE, [400, 200, 2]);
    f32cmd(enc, Op.SET_VIEW, [1, 0, 0, 1, 10, 20]);
    core.execute(enc.finish(1));

    expect(backend.pixelWidth).toBe(800);
    expect(backend.pixelHeight).toBe(400);
    const viewBuffer = backend.buffers.find(b => b.label === 'cozygpu view')!;
    const view = new Float32Array(viewBuffer.bytes.buffer);
    expect(Array.from(view)).toEqual([
      1, 0, 0, 1, 10, 20, 400, 200, 2, 0.5, 2, 0,
    ]);
  });

  it('passes the straight clear color and uses an MSAA target when antialias', async () => {
    const { core, backend } = setup({ antialias: true });
    await core.init();
    const enc = new TestEncoder();
    f32cmd(enc, Op.RESIZE, [100, 50, 1]);
    f32cmd(enc, Op.SET_CLEAR_COLOR, [1, 0.5, 0, 0.25]);
    core.execute(enc.finish(1));
    const msaa = backend.textures
      .filter(t => t.label === 'cozygpu msaa')
      .pop() as FakeTexture;
    expect(msaa).toBeDefined();
    expect(msaa.sampleCount).toBe(4);
    expect(msaa.width).toBe(100);
    expect(backend.lastPassDesc!.target).toBe(msaa);
    expect(backend.lastPassDesc!.resolveTarget).toBe('canvas');
    // Straight color in the RHI desc; the backend premultiplies.
    expect(backend.lastPassDesc!.clearColor).toEqual([1, 0.5, 0, 0.25]);

    const enc2 = new TestEncoder();
    f32cmd(enc2, Op.RESIZE, [120, 60, 1]);
    core.execute(enc2.finish(2));
    expect(msaa.destroyed).toBe(true);
  });

  it('skips GPU work for a zero-size canvas but still acks', async () => {
    const { core, log, messages } = setup();
    await core.init();
    const enc = new TestEncoder();
    f32cmd(enc, Op.RESIZE, [0, 0, 1]);
    cmd(enc, SPRITE_DRAW, [1], CommandFlag.DRAW);
    log.length = 0;
    core.execute(enc.finish(3));
    expect(log).not.toContain('beginCommands');
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'frameDone',
      frameId: 3,
    });
  });

  it('creates, premultiplies, retains and destroys textures', async () => {
    const { core, backend } = setup();
    await core.init();
    const enc = new TestEncoder();
    cmd(enc, Op.TEXTURE_CREATE, [
      5,
      2,
      1,
      TextureFormatId.rgba8unorm,
      TextureFlag.RETAIN_SOURCE,
    ]);
    enc.begin(Op.TEXTURE_UPLOAD_PIXELS, 20 + 8);
    for (const v of [5, 0, 0, 2, 1]) enc.u32(v);
    enc.bytes(new Uint8Array([200, 100, 50, 128, 10, 20, 30, 255]));
    enc.end();
    core.execute(enc.finish(1));

    const ctx = core.context;
    const tex = ctx.getTexture(5);
    expect(tex).not.toBe(ctx.whiteTexture);
    expect(tex.width).toBe(2);
    const write = backend.textureWrites.find(w => w.texture === tex.texture)!;
    expect(Array.from(write.data)).toEqual([100, 50, 25, 128, 10, 20, 30, 255]);
    expect(ctx.getTexture(999)).toBe(ctx.whiteTexture);

    const enc2 = new TestEncoder();
    cmd(enc2, Op.TEXTURE_DESTROY, [5]);
    core.execute(enc2.finish(2));
    expect(ctx.getTexture(5)).toBe(ctx.whiteTexture);
    expect((tex.texture as FakeTexture).destroyed).toBe(true);
  });

  it('keeps shared memory registrations', async () => {
    const { core } = setup();
    await core.init();
    const shared = new ArrayBuffer(40);
    const enc = new TestEncoder();
    const index = enc.addObject(shared, false);
    cmd(enc, Op.SHARED_REGISTER, [9, index]);
    core.execute(enc.finish(1));
    expect(core.context.getShared(9)).toBe(shared);
    const enc2 = new TestEncoder();
    cmd(enc2, Op.SHARED_RELEASE, [9]);
    core.execute(enc2.finish(2));
    expect(core.context.getShared(9)).toBeUndefined();
  });

  it('warns once per unknown opcode and keeps decoding', async () => {
    const { core, log } = setup();
    await core.init();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let frame = 1; frame <= 2; frame++) {
      const enc = new TestEncoder();
      cmd(enc, 0x7f01, [1, 2, 3]);
      cmd(enc, SPRITE_OP, [4]);
      core.execute(enc.finish(frame));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log.filter(l => l === 'sprites.execute 202 4')).toHaveLength(2);
    warn.mockRestore();
  });

  it('drops frames while lost, restores textures + systems, then resumes', async () => {
    const { core, backend, messages, sprites, swarm, log } = setup();
    await core.init();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const enc = new TestEncoder();
    cmd(enc, Op.TEXTURE_CREATE, [
      1,
      1,
      1,
      TextureFormatId.rgba8unorm,
      TextureFlag.RETAIN_SOURCE,
    ]);
    enc.begin(Op.TEXTURE_UPLOAD_PIXELS, 24);
    for (const v of [1, 0, 0, 1, 1]) enc.u32(v);
    enc.bytes(new Uint8Array([255, 0, 0, 255]));
    enc.end();
    cmd(enc, Op.TEXTURE_CREATE, [2, 1, 1, TextureFormatId.rgba8unorm, 0]);
    core.execute(enc.finish(1));
    const before = core.context.getTexture(1);

    backend.loseDevice();
    expect(messages[messages.length - 1]).toEqual({
      type: 'deviceLost',
      message: 'fake loss',
    });

    log.length = 0;
    const lostFrame = new TestEncoder();
    cmd(lostFrame, SPRITE_OP, [1]);
    core.execute(lostFrame.finish(2));
    expect(log).not.toContain('sprites.execute 202 1');
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'frameDone',
      frameId: 2,
    });

    await core.restorePromise;
    expect(messages[messages.length - 1]).toEqual({ type: 'deviceRestored' });
    expect(sprites.restores).toBe(1);
    expect(swarm.restores).toBe(1);
    const after = core.context.getTexture(1);
    expect(after).not.toBe(before);
    expect(after).not.toBe(core.context.whiteTexture);
    // Unretained texture falls back to white until the front re-creates it.
    expect(core.context.getTexture(2)).toBe(core.context.whiteTexture);

    log.length = 0;
    const next = new TestEncoder();
    cmd(next, SPRITE_OP, [3]);
    core.execute(next.finish(3));
    expect(log).toContain('sprites.execute 202 3');
    warn.mockRestore();
  });

  it('posts error{DEVICE_LOST} when restore fails', async () => {
    const { core, backend, messages } = setup();
    await core.init();
    backend.restoreFailures = 1;
    backend.loseDevice();
    await core.restorePromise;
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'error',
      code: 'DEVICE_LOST',
    });
  });

  // Regression (WebGL2): a context lost again after backend.restore() but
  // before the backend's loss notification made a system restore reject
  // DEVICE_LOST while lostAgain was still false, so the core went DEAD and
  // the front destroyed the renderer. It must restore again instead.
  it('restores again when a system restore fails with DEVICE_LOST after the backend came back', async () => {
    const { core, backend, messages, sprites } = setup();
    await core.init();
    let failures = 1;
    const restore = sprites.restore.bind(sprites);
    sprites.restore = async () => {
      if (failures > 0) {
        failures--;
        throw new CozyGPUError(
          'DEVICE_LOST',
          'program "cozygpu.sprite.normal": WebGL context lost',
        );
      }
      return restore();
    };
    backend.loseDevice();
    await core.restorePromise;
    expect(backend.calls.filter(c => c === 'restore')).toHaveLength(2);
    expect(messages.some(m => m.type === 'error')).toBe(false);
    expect(messages[messages.length - 1]).toEqual({ type: 'deviceRestored' });
    expect(sprites.restores).toBe(1);
  });

  it('still goes DEAD when system restores keep failing with DEVICE_LOST', async () => {
    const { core, backend, messages, sprites } = setup();
    await core.init();
    sprites.restore = async () => {
      throw new CozyGPUError('DEVICE_LOST', 'context lost');
    };
    backend.loseDevice();
    await core.restorePromise;
    expect(backend.calls.filter(c => c === 'restore')).toHaveLength(4);
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'error',
      code: 'DEVICE_LOST',
    });
  });

  it('ignores the device loss caused by its own destroy()', async () => {
    const { core, backend, messages } = setup();
    await core.init();
    core.destroy();
    backend.loseDevice('destroyed');
    expect(messages).toHaveLength(0);
    expect(core.restorePromise).toBeNull();
  });

  // Regression: a raw GPUDevice.destroy() from outside the renderer (reason
  // 'destroyed') was ignored, leaving a silent dead renderer.
  it('restores after a device destroyed outside the renderer', async () => {
    const { core, backend, messages } = setup();
    await core.init();
    backend.loseDevice('destroyed');
    expect(messages[0]).toMatchObject({ type: 'deviceLost' });
    expect(core.restorePromise).not.toBeNull();
    await core.restorePromise;
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'deviceRestored',
    });
  });

  it('routes READBACK to a system exposing readback()', async () => {
    const { core, messages, swarm } = setup();
    await core.init();
    (swarm as unknown as { readback: unknown }).readback = (
      kind: number,
      id: number,
      first: number,
      count: number,
    ) =>
      kind === 1
        ? Promise.resolve(new Float32Array([id, first, count]).buffer)
        : undefined;
    const enc = new TestEncoder();
    cmd(enc, Op.READBACK, [77, 1, 4, 5, 6]);
    core.execute(enc.finish(1));
    await Promise.resolve();
    await Promise.resolve();
    const msg = messages.find(m => m.type === 'readback') as Extract<
      CoreMessage,
      { type: 'readback' }
    >;
    expect(msg.requestId).toBe(77);
    expect(Array.from(new Float32Array(msg.data))).toEqual([4, 5, 6]);
  });

  // Regression: packets dropped while the core is LOST used to swallow their
  // READBACK commands, so the front's readback promise never settled.
  it('answers READBACK with empty data in packets dropped while the device is lost', async () => {
    const { core, backend, messages } = setup();
    await core.init();
    backend.restoreFailures = 0;
    backend.loseDevice();
    const enc = new TestEncoder();
    cmd(enc, SPRITE_OP, [1]);
    cmd(enc, Op.READBACK, [55, 1, 4, 0, 1]);
    cmd(enc, Op.READBACK, [56, 2, 4, 0, 1]);
    core.execute(enc.finish(2));
    const answers = messages.filter(m => m.type === 'readback') as Extract<
      CoreMessage,
      { type: 'readback' }
    >[];
    expect(answers.map(m => [m.requestId, m.data.byteLength, m.code])).toEqual([
      [55, 0, 'DEVICE_LOST'],
      [56, 0, 'DEVICE_LOST'],
    ]);
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'frameDone',
      frameId: 2,
    });
    await core.restorePromise;
  });

  it('a readback failing because the device was lost is answered but not reported', async () => {
    const { core, backend, messages, swarm } = setup();
    await core.init();
    let fail: (err: Error) => void = () => {};
    (swarm as unknown as { readback: unknown }).readback = () =>
      new Promise<ArrayBuffer>((_, reject) => (fail = reject));
    const enc = new TestEncoder();
    cmd(enc, Op.READBACK, [58, 1, 4, 0, 1]);
    core.execute(enc.finish(1));
    backend.loseDevice();
    fail(new Error('Buffer was unmapped before mapping was resolved.'));
    await core.restorePromise;
    await Promise.resolve();
    expect(messages.find(m => m.type === 'readback')).toMatchObject({
      requestId: 58,
      code: 'DEVICE_LOST',
    });
    expect(messages.filter(m => m.type === 'error')).toEqual([]);
  });

  // Regression: every failed readback was answered with bare empty data, which
  // the front turned into UNSUPPORTED whatever the cause.
  it('answers failed READBACKs with the error code', async () => {
    const { core, messages, swarm } = setup();
    await core.init();
    const { CozyGPUError } = jest.requireActual('../types/errors');
    (swarm as unknown as { readback: unknown }).readback = (kind: number) =>
      kind === 1
        ? Promise.reject(new CozyGPUError('OUT_OF_CAPACITY', 'refused'))
        : kind === 2
          ? Promise.reject(new Error('boom'))
          : undefined;
    const enc = new TestEncoder();
    cmd(enc, Op.READBACK, [60, 1, 4, 0, 1]);
    cmd(enc, Op.READBACK, [61, 2, 4, 0, 1]);
    cmd(enc, Op.READBACK, [62, 9, 4, 0, 1]);
    core.execute(enc.finish(1));
    await new Promise(r => setTimeout(r, 0));
    const answers = messages.filter(m => m.type === 'readback') as Extract<
      CoreMessage,
      { type: 'readback' }
    >[];
    const codes = new Map(answers.map(m => [m.requestId, m.code]));
    expect(codes.get(60)).toBe('OUT_OF_CAPACITY');
    expect(codes.get(61)).toBe('INTERNAL');
    expect(codes.get(62)).toBe('UNSUPPORTED');
    const errors = messages.filter(m => m.type === 'error') as Extract<
      CoreMessage,
      { type: 'error' }
    >[];
    // Only the non-library failure is logged as a bug.
    expect(errors.map(e => e.code)).toEqual(['INTERNAL']);
  });

  it('answers READBACK left in a packet when the device is lost mid-packet', async () => {
    const { core, backend, messages, sprites } = setup();
    await core.init();
    sprites.execute = () => backend.loseDevice();
    const enc = new TestEncoder();
    cmd(enc, SPRITE_OP, [1]);
    cmd(enc, Op.READBACK, [57, 1, 4, 0, 1]);
    core.execute(enc.finish(1));
    const answer = messages.find(m => m.type === 'readback') as Extract<
      CoreMessage,
      { type: 'readback' }
    >;
    expect(answer).toMatchObject({ requestId: 57 });
    expect(answer.data.byteLength).toBe(0);
    await core.restorePromise;
  });

  it('rejects systems that claim reserved or duplicate ranges', () => {
    const backend = new FakeBackend();
    const post = () => {};
    expect(
      () =>
        new RenderCoreImpl(
          backend,
          { backend: 'auto', antialias: false },
          [new RecordingSystem('x', 0x01, [])],
          post,
        ),
    ).toThrow(/reserved/);
    expect(
      () =>
        new RenderCoreImpl(
          backend,
          { backend: 'auto', antialias: false },
          [
            new RecordingSystem('a', 0x02, []),
            new RecordingSystem('b', 0x02, []),
          ],
          post,
        ),
    ).toThrow(/share/);
  });

  it('destroys systems, textures and the backend', async () => {
    const { core, backend, log } = setup();
    await core.init();
    core.destroy();
    expect(log).toContain('sprites.destroy');
    expect(backend.destroyed).toBe(true);
    // Packets after destroy are only acked.
    const enc = new TestEncoder();
    cmd(enc, SPRITE_OP, [1]);
    core.execute(enc.finish(9));
    expect(log).not.toContain('sprites.execute 202 1');
  });
});

// Keep TestDecoder referenced for the mock factory's type-only import.
export type { TestDecoder };
