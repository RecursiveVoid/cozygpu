import { CommandFlag } from '../commands/opcodes';
import { FAKE_CAPS, FakeBackend } from '../renderer/testing/fakeBackend';
import type { CoreContext, CoreFrameState } from '../types/core';
import type { CoreMessage } from '../types/transport';
import { FakeEncoder, FakeReader } from './__fakes__/commands';
import { behaviors } from './behaviors';
import { createSwarmCoreSystem } from './core';
import { Swarm } from './Swarm';
import type { FrontFrame } from '../types/core';

const IDENTITY = new Float32Array([1, 0, 0, 1, 0, 0]);
const flush = () => new Promise(r => setTimeout(r, 0));

function setup() {
  const backend = new FakeBackend(800, 600);
  const posted: CoreMessage[] = [];
  const res = { label: 'r', destroy() {} };
  const ctx = {
    backend,
    viewLayout: res,
    viewBindGroup: res,
    textureLayout: res,
    whiteTexture: { bindGroup: res },
    getTexture: () => ({ bindGroup: res }),
    getShared: () => undefined,
    sampleCount: 1,
    post: (m: CoreMessage) => posted.push(m),
  } as unknown as CoreContext;
  const system = createSwarmCoreSystem();
  const frameState = { frameId: 1, time: 0, dt: 1 / 60 } as CoreFrameState;
  const front: FrontFrame & { encoder: FakeEncoder } = {
    rendererId: 7,
    encoder: new FakeEncoder(),
    frameId: 1,
    time: 0,
    dt: 1 / 60,
    cssWidth: 800,
    cssHeight: 600,
    resolution: 1,
    sharedMemory: true,
    useSharedArrayBuffer: false,
    generation: 0,
    registerShared: () => 1,
    readback: () => Promise.resolve(new ArrayBuffer(0)),
    caps: FAKE_CAPS,
    isSystemReady: () => true,
  };
  /** One frame through the core, like RenderCore does (execute, compute, draw). */
  const frame = (swarm: Swarm): string[] => {
    backend.calls.length = 0;
    front.encoder.reset();
    swarm._emitDraw(front, IDENTITY, 0, 1);
    const reader = new FakeReader(front.encoder.finish(1));
    const commands = reader.list();
    for (const c of commands) {
      if (c.flags & CommandFlag.DRAW) continue;
      reader.seek(c.commandOffset);
      system.execute(reader, frameState);
    }
    const list = backend.beginCommands();
    system.compute!(list, frameState);
    const pass = list.beginRenderPass({ color: { target: null } } as never);
    for (const c of commands) {
      if (!(c.flags & CommandFlag.DRAW)) continue;
      reader.seek(c.commandOffset);
      system.draw(reader, pass, frameState);
    }
    return backend.calls.filter(s => /^(dispatch|draw|computePass)/.test(s));
  };
  return { backend, ctx, system, frame, posted, front };
}

