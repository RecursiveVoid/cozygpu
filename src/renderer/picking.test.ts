/**
 * Picking (ARCHITECTURE §16.3): front client, core module, sprite pick draws
 * and pick ids in sprite instances.
 */
import type { RenderPass, RenderPipelineDesc } from '../backend/types';
import { Op } from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { nodeStore } from '../scene/store';
import { SpriteCoreSystem } from '../sprites/core';
import { FakeFrame } from '../sprites/fakes.testutil';
import { SpriteScenePacker } from '../sprites/front';
import type { CoreContext, CoreFrameState, PickReplay } from '../types/core';
import { SI_PICK_SHIFT, VU_TRANSLATE } from '../types/layouts';
import type { CoreMessage } from '../types/transport';
import { createPickClient } from './picking';
import { createCorePicking as createLazyCorePicking } from './pickingCore';
import { createCorePickingNow, PICK_SLOTS } from './pickingCoreImpl';
import {
  beginPickPipeline,
  endPickPipeline,
  pickPipelinesPending,
} from './pickingPipelines';
import { FakeBackend, FakeBuffer } from './testing/fakeBackend';

type PickMessage = Extract<CoreMessage, { type: 'pick' }>;

const createCorePicking = (ctx: CoreContext) =>
  createCorePickingNow(ctx, pickPipelinesPending);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('createPickClient', () => {
  it('encodes queued picks and resolves hits to live nodes', async () => {
    const stage = new Container();
    const group = stage.addChild(new Container());
    const sprite = group.addChild(new Sprite());
    const client = createPickClient({ stage });
    const frame = new FakeFrame();

    const hit = client.pick(12.5, 7);
    const miss = client.pick(1, 2);
    client.encode(frame.next());
    const cmds = frame.encoder.commands();
    expect(cmds.map(c => c.opcode)).toEqual([Op.PICK, Op.PICK]);
    const f32 = new Float32Array(frame.encoder.buf);
    expect(f32[(cmds[0].payloadOffset >> 2) + 1]).toBe(12.5);
    expect(f32[(cmds[0].payloadOffset >> 2) + 2]).toBe(7);
    // Encoded once only.
    client.encode(frame.next());
    expect(frame.encoder.commands()).toEqual([]);

    client.handleMessage({
      type: 'pick',
      requestId: cmds[0].words[0],
      objectId: sprite.id,
      instance: -1,
    });
    client.handleMessage({
      type: 'pick',
      requestId: cmds[1].words[0],
      objectId: 0,
      instance: -1,
    });
    await expect(hit).resolves.toEqual({
      node: sprite,
      instance: -1,
      x: 12.5,
      y: 7,
    });
    await expect(miss).resolves.toBeNull();
    stage.destroy();
  });

  it('resolves null for destroyed nodes and rejects on error codes', async () => {
    const stage = new Container();
    const sprite = stage.addChild(new Sprite());
    const id = sprite.id;
    const client = createPickClient({ stage });
    const frame = new FakeFrame();
    const gone = client.pick(0, 0);
    const failed = client.pick(0, 0);
    client.encode(frame.next());
    const [a, b] = frame.encoder.commands().map(c => c.words[0]);
    sprite.destroy();
    client.handleMessage({
      type: 'pick',
      requestId: a,
      objectId: id,
      instance: -1,
    });
    client.handleMessage({
      type: 'pick',
      requestId: b,
      objectId: 0,
      instance: -1,
      code: 'UNSUPPORTED',
      message: 'nope',
    });
    await expect(gone).resolves.toBeNull();
    await expect(failed).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.pick(NaN, 0)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    stage.destroy();
  });

  it('rejectAll: DEVICE_LOST keeps sent ids until answered; late answers are ignored', async () => {
    const stage = new Container();
    const sprite = stage.addChild(new Sprite());
    const client = createPickClient({ stage });
    const frame = new FakeFrame();
    const sent = client.pick(0, 0);
    client.encode(frame.next());
    const requestId = frame.encoder.commands()[0].words[0];
    const queued = client.pick(0, 0);
    client.rejectAll('DEVICE_LOST', 'lost');
    await expect(sent).rejects.toMatchObject({ code: 'DEVICE_LOST' });
    await expect(queued).rejects.toMatchObject({ code: 'DEVICE_LOST' });
    // Nothing left to encode.
    client.encode(frame.next());
    expect(frame.encoder.commands()).toEqual([]);
    // Late answer: ignored, and a new pick works.
    client.handleMessage({
      type: 'pick',
      requestId,
      objectId: sprite.id,
      instance: -1,
    });
    const next = client.pick(1, 1);
    client.encode(frame.next());
    client.handleMessage({
      type: 'pick',
      requestId: frame.encoder.commands()[0].words[0],
      objectId: sprite.id,
      instance: -1,
    });
    await expect(next).resolves.toMatchObject({ node: sprite });
    const late = client.pick(0, 0);
    client.rejectAll('DESTROYED', 'bye');
    await expect(late).rejects.toMatchObject({ code: 'DESTROYED' });
    stage.destroy();
  });
});

