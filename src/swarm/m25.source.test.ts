/**
 * Owner: "swarm-hooks". M2.5 Swarm hooks against the fake RHI
 * (ARCHITECTURE §19.3, §19.4): instance user ids in the pick output, and
 * external instance sources (front validation, stream, WebGPU core binding,
 * WebGL2 refusal).
 */
import { BufferUsage } from '../backend/types';
import type {
  BindGroupDesc,
  Capabilities,
  CommandList,
  RenderPass,
  RhiBindGroup,
  RhiBuffer,
} from '../backend/types';
import { CommandFlag, Op, SwarmSourceFlag } from '../commands/opcodes';
import {
  FAKE_CAPS,
  FakeBackend,
  FakeBuffer,
} from '../renderer/testing/fakeBackend';
import type { CoreContext, CoreFrameState, FrontFrame } from '../types/core';
import type { ExternalInstanceBuffer, ExternalLayout } from '../types/interop';
import type { CoreMessage } from '../types/transport';
import { SWARM_COLD_BYTES, SWARM_HOT_BYTES } from '../types/layouts';
import renderWGSL from '../shaders/swarm/render.wgsl';
import renderVertGLSL from '../shaders/swarm/render.vert.glsl';
import { FakeEncoder, FakeReader } from './__fakes__/commands';
import { behaviors } from './behaviors';
import { composeSwarmShaders } from './composer';
import { createSwarmCoreSystem } from './core';
import { installGlslComposer } from './glsl';
import { glslStage } from './opQueue';
import { Swarm } from './Swarm';
import { SWARM_GL_MAX_CAPACITY } from './types';

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

let nextExternalId = 1000;

/** A registered external buffer as the interop layer would hand it out. */
function external(
  layout: ExternalLayout,
  capacity: number,
): ExternalInstanceBuffer & { valid: boolean } {
  return {
    id: nextExternalId++,
    layout,
    capacity,
    valid: true,
    release() {
      this.valid = false;
    },
  };
}

function setup(caps: Capabilities = FAKE_CAPS) {
  const backend = new FakeBackend(800, 600);
  backend.caps = { ...caps };
  const groups: { label: string; buffers: (string | undefined)[] }[] = [];
  const createBindGroup = backend.createBindGroup.bind(backend);
  backend.createBindGroup = (desc: BindGroupDesc): RhiBindGroup => {
    groups.push({
      label: desc.label ?? '',
      buffers: desc.entries.map(
        e => (e.resource as { buffer?: RhiBuffer }).buffer?.label,
      ),
    });
    return createBindGroup(desc);
  };
  const externals = new Map<number, RhiBuffer>();
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
    getExternalBuffer: (id: number) => externals.get(id),
    sampleCount: 1,
    post: (m: CoreMessage) => posted.push(m),
  } as unknown as CoreContext;
  const system = createSwarmCoreSystem();
  const frameState = { frameId: 1, time: 0, dt: 1 / 60 } as CoreFrameState;
  const front: FrontFrame & { encoder: FakeEncoder } = {
    rendererId: 9,
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
  const computePass = {
    setPipeline: (p: { label?: string }) => log.push(`cs ${p.label}`),
    setBindGroup: () => {},
    dispatch: (x: number) => log.push(`dispatch ${x}`),
    dispatchIndirect: () => {},
    end: () => {},
  };
  const feedbackPass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    run: () => log.push('fb.run'),
    end: () => {},
  };
  const list = {
    beginRenderPass: () => renderPass,
    beginComputePass: () => computePass,
    beginFeedbackPass: () => feedbackPass,
    submit: () => {},
  } as unknown as CommandList;

  /** Stream opcodes of the last frame. */
  let lastOps: number[] = [];
  const frame = (swarm: Swarm, pick = false): string[] => {
    log.length = 0;
    front.encoder.reset();
    swarm._emitDraw(front, IDENTITY, 0, 1);
    const reader = new FakeReader(front.encoder.finish(1));
    const commands = reader.list();
    lastOps = commands.map(c => c.opcode).filter(op => op !== Op.SWARM_DESTROY);
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
  /** Registers a fake native buffer under `ext.id` (the core table). */
  const register = (
    ext: ExternalInstanceBuffer,
    usage = BufferUsage.STORAGE | BufferUsage.COPY_SRC,
  ): FakeBuffer => {
    const record =
      ext.layout === 'swarm-hot' ? SWARM_HOT_BYTES : SWARM_COLD_BYTES;
    const buffer = new FakeBuffer({
      label: `ext${ext.id}`,
      size: ext.capacity * record,
      usage,
    });
    externals.set(ext.id, buffer);
    return buffer;
  };
  const lastGroup = (suffix: string) =>
    groups.filter(g => g.label.endsWith(suffix)).pop()!;
  const draws = (log: string[]) => log.filter(l => /^draw/.test(l));
  return {
    backend,
    ctx,
    system,
    frame,
    front,
    posted,
    externals,
    register,
    lastGroup,
    draws,
    ops: () => lastOps,
    groups,
  };
}