describe('swarm core system', () => {
  test('spawn waits for pipelines, steps and draws afterwards', async () => {
    const { ctx, system, frame, posted } = setup();
    await system.init(ctx);
    const swarm = new Swarm({
      capacity: 1000,
      behaviors: [behaviors.velocity()],
    });
    swarm.spawn(1000);

    // Pipelines compile asynchronously: nothing is dispatched or drawn yet.
    expect(frame(swarm)).toEqual([]);
    await flush();
    // Frame 2: the kept spawn runs first (4 workgroups of 256), then the step.
    expect(frame(swarm)).toEqual([
      'dispatch 4',
      'dispatch 4',
      'computePass.end',
      'draw 4',
    ]);
    expect(frame(swarm)).toEqual(['dispatch 4', 'computePass.end', 'draw 4']);
    expect(posted).toEqual([]);
    swarm.destroy();
    system.destroy();
  });

  test('over-capacity swarms report OUT_OF_CAPACITY', async () => {
    const { ctx, system, frame, posted, backend } = setup();
    backend.caps = { ...backend.caps, maxStorageBufferBindingSize: 400 };
    await system.init(ctx);
    const swarm = new Swarm({ capacity: 11 });
    swarm.spawn(11);
    frame(swarm);
    expect(posted.map(m => (m as { code?: string }).code)).toEqual([
      'OUT_OF_CAPACITY',
    ]);
    // Regression: readback of a refused swarm resolved empty, which the
    // front reported as UNSUPPORTED. It now carries the refusal code.
    await expect(system.readback(1, swarm.swarmId, 0, 1)).rejects.toMatchObject(
      { code: 'OUT_OF_CAPACITY' },
    );
    await expect(system.readback(2, 999, 0, 1)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    swarm.destroy();
    system.destroy();
  });

  // Regression: capacities up to the binding limit (100M = 6 GB) were
  // accepted silently and then ran at about 1 fps.
  test('very large swarms log one allocation warning', async () => {
    const { ctx, system, frame, posted, backend } = setup();
    backend.caps = {
      ...backend.caps,
      maxStorageBufferBindingSize: 2 ** 32,
      maxBufferSize: 2 ** 32,
    };
    await system.init(ctx);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const small = new Swarm({ capacity: 1000 });
    frame(small);
    expect(warn).not.toHaveBeenCalled();
    const big = new Swarm({ capacity: 20_000_000 });
    frame(big);
    const big2 = new Swarm({ capacity: 20_000_000 });
    frame(big2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /capacity 20000000 allocates 1\.0 GiB/,
    );
    expect(posted).toEqual([]);
    warn.mockRestore();
    small.destroy();
    big.destroy();
    big2.destroy();
    system.destroy();
  });

  // Regression: a swarm whose hot/cold allocation failed with out-of-memory
  // (inside the reported limits) was bound every frame, invalidating every
  // command buffer. It must stay idle until the allocation is confirmed, and
  // be disabled with OUT_OF_CAPACITY when it fails.
  test('out-of-memory hot/cold allocation disables only that swarm', async () => {
    const { ctx, system, frame, posted, backend } = setup();
    let failHot = true;
    const create = backend.createBuffer.bind(backend);
    let resolveHot: (ok: boolean) => void = () => {};
    backend.createBuffer = desc => {
      const buffer = create(desc);
      if (/\.hot$/.test(desc.label ?? '')) {
        (buffer as { allocated?: Promise<boolean> }).allocated = new Promise(
          r => (resolveHot = r),
        );
      }
      return buffer;
    };
    await system.init(ctx);
    const swarm = new Swarm({
      capacity: 1000,
      behaviors: [behaviors.velocity()],
    });
    swarm.spawn(1000);
    expect(frame(swarm)).toEqual([]);
    await flush(); // pipelines ready, allocation still unknown
    expect(frame(swarm)).toEqual([]);
    const read = system.readback(1, swarm.swarmId, 0, 1)!.then(
      () => null,
      (e: unknown) => e,
    );
    resolveHot(!failHot);
    await flush();
    expect(posted.map(m => (m as { code?: string }).code)).toEqual([
      'OUT_OF_CAPACITY',
    ]);
    // Rejected with the reason instead of reading a disabled swarm.
    expect(await read).toMatchObject({ code: 'OUT_OF_CAPACITY' });
    // Disabled: nothing is dispatched or drawn for it any more.
    expect(frame(swarm)).toEqual([]);
    expect(frame(swarm)).toEqual([]);
    swarm.destroy();

    // A successful allocation starts running once confirmed.
    failHot = false;
    posted.length = 0;
    const ok = new Swarm({ capacity: 1000, behaviors: [behaviors.velocity()] });
    ok.spawn(1000);
    expect(frame(ok)).toEqual([]);
    await flush();
    expect(frame(ok)).toEqual([]);
    resolveHot(true);
    await flush();
    expect(frame(ok)).toEqual([
      'dispatch 4',
      'dispatch 4',
      'computePass.end',
      'draw 4',
    ]);
    expect(posted).toEqual([]);
    ok.destroy();
    system.destroy();
  });

  test('restore forgets GPU swarms; the front re-creates them', async () => {
    const { ctx, system, frame, front } = setup();
    await system.init(ctx);
    let restores = 0;
    const swarm = new Swarm({
      capacity: 300,
      onRestore: s => {
        restores++;
        s.spawn(300);
      },
    });
    swarm.spawn(300);
    frame(swarm);
    await flush();
    frame(swarm);
    await system.restore(ctx);
    expect(frame(swarm)).toEqual([]); // unknown swarm id until re-created
    (front as { generation: number }).generation = 1;
    frame(swarm);
    await flush();
    expect(restores).toBe(1);
    expect(frame(swarm)).toEqual([
      'dispatch 2',
      'dispatch 2',
      'computePass.end',
      'draw 4',
    ]);
    swarm.destroy();
    system.destroy();
  });
});
