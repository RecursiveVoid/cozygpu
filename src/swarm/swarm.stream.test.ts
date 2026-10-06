/**
 * Tester: Swarm front → real command encoder/decoder → swarm core system,
 * checking allocation (ring/manual), payload bytes, dynamic-offset arena
 * contents, dispatch math, write deferral and WGSL binding agreement.
 */
import type {
  BindGroupLayoutDesc,
  BufferDesc,
  CommandList,
  ComputePass,
  RenderPass,
  RhiBindGroup,
  RhiBuffer,
} from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, Op } from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import { FAKE_CAPS, FakeBackend } from '../renderer/testing/fakeBackend';
import type { CoreContext, CoreFrameState, FrontFrame } from '../types/core';
import { NO_ID } from '../types/ids';
import * as L from '../types/layouts';
import { behaviors } from './behaviors';
import { composeSwarmShaders } from './composer';
import {
  SWARM_MAX_WORKGROUPS,
  SWARM_UNIFORM_STRIDE,
  SWARM_WORKGROUP_SIZE,
  SwarmInternalRenderFlag,
} from './constants';
import { createSwarmCoreSystem } from './core';
import { dropSwarmDestroys, flushSwarmDestroys } from './destroyQueue';
import { Swarm } from './Swarm';

const IDENTITY = new Float32Array([1, 0, 0, 1, 0, 0]);
const flush = () => new Promise(r => setTimeout(r, 0));

