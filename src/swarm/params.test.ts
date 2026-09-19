/**
 * Tester: behavior params mirror (bytes at composer offsets), value
 * preservation across re-layout, and CommandQueue → encoder round-trips.
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { COMMAND_HEADER_BYTES, CommandFlag, Op } from '../commands/opcodes';
import { CozyGPUError } from '../types/errors';
import { behaviors, defineBehavior } from './behaviors';
import { composeSwarmShaders } from './composer';
import { createBehaviorSet, ParamsMirror } from './params';
import { CommandQueue } from './queue';
import type { BehaviorDefinition } from './types';

const mixed = defineBehavior({
  name: 'mixed',
  params: {
    s: 'f32',
    i: 'i32',
    n: 'u32',
    v2: 'vec2f',
    v3: 'vec3f',
    v4: 'vec4f',
  },
  defaults: {
    s: 1.5,
    i: -7,
    n: 0xfffffff0,
    v2: [1, 2],
    v3: [3, 4, 5],
    v4: [6, 7, 8, 9],
  },
  update: '',
});

function setFor(
  defs: readonly BehaviorDefinition[],
  previous?: ReturnType<typeof createBehaviorSet>,
) {
  const composed = composeSwarmShaders(defs, 0);
  return { composed, set: createBehaviorSet(defs, composed, previous) };
}

describe('ParamsMirror / createBehaviorSet', () => {
  it('writes defaults at the composer offsets with the right encodings', () => {
    const { composed, set } = setFor([behaviors.velocity(), mixed]);
    const dv = new DataView(set.mirror.u8.buffer);
    const at = (name: string) =>
      composed.params.find(p => p.param === name)!.offset;
    expect(dv.getFloat32(at('s'), true)).toBe(1.5);
    expect(dv.getInt32(at('i'), true)).toBe(-7);
    expect(dv.getUint32(at('n'), true)).toBe(0xfffffff0);
    expect([0, 1].map(k => dv.getFloat32(at('v2') + 4 * k, true))).toEqual([
      1, 2,
    ]);
    expect([0, 1, 2].map(k => dv.getFloat32(at('v3') + 4 * k, true))).toEqual([
      3, 4, 5,
    ]);
    expect(
      [0, 1, 2, 3].map(k => dv.getFloat32(at('v4') + 4 * k, true)),
    ).toEqual([6, 7, 8, 9]);
    expect(set.mirror.bytes).toBe(composed.paramsBytes);
    expect(set.mirror.dirty).toBe(true);
  });

  it('set() marks dirty and touches only the param bytes', () => {
    const { composed, set } = setFor([mixed]);
    const before = set.mirror.u8.slice();
    set.mirror.dirty = false;
    const h = set.byName.get('mixed')!;
    h.set('v2', [10, 20]);
    expect(set.mirror.dirty).toBe(true);
    const off = composed.params.find(p => p.param === 'v2')!.offset;
    for (let i = 0; i < before.length; i++) {
      if (i >= off && i < off + 8) continue;
      expect(set.mirror.u8[i]).toBe(before[i]);
    }
    expect(h.get('v2')).toEqual([10, 20]);
    h.set('i', -1.9);
    expect(h.get('i')).toBe(-1);
    h.set('n', -1);
    expect(h.get('n')).toBe(0xffffffff);
    expect(() => h.set('nope' as never, 1 as never)).toThrow(CozyGPUError);
  });

  it('setBehaviors keeps values by (behavior, param, type) and handle identity', () => {
    const gravity = behaviors.acceleration({ name: 'gravity', y: 10 });
    const first = setFor([gravity, mixed]);
    const handle = first.set.byName.get('mixed')!;
    handle.set('s', 42);
    handle.set('v4', [1, 1, 1, 1]);
    // re-order and insert a behavior in front: offsets move
    const changedType = defineBehavior({
      name: 'mixed',
      params: { s: 'f32', v4: 'vec3f' },
      defaults: { s: 0, v4: [5, 5, 5] },
      update: '',
    });
    const drag = behaviors.drag({ k: 3 });
    const second = setFor([drag, gravity, changedType], first.set);
    const h2 = second.set.byName.get('mixed')!;
    expect(h2).toBe(handle); // user references stay valid
    expect(h2.get('s')).toBe(42); // preserved
    expect(h2.get('v4')).toEqual([5, 5, 5]); // type changed → default
    expect(second.set.byName.get('gravity')!.get('value')).toEqual([0, 10]);
    expect(second.set.byName.get('drag')!.get('k')).toBe(3);
    // new offsets differ from the old ones, and the mirror is new
    const oldOff = first.composed.params.find(
      p => p.behavior === 'mixed' && p.param === 's',
    )!.offset;
    const newOff = second.composed.params.find(
      p => p.behavior === 'mixed' && p.param === 's',
    )!.offset;
    expect(newOff).not.toBe(oldOff);
    expect(second.set.mirror).not.toBe(first.set.mirror);
  });

  it('mirror size equals paramsBytes even with no params (16-byte pad)', () => {
    const m = new ParamsMirror(composeSwarmShaders([], 0).paramsBytes);
    expect(m.bytes).toBe(16);
    expect(m.u32.length).toBe(4);
  });
});

describe('CommandQueue.flushInto (real encoder/decoder)', () => {
  it('copies small (word) and large (bytes) payloads verbatim, then empties', () => {
    const q = new CommandQueue();
    // small: 3 words
    let w = q.begin(Op.SWARM_KILL_RANGE, 12, CommandFlag.COMPUTE);
    q.u32.set([7, 0xffffffff, 0x80000000], w);
    // unpadded payload length → padded
    w = q.begin(Op.SWARM_SET_PARAMS, 13);
    q.u8.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], w * 4);
    // large: > WORD_COPY_LIMIT (512 B), forces growth past 1024 B
    const big = 12 + 100 * 16;
    w = q.begin(Op.SWARM_WRITE_COLD, big);
    const bigBytes = new Uint8Array(big);
    for (let i = 0; i < big; i++) bigBytes[i] = (i * 13 + 1) & 0xff;
    q.u8.set(bigBytes, w * 4);
    // f32 content (-0 survives because copies are word exact)
    w = q.begin(Op.SWARM_STEP, 16, CommandFlag.COMPUTE);
    q.f32[w + 1] = -0;

    const enc = createCommandEncoder(256);
    enc.reset();
    enc.begin(Op.NOP, 0);
    q.flushInto(enc);
    expect(q.empty).toBe(true);
    const dec = createCommandDecoder();
    dec.reset(enc.finish(3));
    const r = dec.reader;
    expect(dec.next()).toBe(true);
    expect(r.opcode).toBe(Op.NOP);

    expect(dec.next()).toBe(true);
    expect([r.opcode, r.flags, r.payloadBytes]).toEqual([
      Op.SWARM_KILL_RANGE,
      CommandFlag.COMPUTE,
      12,
    ]);
    expect([r.u32(), r.u32(), r.u32()]).toEqual([7, 0xffffffff, 0x80000000]);

    expect(dec.next()).toBe(true);
    expect([r.opcode, r.flags, r.payloadBytes]).toEqual([
      Op.SWARM_SET_PARAMS,
      0,
      16,
    ]);
    expect(
      Array.from(r.u8.subarray(r.payloadOffset, r.payloadOffset + 16)),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 0, 0]);

    expect(dec.next()).toBe(true);
    expect([r.opcode, r.payloadBytes]).toEqual([
      Op.SWARM_WRITE_COLD,
      (big + 3) & ~3,
    ]);
    expect(r.u8.subarray(r.payloadOffset, r.payloadOffset + big)).toEqual(
      bigBytes,
    );

    expect(dec.next()).toBe(true);
    expect(r.opcode).toBe(Op.SWARM_STEP);
    r.u32();
    expect(Object.is(r.f32(), -0)).toBe(true);
    expect(dec.next()).toBe(false);
  });

  it('begin() zero-fills reused bytes and returns payload word indices', () => {
    const q = new CommandQueue();
    const w = q.begin(1, 8);
    q.u32[w] = 0xffffffff;
    q.u32[w + 1] = 0xffffffff;
    q.reset();
    const w2 = q.begin(2, 8);
    expect(w2).toBe(w);
    expect(w2 * 4).toBe(COMMAND_HEADER_BYTES);
    expect([q.u32[w2], q.u32[w2 + 1]]).toEqual([0, 0]);
  });
});