// ─── user ids in the pick output (§19.3) ──────────────────────────────────────

describe('instance user id in the pick texel', () => {
  test('WGSL: the vertex stage passes cold.user flat, fs_pick writes it', () => {
    expect(renderWGSL).toMatch(/@location\(3\) @interpolate\(flat\) user: u32/);
    expect(renderWGSL).toMatch(/out\.user = c\.user;/);
    const fsPick = /fn fs_pick\([^]*$/.exec(renderWGSL)![0];
    expect(fsPick).toMatch(
      /return vec4u\(swarmPick\.id, in\.slot \+ 1u, in\.user, 0u\);/,
    );
    // Composed programs keep it (every render flag variant).
    for (const flags of [0, 8]) {
      const { render } = composeSwarmShaders([behaviors.velocity()], flags);
      expect(render).toMatch(/in\.user, 0u\)/);
    }
  });

  test('GLSL: v_user = a_user (before the dead-object early return)', () => {
    installGlslComposer();
    const vs = renderVertGLSL;
    expect(vs).toMatch(/flat out uint v_user;/);
    const set = vs.indexOf('v_user = a_user;');
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(vs.indexOf('if (life <= 0.0)'));
    const { render } = composeSwarmShaders(
      [behaviors.velocity()],
      0,
      'glsl300es',
    );
    const pick = glslStage(render, 'pickFragment');
    expect(pick).toMatch(/flat in uint v_user;/);
    expect(pick).toMatch(
      /outPick = uvec4\(swarmPick\.id, v_slot \+ 1u, v_user, 0u\);/,
    );
    // The color program declares the same varying (linking needs a match).
    expect(glslStage(render, 'fragment')).toMatch(/flat in uint v_user;/);
  });

  test('SpawnOptions.user lands in the spawn params (cold.user)', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 16 });
    swarm.spawn(4, { user: 0xfffffffe });
    swarm.spawn(4, { user: -1 }); // coerced with >>> 0
    h.frame(swarm);
    await flush();
    h.frame(swarm);
    const arena = h.backend.buffers.filter(
      b => !b.destroyed && b.label === `swarm${swarm.swarmId}.arena`,
    )[0];
    const words = new Uint32Array(arena.bytes.buffer);
    // SP_USER is word 26 of each 256-byte arena entry.
    expect(words[26]).toBe(0xfffffffe);
    expect(words[64 + 26]).toBe(0xffffffff);
    swarm.destroy();
    h.system.destroy();
  });
});

// ─── external sources: front (§19.4) ──────────────────────────────────────────

