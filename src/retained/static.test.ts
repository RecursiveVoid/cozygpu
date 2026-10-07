/**
 * Static containers (ARCHITECTURE §27.5): the packer leaf, the bake (baked
 * sprite records, Graphics through their bake path, texture slot tables,
 * holes), change detection by scope, the transform slot, replay as retained
 * segments or as plain commands, and turning `static` off again.
 */
import { CommandFlag, Op, OpcodeRange } from '../commands/opcodes';
import { GfxOp, GfxPoolKind } from '../commands/gfxOpcodes';
import { RetainOp } from '../commands/retainOpcodes';
import { Graphics, loadGraphics } from '../graphics/Graphics';
import type { Recorded } from '../graphics/frame.testutil';
import { TestFrame } from '../graphics/frame.testutil';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { nodeStore } from '../scene/store';
import { BulkField } from '../scene/types';
import { SpriteScenePacker, loadSegments } from '../sprites/front';
import type { FrontFrame } from '../types/core';
import {
  GFX_ITEM_KIND_SHIFT,
  GFX_SPRITE_SLOT_SHIFT,
  GfxItemKind,
} from '../types/gfxLayouts';
import { SI_PICK_SHIFT, SPRITE_INSTANCE_BYTES } from '../types/layouts';

beforeAll(async () => {
  await Promise.all([loadSegments(), loadGraphics('all')]);
});

const VOLATILE_DRAW = 0x0310;

class Volatile extends Container {
  worlds: number[][] = [];
  _emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    offset: number,
    alpha: number,
  ): void {
    this.worlds.push([world[offset + 4], world[offset + 5], alpha]);
    frame.encoder.begin(VOLATILE_DRAW, 4, CommandFlag.DRAW);
    frame.encoder.u32(this.id);
    frame.encoder.end();
  }
}

/** A frame whose retain core can be "not loaded yet". */
class Frame extends TestFrame {
  retain = true;
  override isSystemReady(range?: number): boolean {
    return range === OpcodeRange.RETAIN ? this.retain : this.ready;
  }
}

const pixels = (): Uint8Array => new Uint8Array(4 * 4 * 4).fill(255);
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function baked(c: Container): Promise<void> {
  for (let i = 0; i < 50 && !c._sbLeaf; i++) await tick();
  expect(c._sbLeaf).toBe(true);
}

function draws(list: Recorded[]): number[] {
  return list.filter(c => c.flags & CommandFlag.DRAW).map(c => c.opcode);
}
function only(list: Recorded[], opcode: number): Recorded[] {
  return list.filter(c => c.opcode === opcode);
}
function pool(list: Recorded[], kind: number): Recorded[] {
  return only(list, GfxOp.GFX_POOL_UPLOAD).filter(c => c.words[0] === kind);
}

let nextRenderer = 0;

async function scene(options: { hole?: boolean } = {}) {
  const stage = new Container();
  const map = new Container({ static: true, x: 100, y: 50 });
  const a = Texture.fromPixels(4, 4, pixels());
  const b = Texture.fromPixels(4, 4, pixels());
  const sprites: Sprite[] = [];
  for (let i = 0; i < 4; i++) {
    sprites.push(
      map.addChild(new Sprite({ texture: i < 2 ? a : b, x: i * 10, y: 5 })),
    );
  }
  const shape = map.addChild(new Graphics().rect(0, 0, 4, 4).fill(0xff0000));
  const hole = options.hole ? map.addChild(new Volatile({ x: 7 })) : null;
  const tail = map.addChild(new Sprite({ texture: a, x: 99 }));
  stage.addChild(map);
  await shape.ready;
  await baked(map);
  const packer = new SpriteScenePacker();
  const frame = new Frame();
  frame.rendererId = 1800 + nextRenderer++;
  const pack = (): Recorded[] => {
    packer.pack(stage, frame);
    return frame.end();
  };
  return { stage, map, sprites, shape, hole, tail, packer, frame, pack };
}

