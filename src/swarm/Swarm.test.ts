import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import { Op } from '../commands/opcodes';
import type { FrontFrame } from '../types/core';
import { SP_COUNT, SP_FIRST } from '../types/layouts';
import { FakeEncoder, FakeReader } from './__fakes__/commands';
import { behaviors } from './behaviors';
import { Swarm } from './Swarm';

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

function emit(swarm: Swarm, frame: FrontFrame & { encoder: FakeEncoder }) {
  frame.encoder.reset();
  swarm._emitDraw(frame, IDENTITY, 0, 1);
  const packet = frame.encoder.finish(1);
  const reader = new FakeReader(packet);
  const commands = reader.list();
  return {
    reader,
    commands,
    ops: commands.map(c => c.opcode),
    bytes: packet.byteLength,
  };
}

describe('Swarm front', () => {
  test('first frame creates, steady state is step + draw only', () => {
    const swarm = new Swarm({
      capacity: 1000,
      shape: 'circle',
      behaviors: [
        behaviors.velocity(),
        behaviors.acceleration({ name: 'gravity', y: 10 }),
      ],
    });
    swarm.spawn(1000, { x: [0, 100], y: [0, 100] });
    const frame = makeFrame();
    const first = emit(swarm, frame);
    expect(first.ops).toEqual([
      Op.SWARM_CREATE,
      Op.SWARM_SET_FRAMES,
      Op.SWARM_SPAWN,
      Op.SWARM_SET_PARAMS,
      Op.SWARM_STEP,
      Op.SWARM_DRAW,
    ]);
    const steady = emit(swarm, frame);
    expect(steady.ops).toEqual([Op.SWARM_STEP, Op.SWARM_DRAW]);
    expect(steady.bytes).toBeLessThan(128);

    swarm.behavior<{ value: 'vec2f' }>('gravity').set('value', [0, 5]);
    swarm.behavior<{ value: 'vec2f' }>('gravity').set('value', [0, 6]);
    expect(emit(swarm, frame).ops).toEqual([
      Op.SWARM_SET_PARAMS,
      Op.SWARM_STEP,
      Op.SWARM_DRAW,
    ]);
    expect(swarm.behavior<{ value: 'vec2f' }>('gravity').get('value')).toEqual([
      0, 6,
    ]);
    swarm.destroy();
  });

  test('ring allocation wraps into two spawn commands', () => {
    const swarm = new Swarm({ capacity: 100 });
    expect(swarm.spawn(70)).toBe(0);
    expect(swarm.activeCount).toBe(70);
    expect(swarm.spawn(50)).toBe(70);
    expect(swarm.activeCount).toBe(100);
    const { reader, commands } = emit(swarm, makeFrame());
    const spawns = commands.filter(c => c.opcode === Op.SWARM_SPAWN);
    const ranges = spawns.map(c => {
      const w = (c.payloadOffset >> 2) + 1; // after swarmId
      return [
        reader.u32View[w + SP_FIRST / 4],
        reader.u32View[w + SP_COUNT / 4],
      ];
    });
    expect(ranges).toEqual([
      [0, 70],
      [70, 30],
      [0, 20],
    ]);
    expect(swarm.spawn(10)).toBe(20);
    swarm.destroy();
  });

  test('manual allocation returns -1 when full and reuses killed slots', () => {
    const swarm = new Swarm({ capacity: 10, allocation: 'manual' });
    expect(swarm.spawn(6)).toBe(0);
    expect(swarm.spawn(4)).toBe(6);
    expect(swarm.spawn(1)).toBe(-1);
    swarm.kill(6, 4);
    expect(swarm.activeCount).toBe(6);
    expect(swarm.spawn(3)).toBe(6);
    swarm.destroy();
  });

  test('a new generation re-creates the swarm and calls onRestore', () => {
    const restored: number[] = [];
    const swarm = new Swarm({
      capacity: 50,
      onRestore: s => {
        restored.push(s.activeCount);
        s.spawn(5);
      },
    });
    swarm.spawn(50);
    emit(swarm, makeFrame(0));
    const after = emit(swarm, makeFrame(1));
    expect(restored).toEqual([0]);
    expect(after.ops.slice(0, 3)).toEqual([
      Op.SWARM_CREATE,
      Op.SWARM_SET_FRAMES,
      Op.SWARM_SPAWN,
    ]);
    expect(swarm.activeCount).toBe(5);
    swarm.destroy();
  });

  test('destroyed swarms emit SWARM_DESTROY on the next swarm frame', () => {
    const a = new Swarm({ capacity: 4 });
    const b = new Swarm({ capacity: 4 });
    a.spawn(1);
    b.spawn(1);
    const frame = makeFrame();
    emit(a, frame);
    a.destroy();
    expect(() => a.spawn(1)).toThrow(/destroyed/);
    expect(emit(b, frame).ops[0]).toBe(Op.SWARM_DESTROY);
    b.destroy();
  });
});