describe('Swarm.setSource (front)', () => {
  test('validates the source', () => {
    const swarm = new Swarm({ capacity: 100 });
    expect(() => swarm.setSourceCount(1)).toThrow(/no external source/);
    const cold = external('swarm-cold', 50);
    expect(() =>
      swarm.setSource({ hot: external('swarm-cold', 50), count: 1 }),
    ).toThrow(/'swarm-hot'/);
    expect(() =>
      swarm.setSource({
        hot: external('swarm-hot', 50),
        cold: cold,
        count: 60,
      }),
    ).toThrow(/capacity/);
    expect(() =>
      swarm.setSource({
        hot: external('swarm-hot', 50),
        cold: external('swarm-hot', 50),
        count: 1,
      }),
    ).toThrow(/'swarm-cold'/);
    const released = external('swarm-hot', 50);
    released.release();
    expect(() => swarm.setSource({ hot: released, count: 1 })).toThrow(/valid/);
    const gpu = new Swarm({ capacity: 10, allocation: 'gpu' });
    expect(() =>
      gpu.setSource({ hot: external('swarm-hot', 10), count: 1 }),
    ).toThrow(/allocation 'gpu'/);
    swarm.destroy();
    gpu.destroy();
    expect(() =>
      swarm.setSource({ hot: external('swarm-hot', 10), count: 1 }),
    ).toThrow(/destroyed/);
  });

  test('mutations throw while a source is set, and work again after null', () => {
    const swarm = new Swarm({ capacity: 100 });
    swarm.setSource({ hot: external('swarm-hot', 100), count: 10 });
    expect(() => swarm.spawn(1)).toThrow(/external source/);
    expect(() => swarm.kill(0)).toThrow(/external source/);
    expect(() => swarm.killList(new Uint32Array([1]))).toThrow(
      /external source/,
    );
    expect(() => swarm.write(0, new Float32Array(10))).toThrow(
      /external source/,
    );
    expect(() => swarm.clear()).toThrow(/external source/);
    swarm.setSource(null);
    expect(swarm.spawn(3)).toBe(0);
    swarm.clear();
    swarm.destroy();
  });

  test('setSourceCount clamps to the swarm and buffer capacities', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 100 });
    const hot = external('swarm-hot', 80);
    const cold = external('swarm-cold', 60);
    h.register(hot);
    h.register(cold);
    swarm.setSource({ hot, cold, count: 10 });
    h.frame(swarm);
    await flush();
    swarm.setSourceCount(1e9);
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x60']);
    swarm.setSourceCount(-5);
    expect(h.draws(h.frame(swarm))).toEqual([]);
    swarm.setSourceCount(7.9);
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x7']);
    swarm.destroy();
    h.system.destroy();
  });

  test('stream: SET_SOURCE follows queued commands; draw-only sends no STEP', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 100,
      behaviors: [behaviors.velocity()],
    });
    swarm.spawn(5);
    const hot = external('swarm-hot', 100);
    h.register(hot);
    swarm.setSource({ hot, count: 40 });
    h.frame(swarm);
    expect(h.ops()).toEqual([
      Op.SWARM_CREATE,
      Op.SWARM_SET_FRAMES,
      Op.SWARM_SPAWN,
      Op.SWARM_SET_SOURCE,
      Op.SWARM_SET_PARAMS,
      Op.SWARM_DRAW,
    ]);
    h.frame(swarm);
    expect(h.ops()).toEqual([Op.SWARM_DRAW]);
    // simulate: the step runs over the source count
    swarm.setSource({ hot, count: 40, simulate: true });
    h.frame(swarm);
    expect(h.ops()).toEqual([
      Op.SWARM_SET_SOURCE,
      Op.SWARM_STEP,
      Op.SWARM_DRAW,
    ]);
    // back to the own buffers: own activeCount (5), steps again
    swarm.setSource(null);
    h.frame(swarm);
    expect(h.ops()).toEqual([
      Op.SWARM_SET_SOURCE,
      Op.SWARM_STEP,
      Op.SWARM_DRAW,
    ]);
    expect(swarm.activeCount).toBe(5);
    swarm.destroy();
    h.system.destroy();
  });

  test('WebGL2: setSource throws UNSUPPORTED once the swarm runs there', async () => {
    installGlslComposer();
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 64,
      behaviors: [behaviors.velocity()],
    });
    swarm.spawn(4);
    h.frame(swarm);
    expect(() =>
      swarm.setSource({ hot: external('swarm-hot', 64), count: 4 }),
    ).toThrow(/WebGPU/);
    swarm.destroy();
    h.system.destroy();
  });
});

// ─── external sources: WebGPU core ────────────────────────────────────────────

