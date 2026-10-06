/**
 * The `Particles` node: it is a Swarm, it emits one SWARM_SPAWN per emitter
 * per frame, and it uploads the over-life curves once (ARCHITECTURE §24).
 */
import { Op } from '../commands/opcodes';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import { FakeEncoder, FakeReader } from '../swarm/__fakes__/commands';
import type { FrontFrame } from '../types/core';
import {
  SCV_COLOR,
  SP_COUNT,
  SWARM_CURVE_BYTES,
  SwarmRenderFlag,
} from '../types/layouts';
import { loadParticles, Particles, particlePresets } from './Particles';

const IDENTITY = new Float32Array([1, 0, 0, 1, 0, 0]);

function makeFrame(generation = 0): FrontFrame & { encoder: FakeEncoder } {
  return {
    rendererId: 1,
    encoder: new FakeEncoder(),
    frameId: 1,
    time: 0,
    dt: 1 / 60,
    cssWidth: 800,
    cssHeight: 600,
    resolution: 1,
    sharedMemory: true,
    useSharedArrayBuffer: false,
    generation,
    registerShared: () => 1,
    readback: () => Promise.resolve(new ArrayBuffer(0)),
    caps: FAKE_CAPS,
    isSystemReady: () => true,
  };
}

function emit(node: Particles, frame: FrontFrame & { encoder: FakeEncoder }) {
  frame.encoder.reset();
  node._emitDraw(frame, IDENTITY, 0, 1);
  const packet = frame.encoder.finish(1);
  const reader = new FakeReader(packet);
  const commands = reader.list();
  /** Payload word `index` of the first command with `opcode`. */
  const word = (opcode: number, index: number): number => {
    const command = commands.find(c => c.opcode === opcode);
    if (!command) throw new Error(`no command ${opcode.toString(16)}`);
    return reader.u32View[(command.payloadOffset >> 2) + index];
  };
  return { reader, commands, word, ops: commands.map(c => c.opcode) };
}

/** The dynamic import of the compiler chunk resolves on the microtask queue. */
const ready = (): Promise<void> => loadParticles().then(() => undefined);

