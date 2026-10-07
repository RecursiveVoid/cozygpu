/**
 * M2 core paths against the fake RHI: allocation 'gpu'
 * (free list + compaction + drawIndirect), alive counts, picking, and the
 * WebGL2 transform-feedback core.
 */
import type {
  Capabilities,
  CommandList,
  FeedbackPass,
  RenderPass,
  RhiBuffer,
} from '../backend/types';
import { CommandFlag, Op, ReadbackSource } from '../commands/opcodes';
import {
  FAKE_CAPS,
  FakeBackend,
  FakeBuffer,
} from '../renderer/testing/fakeBackend';
import type { CoreContext, CoreFrameState, FrontFrame } from '../types/core';
import type { CoreMessage } from '../types/transport';
import { FakeEncoder, FakeReader } from './__fakes__/commands';
import { behaviors, defineBehavior } from './behaviors';
import { createSwarmCoreSystem } from './core';
import { installGlslComposer } from './glsl';
import { Swarm } from './Swarm';

const IDENTITY = new Float32Array([1, 0, 0, 1, 0, 0]);
const flush = () => new Promise(r => setTimeout(r, 0));

const GL_CAPS: Capabilities = {
  ...FAKE_CAPS,
  backend: 'webgl2',
  shaderLanguage: 'glsl300es',
  compute: false,
  storageBuffers: false,
  vertexStorage: false,
  indirectDraw: false,
  transformFeedback: true,
  canvasFormat: 'rgba8unorm',
};

function setup(caps: Capabilities = FAKE_CAPS) {
  const backend = new FakeBackend(800, 600);
  backend.caps = { ...caps };
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
    caps: backend.caps,
    isSystemReady: () => true,
  };
  const log: string[] = [];
  const renderPass = {
    setPipeline: (p: { label?: string }) => log.push(`pipeline ${p.label}`),
    setBindGroup: (i: number, g: { label?: string }) =>
      log.push(`group${i} ${g.label}`),
    setVertexBuffer: (slot: number, b: RhiBuffer) =>
      log.push(`vertex${slot} ${b.label}`),
    setIndexBuffer: () => {},
    setViewport: () => {},
    setScissor: () => {},
    draw: (v: number, n: number) => log.push(`draw ${v}x${n}`),
    drawIndexed: () => {},
    drawIndirect: (b: RhiBuffer) => log.push(`drawIndirect ${b.label}`),
    end: () => {},
  } as unknown as RenderPass;
  const feedbackPass: FeedbackPass = {
    setPipeline: p => log.push(`fb.pipeline ${p.label}`),
    setBindGroup: () => {},
    setVertexBuffer: (slot, b) => log.push(`fb.vertex${slot} ${b.label}`),
    run: (out, offset, first, count) =>
      log.push(`fb.run ${out.label} @${offset} [${first}+${count}]`),
    end: () => log.push('fb.end'),
  };
  const computePass = {
    setPipeline: (p: { label?: string }) => log.push(`cs ${p.label}`),
    setBindGroup: () => {},
    dispatch: (x: number) => log.push(`dispatch ${x}`),
    dispatchIndirect: () => {},
    end: () => log.push('cs.end'),
  };
  const list = {
    beginRenderPass: () => renderPass,
    beginComputePass: () => computePass,
    beginFeedbackPass: () => feedbackPass,
    submit: () => {},
  } as unknown as CommandList;

  /** One frame like RenderCore: execute, compute, draw, (pick), endFrame. */
  const frame = (swarm: Swarm, pick = false): string[] => {
    log.length = 0;
    front.encoder.reset();
    swarm._emitDraw(front, IDENTITY, 0, 1);
    const reader = new FakeReader(front.encoder.finish(1));
    const commands = reader.list();
    for (const c of commands) {
      if (c.flags & CommandFlag.DRAW) continue;
      reader.seek(c.commandOffset);
      system.execute(reader, frameState);
    }
    system.compute!(list, frameState);
    for (const c of commands) {
      if (!(c.flags & CommandFlag.DRAW)) continue;
      reader.seek(c.commandOffset);
      system.draw(reader, renderPass, frameState);
      if (pick) {
        reader.seek(c.commandOffset);
        system.drawPick!(reader, renderPass, frameState, {
          label: 'pickView',
          destroy() {},
        });
      }
    }
    system.endFrame!(frameState);
    return log.slice();
  };
  const opcodes = (swarm: Swarm): number[] => {
    front.encoder.reset();
    swarm._emitDraw(front, IDENTITY, 0, 1);
    return new FakeReader(front.encoder.finish(1))
      .list()
      .map(c => c.opcode)
      .filter(op => op !== Op.SWARM_DESTROY); // other tests' swarms
  };
  const buffer = (suffix: string) =>
    backend.buffers
      .filter(b => !b.destroyed && b.label?.endsWith(suffix))
      .pop()!;
  return { backend, ctx, system, frame, opcodes, posted, front, buffer };
}