describe('external sources (WebGPU core)', () => {
  test('draws from the external hot (and cold) buffers, no copy', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 100,
      behaviors: [behaviors.velocity()],
    });
    swarm.pickable = true;
    swarm.spawn(10);
    h.frame(swarm);
    await flush();
    h.frame(swarm);
    const id = swarm.swarmId;
    expect(h.lastGroup('.render').buffers.slice(0, 2)).toEqual([
      `swarm${id}.hot`,
      `swarm${id}.cold`,
    ]);

    const hot = external('swarm-hot', 50);
    h.register(hot);
    swarm.setSource({ hot, count: 30 });
    const log = h.frame(swarm, true);
    expect(h.draws(log)).toEqual(['draw 4x30', 'draw 4x30']);
    expect(h.lastGroup('.render').buffers.slice(0, 2)).toEqual([
      `ext${hot.id}`,
      `swarm${id}.cold`,
    ]);
    expect(h.lastGroup('.pick').buffers.slice(0, 2)).toEqual([
      `ext${hot.id}`,
      `swarm${id}.cold`,
    ]);
    // draw-only: no step dispatch
    expect(log.filter(l => l.startsWith('cs '))).toEqual([]);

    const cold = external('swarm-cold', 50);
    h.register(cold);
    swarm.setSource({ hot, cold, count: 20 });
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x20']);
    expect(h.lastGroup('.render').buffers.slice(0, 2)).toEqual([
      `ext${hot.id}`,
      `ext${cold.id}`,
    ]);

    // steady state: no bind group rebuilt
    const before = h.groups.length;
    h.frame(swarm);
    h.frame(swarm);
    expect(h.groups.length).toBe(before);

    // back to the own buffers
    swarm.setSource(null);
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x10']);
    expect(h.lastGroup('.render').buffers.slice(0, 2)).toEqual([
      `swarm${id}.hot`,
      `swarm${id}.cold`,
    ]);
    swarm.destroy();
    h.system.destroy();
  });

  test('simulate runs the step on the external hot buffer', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 1000,
      behaviors: [behaviors.velocity()],
    });
    const hot = external('swarm-hot', 1000);
    h.register(hot);
    swarm.setSource({ hot, count: 600, simulate: true });
    h.frame(swarm);
    await flush();
    const log = h.frame(swarm);
    expect(log.filter(l => /^(cs |dispatch|draw)/.test(l))).toEqual([
      `cs swarm${swarm.swarmId}.cs_step`,
      'dispatch 3',
      'draw 4x600',
    ]);
    expect(h.lastGroup('.step').buffers[0]).toBe(`ext${hot.id}`);
    swarm.destroy();
    h.system.destroy();
  });

  test('spawns queued before setSource still target the own buffers', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 100,
      behaviors: [behaviors.velocity()],
    });
    h.frame(swarm);
    await flush();
    h.frame(swarm);
    const hot = external('swarm-hot', 100);
    h.register(hot);
    swarm.spawn(8);
    swarm.setSource({ hot, count: 8 });
    let log = h.frame(swarm);
    // spawn dispatched with the own-buffer op group; the switch waits a frame
    expect(log.filter(l => l.startsWith('cs '))).toEqual([
      `cs swarm${swarm.swarmId}.cs_spawn`,
    ]);
    expect(h.lastGroup('.op').buffers[0]).toBe(`swarm${swarm.swarmId}.hot`);
    log = h.frame(swarm);
    expect(h.lastGroup('.render').buffers[0]).toBe(`ext${hot.id}`);
    expect(h.draws(log)).toEqual(['draw 4x8']);
    swarm.destroy();
    h.system.destroy();
  });

  test('a released (or lost) buffer draws nothing until a new source', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 100 });
    swarm.pickable = true;
    const hot = external('swarm-hot', 100);
    h.register(hot);
    swarm.setSource({ hot, count: 50 });
    h.frame(swarm);
    await flush();
    expect(h.draws(h.frame(swarm, true))).toEqual(['draw 4x50', 'draw 4x50']);
    h.externals.delete(hot.id);
    expect(h.draws(h.frame(swarm, true))).toEqual([]);
    await expect(h.system.readback(1, swarm.swarmId, 0, 1)).rejects.toThrow(
      /unreadable/,
    );
    const hot2 = external('swarm-hot', 100);
    h.register(hot2);
    swarm.setSource({ hot: hot2, count: 5 });
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x5']);
    swarm.destroy();
    h.system.destroy();
  });

  test('readbacks read the external buffer; without COPY_SRC they reject', async () => {
    const h = setup();
    await h.system.init(h.ctx);
    const swarm = new Swarm({ capacity: 100 });
    const hot = external('swarm-hot', 100);
    const hotBuffer = h.register(hot);
    const cold = external('swarm-cold', 100);
    h.register(cold, BufferUsage.STORAGE);
    swarm.setSource({ hot, cold, count: 50 });
    h.frame(swarm);
    const reads: string[] = [];
    h.backend.readBuffer = async (b, offset, length) => {
      reads.push(`${b.label} ${offset} ${length}`);
      return new ArrayBuffer(length);
    };
    await h.system.readback(1, swarm.swarmId, 2, 3);
    expect(reads).toEqual([`${hotBuffer.label} 80 120`]);
    await expect(h.system.readback(2, swarm.swarmId, 0, 1)).rejects.toThrow(
      /unreadable/,
    );
    expect(h.system.readbackBuffer(1, swarm.swarmId)).toBe(hotBuffer);
    swarm.destroy();
    h.system.destroy();
  });
});

