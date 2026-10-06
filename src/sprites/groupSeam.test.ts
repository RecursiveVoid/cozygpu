/**
 * The render-group seam in the scene packer (ARCHITECTURE §21.4): a group is
 * a batch boundary with children, and a begin that answers false takes its
 * whole subtree out of the frame.
 */
import { Op } from '../commands/opcodes';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { nodeStore } from '../scene/store';
import type { FrontFrame, RenderGroup } from '../types/core';
import { FakeFrame } from './fakes.testutil';
import { SpriteScenePacker } from './front';

const white = () =>
  Texture.fromPixels(2, 2, new Uint8Array(2 * 2 * 4).fill(255));

/** A Container that records the seam calls the packer makes on it. */
class FakeGroup extends Container implements RenderGroup {
  readonly log: string[] = [];
  drawable = true;
  worldX = NaN;

  _emitGroupBegin(
    _frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): boolean {
    this.log.push(`begin:${world[worldOffset + 4]}:${worldAlpha}`);
    this.worldX = world[worldOffset + 4];
    return this.drawable;
  }

  _emitGroupEnd(): void {
    this.log.push('end');
  }
}

/** SPRITE_DRAW instance counts, in draw order, interleaved with seam calls. */
function drawSizes(frame: FakeFrame): number[] {
  const out: number[] = [];
  for (const c of frame.encoder.commands()) {
    if (c.opcode === Op.SPRITE_DRAW) out.push(c.words[2]);
  }
  return out;
}

function stageWith(group: FakeGroup, inside: number, after: number) {
  const tex = white();
  const stage = new Container();
  stage.addChild(new Sprite({ texture: tex }));
  for (let i = 0; i < inside; i++) group.addChild(new Sprite({ texture: tex }));
  stage.addChild(group);
  for (let i = 0; i < after; i++) stage.addChild(new Sprite({ texture: tex }));
  return stage;
}

describe('render-group seam', () => {
  it('ends the batch on both sides and calls begin/end around the subtree', () => {
    const group = new FakeGroup();
    const stage = stageWith(group, 3, 2);
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame as unknown as FrontFrame);

    // One batch before, one inside, one after: the group is never merged in.
    expect(drawSizes(frame)).toEqual([1, 3, 2]);
    expect(group.log).toEqual(['begin:0:1', 'end']);
    packer.destroy();
    stage.destroy({ children: true });
  });

  it('passes the group its own world transform and world alpha', () => {
    const group = new FakeGroup();
    const stage = stageWith(group, 1, 0);
    stage.alpha = 0.5;
    group.x = 40;
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame as unknown as FrontFrame);
    expect(group.worldX).toBe(40);
    expect(group.log[0]).toBe('begin:40:0.5');
    packer.destroy();
    stage.destroy({ children: true });
  });

  it('skips the whole subtree, and only it, when begin answers false', () => {
    const group = new FakeGroup();
    group.drawable = false;
    const stage = stageWith(group, 3, 2);
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame as unknown as FrontFrame);

    expect(drawSizes(frame)).toEqual([1, 2]);
    expect(group.log).toEqual(['begin:0:1']); // no end for a skipped group
    packer.destroy();
    stage.destroy({ children: true });
  });

  it('nests: an inner group is skipped with its outer one', () => {
    const outer = new FakeGroup();
    const inner = new FakeGroup();
    const tex = white();
    const stage = new Container();
    inner.addChild(new Sprite({ texture: tex }));
    outer.addChild(new Sprite({ texture: tex }));
    outer.addChild(inner);
    stage.addChild(outer);
    stage.addChild(new Sprite({ texture: tex }));

    const packer = new SpriteScenePacker();
    packer.pack(stage, new FakeFrame() as unknown as FrontFrame);
    expect(outer.log).toEqual(['begin:0:1', 'end']);
    expect(inner.log).toEqual(['begin:0:1', 'end']);

    outer.log.length = 0;
    inner.log.length = 0;
    outer.drawable = false;
    const frame = new FakeFrame();
    packer.pack(stage, frame as unknown as FrontFrame);
    // Only the sprite after the outer group is drawn.
    expect(drawSizes(frame)).toEqual([1]);
    expect(outer.log).toEqual(['begin:0:1']);
    expect(inner.log).toEqual([]);
    packer.destroy();
    stage.destroy({ children: true });
  });

  it('a live group keeps the packer on full rebuilds', async () => {
    const group = new FakeGroup();
    const stage = stageWith(group, 1, 1);
    const packer = new SpriteScenePacker();
    packer.pack(stage, new FakeFrame() as unknown as FrontFrame);
    const { loadPatcher } = await import('./front');
    await loadPatcher();

    const rebuilds = packer.rebuildCount;
    const patches = packer.patchCount;
    // nodeStore.groups is what the packer reads; FakeGroup is not a Group.
    nodeStore.groups++;
    stage.addChild(new Sprite({ texture: white() }));
    packer.pack(stage, new FakeFrame() as unknown as FrontFrame);
    nodeStore.groups--;
    expect(packer.patchCount).toBe(patches);
    expect(packer.rebuildCount).toBe(rebuilds + 1);
    packer.destroy();
    stage.destroy({ children: true });
  });
});
