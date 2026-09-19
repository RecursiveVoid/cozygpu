/**
 * M2.5 review: the core picking FIFO and ring slots under wraparound
 * (ARCHITECTURE §19.6). Requests are answered in request order while the
 * queue's head wraps and the queue grows with a wrapped head; ring slots are
 * reused with no new targets, buffers or rings.
 */
import type { RenderPass } from '../backend/types';
import type { CoreContext, CoreFrameState, PickReplay } from '../types/core';
import type { CoreMessage } from '../types/transport';
import { createCorePickingNow, PICK_SLOTS } from './pickingCoreImpl';
import { pickPipelinesPending } from './pickingPipelines';
import { FakeBackend } from './testing/fakeBackend';

type PickMessage = Extract<CoreMessage, { type: 'pick' }>;

const frame: CoreFrameState = {
  frameId: 1,
  time: 0,
  dt: 0.016,
  pixelWidth: 10,
  pixelHeight: 10,
  cssWidth: 10,
  cssHeight: 10,
  resolution: 1,
};

const replay: PickReplay = {
  drawCount: 1,
  drawPick(_i: number, _p: RenderPass): void {},
};

function setup() {
  const backend = new FakeBackend();
  const answers: PickMessage[] = [];
  const res = { label: 'x', destroy: () => {} };
  const ctx: CoreContext = {
    backend,
    viewLayout: res,
    viewBindGroup: res,
    textureLayout: res,
    whiteTexture: {} as never,
    getTexture: () => ({ bindGroup: res }) as never,
    getShared: () => undefined,
    sampleCount: 1,
    post: (m: CoreMessage) => void answers.push({ ...(m as PickMessage) }),
  };
  const picking = createCorePickingNow(ctx, pickPipelinesPending);
  /** One packet: render what fits, then poll (READY per backend.ringReady). */
  const packet = () => {
    picking.render(backend.beginCommands(), replay, frame);
    picking.poll!();
  };
  return { backend, picking, answers, packet };
}

describe('core picking queue wraparound', () => {
  it('answers in request order while the head wraps and the queue grows wrapped', () => {
    const { backend, picking, answers, packet } = setup();
    let next = 1;
    // Advance the head to 12 of 16: three packets of PICK_SLOTS requests.
    for (let round = 0; round < 3; round++) {
      for (let k = 0; k < PICK_SLOTS; k++) picking.request(next++, k, k);
      packet();
    }
    expect(answers.map(a => a.requestId)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    // Slots stay busy: 30 more requests wrap the head and grow the queue.
    backend.ringReady = false;
    for (let k = 0; k < 30; k++) picking.request(next++, k, k);
    packet(); // 4 rendered, stuck in flight
    expect(picking.pending).toBe(26);
    backend.ringReady = true;
    for (let i = 0; i < 20 && answers.length < 42; i++) packet();
    expect(picking.pending).toBe(0);
    expect(answers.map(a => a.requestId)).toEqual(
      Array.from({ length: 42 }, (_, i) => i + 1),
    );
    expect(answers.every(a => a.code === undefined)).toBe(true);
  });

  it('reuses its targets, view buffers and one ring across hundreds of picks', () => {
    const { backend, picking, answers, packet } = setup();
    for (let i = 1; i <= 400; i++) {
      picking.request(i, i % 7, i % 5);
      if (i % 3 === 0) packet();
    }
    packet();
    packet();
    expect(answers.length).toBe(400);
    expect(backend.rings.length).toBe(1);
    expect(
      backend.textures.filter(t => t.label?.startsWith('cozygpu.pick')).length,
    ).toBe(PICK_SLOTS);
    expect(
      backend.buffers.filter(b => b.label?.startsWith('cozygpu.pick.view'))
        .length,
    ).toBe(PICK_SLOTS);
    expect(Array.from(backend.rings[0].state)).toEqual([0, 0, 0, 0]);
  });

  it('failAll with a wrapped, grown queue answers every request exactly once', () => {
    const { backend, picking, answers, packet } = setup();
    let next = 1;
    for (let round = 0; round < 3; round++) {
      for (let k = 0; k < PICK_SLOTS; k++) picking.request(next++, 0, 0);
      packet();
    }
    answers.length = 0;
    backend.ringReady = false;
    for (let k = 0; k < 20; k++) picking.request(next++, 0, 0);
    packet(); // 4 in flight, 16 queued (wrapped and grown)
    picking.failAll('DEVICE_LOST', 'gone');
    const ids = answers.map(a => a.requestId).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => 13 + i));
    expect(answers.every(a => a.code === 'DEVICE_LOST')).toBe(true);
    // Nothing left: later packets answer nothing more.
    backend.ringReady = true;
    packet();
    expect(answers.length).toBe(20);
    expect(picking.pending).toBe(0);
  });
});