describe('Particles', () => {
  test('is a swarm node and exposes its emitters at once', () => {
    const fx = new Particles({
      capacity: 1000,
      emitter: [{ name: 'a', rate: 60 }, { rate: 10 }],
    });
    expect(fx.kind).toBe('swarm');
    expect(fx.swarm).toBe(fx);
    expect(fx.capacity).toBe(1000);
    expect(fx.allocation).toBe('ring');
    expect(fx.playing).toBe(true);
    expect(fx.emitters.length).toBe(2);
    expect(fx.emitter('a').rate).toBe(60);
    // the second emitter got a generated name
    expect(fx.emitters[1].name).toBe('e1');
    expect(() => fx.emitter('nope')).toThrow(/no emitter named/);
    fx.emitter('a').moveTo(10, 20);
    expect(fx.emitter('a').x).toBe(10);
  });

  test('first frame creates the swarm, then emits one spawn per emitter', async () => {
    const fx = new Particles({
      capacity: 10_000,
      emitter: [
        { name: 'a', rate: 600, speed: [10, 20], life: [1, 2] },
        { name: 'b', rate: 300 },
      ],
      over: { color: ['#ff0000', '#0000ff'], size: [1, 0] },
    });
    await ready();
    const frame = makeFrame();
    const first = emit(fx, frame);
    expect(first.ops[0]).toBe(Op.SWARM_CREATE);
    expect(first.ops).toContain(Op.SWARM_SET_CURVES);
    expect(first.ops.filter(o => o === Op.SWARM_SPAWN).length).toBe(2);

    const steady = emit(fx, frame);
    // curves are not re-sent, one spawn per emitter, then step + draw
    expect(steady.ops).toEqual([
      Op.SWARM_SPAWN,
      Op.SWARM_SPAWN,
      Op.SWARM_STEP,
      Op.SWARM_DRAW,
    ]);
    // 600 per second at 1/60 s
    expect(steady.word(Op.SWARM_SPAWN, 1 + SP_COUNT / 4)).toBe(10);
  });

  test('the curve block carries the packed colors', async () => {
    const fx = new Particles({
      capacity: 100,
      over: { color: ['#ff0000', '#0000ff'] },
    });
    await ready();
    const frame = makeFrame();
    const packet = emit(fx, frame);
    const curves = packet.commands.find(c => c.opcode === Op.SWARM_SET_CURVES)!;
    expect(curves.payloadBytes).toBe(4 + SWARM_CURVE_BYTES);
    const first = packet.word(Op.SWARM_SET_CURVES, 1 + SCV_COLOR / 4);
    expect(first & 0xff).toBe(0xff); // red
    expect((first >>> 24) & 0xff).toBe(0xff); // opaque
  });

  test('the render shader is compiled with the curve lookup', () => {
    const fx = new Particles({ capacity: 10 });
    const frame = makeFrame();
    const packet = emit(fx, frame);
    // SWARM_CREATE: id, capacity, texId, blendModeId, renderFlags
    const flags = packet.word(Op.SWARM_CREATE, 4);
    expect(flags & SwarmRenderFlag.CURVES).toBe(SwarmRenderFlag.CURVES);
  });

  test('pause stops emission but keeps the simulation running', async () => {
    const fx = new Particles({ capacity: 1000, emitter: { rate: 600 } });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    fx.pause();
    expect(fx.playing).toBe(false);
    const paused = emit(fx, frame);
    expect(paused.ops).not.toContain(Op.SWARM_SPAWN);
    expect(paused.ops).toContain(Op.SWARM_STEP);
    fx.play();
    expect(emit(fx, frame).ops).toContain(Op.SWARM_SPAWN);
  });

  test('burst and emit while paused wait for play', async () => {
    const fx = new Particles({ capacity: 1000, emitter: { rate: 0 } });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    fx.pause();
    fx.emitter().burst(25);
    fx.emit(7);
    // pause() stops every emitter, queued bursts included.
    expect(emit(fx, frame).ops).not.toContain(Op.SWARM_SPAWN);
    expect(emit(fx, frame).ops).not.toContain(Op.SWARM_SPAWN);
    // They are kept, not dropped: play() releases them.
    fx.play();
    expect(emit(fx, frame).word(Op.SWARM_SPAWN, 1 + SP_COUNT / 4)).toBe(32);
    expect(emit(fx, frame).ops).not.toContain(Op.SWARM_SPAWN);
  });

  test('burst and emit queue a one-off emission', async () => {
    const fx = new Particles({ capacity: 1000, emitter: { rate: 0 } });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    expect(emit(fx, frame).ops).not.toContain(Op.SWARM_SPAWN);
    fx.emitter().burst(25);
    const burst = emit(fx, frame);
    expect(burst.word(Op.SWARM_SPAWN, 1 + SP_COUNT / 4)).toBe(25);
    fx.emit(7);
    expect(emit(fx, frame).word(Op.SWARM_SPAWN, 1 + SP_COUNT / 4)).toBe(7);
  });

  test('emit with options spawns from a scratch emitter', async () => {
    const fx = new Particles({ capacity: 1000 });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    fx.emit(9, { speed: [100, 200], life: 0.5 });
    const packet = emit(fx, frame);
    expect(packet.ops.filter(o => o === Op.SWARM_SPAWN).length).toBe(1);
    expect(fx.emitters.length).toBe(0);
  });

  test('setOverLife re-uploads the curves without recreating the swarm', async () => {
    const fx = new Particles({ capacity: 100, over: { alpha: [1, 0] } });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    expect(emit(fx, frame).ops).not.toContain(Op.SWARM_SET_CURVES);
    fx.setOverLife({ color: ['#00ff00'] });
    const updated = emit(fx, frame);
    expect(updated.ops).toContain(Op.SWARM_SET_CURVES);
    expect(updated.ops).not.toContain(Op.SWARM_CREATE);
  });

  test('a device restore re-sends the curves', async () => {
    const fx = new Particles({ capacity: 100, over: { alpha: [1, 0] } });
    await ready();
    emit(fx, makeFrame(0));
    const restored = emit(fx, makeFrame(1));
    expect(restored.ops).toContain(Op.SWARM_CREATE);
    expect(restored.ops).toContain(Op.SWARM_SET_CURVES);
  });

  test('the curves wait until the swarm core system is live', async () => {
    const fx = new Particles({ capacity: 100, over: { size: [1, 0] } });
    await ready();
    // The swarm core chunk is still loading: nothing may be sent, or the
    // curves would arrive before SWARM_CREATE and leave a zeroed block.
    const loading = makeFrame();
    loading.isSystemReady = () => false;
    expect(emit(fx, loading).ops).toEqual([]);
    const live = makeFrame();
    const first = emit(fx, live);
    expect(first.ops).toContain(Op.SWARM_CREATE);
    expect(first.ops).toContain(Op.SWARM_SET_CURVES);
  });

  test('addEmitter compiles a line shape behavior', async () => {
    const fx = new Particles({ capacity: 500 });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    fx.addEmitter({
      name: 'rain',
      rate: 120,
      shape: { line: { x2: 300, y2: 0 } },
    });
    const packet = emit(fx, frame);
    // the new behavior is a pipeline change, and its params are uploaded
    expect(packet.ops).toContain(Op.SWARM_SET_PIPELINE);
    expect(packet.ops).toContain(Op.SWARM_SET_PARAMS);
    expect(fx.behaviors.map(b => b.name)).toContain('pxShape0');
  });

  test('presets are plain options the caller can edit', () => {
    const fire = particlePresets.fire({ capacity: 123 });
    expect(fire.capacity).toBe(123);
    expect(fire.over?.color?.length).toBeGreaterThan(1);
    const fx = new Particles(particlePresets.sparks());
    expect(fx.capacity).toBeGreaterThan(0);
    expect(fx.emitters.length).toBe(1);
  });

  test('clear kills everything and restarts the emitter timers', async () => {
    const fx = new Particles({
      capacity: 1000,
      emitter: { rate: 0, burst: { count: 4, at: 0 } },
    });
    await ready();
    const frame = makeFrame();
    emit(fx, frame);
    // the burst has fired; clearing schedules it again
    expect(emit(fx, frame).ops).not.toContain(Op.SWARM_SPAWN);
    fx.clear();
    const after = emit(fx, frame);
    expect(after.ops).toContain(Op.SWARM_KILL_RANGE);
    expect(after.ops).toContain(Op.SWARM_SPAWN);
  });
});