function makeFrame(
  encoder: CommandEncoder,
  rendererId = 1,
): FrontFrame & {
  generation: number;
  dt: number;
  rendererId: number;
} {
  return {
    rendererId,
    encoder,
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
}

interface Decoded {
  opcode: number;
  flags: number;
  words: Uint32Array;
  f32: Float32Array;
  u8: Uint8Array;
}

/** Emits one swarm frame and returns the decoded commands (payload copies). */
function emit(
  swarm: Swarm,
  frame: FrontFrame,
  world = IDENTITY,
  alpha = 1,
): Decoded[] {
  const enc = frame.encoder;
  enc.reset();
  swarm._emitDraw(frame, world, 0, alpha);
  const dec = createCommandDecoder();
  dec.reset(enc.finish(1));
  const out: Decoded[] = [];
  const r = dec.reader;
  while (dec.next()) {
    const bytes = r.u8.slice(r.payloadOffset, r.payloadOffset + r.payloadBytes);
    out.push({
      opcode: r.opcode,
      flags: r.flags,
      u8: bytes,
      words: new Uint32Array(bytes.buffer),
      f32: new Float32Array(bytes.buffer),
    });
  }
  return out;
}

const of = (cmds: Decoded[], op: number) => cmds.filter(c => c.opcode === op);

describe('Swarm front: allocation and payloads', () => {
  it('ring: wraps into two SWARM_SPAWN commands and tracks activeCount', () => {
    const swarm = new Swarm({ capacity: 100 });
    const frame = makeFrame(createCommandEncoder());
    expect(swarm.spawn(70)).toBe(0);
    expect(swarm.activeCount).toBe(70);
    expect(swarm.spawn(50)).toBe(70);
    expect(swarm.activeCount).toBe(100);
    expect(swarm.spawn(1000)).toBe(20); // clamps to capacity, wraps fully
    const spawns = of(emit(swarm, frame), Op.SWARM_SPAWN);
    const ranges = spawns.map(c => [
      c.words[1 + L.SP_FIRST / 4],
      c.words[1 + L.SP_COUNT / 4],
    ]);
    expect(ranges).toEqual([
      [0, 70],
      [70, 30],
      [0, 20],
      [20, 80],
      [0, 20],
    ]);
    for (const c of spawns) {
      expect(c.flags).toBe(CommandFlag.COMPUTE);
      expect(c.words[0]).toBe(swarm.swarmId);
      expect(c.u8.byteLength).toBe(4 + L.SWARM_SPAWN_BYTES);
    }
    // halves of one wrapped spawn share a seed
    expect(spawns[1].words[1 + L.SP_SEED / 4]).toBe(
      spawns[2].words[1 + L.SP_SEED / 4],
    );
    expect(spawns[0].words[1 + L.SP_SEED / 4]).not.toBe(
      spawns[1].words[1 + L.SP_SEED / 4],
    );
    swarm.destroy();
  });

  it('manual: first-fit, -1 when fragmented, kill frees, activeCount = high water', () => {
    const swarm = new Swarm({ capacity: 10, allocation: 'manual' });
    expect(swarm.spawn(4)).toBe(0);
    expect(swarm.spawn(4)).toBe(4);
    expect(swarm.activeCount).toBe(8);
    swarm.kill(0, 4);
    expect(swarm.spawn(3)).toBe(0); // reuses the hole at 0
    expect(swarm.spawn(3)).toBe(-1); // holes: [3,4) and [8,10)
    swarm.kill(4, 4);
    expect(swarm.activeCount).toBe(3);
    swarm.killList(new Uint32Array([0, 1, 2]));
    expect(swarm.activeCount).toBe(0);
    expect(swarm.spawn(10)).toBe(0);
    swarm.destroy();
  });

  // Regression: kill(first < 0, count) clamped `first` but kept `count`, so
  // kill(-5, 10) killed [0, 10) instead of [0, 5).
  it('kill() with a negative first shortens the range', () => {
    const swarm = new Swarm({ capacity: 100 });
    swarm.spawn(100);
    swarm.kill(-5, 10);
    const kills = of(
      emit(swarm, makeFrame(createCommandEncoder())),
      Op.SWARM_KILL_RANGE,
    );
    expect([kills[0].words[1], kills[0].words[2]]).toEqual([0, 5]);
    swarm.destroy();
  });

  it('clear() drops queued work and kills [0, activeCount)', () => {
    const swarm = new Swarm({ capacity: 50 });
    swarm.spawn(30);
    swarm.clear();
    const cmds = emit(swarm, makeFrame(createCommandEncoder()));
    expect(of(cmds, Op.SWARM_SPAWN)).toHaveLength(0);
    const kill = of(cmds, Op.SWARM_KILL_RANGE);
    expect(Array.from(kill[0].words)).toEqual([swarm.swarmId, 0, 30]);
    expect(swarm.activeCount).toBe(0);
    expect(of(cmds, Op.SWARM_DRAW)).toHaveLength(0);
    swarm.destroy();
  });

  it('write(): record bytes land verbatim, count clamps to capacity', () => {
    const swarm = new Swarm({ capacity: 4 });
    const hot = new Float32Array(3 * 10).map((_, i) => i + 0.5);
    const cold = new Uint32Array(2 * 4).map((_, i) => 0xf0000000 + i);
    swarm.write(2, hot, cold);
    expect(swarm.activeCount).toBe(4);
    const cmds = emit(swarm, makeFrame(createCommandEncoder()));
    const h = of(cmds, Op.SWARM_WRITE_HOT)[0];
    expect(Array.from(h.words.subarray(0, 3))).toEqual([swarm.swarmId, 2, 2]);
    expect(Array.from(h.f32.subarray(3, 3 + 20))).toEqual(
      Array.from(hot.subarray(0, 20)),
    );
    expect(h.u8.byteLength).toBe(12 + 2 * L.SWARM_HOT_BYTES);
    const c = of(cmds, Op.SWARM_WRITE_COLD)[0];
    expect(Array.from(c.words.subarray(3))).toEqual(Array.from(cold));
    swarm.destroy();
  });

  it('SWARM_CREATE carries the composed WGSL, params size and flags', () => {
    const defs = [behaviors.velocity(), behaviors.drag({ k: 2 })];
    const swarm = new Swarm({
      capacity: 64,
      shape: 'circle',
      blendMode: 'add',
      behaviors: defs,
      render: { fadeOut: true, cull: true },
    });
    const flags =
      L.SwarmRenderFlag.CIRCLE |
      L.SwarmRenderFlag.FADE_OUT |
      SwarmInternalRenderFlag.CULL;
    const composed = composeSwarmShaders(defs, flags);
    const create = of(
      emit(swarm, makeFrame(createCommandEncoder())),
      Op.SWARM_CREATE,
    )[0];
    const w = create.words;
    expect(Array.from(w.subarray(0, 8))).toEqual([
      swarm.swarmId,
      64,
      NO_ID,
      1, // add
      flags,
      composed.paramsBytes,
      new TextEncoder().encode(composed.compute).byteLength,
      new TextEncoder().encode(composed.render).byteLength,
    ]);
    const td = new TextDecoder();
    const cAt = 32;
    const cLen = w[6];
    const rAt = cAt + ((cLen + 3) & ~3);
    expect(td.decode(create.u8.subarray(cAt, cAt + cLen))).toBe(
      composed.compute,
    );
    expect(td.decode(create.u8.subarray(rAt, rAt + w[7]))).toBe(
      composed.render,
    );
    expect(create.u8.byteLength).toBe(rAt + ((w[7] + 3) & ~3));
    swarm.destroy();
  });

  it('SET_PARAMS mirrors the params bytes once; STEP/DRAW carry dt, world, alpha', () => {
    const swarm = new Swarm({
      capacity: 10,
      behaviors: [behaviors.acceleration({ name: 'g', x: 3, y: -4 })],
      timeScale: 2,
    });
    swarm.spawn(6);
    const frame = makeFrame(createCommandEncoder());
    const world = new Float32Array([2, 0.5, -0.5, 3, 10, 20]);
    let cmds = emit(swarm, frame, world, 0.25);
    const p = of(cmds, Op.SWARM_SET_PARAMS)[0];
    expect(Array.from(p.words.subarray(0, 3))).toEqual([swarm.swarmId, 0, 16]);
    expect(Array.from(p.f32.subarray(3, 5))).toEqual([3, -4]);
    const step = of(cmds, Op.SWARM_STEP)[0];
    expect(step.words[0]).toBe(swarm.swarmId);
    expect(step.f32[1]).toBeCloseTo(2 / 60, 6);
    expect([step.words[2], step.words[3]]).toEqual([1, 6]);
    const draw = of(cmds, Op.SWARM_DRAW)[0];
    expect(draw.flags).toBe(CommandFlag.DRAW);
    expect(Array.from(draw.f32.subarray(1, 7))).toEqual(Array.from(world));
    expect(draw.f32[7]).toBe(0.25);
    expect(draw.words[8]).toBe(6);
    // steady state: no params, no create
    swarm.step(0.5);
    cmds = emit(swarm, frame);
    expect(cmds.map(c => c.opcode)).toEqual([Op.SWARM_STEP, Op.SWARM_DRAW]);
    expect(cmds[0].f32[1]).toBeCloseTo(0.5 + 2 / 60, 6);
    swarm.behavior('g').set('value', [1, 1]);
    cmds = emit(swarm, frame);
    expect(cmds.map(c => c.opcode)).toEqual([
      Op.SWARM_SET_PARAMS,
      Op.SWARM_STEP,
      Op.SWARM_DRAW,
    ]);
    swarm.destroy();
  });

  // Regression (M1 low bug): a created swarm that moved to another renderer
  // never queued SWARM_DESTROY for the old one, leaking its GPU buffers.
  it('moving a swarm to another renderer frees it on the old one', () => {
    const swarm = new Swarm({ capacity: 10 });
    const a = makeFrame(createCommandEncoder(), 101);
    const b = makeFrame(createCommandEncoder(), 102);
    emit(swarm, a);
    emit(swarm, b);
    a.encoder.reset();
    flushSwarmDestroys(a);
    const dec = createCommandDecoder();
    dec.reset(a.encoder.finish(2));
    const ops: number[] = [];
    const targets: number[] = [];
    while (dec.next()) {
      ops.push(dec.reader.opcode);
      targets.push(dec.reader.u32());
    }
    expect(ops).toEqual([Op.SWARM_DESTROY]);
    expect(targets).toEqual([swarm.swarmId]);
    // The id stays owned by the live swarm: a new swarm must not reuse it.
    const other = new Swarm({ capacity: 1 });
    expect(other.swarmId).not.toBe(swarm.swarmId);
    other.destroy();
    // Steady state on the new renderer: no re-create, no destroy.
    const ops2 = emit(swarm, b).map(c => c.opcode);
    expect(ops2).not.toContain(Op.SWARM_CREATE);
    expect(ops2).not.toContain(Op.SWARM_DESTROY);
    const id = swarm.swarmId;
    swarm.destroy();
    // Destroyed on b: freed there, and the id is reusable afterwards.
    b.encoder.reset();
    flushSwarmDestroys(b);
    dec.reset(b.encoder.finish(3));
    expect(dec.next()).toBe(true);
    expect(dec.reader.opcode).toBe(Op.SWARM_DESTROY);
    const reused = new Swarm({ capacity: 1 });
    expect(reused.swarmId).toBe(id);
    reused.destroy();
  });

  it('moving back and forth releases on the renderer left each time, and a dropped renderer never frees a live id', () => {
    const swarm = new Swarm({ capacity: 4 });
    const a = makeFrame(createCommandEncoder(), 201);
    const b = makeFrame(createCommandEncoder(), 202);
    emit(swarm, a);
    emit(swarm, b); // release queued on a
    const back = emit(swarm, a).map(c => c.opcode); // flushes a first
    expect(back.indexOf(Op.SWARM_DESTROY)).toBeGreaterThanOrEqual(0);
    expect(back.indexOf(Op.SWARM_DESTROY)).toBeLessThan(
      back.indexOf(Op.SWARM_CREATE),
    );
    // release queued on b; b is then destroyed without flushing
    dropSwarmDestroys(202);
    const other = new Swarm({ capacity: 1 });
    expect(other.swarmId).not.toBe(swarm.swarmId);
    other.destroy();
    swarm.destroy();
  });
});

// ─── Core system harness ───────────────────────────────────────────────────────

interface Dispatch {
  pipeline: unknown;
  x: number;
  y: number;
  z: number;
  offset: number;
}

class BigBufferBackend extends FakeBackend {
  readonly layouts: BindGroupLayoutDesc[] = [];
  createBindGroupLayout(desc: BindGroupLayoutDesc) {
    this.layouts.push(desc);
    return super.createBindGroupLayout(desc);
  }
  createBuffer(desc: BufferDesc): RhiBuffer {
    if (desc.size > 1 << 24) {
      // no backing store for huge hot/cold buffers
      return {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        destroy() {},
      } as unknown as RhiBuffer;
    }
    return super.createBuffer(desc);
  }
  writeBuffer(
    buffer: RhiBuffer,
    off: number,
    data: ArrayBufferView,
    dOff?: number,
    len?: number,
  ): void {
    if (!('bytes' in buffer)) return;
    super.writeBuffer(buffer, off, data, dOff, len);
  }
}

function harness(caps?: Partial<FakeBackend['caps']>) {
  const backend = new BigBufferBackend(800, 600);
  if (caps) backend.caps = { ...backend.caps, ...caps };
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
    post: () => undefined,
  } as unknown as CoreContext;
  const system = createSwarmCoreSystem();
  const state = { frameId: 1, time: 5, dt: 1 / 60 } as CoreFrameState;
  const dispatches: Dispatch[] = [];
  const draws: number[][] = [];
  let pipeline: unknown = null;
  let offset = -1;
  const computePass: ComputePass = {
    setPipeline: p => void (pipeline = p),
    setBindGroup: (i: number, _g: RhiBindGroup, dyn?: Uint32Array) => {
      if (i === 2) offset = dyn ? dyn[0] : -1;
    },
    dispatch: (x, y = 1, z = 1) =>
      void dispatches.push({ pipeline, x, y, z, offset }),
    dispatchIndirect: () => undefined,
    end: () => undefined,
  };
  const renderPass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    draw: (v: number, n = 1) => void draws.push([v, n]),
    drawIndirect: () => void draws.push([-1]),
  } as unknown as RenderPass;
  const list: CommandList = {
    beginComputePass: () => computePass,
    beginRenderPass: () => renderPass,
    beginFeedbackPass: () => {
      throw new Error('no transform feedback in this test');
    },
    submit: () => undefined,
  };
  const encoder = createCommandEncoder();
  const front = makeFrame(encoder);
  const decoder = createCommandDecoder();
  const run = (swarm: Swarm, slot?: SharedArrayBuffer): void => {
    dispatches.length = 0;
    draws.length = 0;
    // `slot` encodes the packet into a command-ring SharedArrayBuffer (§17).
    encoder.reset(slot);
    swarm._emitDraw(front, IDENTITY, 0, 1);
    decoder.reset(encoder.finish(1));
    const drawOffsets: number[] = [];
    while (decoder.next()) {
      const r = decoder.reader;
      if (r.flags & CommandFlag.DRAW) drawOffsets.push(r.commandOffset);
      else system.execute(r, state);
    }
    system.compute!(list, state);
    for (const o of drawOffsets) {
      decoder.seek(o);
      system.draw(decoder.reader, renderPass, state);
    }
  };
  const buffer = (label: string) =>
    backend.buffers.filter(b => b.label === label).pop()!;
  return { backend, ctx, system, run, dispatches, draws, buffer, front };
}

