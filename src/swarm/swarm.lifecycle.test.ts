/**
 * Tester (logic, round 1): Swarm lifecycle edges between the front queue and
 * the core op queue — device restore with commands still queued, and
 * pipelines that never compile.
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, Op } from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import { FAKE_CAPS, FakeBackend } from '../renderer/testing/fakeBackend';
import type { ComputePipelineDesc, RhiComputePipeline } from '../backend/types';
import type { CoreContext, CoreFrameState, FrontFrame } from '../types/core';
import { ids } from '../types/ids';
import * as L from '../types/layouts';
import { createSwarmCoreSystem } from './core';
import { Swarm } from './Swarm';
import type { BehaviorDefinition } from './types';

const IDENTITY = new Float32Array([1, 0, 0, 1, 0, 0]);
const flush = () => new Promise(r => setTimeout(r, 0));

function makeFrame(encoder: CommandEncoder, generation = 0): FrontFrame {
  return {
    rendererId: 31,
    encoder,
    frameId: 1,
    time: 0,
    dt: 1 / 60,
    cssWidth: 800,
    cssHeight: 600,
    resolution: 1,
    sharedMemory: false,
    useSharedArrayBuffer: false,
    generation,
    registerShared: () => 1,
    readback: () => Promise.resolve(new ArrayBuffer(0)),
    caps: FAKE_CAPS,
    isSystemReady: () => true,
  };
}

interface Cmd {
  opcode: number;
  words: Uint32Array;
}

function emit(swarm: Swarm, frame: FrontFrame): Cmd[] {
  frame.encoder.reset();
  swarm._emitDraw(frame, IDENTITY, 0, 1);
  const dec = createCommandDecoder();
  dec.reset(frame.encoder.finish(1));
  const out: Cmd[] = [];
  const r = dec.reader;
  while (dec.next()) {
    const copy = r.u8.slice(r.payloadOffset, r.payloadOffset + r.payloadBytes);
    out.push({ opcode: r.opcode, words: new Uint32Array(copy.buffer) });
  }
  return out;
}

const spawnRanges = (cmds: Cmd[]) =>
  cmds
    .filter(c => c.opcode === Op.SWARM_SPAWN)
    .map(c => [c.words[1 + L.SP_FIRST / 4], c.words[1 + L.SP_COUNT / 4]]);

describe('Swarm front: device restore with queued commands', () => {
  it('restore resets the ring and calls onRestore once per generation', () => {
    let calls = 0;
    const swarm = new Swarm({
      capacity: 100,
      onRestore: s => {
        calls++;
        s.spawn(10);
      },
    });
    const enc = createCommandEncoder();
    swarm.spawn(60);
    emit(swarm, makeFrame(enc, 0));
    const after = emit(swarm, makeFrame(enc, 1));
    expect(calls).toBe(1);
    expect(spawnRanges(after)).toEqual([[0, 10]]);
    expect(swarm.activeCount).toBe(10);
    // same generation again: no second restore
    emit(swarm, makeFrame(enc, 1));
    expect(calls).toBe(1);
    swarm.destroy();
  });

  // Regression: spawns queued between the last frame of the old generation
  // and the restore frame used to be flushed after SWARM_CREATE while
  // cursor/activeCount were reset, so they were never simulated or drawn.
  // The restore now drops the queue (it targets lost GPU state).
  it('every slot a flushed SWARM_SPAWN writes is inside the drawn range', () => {
    const swarm = new Swarm({ capacity: 100 });
    const enc = createCommandEncoder();
    swarm.spawn(60);
    emit(swarm, makeFrame(enc, 0));
    swarm.spawn(40); // queued while the device is being lost
    const after = emit(swarm, makeFrame(enc, 1));
    const draw = after.find(c => c.opcode === Op.SWARM_DRAW);
    const drawCount = draw ? draw.words[8] : 0;
    for (const [first, count] of spawnRanges(after)) {
      expect(first + count).toBeLessThanOrEqual(drawCount);
    }
    swarm.destroy();
  });

  // Regression: same root cause in manual allocation (the reset allocator
  // handed [0, 5) to onRestore while a queued spawn still targeted it).
  it('manual: onRestore spawns never overlap queued spawns', () => {
    const swarm = new Swarm({
      capacity: 20,
      allocation: 'manual',
      onRestore: s => void s.spawn(5),
    });
    const enc = createCommandEncoder();
    swarm.spawn(5);
    emit(swarm, makeFrame(enc, 0));
    swarm.kill(0, 5);
    swarm.spawn(5); // reuses [0, 5), queued
    const ranges = spawnRanges(emit(swarm, makeFrame(enc, 1)));
    const used = new Uint8Array(20);
    for (const [first, count] of ranges) {
      for (let s = first; s < first + count; s++) {
        expect(used[s]).toBe(0);
        used[s] = 1;
      }
    }
    swarm.destroy();
  });

  it('destroy before the first frame frees the id at once and emits nothing', () => {
    const swarm = new Swarm({ capacity: 4 });
    const id = swarm.swarmId;
    swarm.spawn(4);
    swarm.destroy();
    // the freed id is handed out again immediately
    const next = ids.swarm.alloc();
    expect(next).toBe(id);
    ids.swarm.free(next);
    expect(() => swarm.spawn(1)).toThrow();
    const enc = createCommandEncoder();
    const frame = makeFrame(enc);
    enc.reset();
    swarm._emitDraw(frame, IDENTITY, 0, 1);
    expect(enc.commandCount).toBe(0);
  });
});

// ─── core: pipelines that never compile ──────────────────────────────────────

class FailingBackend extends FakeBackend {
  failCompute = true;
  async createComputePipeline(
    desc: ComputePipelineDesc,
  ): Promise<RhiComputePipeline> {
    if (this.failCompute) throw new Error('bad WGSL');
    return super.createComputePipeline(desc);
  }
}

function coreHarness() {
  const backend = new FailingBackend(800, 600);
  const res = { label: 'r', destroy() {} };
  const posted: { type: string; code?: string }[] = [];
  const ctx = {
    backend,
    viewLayout: res,
    viewBindGroup: res,
    textureLayout: res,
    whiteTexture: { bindGroup: res },
    getTexture: () => ({ bindGroup: res }),
    getShared: () => undefined,
    sampleCount: 1,
    post: (m: { type: string; code?: string }) => void posted.push(m),
  } as unknown as CoreContext;
  const system = createSwarmCoreSystem();
  const state = { frameId: 1, time: 0, dt: 1 / 60 } as CoreFrameState;
  let dispatches = 0;
  const computePass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    dispatch: () => void dispatches++,
    dispatchIndirect: () => undefined,
    end: () => undefined,
  };
  const list = {
    beginComputePass: () => computePass,
    beginRenderPass: () => ({}) as never,
    submit: () => undefined,
  };
  const encoder = createCommandEncoder();
  const front = makeFrame(encoder);
  const decoder = createCommandDecoder();
  const run = (swarm: Swarm): number => {
    dispatches = 0;
    encoder.reset();
    swarm._emitDraw(front, IDENTITY, 0, 1);
    decoder.reset(encoder.finish(1));
    while (decoder.next()) {
      const r = decoder.reader;
      if (!(r.flags & CommandFlag.DRAW)) system.execute(r, state);
    }
    system.compute!(list as never, state);
    return dispatches;
  };
  return { backend, ctx, system, run, posted };
}

describe('swarm core: compile failures', () => {
  it('reports SHADER_COMPILE and dispatches nothing', async () => {
    const h = coreHarness();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 1000 });
    h.run(swarm);
    await flush();
    expect(h.posted.some(m => m.code === 'SHADER_COMPILE')).toBe(true);
    swarm.spawn(10);
    expect(h.run(swarm)).toBe(0);
    swarm.destroy();
    h.system.destroy();
  });

  // Regression: with no active program and none compiling (compile failed),
  // queued SPAWN/KILL/WRITE ops were kept forever (≈116 B per spawn per
  // frame) and all replayed when a fixed shader arrived. They are now dropped.
  it('ops queued while no program can ever become ready are bounded', async () => {
    const h = coreHarness();
    await h.system.init(h.ctx);
    const broken: BehaviorDefinition = {
      name: 'broken',
      params: {},
      defaults: {},
      update: 'p.pos.x += 1.0;',
    };
    const swarm = new Swarm({ capacity: 1000, behaviors: [broken] });
    h.run(swarm);
    await flush();
    for (let f = 0; f < 300; f++) {
      swarm.spawn(1);
      h.run(swarm);
    }
    h.backend.failCompute = false;
    swarm.setBehaviors([{ ...broken, update: 'p.pos.x += 2.0;' }]);
    h.run(swarm);
    await flush();
    const dispatched = h.run(swarm);
    expect(dispatched).toBeLessThan(10);
    swarm.destroy();
    h.system.destroy();
  });
});