function coreContext(backend: FakeBackend, posts: CoreMessage[]): CoreContext {
  const res = { label: 'x', destroy: () => {} };
  return {
    backend,
    viewLayout: res,
    viewBindGroup: res,
    textureLayout: res,
    whiteTexture: {} as never,
    getTexture: () => ({ bindGroup: res }) as never,
    getShared: () => undefined,
    sampleCount: 1,
    post: (m: CoreMessage) => void posts.push(m),
  };
}

const coreFrame: CoreFrameState = {
  frameId: 1,
  time: 2,
  dt: 0.016,
  pixelWidth: 300,
  pixelHeight: 150,
  cssWidth: 300,
  cssHeight: 150,
  resolution: 2,
};

class Replay implements PickReplay {
  calls: { index: number; view: unknown }[] = [];
  constructor(public drawCount: number) {}
  drawPick(index: number, _pass: RenderPass, view: never): void {
    this.calls.push({ index, view });
  }
}

describe('createCorePicking', () => {
  it('renders one pass per request into its own 1×1 target and posts the texel', async () => {
    const backend = new FakeBackend();
    const posts: CoreMessage[] = [];
    const picking = createCorePicking(coreContext(backend, posts));
    picking.request(5, 10, 20);
    picking.request(6, 30, 40);
    expect(picking.pending).toBe(2);
    const replay = new Replay(3);
    const list = backend.beginCommands();
    picking.render(list, replay, coreFrame);
    expect(picking.pending).toBe(0);
    expect(replay.calls.map(c => c.index)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(replay.calls[0].view).not.toBe(replay.calls[3].view);

    const targets = backend.textures.filter(t =>
      t.label?.startsWith('cozygpu.pick'),
    );
    expect(targets.map(t => [t.width, t.height, t.format])).toEqual([
      [1, 1, 'rg32uint'],
      [1, 1, 'rg32uint'],
    ]);
    expect(backend.lastPassDesc?.target).toBe(targets[1]);
    // Pick View: css (x, y) at the texel center.
    const views = backend.buffers.filter(b =>
      b.label?.startsWith('cozygpu.pick.view'),
    );
    const v0 = new Float32Array((views[0] as FakeBuffer).bytes.buffer);
    expect([v0[VU_TRANSLATE >> 2], v0[(VU_TRANSLATE >> 2) + 1]]).toEqual([
      -9.5, -19.5,
    ]);

    list.submit();
    backend.nextTextureRead = new Uint8Array(new Uint32Array([77, 0]).buffer);
    picking.afterSubmit();
    await flush();
    expect(posts).toEqual([
      { type: 'pick', requestId: 5, objectId: 77, instance: -1 },
      { type: 'pick', requestId: 6, objectId: 0, instance: -1 },
    ]);
    // Nothing rendered: afterSubmit is a no-op.
    picking.afterSubmit();
    await flush();
    expect(posts.length).toBe(2);
    picking.destroy();
  });

  it('the lazy proxy queues requests until the implementation loads', async () => {
    const backend = new FakeBackend();
    const posts: CoreMessage[] = [];
    const picking = createLazyCorePicking(coreContext(backend, posts));
    picking.request(7, 1, 2);
    picking.request(8, 3, 4);
    // Not loaded yet: nothing to render.
    expect(picking.pending).toBe(0);
    picking.render(backend.beginCommands(), new Replay(1), coreFrame);
    picking.afterSubmit();
    for (let i = 0; i < 20 && picking.pending === 0; i++) await flush();
    expect(picking.pending).toBe(2);
    picking.render(backend.beginCommands(), new Replay(1), coreFrame);
    picking.afterSubmit();
    await flush();
    expect((posts as PickMessage[]).map(m => m.requestId)).toEqual([7, 8]);

    const early = createLazyCorePicking(coreContext(backend, posts));
    early.request(9, 0, 0);
    early.failAll('DESTROYED', 'bye');
    expect(posts[posts.length - 1]).toMatchObject({
      requestId: 9,
      code: 'DESTROYED',
    });
    early.destroy();
  });

  it(`renders at most ${PICK_SLOTS} requests per packet`, async () => {
    const backend = new FakeBackend();
    const posts: CoreMessage[] = [];
    const picking = createCorePicking(coreContext(backend, posts));
    for (let i = 0; i < PICK_SLOTS + 2; i++) picking.request(100 + i, i, i);
    picking.render(backend.beginCommands(), new Replay(1), coreFrame);
    expect(picking.pending).toBe(2);
    picking.afterSubmit();
    picking.render(backend.beginCommands(), new Replay(1), coreFrame);
    picking.afterSubmit();
    await flush();
    expect((posts as PickMessage[]).map(m => m.requestId)).toEqual([
      100, 101, 102, 103, 104, 105,
    ]);
  });

  it('keeps requests queued while a pick pipeline compiles', async () => {
    const backend = new FakeBackend();
    const posts: CoreMessage[] = [];
    const ctx = coreContext(backend, posts);
    const picking = createCorePicking(ctx);
    picking.request(1, 0, 0);
    const replay = new Replay(1);
    replay.drawPick = () => beginPickPipeline(ctx);
    picking.render(backend.beginCommands(), replay, coreFrame);
    picking.afterSubmit();
    expect(picking.pending).toBe(1);
    expect(backend.calls).not.toContain('readTexture cozygpu.pick#0');
    endPickPipeline(ctx);
    expect(pickPipelinesPending(ctx)).toBe(false);
    picking.render(backend.beginCommands(), new Replay(1), coreFrame);
    picking.afterSubmit();
    await flush();
    expect(posts).toMatchObject([{ requestId: 1, objectId: 0 }]);
  });

  it('failAll answers every queued request; no integer targets → UNSUPPORTED', async () => {
    const backend = new FakeBackend();
    const posts: CoreMessage[] = [];
    const picking = createCorePicking(coreContext(backend, posts));
    picking.request(1, 0, 0);
    picking.request(2, 0, 0);
    picking.failAll('DEVICE_LOST', 'gone');
    expect(picking.pending).toBe(0);
    expect(posts).toMatchObject([
      { requestId: 1, code: 'DEVICE_LOST' },
      { requestId: 2, code: 'DEVICE_LOST' },
    ]);
    backend.caps = { ...backend.caps, integerRenderTargets: false };
    picking.request(3, 0, 0);
    expect(posts[2]).toMatchObject({ requestId: 3, code: 'UNSUPPORTED' });
    // readTexture failure → the request is answered with its code
    backend.caps = { ...backend.caps, integerRenderTargets: true };
    backend.readTexture = () => Promise.reject(new Error('boom'));
    picking.request(4, 0, 0);
    picking.render(backend.beginCommands(), new Replay(0), coreFrame);
    picking.afterSubmit();
    await flush();
    expect(posts[3]).toMatchObject({ requestId: 4, code: 'INTERNAL' });
  });
});

function drawReader(words: number[]): CommandReader {
  const u32View = new Uint32Array(words);
  let at = 0;
  return {
    opcode: Op.SPRITE_DRAW,
    u32: () => u32View[at++],
  } as unknown as CommandReader;
}

describe('SpriteCoreSystem.drawPick', () => {
  it('creates the pick pipeline lazily, reports it pending, then draws with the pick view', async () => {
    const backend = new FakeBackend();
    const pipelines: RenderPipelineDesc[] = [];
    const create = backend.createRenderPipeline.bind(backend);
    backend.createRenderPipeline = (d: RenderPipelineDesc) => {
      pipelines.push(d);
      return create(d);
    };
    const ctx = coreContext(backend, []);
    const sys = new SpriteCoreSystem();
    await sys.init(ctx);
    expect(pipelines.length).toBe(5);
    sys.execute(
      {
        opcode: Op.SPRITE_BUFFER_ALLOC,
        u32: (() => {
          let i = 0;
          const w = [1, 16];
          return () => w[i++];
        })(),
      } as unknown as CommandReader,
      coreFrame,
    );
    const calls: string[] = [];
    const pass = {
      setPipeline: () => calls.push('setPipeline'),
      setBindGroup: (i: number, g: { label?: string }) =>
        calls.push(`bind ${i} ${g.label}`),
      setVertexBuffer: () => calls.push('vb'),
      draw: (...a: number[]) => calls.push(`draw ${a.join(',')}`),
    } as unknown as RenderPass;
    const view = { label: 'pickView', destroy: () => {} };

    sys.drawPick(drawReader([1, 2, 3, 0, 0]), pass, coreFrame, view);
    expect(calls).toEqual([]);
    expect(pickPipelinesPending(ctx)).toBe(true);
    const pick = pipelines[5];
    expect(pick).toMatchObject({
      fragmentEntry: 'fs_pick',
      colorFormat: 'rg32uint',
      blend: 'none',
      sampleCount: 1,
      topology: 'triangle-strip',
    });
    await flush();
    expect(pickPipelinesPending(ctx)).toBe(false);
    sys.drawPick(drawReader([1, 2, 3, 0, 0]), pass, coreFrame, view);
    expect(calls).toEqual([
      'setPipeline',
      'bind 0 pickView',
      'bind 1 x',
      'vb',
      'draw 4,3,0,2',
    ]);
    sys.destroy();
  });
});

describe('pick ids in sprite instances', () => {
  it('packs node ids for pickable sprites and rewrites on toggle without a rebuild', () => {
    const stage = new Container();
    const a = stage.addChild(new Sprite());
    const b = stage.addChild(new Sprite({ pickable: false }));
    const c = stage.addChild(new Container({ pickable: true }));
    expect([a.pickable, b.pickable, c.pickable, stage.pickable]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame.next());
    const u32 = () => packer.instances.u32;
    expect(u32()[9] >>> SI_PICK_SHIFT).toBe(a.id);
    expect(u32()[19]).toBe(0);

    const rebuilds = packer.rebuildCount + packer.patchCount;
    a.pickable = false;
    b.pickable = true;
    packer.pack(stage, frame.next());
    expect(packer.rebuildCount + packer.patchCount).toBe(rebuilds);
    expect(u32()[9]).toBe(0);
    expect(u32()[19] >>> SI_PICK_SHIFT).toBe(b.id);
    const upload = frame.encoder
      .commands()
      .find(x => x.opcode === Op.SPRITE_UPLOAD);
    expect(upload?.words.slice(1, 3)).toEqual([0, 2]);
    // Flag bits 0–7 survive pick id writes.
    nodeStore.flags[a._slot] |= 1;
    a.pickable = true;
    expect(nodeStore.flags[a._slot]).toBe(((a.id << SI_PICK_SHIFT) | 1) >>> 0);
    packer.destroy();
    stage.destroy();
  });
});