describe('swarm core: command-ring packets', () => {
  /**
   * Blink's TextDecoder refuses a view over a SharedArrayBuffer; Node's does
   * not, so the browser rule is emulated here. Without it this test cannot see
   * the bug it guards.
   */
  function withStrictTextDecoder<T>(body: () => T): T {
    const real = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (
      this: TextDecoder,
      input?: ArrayBufferView | ArrayBuffer,
      options?: { stream?: boolean },
    ): string {
      const buffer = ArrayBuffer.isView(input) ? input.buffer : input;
      if (buffer instanceof SharedArrayBuffer) {
        throw new TypeError(
          "Failed to execute 'decode' on 'TextDecoder': " +
            'The provided ArrayBufferView value must not be shared.',
        );
      }
      return real.call(this, input as ArrayBufferView, options);
    } as typeof real;
    try {
      return body();
    } finally {
      TextDecoder.prototype.decode = real;
    }
  }

  it('reads SWARM_CREATE shader sources out of a SharedArrayBuffer slot', async () => {
    // Regression: both swarm cores decoded the WGSL/GLSL with their own
    // TextDecoder over `reader.u8`, which throws for a shared view, so every
    // worker + command-ring page lost SWARM_CREATE (opcode 0x300).
    // `reader.utf8()` copies out of the slot first.
    const h = harness();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 1000 });
    const slot = new SharedArrayBuffer(1 << 16);
    withStrictTextDecoder(() => h.run(swarm, slot));
    await flush();
    const id = swarm.swarmId;
    expect(h.backend.buffers.some(b => b.label === `swarm${id}.arena`)).toBe(
      true,
    );
  });
});