describe('external sources (WebGL2 core)', () => {
  test('a (forged) SWARM_SET_SOURCE draws nothing until cleared', async () => {
    installGlslComposer();
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 64,
      behaviors: [behaviors.velocity()],
    });
    swarm.spawn(4);
    h.frame(swarm);
    await flush();
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x4']);
    const forge = (hotId: number) => {
      const enc = new FakeEncoder();
      enc.begin(Op.SWARM_SET_SOURCE, 16);
      enc.u32(swarm.swarmId);
      enc.u32(hotId);
      enc.u32(0);
      enc.u32(SwarmSourceFlag.SIMULATE);
      enc.end();
      const reader = new FakeReader(enc.finish(1));
      reader.seek(reader.list()[0].commandOffset);
      h.system.execute(reader, {
        frameId: 2,
        time: 0,
        dt: 0,
      } as CoreFrameState);
    };
    forge(55); // the front refuses setSource on WebGL2
    expect(h.draws(h.frame(swarm))).toEqual([]);
    forge(0);
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x4']);
    swarm.destroy();
    h.system.destroy();
  });
});

describe('external sources (WebGL2 front)', () => {
  test('a source set before the first WebGL2 frame disables the swarm', async () => {
    installGlslComposer();
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const swarm = new Swarm({
      capacity: 64,
      behaviors: [behaviors.velocity()],
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    swarm.setSource({ hot: external('swarm-hot', 64), count: 4 });
    expect(h.draws(h.frame(swarm))).toEqual([]);
    expect(h.ops()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/UNSUPPORTED.*WebGPU/);
    await expect(swarm.readHot(0, 1)).rejects.toThrow(/WebGPU/);
    // back to the own buffers: runs on WebGL2 again
    swarm.setSource(null);
    swarm.spawn(4);
    h.frame(swarm);
    await flush();
    expect(h.draws(h.frame(swarm))).toEqual(['draw 4x4']);
    error.mockRestore();
    swarm.destroy();
    h.system.destroy();
  });

  test('WebGL2 refusals reach the events sink as one error each, like the WebGPU core', async () => {
    installGlslComposer();
    const h = setup(GL_CAPS);
    await h.system.init(h.ctx);
    const events: [string, unknown][] = [];
    (h.front as unknown as { _emit: unknown })._emit = (
      name: string,
      payload: unknown,
    ) => events.push([name, payload]);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const gpu = new Swarm({
      capacity: 64,
      allocation: 'gpu',
      behaviors: [behaviors.velocity()],
    });
    const big = new Swarm({
      capacity: SWARM_GL_MAX_CAPACITY + 1,
      behaviors: [behaviors.velocity()],
    });
    const sourced = new Swarm({
      capacity: 64,
      behaviors: [behaviors.velocity()],
    });
    sourced.setSource({ hot: external('swarm-hot', 64), count: 4 });
    for (let i = 0; i < 3; i++) {
      h.frame(gpu);
      h.frame(big);
      h.frame(sourced);
    }
    // Once per refusal (never per frame), with the logged code and text.
    expect(events.map(([name]) => name)).toEqual(['error', 'error', 'error']);
    const payloads = events.map(
      ([, p]) => p as { code: string; message: string },
    );
    expect(payloads.map(p => p.code)).toEqual([
      'UNSUPPORTED',
      'OUT_OF_CAPACITY',
      'UNSUPPORTED',
    ]);
    expect(error).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(String(error.mock.calls[i][0])).toBe(
        `[cozygpu:${payloads[i].code}] ${payloads[i].message}`,
      );
    }
    error.mockRestore();
    gpu.destroy();
    big.destroy();
    sourced.destroy();
    h.system.destroy();
  });
});