describe("allocation 'gpu' (WebGPU)", () => {
  test('initialises the free list, pops on spawn, compacts, draws indirect', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 1000,
      allocation: 'gpu',
      behaviors: [behaviors.velocity()],
    });
    expect(swarm.spawn(10, { life: 1 })).toBe(0);
    expect(swarm.activeCount).toBe(1000);
    h.frame(swarm);
    // freeTop starts at capacity
    expect(new Uint32Array(h.buffer('.counters').bytes.buffer)[0]).toBe(1000);
    expect(h.buffer('.free').size).toBe(4000);
    await flush();
    const log = h.frame(swarm);
    expect(
      log.filter(l => /^(cs |dispatch|drawIndirect|draw )/.test(l)),
    ).toEqual([
      `cs swarm${swarm.swarmId}.cs_free_init`,
      'dispatch 4',
      `cs swarm${swarm.swarmId}.cs_spawn_pop`,
      'dispatch 1',
      `cs swarm${swarm.swarmId}.cs_spawn`,
      'dispatch 1',
      `cs swarm${swarm.swarmId}.cs_step`,
      'dispatch 4',
      `cs swarm${swarm.swarmId}.cs_cull`,
      'dispatch 4',
      `drawIndirect swarm${swarm.swarmId}.args`,
    ]);
    swarm.destroy();
    h.system.destroy();
  });

  test('kill lists are de-duplicated so a slot is pushed once', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 64, allocation: 'gpu' });
    swarm.spawn(8);
    h.frame(swarm);
    await flush();
    h.frame(swarm);
    swarm.killList(new Uint32Array([5, 3, 5, 5, 3, 9]));
    h.frame(swarm);
    const kill = h.buffer('.kill');
    expect(Array.from(new Uint32Array(kill.bytes.buffer, 0, 3))).toEqual([
      3, 5, 9,
    ]);
    swarm.destroy();
    h.system.destroy();
  });

  test('aliveCount reads the counters buffer', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 64, allocation: 'gpu' });
    swarm.spawn(8);
    h.frame(swarm);
    new Uint32Array(h.buffer('.counters').bytes.buffer)[1] = 42;
    const data = await h.system.readback(
      ReadbackSource.SWARM_ALIVE,
      swarm.swarmId,
      0,
      0,
    )!;
    expect(new Uint32Array(data)[0]).toBe(42);
    swarm.destroy();
    h.system.destroy();
  });

  test('WebGPU without indirect draws refuses allocation gpu', async () => {
    const h = setup({ ...FAKE_CAPS, indirectDraw: false });
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 64, allocation: 'gpu' });
    h.frame(swarm);
    expect(h.posted.map(m => (m as { code?: string }).code)).toEqual([
      'UNSUPPORTED',
    ]);
    swarm.destroy();
    h.system.destroy();
  });
});

describe('alive counts and picking (WebGPU)', () => {
  test("'ring' aliveCount dispatches cs_count and reads after the frame", async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 600 });
    swarm.spawn(600);
    h.frame(swarm);
    await flush();
    h.frame(swarm);
    const reads: string[] = [];
    h.backend.readBuffer = async (b, offset, length) => {
      reads.push(`${b.label} ${offset} ${length}`);
      return new Uint32Array([123]).buffer;
    };
    const pending = h.system.readback(
      ReadbackSource.SWARM_ALIVE,
      swarm.swarmId,
      0,
      600,
    )!;
    expect(reads).toEqual([]);
    const log = h.frame(swarm);
    expect(log).toContain(`cs swarm${swarm.swarmId}.cs_count`);
    expect(reads).toEqual([`swarm${swarm.swarmId}.counters 4 4`]);
    expect(new Uint32Array(await pending)[0]).toBe(123);
    // Only once per request.
    expect(h.frame(swarm)).not.toContain(`cs swarm${swarm.swarmId}.cs_count`);
    swarm.destroy();
    h.system.destroy();
  });

  test('destroy rejects pending alive counts', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 10 });
    swarm.spawn(10);
    h.frame(swarm);
    const pending = h.system.readback(
      ReadbackSource.SWARM_ALIVE,
      swarm.swarmId,
      0,
      10,
    )!;
    h.system.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'DESTROYED' });
    swarm.destroy();
  });

  test('pickable swarms emit SWARM_SET_PICK once and draw the pick pipeline', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 16 });
    swarm.spawn(16);
    expect(h.opcodes(swarm)).not.toContain(Op.SWARM_SET_PICK);
    swarm.pickable = true;
    expect(h.opcodes(swarm)).toContain(Op.SWARM_SET_PICK);
    expect(h.opcodes(swarm)).not.toContain(Op.SWARM_SET_PICK);
    swarm.pickable = false;
    expect(h.opcodes(swarm)).toContain(Op.SWARM_SET_PICK);
    swarm.destroy();

    const s2 = new Swarm({ capacity: 16, pickable: true });
    s2.spawn(16);
    h.frame(s2, true);
    await flush();
    await flush();
    const log = h.frame(s2, true);
    const pick = log.indexOf(`pipeline swarm${s2.swarmId}.pick`);
    expect(pick).toBeGreaterThan(0);
    expect(log.slice(pick)).toEqual([
      `pipeline swarm${s2.swarmId}.pick`,
      'group0 pickView',
      'group1 r',
      `group2 swarm${s2.swarmId}.pick`,
      'draw 4x16',
    ]);
    expect(
      new Uint32Array(h.buffer(`swarm${s2.swarmId}.pick`).bytes.buffer)[0],
    ).toBe(s2.id);
    s2.destroy();
    h.system.destroy();
  });
});