describe('swarm core: arena, dispatch and ordering', () => {
  it('each spawn/kill/substep gets its own stride and correct uniform words', async () => {
    const h = harness();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 1000, substeps: 3 });
    h.run(swarm); // create
    await flush(); // pipelines ready
    swarm.spawn(300, { x: [1, 2], user: 99 });
    swarm.killList(new Uint32Array([5, 6, 7]));
    swarm.kill(10, 20);
    h.front.dt = 0.03;
    h.run(swarm);
    const id = swarm.swarmId;
    const arena = h.buffer(`swarm${id}.arena`).bytes;
    const u32 = new Uint32Array(
      arena.buffer,
      arena.byteOffset,
      arena.byteLength >> 2,
    );
    const f32 = new Float32Array(
      arena.buffer,
      arena.byteOffset,
      arena.byteLength >> 2,
    );
    const S = SWARM_UNIFORM_STRIDE;
    expect(h.dispatches.map(d => d.offset)).toEqual([
      0,
      S,
      2 * S,
      3 * S,
      4 * S,
      5 * S,
    ]);
    // entry 0: SpawnParams
    expect([u32[0], u32[1]]).toEqual([0, 300]);
    expect(f32[L.SP_POS_MIN / 4]).toBe(1);
    expect(u32[L.SP_USER / 4]).toBe(99);
    expect(h.dispatches[0].x).toBe(Math.ceil(300 / SWARM_WORKGROUP_SIZE));
    // entry 1: kill list → first 0, count 3, mode 1 (seed), list offset 0 (frame)
    const e1 = S / 4;
    expect(Array.from(u32.subarray(e1, e1 + 4))).toEqual([0, 3, 1, 0]);
    const kill = h.buffer(`swarm${id}.kill`).bytes;
    expect(
      Array.from(new Uint32Array(kill.buffer, kill.byteOffset, 3)),
    ).toEqual([5, 6, 7]);
    // entry 2: kill range → mode 0
    const e2 = (2 * S) / 4;
    expect(Array.from(u32.subarray(e2, e2 + 3))).toEqual([10, 20, 0]);
    // entries 3..5: substeps with dt/3, time, count, substep index
    for (let s = 0; s < 3; s++) {
      const e = ((3 + s) * S) / 4;
      expect(f32[e]).toBeCloseTo(0.03 / 3, 6);
      expect(f32[e + 1]).toBe(5);
      expect([u32[e + 2], u32[e + 3]]).toEqual([300, s]);
    }
    expect(h.draws).toEqual([[4, 300]]);
    swarm.destroy();
    h.system.destroy();
  });

  it('dispatch splits into x=65535, y=ceil(...) beyond 16.7M invocations', async () => {
    const big = SWARM_WORKGROUP_SIZE * SWARM_MAX_WORKGROUPS + 1;
    const h = harness({
      maxStorageBufferBindingSize: 2 ** 31,
      maxBufferSize: 2 ** 31,
    });
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: big });
    h.run(swarm);
    await flush();
    swarm.spawn(big);
    h.run(swarm);
    const d = h.dispatches[0];
    expect([d.x, d.y, d.z]).toEqual([SWARM_MAX_WORKGROUPS, 2, 1]);
    // swarm_index = gid.x + gid.y * 65535 * 256 covers [0, big) exactly once
    const maxIndex =
      (d.x - 1) * 1 +
      (d.y - 1) * SWARM_MAX_WORKGROUPS * SWARM_WORKGROUP_SIZE +
      (SWARM_WORKGROUP_SIZE - 1);
    expect(maxIndex).toBeGreaterThanOrEqual(big - 1);
    swarm.destroy();
    h.system.destroy();
  });

  it('a write after a dispatch is deferred to the next frame, in order', async () => {
    const h = harness();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 8, autoStep: false });
    h.run(swarm);
    await flush();
    const id = swarm.swarmId;
    swarm.spawn(8);
    const hot = new Float32Array(10).fill(7);
    swarm.write(0, hot);
    h.run(swarm);
    const hotBuf = h.buffer(`swarm${id}.hot`).bytes;
    expect(hotBuf[0]).toBe(0); // not yet: all writeBuffers land before the spawn dispatch
    expect(h.dispatches).toHaveLength(1);
    h.run(swarm);
    expect(new Float32Array(hotBuf.buffer, hotBuf.byteOffset, 10)[0]).toBe(7);
    swarm.destroy();
    h.system.destroy();
  });

  it('commands for unknown ids and out-of-range slots are ignored', async () => {
    const h = harness();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 8 });
    h.run(swarm);
    await flush();
    const enc = createCommandEncoder();
    enc.reset();
    enc.begin(Op.SWARM_KILL_RANGE, 12, CommandFlag.COMPUTE);
    enc.u32(swarm.swarmId);
    enc.u32(8); // == capacity
    enc.u32(1);
    enc.begin(Op.SWARM_STEP, 16, CommandFlag.COMPUTE);
    enc.u32(0x7fff); // unknown swarm
    enc.f32(1);
    enc.u32(1);
    enc.u32(1);
    const dec = createCommandDecoder();
    dec.reset(enc.finish(1));
    expect(() => {
      while (dec.next()) h.system.execute(dec.reader, {} as CoreFrameState);
    }).not.toThrow();
    h.dispatches.length = 0;
    h.system.compute!(
      {
        beginComputePass: () => {
          throw new Error('no work expected');
        },
      } as unknown as CommandList,
      {} as CoreFrameState,
    );
    expect(h.dispatches).toHaveLength(0);
    swarm.destroy();
    h.system.destroy();
  });
});