describe('static containers', () => {
  it('bake once: baked sprites and Graphics in one unified draw, then a replay', async () => {
    const s = await scene();
    const first = s.pack();
    // No sprite draws: the subtree is not in the packer's list.
    expect(only(first, Op.SPRITE_DRAW)).toEqual([]);
    expect(draws(first)).toEqual([
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    const draw = only(first, GfxOp.GFX_DRAW_UNIFIED)[0].words;
    // 5 sprites + 1 rect, six items each, through transform slot 1+.
    expect(draw[2]).toBe(6 * 6);
    expect(draw[8]).toBeGreaterThan(0);
    // The container's world goes to the transform slot.
    const xf = only(first, GfxOp.GFX_SET_TRANSFORM)[0];
    expect(xf.words[0]).toBe(draw[8]);
    expect(xf.floats.slice(1, 8)).toEqual([1, 0, 0, 1, 100, 50, 1]);
    // Two textures: one slot table.
    const slots = only(first, GfxOp.GFX_SET_TEXTURE_SLOTS);
    expect(slots.map(c => c.words[1])).toEqual([2]);
    expect(draw[7]).toBe(slots[0].words[0]);
    // Baked sprite records: relative transforms, slot bits, pick id.
    const up = pool(first, GfxPoolKind.SPRITES)[0];
    const f = new Float32Array(up.bytes.buffer, up.bytes.byteOffset + 16);
    const u = new Uint32Array(up.bytes.buffer, up.bytes.byteOffset + 16);
    const per = SPRITE_INSTANCE_BYTES / 4;
    expect([f[4], f[5]]).toEqual([0, 5]);
    expect([f[per * 2 + 4], f[per * 2 + 5]]).toEqual([20, 5]);
    expect((u[9] >>> GFX_SPRITE_SLOT_SHIFT) & 7).toBe(0);
    expect((u[per * 2 + 9] >>> GFX_SPRITE_SLOT_SHIFT) & 7).toBe(1);
    expect(u[9] >>> SI_PICK_SHIFT).toBe(
      s.sprites[0].pickable ? s.sprites[0].id : 0,
    );
    // SPRITE items, then the rect's SHAPE items (tree order).
    const items = pool(first, GfxPoolKind.ITEMS)[0].words.slice(4);
    expect(items[0] >>> GFX_ITEM_KIND_SHIFT).toBe(GfxItemKind.SPRITE);
    expect(items[24] >>> GFX_ITEM_KIND_SHIFT).toBe(GfxItemKind.SHAPE);
    expect(items[30] >>> GFX_ITEM_KIND_SHIFT).toBe(GfxItemKind.SPRITE);

    // Idle: one replay, nothing else.
    expect(s.pack().map(c => c.opcode)).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('moving or fading the container rewrites the transform slot only', async () => {
    const s = await scene();
    s.pack();
    s.map.x = 140;
    s.map.alpha = 0.5;
    const out = s.pack();
    expect(out.map(c => c.opcode)).toEqual([
      GfxOp.GFX_SET_TRANSFORM,
      RetainOp.RETAIN_DRAW,
    ]);
    expect(out[0].floats.slice(5, 8)).toEqual([140, 50, 0.5]);
  });

  it('any change inside re-bakes: a moved sprite, a Graphics edit, a new child', async () => {
    const s = await scene();
    s.pack();
    s.sprites[1].x = 33;
    let out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    expect(pool(out, GfxPoolKind.SPRITES).length).toBe(1);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
    // A context edit touches no node: the draw epoch catches it.
    s.shape.circle(10, 10, 3).fill(0);
    out = s.pack();
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(7 * 6);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
    s.map.addChild(new Sprite({ texture: s.sprites[0].texture }));
    out = s.pack();
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(8 * 6);
    // Edits elsewhere never re-bake it.
    s.stage.addChild(new Sprite({ texture: s.sprites[0].texture }));
    out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_DRAW,
      RetainOp.RETAIN_BEGIN,
      Op.SPRITE_DRAW,
      RetainOp.RETAIN_END,
    ]);
  });

  it('a bulk commit inside re-bakes it', async () => {
    const s = await scene();
    s.pack();
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
    const bulk = s.map.bulkChildren(BulkField.POSITION);
    bulk.position[2] = 55;
    bulk.commit(BulkField.POSITION, 1, 1);
    expect(draws(s.pack())).toEqual([
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('a removed child stops touching the container', async () => {
    const s = await scene();
    s.pack();
    const moved = s.sprites[3];
    s.stage.addChild(moved); // leaves the static container
    const rebake = s.pack();
    expect(draws(rebake).slice(0, 3)).toEqual([
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    const touch = nodeStore.scopeTouch![s.map._scopeId!];
    moved.x = 77;
    expect(nodeStore.scopeTouch![s.map._scopeId!]).toBe(touch);
    expect(draws(s.pack())[0]).toBe(RetainOp.RETAIN_DRAW);
  });

  it('holes are drawn live in their place with container × relative world', async () => {
    const s = await scene({ hole: true });
    let out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
      VOLATILE_DRAW,
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    s.map.x = 0;
    out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_DRAW,
      VOLATILE_DRAW,
      RetainOp.RETAIN_DRAW,
    ]);
    expect(s.hole!.worlds.map(w => w[0])).toEqual([107, 7]);
  });

  it('without the retain core the baked draws are re-emitted every frame', async () => {
    const s = await scene();
    s.frame.retain = false;
    const first = s.pack();
    expect(draws(first)).toEqual([GfxOp.GFX_DRAW_UNIFIED]);
    const again = s.pack();
    expect(again.map(c => c.opcode)).toEqual([GfxOp.GFX_DRAW_UNIFIED]);
    expect(again[0].words).toEqual(
      only(first, GfxOp.GFX_DRAW_UNIFIED)[0].words,
    );
    // The core lands: the next frame records, then replays.
    s.frame.retain = true;
    expect(draws(s.pack())).toEqual([
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('a new generation re-bakes and re-sends the transform', async () => {
    const s = await scene();
    s.pack();
    s.frame.generation++;
    const out = s.pack();
    expect(only(out, GfxOp.GFX_SET_TRANSFORM).length).toBe(1);
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
  });

  it('static = false draws the subtree normally and frees the segment', async () => {
    const s = await scene();
    s.pack();
    s.map.static = false;
    await tick(); // the static chunk applies it
    const out = s.pack();
    expect(only(out, Op.SPRITE_DRAW).length).toBeGreaterThan(0);
    expect(only(out, RetainOp.RETAIN_DESTROY).length).toBe(1);
    expect(s.map._sbLeaf).toBe(false);
  });

  it('a static container inside another folds into it', async () => {
    const stage = new Container();
    const outer = new Container({ static: true });
    const inner = new Container({ static: true, x: 5 });
    const tex = Texture.fromPixels(4, 4, pixels());
    inner.addChild(new Sprite({ texture: tex }));
    outer.addChild(new Sprite({ texture: tex }));
    outer.addChild(inner);
    stage.addChild(outer);
    await baked(outer);
    await baked(inner);
    const packer = new SpriteScenePacker();
    const frame = new Frame();
    frame.rendererId = 1800 + nextRenderer++;
    const pack = (): Recorded[] => {
      packer.pack(stage, frame);
      return frame.end();
    };
    let out = pack();
    // One bake holds both sprites.
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED).map(c => c.words[2])).toEqual([
      12,
    ]);
    // The inner container's own bake takes over when the outer stops.
    outer.static = false;
    await tick();
    out = pack();
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED).map(c => c.words[2])).toEqual([6]);
    expect(only(out, Op.SPRITE_DRAW).length).toBe(1);
    expect(draws(pack())).toEqual([RetainOp.RETAIN_DRAW, RetainOp.RETAIN_DRAW]);
  });

  it('a Group inside makes the container draw unbaked, with one warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await scene();
    const group = Object.assign(new Container(), {
      _emitGroupBegin: () => true,
      _emitGroupEnd: () => {},
    });
    s.map.addChild(group);
    s.pack(); // the bake finds the group and gives up
    const out = s.pack();
    expect(only(out, Op.SPRITE_DRAW).length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('static containers: drawables with a `_binding`', () => {
  async function layerScene(bound: boolean) {
    const front = await import('../layer/front');
    const { SpriteLayer } = await import('../layer/SpriteLayer');
    const stage = new Container();
    const map = stage.addChild(new Container({ static: true }));
    const tex = Texture.fromPixels(4, 4, pixels());
    map.addChild(new Sprite(tex));
    const layer = new SpriteLayer({ capacity: 4, frames: [tex] });
    layer._front = front;
    for (let i = 0; i < 4; i++) layer.setInstance(i, 50 + i * 80, 150);
    layer.count = 4;
    if (bound) layer.bindColumns({ xy: new Float32Array(8) }).commit(4);
    map.addChild(layer);
    await baked(map);
    const packer = new SpriteScenePacker();
    const frame = new Frame();
    frame.caps = { ...frame.caps, vertexStorage: true };
    frame.rendererId = 1900 + nextRenderer++;
    const pack = (): Recorded[] => {
      packer.pack(stage, frame);
      return frame.end();
    };
    return { layer, pack };
  }

  for (const bound of [false, true]) {
    it(`a SpriteLayer inside is drawn live, bake kept${bound ? ' (bound columns)' : ''}`, async () => {
      const { LayerOp } = await import('../commands/layerOpcodes');
      const s = await layerScene(bound);
      s.pack();
      const out = s.pack();
      expect(only(out, LayerOp.LAYER_DRAW).length).toBe(1);
      // The sibling sprite stays baked: replayed, not re-baked.
      expect(draws(out)).toEqual([RetainOp.RETAIN_DRAW, LayerOp.LAYER_DRAW]);
    });
  }
});

describe('static containers: segment ids', () => {
  it('a re-bake with fewer parts destroys the segments it no longer uses', async () => {
    const s = await scene({ hole: true });
    const first = s.pack();
    // Baked run, the hole, baked run.
    expect(only(first, RetainOp.RETAIN_BEGIN).length).toBe(2);
    const ids = only(first, RetainOp.RETAIN_BEGIN).map(c => c.words[0]);
    s.hole!.removeFromParent();
    const out = s.pack();
    expect(only(out, RetainOp.RETAIN_BEGIN).map(c => c.words[0])).toEqual([
      ids[0],
    ]);
    expect(only(out, RetainOp.RETAIN_DESTROY).map(c => c.words[0])).toEqual([
      ids[1],
    ]);
  });
});