describe('WebGL2 swarm core (transform feedback)', () => {
  beforeAll(() => installGlslComposer());

  test('spawn, step (ping-pong) and instanced draw', async () => {
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 100,
      behaviors: [behaviors.velocity(), behaviors.drag()],
    });
    swarm.spawn(40);
    h.frame(swarm);
    await flush();
    const id = swarm.swarmId;
    expect(h.frame(swarm)).toEqual([
      `fb.pipeline swarm${id}.gl.spawn`,
      `fb.run swarm${id}.hotA @0 [0+40]`,
      `fb.pipeline swarm${id}.gl.spawnCold`,
      `fb.run swarm${id}.cold @0 [0+40]`,
      `fb.pipeline swarm${id}.gl.step`,
      `fb.vertex0 swarm${id}.hotA`,
      `fb.vertex1 swarm${id}.cold`,
      `fb.run swarm${id}.hotB @0 [0+40]`,
      'fb.end',
      `pipeline swarm${id}.gl.render`,
      'group0 r',
      'group1 r',
      `group2 swarm${id}.gl.render`,
      `vertex0 swarm${id}.hotB`,
      `vertex1 swarm${id}.cold`,
      'draw 4x40',
    ]);
    // next frame steps hotB → hotA
    expect(h.frame(swarm)).toContain(`fb.run swarm${id}.hotA @0 [0+40]`);
    expect(h.posted).toEqual([]);
    swarm.destroy();
    h.system.destroy();
  });

  test('kills zero both hot buffers; aliveCount counts on the core', async () => {
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 10, autoStep: false });
    swarm.spawn(10);
    h.frame(swarm);
    await flush();
    h.frame(swarm);
    const a = h.buffer('.hotA') as FakeBuffer;
    const b = h.buffer('.hotB') as FakeBuffer;
    new Float32Array(a.bytes.buffer).fill(1);
    new Float32Array(b.bytes.buffer).fill(1);
    swarm.killList(new Uint32Array([2, 7]));
    swarm.kill(4, 2);
    h.frame(swarm);
    for (const buf of [a, b]) {
      const f = new Float32Array(buf.bytes.buffer);
      expect([2, 4, 5, 7].map(i => f[i * 10 + 9])).toEqual([0, 0, 0, 0]);
      expect(f[3 * 10 + 9]).toBe(1);
      expect(f[4 * 10]).toBe(0); // range kills zero the whole record
    }
    const alive = await h.system.readback(
      ReadbackSource.SWARM_ALIVE,
      swarm.swarmId,
      0,
      10,
    )!;
    expect(new Uint32Array(alive)[0]).toBe(6);
    swarm.destroy();
    h.system.destroy();
  });

  test('front disables unsupported swarms with one error', async () => {
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const wgslOnly = defineBehavior({
      name: 'custom',
      params: {},
      defaults: {},
      update: 'p.rot += 1.0;',
    });
    const a = new Swarm({ capacity: 10, behaviors: [wgslOnly] });
    a.spawn(10);
    expect(h.opcodes(a)).toEqual([]);
    expect(h.opcodes(a)).toEqual([]);
    const b = new Swarm({ capacity: 10, allocation: 'gpu' });
    expect(h.opcodes(b)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toMatch(
      /\[cozygpu:UNSUPPORTED\].*"custom" has no GLSL variant/,
    );
    await expect(a.readHot(0, 1)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(b.aliveCount()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    // Supplying a GLSL variant re-enables it.
    a.setBehaviors([{ ...wgslOnly, glsl: { update: 'p.rot += 1.0;' } }]);
    expect(h.opcodes(a)).toContain(Op.SWARM_CREATE);
    error.mockRestore();
    a.destroy();
    b.destroy();
    h.system.destroy();
  });
});