describe('swarm core bind group layouts agree with the composed WGSL', () => {
  function declarations(
    src: string,
  ): Map<number, { space: string; access: string; type: string }> {
    const out = new Map<
      number,
      { space: string; access: string; type: string }
    >();
    const re =
      /@group\(2\)\s*@binding\((\d+)\)\s*var<(\w+)(?:,\s*(\w+))?>\s*\w+\s*:\s*([\w<>]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      out.set(Number(m[1]), {
        space: m[2],
        access: m[3] ?? 'read',
        type: m[4],
      });
    }
    return out;
  }
  const STRUCT_BYTES: Record<string, number> = {
    SwarmSim: L.SWARM_SIM_BYTES,
    SpawnParams: L.SWARM_SPAWN_BYTES,
    SwarmDraw: L.SWARM_DRAW_BYTES,
    SwarmPick: 16,
    SwarmCurves: L.SWARM_CURVE_BYTES,
  };

  it('every layout entry matches its WGSL declaration', async () => {
    const h = harness();
    await h.system.init(h.ctx);
    const composed = composeSwarmShaders(
      [],
      SwarmInternalRenderFlag.CULL | SwarmInternalRenderFlag.GPU_ALLOC,
    );
    const compute = declarations(composed.compute);
    const render = declarations(composed.render);
    const byLabel = new Map(h.backend.layouts.map(l => [l.label, l]));
    const check = (label: string, decl: typeof compute) => {
      const layout = byLabel.get(label);
      expect(layout).toBeDefined();
      for (const e of layout!.entries) {
        const d = decl.get(e.binding);
        expect({ label, binding: e.binding, found: !!d }).toEqual({
          label,
          binding: e.binding,
          found: true,
        });
        const t = e.type as {
          kind: string;
          readOnly?: boolean;
          minBindingSize?: number;
        };
        if (t.kind === 'storage') {
          expect(d!.space).toBe('storage');
          expect({ label, binding: e.binding, readOnly: t.readOnly }).toEqual({
            label,
            binding: e.binding,
            readOnly: d!.access === 'read',
          });
        } else {
          expect(t.kind).toBe('uniform');
          expect(d!.space).toBe('uniform');
          if (t.minBindingSize)
            expect(t.minBindingSize).toBe(STRUCT_BYTES[d!.type]);
        }
      }
    };
    check('swarm.step', compute);
    check('swarm.op', compute);
    check('swarm.cull', compute);
    check('swarm.count', compute);
    for (let variant = 0; variant < 4; variant++) {
      check(`swarm.render${variant}`, render);
    }
    expect(h.backend.layouts.length).toBeGreaterThanOrEqual(6);
    // binding numbers are unique across the compute module
    const src = composed.compute;
    const all = src.match(/@group\(2\)\s*@binding\((\d+)\)/g) ?? [];
    expect(new Set(all).size).toBe(all.length);
    h.system.destroy();
  });
});
