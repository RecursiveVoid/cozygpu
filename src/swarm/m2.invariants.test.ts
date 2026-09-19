/**
 * Tester (logic, M2). Two invariants the M2 swarm cores rest on and that
 * m2.core.test.ts does not pin:
 *  - WebGL2 transform feedback (ARCHITECTURE §14.2): the ping-pong `src`
 *    index after N substeps, and that the draw / readback always use the
 *    buffer the last feedback run wrote.
 *  - allocation 'gpu' (§14.3): the free-list init dispatch must cover the
 *    whole capacity, not the active count, or the slots above it stay 0 and
 *    cs_spawn hands out slot 0 several times.
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

const STRIDE = 256;
/** SwarmSim.count of arena entry `e`. */
const simCount = (arena: { bytes: Uint8Array }, e: number): number =>
  new Uint32Array(arena.bytes.buffer, e * STRIDE, 4)[2];

describe('WebGL2 transform-feedback ping-pong', () => {
  beforeAll(() => installGlslComposer());

  test.each([
    [1, 'B'],
    [2, 'A'],
    [3, 'B'],
    [4, 'A'],
  ])(
    '%i substep(s) leave src on hot%s and the draw reads it',
    async (substeps, end) => {
      const h = setup(GL_CAPS);
      await h.system.init(h.ctx);
      const swarm = new Swarm({
        capacity: 32,
        substeps,
        behaviors: [behaviors.velocity()],
      });
      swarm.spawn(32);
      h.frame(swarm);
      await flush();
      const id = swarm.swarmId;
      const log = h.frame(swarm);
      const runs = log.filter(
        l => l.startsWith('fb.run swarm') && l.includes('hot'),
      );
      // one spawn run + one run per substep
      expect(runs.length).toBe(1 + substeps);
      expect(runs[runs.length - 1]).toBe(
        `fb.run swarm${id}.hot${end} @0 [0+32]`,
      );
      // The draw must bind the buffer the last feedback run wrote.
      expect(log).toContain(`vertex0 swarm${id}.hot${end}`);
      swarm.destroy();
      h.system.destroy();
    },
  );

  test('a readback of hot records reads the buffer the last step wrote', async () => {
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 8, behaviors: [behaviors.velocity()] });
    swarm.spawn(8);
    h.frame(swarm);
    await flush();
    const reads: string[] = [];
    h.backend.readBuffer = async (b, offset, length) => {
      reads.push(`${b.label} ${offset} ${length}`);
      return new ArrayBuffer(length);
    };
    const id = swarm.swarmId;
    h.frame(swarm); // steps hotA -> hotB, src = hotB
    await h.system.readback(ReadbackSource.SWARM_HOT, id, 0, 8);
    h.frame(swarm); // steps hotB -> hotA, src = hotA
    await h.system.readback(ReadbackSource.SWARM_HOT, id, 0, 8);
    expect(reads.map(r => r.split(' ')[0])).toEqual([
      `swarm${id}.hotB`,
      `swarm${id}.hotA`,
    ]);
    swarm.destroy();
    h.system.destroy();
  });

  test('every hot slot is stepped: the feedback run covers [0, activeCount)', async () => {
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 64,
      allocation: 'manual',
      behaviors: [behaviors.velocity()],
    });
    expect(swarm.spawn(10)).toBe(0);
    expect(swarm.spawn(10)).toBe(10);
    h.frame(swarm);
    await flush();
    const id = swarm.swarmId;
    let log = h.frame(swarm);
    expect(log).toContain(`fb.run swarm${id}.hotB @0 [0+20]`);
    // Freeing the tail lowers activeCount, but the kill zeroes BOTH buffers,
    // so the slots the shorter step no longer copies cannot resurrect.
    swarm.kill(10, 10);
    log = h.frame(swarm);
    expect(
      log.some(l => /fb\.run swarm\d+\.hot[AB] @0 \[0\+10\]/.test(l)),
    ).toBe(true);
    swarm.destroy();
    h.system.destroy();
  });
});

describe("allocation 'gpu' free-list index math", () => {
  test('cs_free_init runs over the whole capacity, not the active count', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 1000,
      allocation: 'gpu',
      behaviors: [behaviors.velocity()],
    });
    swarm.spawn(4);
    h.frame(swarm);
    await flush();
    const log = h.frame(swarm);
    const id = swarm.swarmId;
    expect(log[0]).toBe(`cs swarm${id}.cs_free_init`);
    expect(log[1]).toBe('dispatch 4'); // ceil(1000 / 256)
    const arena = h.buffer('.arena') as FakeBuffer;
    // Entry 0 is cs_free_init: it must initialise swarmFree[0 .. capacity),
    // otherwise the entries above sim.count stay 0 and are handed out twice.
    expect(simCount(arena, 0)).toBe(1000);
    // Entry 1 is the spawn's SpawnParams, entry 2 the step's SwarmSim.
    expect(simCount(arena, 2)).toBe(1000);
    swarm.destroy();
    h.system.destroy();
  });

  test('freeTop starts at capacity for gpu allocation and at 0 otherwise', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const gpu = new Swarm({ capacity: 256, allocation: 'gpu' });
    h.frame(gpu);
    const gpuCounters = new Uint32Array(
      (h.buffer('.counters') as FakeBuffer).bytes.buffer,
    );
    expect(gpuCounters[0]).toBe(256); // freeTop
    expect(gpuCounters[1]).toBe(0); // alive
    expect(h.buffer('.free').size).toBe(256 * 4);
    gpu.destroy();

    const ring = new Swarm({ capacity: 256 });
    h.frame(ring);
    const ringCounters = new Uint32Array(
      (h.buffer('.counters') as FakeBuffer).bytes.buffer,
    );
    expect(ringCounters[0]).toBe(0);
    // 'ring' still binds a 4-byte dummy free list (the shader binding exists).
    expect(h.buffer('.free').size).toBe(4);
    ring.destroy();
    h.system.destroy();
  });

  test('every spawn dispatches cs_spawn_pop once before cs_spawn', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 512, allocation: 'gpu' });
    h.frame(swarm);
    await flush();
    swarm.spawn(3);
    swarm.spawn(700); // clamped to the capacity
    const id = swarm.swarmId;
    const log = h
      .frame(swarm)
      .filter(
        l =>
          l.startsWith('cs ') || l === 'dispatch 1' || /^dispatch \d+$/.test(l),
      );
    const pops = log.filter(l => l === `cs swarm${id}.cs_spawn_pop`).length;
    const spawns = log.filter(l => l === `cs swarm${id}.cs_spawn`).length;
    expect(pops).toBe(2);
    expect(spawns).toBe(2);
    // cs_spawn_pop is a single-invocation pass.
    const popAt = log.indexOf(`cs swarm${id}.cs_spawn_pop`);
    expect(log[popAt + 1]).toBe('dispatch 1');
    swarm.destroy();
    h.system.destroy();
  });
});
