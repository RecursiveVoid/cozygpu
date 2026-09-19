/**
 * M2.5 review: `PickHit.userId` end to end (ARCHITECTURE §19.3). The pick
 * texel (objectId, instance + 1, userId, 0) read back by the core picking
 * module is posted as a `pick` message and resolved by the front client:
 * a Swarm hit reports the texel's instance user id, a sprite hit reports
 * `node.userId` (also when written by `bindColumns`), a miss resolves null.
 * Worker mode is modelled by structured-cloning each posted message.
 */
import type { RenderPass } from '../backend/types';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { FakeFrame } from '../sprites/fakes.testutil';
import { Swarm } from '../swarm/Swarm';
import type {
  CoreContext,
  CoreFrameState,
  CorePicking,
  PickClient,
  PickReplay,
} from '../types/core';
import {
  PICK_TEXEL_INSTANCE,
  PICK_TEXEL_OBJECT,
  PICK_TEXEL_USER,
} from '../types/layouts';
import type { PickHit } from '../types/renderer';
import type { CoreMessage } from '../types/transport';
import { createPickClient } from './picking';
import { createCorePickingNow } from './pickingCoreImpl';
import { pickPipelinesPending } from './pickingPipelines';
import { FakeBackend } from './testing/fakeBackend';

type PickMessage = Extract<CoreMessage, { type: 'pick' }>;

const coreFrame: CoreFrameState = {
  frameId: 1,
  time: 0,
  dt: 0.016,
  pixelWidth: 100,
  pixelHeight: 100,
  cssWidth: 100,
  cssHeight: 100,
  resolution: 1,
};

const replay: PickReplay = {
  drawCount: 1,
  drawPick(_index: number, _pass: RenderPass): void {},
};

/**
 * A core picking module wired to a front pick client through `post`, like
 * the local transport (the reused message object) or the worker transport
 * (a structured clone per message).
 */
function wire(stage: Container, worker: boolean) {
  const backend = new FakeBackend();
  const client: PickClient = createPickClient({ stage });
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
    post: (m: CoreMessage) => {
      const msg = (worker ? structuredClone(m) : m) as PickMessage;
      client.handleMessage(msg);
    },
  };
  const core: CorePicking = createCorePickingNow(ctx, pickPipelinesPending);
  const frame = new FakeFrame();

  /** One pick through the whole path; `texel` is what the GPU wrote. */
  async function pick(texel: number[]): Promise<PickHit | null> {
    const promise = client.pick(3, 4);
    client.encode(frame.next());
    const cmd = frame.encoder.commands()[0];
    core.request(cmd.words[0], 3, 4);
    core.render(backend.beginCommands(), replay, coreFrame);
    const words = new Uint32Array(4);
    words[PICK_TEXEL_OBJECT] = texel[0];
    words[PICK_TEXEL_INSTANCE] = texel[1];
    words[PICK_TEXEL_USER] = texel[2];
    backend.nextTextureRead = new Uint8Array(words.buffer);
    core.poll!();
    return promise;
  }
  return { pick, core };
}

describe.each([
  ['local', false],
  ['worker (structured clone)', true],
])('PickHit.userId round trip, %s', (_name, worker) => {
  it('a Swarm hit reports the instance user id from the texel (full u32 range)', async () => {
    const stage = new Container();
    const swarm = stage.addChild(new Swarm({ capacity: 16 }));
    swarm.userId = 5; // the node's own id must not leak into instance hits
    const { pick } = wire(stage, worker);

    await expect(pick([swarm.id, 7 + 1, 0xffffffff])).resolves.toEqual({
      node: swarm,
      instance: 7,
      userId: 0xffffffff,
      x: 3,
      y: 4,
    });
    await expect(pick([swarm.id, 0 + 1, 0x80000000])).resolves.toMatchObject({
      instance: 0,
      userId: 0x80000000,
    });
    await expect(pick([swarm.id, 16, 0])).resolves.toMatchObject({
      instance: 15,
      userId: 0,
    });
    swarm.destroy();
  });

  it('a sprite hit reports node.userId, never the texel word', async () => {
    const stage = new Container();
    const sprite = stage.addChild(new Sprite({ userId: 0xfffffffe }));
    const { pick } = wire(stage, worker);
    await expect(pick([sprite.id, 0, 1234])).resolves.toEqual({
      node: sprite,
      instance: -1,
      userId: 0xfffffffe,
      x: 3,
      y: 4,
    });
  });

  it('a sprite id written by bindColumns comes back from pick', async () => {
    const stage = new Container();
    const layer = stage.addChild(new Container());
    for (let i = 0; i < 4; i++) layer.addChild(new Sprite());
    const entity = new Uint32Array([10, 20, 30, 0xffffffff]);
    const binding = layer.bindColumns({
      x: new Float32Array(4),
      y: new Float32Array(4),
      userId: entity,
    });
    binding.commit(4);
    const { pick } = wire(stage, worker);
    for (let i = 0; i < 4; i++) {
      const hit = await pick([layer.children[i].id, 0, 0]);
      expect(hit?.userId).toBe(entity[i]);
    }
    // A swap-remove: the next commit rewrites row 1 with the moved entity.
    entity[1] = entity[3];
    layer.removeChild(layer.children[3]);
    binding.commit(3);
    const hit = await pick([layer.children[1].id, 0, 0]);
    expect(hit?.userId).toBe(0xffffffff);
  });

  it('a miss (object 0) resolves null even when other texel words are set', async () => {
    const stage = new Container();
    stage.addChild(new Sprite({ userId: 9 }));
    const { pick } = wire(stage, worker);
    await expect(pick([0, 3, 77])).resolves.toBeNull();
  });

  it('a hit on a node that left the stage resolves null', async () => {
    const stage = new Container();
    const sprite = stage.addChild(new Sprite({ userId: 9 }));
    const { pick } = wire(stage, worker);
    stage.removeChild(sprite);
    await expect(pick([sprite.id, 0, 9])).resolves.toBeNull();
    sprite.destroy();
  });
});

describe('pick message without userId (older core)', () => {
  it('a Swarm hit falls back to userId 0', async () => {
    const stage = new Container();
    const swarm = stage.addChild(new Swarm({ capacity: 4 }));
    const client = createPickClient({ stage });
    const frame = new FakeFrame();
    const promise = client.pick(0, 0);
    client.encode(frame.next());
    client.handleMessage({
      type: 'pick',
      requestId: frame.encoder.commands()[0].words[0],
      objectId: swarm.id,
      instance: 2,
    });
    await expect(promise).resolves.toMatchObject({ instance: 2, userId: 0 });
    swarm.destroy();
  });
});
