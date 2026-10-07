/**
 * Retained rendering, stale-cache review: what a replayed segment or a
 * static bake must notice. Each case compares the retained output with what
 * the immediate path (or a fresh bake) would draw. `it.failing` marks known
 * defects: each documents the expected behaviour.
 */
import { CommandFlag, Op, OpcodeRange } from '../commands/opcodes';
import { GfxOp } from '../commands/gfxOpcodes';
import { RetainOp } from '../commands/retainOpcodes';
import { Graphics, loadGraphics } from '../graphics/Graphics';
import type { Recorded } from '../graphics/frame.testutil';
import { TestFrame } from '../graphics/frame.testutil';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { SpriteScenePacker, loadSegments } from '../sprites/front';
import { NO_ID } from '../types/ids';

beforeAll(async () => {
  await Promise.all([loadSegments(), loadGraphics('all')]);
});

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
/** Commands that write Graphics records (shape uploads, pool uploads). */
function recordWrites(list: Recorded[]): Recorded[] {
  return list.filter(
    c =>
      c.opcode === GfxOp.GFX_SHAPE_UPLOAD ||
      c.opcode === GfxOp.GFX_POOL_UPLOAD ||
      c.opcode === GfxOp.GFX_POOL_UPLOAD_SHARED,
  );
}

let nextRenderer = 0;

function packerFor(stage: Container, retained = true) {
  const packer = new SpriteScenePacker();
  packer.retained = retained;
  const frame = new Frame();
  frame.rendererId = 2600 + nextRenderer++;
  const pack = (): Recorded[] => {
    packer.pack(stage, frame);
    return frame.end();
  };
  return { packer, frame, pack };
}

/** Eight sprites (so the packer loads segments) and two Graphics. */
async function flatScene() {
  const stage = new Container();
  const tex = Texture.fromPixels(4, 4, pixels());
  const other = Texture.fromPixels(4, 4, pixels());
  const sprites: Sprite[] = [];
  for (let i = 0; i < 8; i++) {
    sprites.push(stage.addChild(new Sprite({ texture: tex, x: i })));
  }
  const shapes: Graphics[] = [];
  for (let i = 0; i < 2; i++) {
    shapes.push(
      stage.addChild(
        new Graphics({ x: i * 10 }).circle(0, 0, 4).fill(0xff0000),
      ),
    );
  }
  await Promise.all(shapes.map(g => g.ready));
  return { stage, tex, other, sprites, shapes };
}

async function staticScene() {
  const stage = new Container();
  const map = new Container({ static: true, x: 100 });
  const tex = Texture.fromPixels(4, 4, pixels());
  const sprites: Sprite[] = [];
  for (let i = 0; i < 3; i++) {
    sprites.push(map.addChild(new Sprite({ texture: tex, x: i * 10 })));
  }
  const shape = map.addChild(new Graphics().rect(0, 0, 4, 4).fill(0xff0000));
  stage.addChild(map);
  await shape.ready;
  await baked(map);
  return { stage, map, tex, sprites, shape, ...packerFor(stage) };
}

describe('retained segments: stale caches', () => {
  it('a sprite texture swap to another source re-records', async () => {
    const s = await flatScene();
    const { pack } = packerFor(s.stage);
    pack();
    expect(draws(pack())).toEqual([RetainOp.RETAIN_DRAW]);
    for (const sp of s.sprites) sp.texture = s.other;
    const out = pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, Op.SPRITE_DRAW)[0].words[3]).toBe(s.other.sourceId);
    expect(draws(pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('a sprite frame change within the same source only uploads', async () => {
    const s = await flatScene();
    const { pack } = packerFor(s.stage);
    pack();
    pack();
    const sub = s.tex.sub(0, 0, 2, 2);
    s.sprites[2].texture = sub;
    const out = pack();
    expect(draws(out)).toEqual([RetainOp.RETAIN_DRAW]);
    expect(only(out, Op.SPRITE_UPLOAD).length).toBe(1);
  });

  it('a blend mode change splits the batch and re-records', async () => {
    const s = await flatScene();
    const { pack } = packerFor(s.stage);
    pack();
    pack();
    s.sprites[7].blendMode = 'add';
    const out = pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, Op.SPRITE_DRAW).map(c => c.words[4])).toHaveLength(2);
  });

  it('hiding and showing a sprite re-records both times', async () => {
    const s = await flatScene();
    const { pack } = packerFor(s.stage);
    pack();
    pack();
    s.sprites[3].visible = false;
    let out = pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    const hidden = only(out, Op.SPRITE_DRAW)[0].words[2];
    s.sprites[3].visible = true;
    out = pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, Op.SPRITE_DRAW)[0].words[2]).toBe(hidden + 1);
  });

  it('removing and re-adding a Graphics frees and re-records', async () => {
    const s = await flatScene();
    const { pack } = packerFor(s.stage);
    const first = pack();
    const id = only(first, RetainOp.RETAIN_BEGIN)[0].words[0];
    s.shapes[1].removeFromParent();
    let out = pack();
    expect(only(out, RetainOp.RETAIN_DESTROY).map(c => c.words[0])).toEqual([
      id,
    ]);
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(6);
    s.stage.addChild(s.shapes[1]);
    out = pack();
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(12);
    expect(draws(pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('a different stage re-partitions', async () => {
    const a = await flatScene();
    const b = await flatScene();
    const packer = new SpriteScenePacker();
    const frame = new Frame();
    frame.rendererId = 2600 + nextRenderer++;
    packer.pack(a.stage, frame);
    frame.end();
    packer.pack(a.stage, frame);
    frame.end();
    packer.pack(b.stage, frame);
    const out = frame.end();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, RetainOp.RETAIN_DESTROY).length).toBeGreaterThan(0);
  });

  it('a texture destroyed under a clean segment stops drawing like the immediate path', async () => {
    // Immediate path: the destroyed source draws as NO_ID from the next
    // frame on. A clean segment replays its recorded texId, which the
    // texture registry may hand to a new texture once it is freed.
    const s = await flatScene();
    const { pack } = packerFor(s.stage);
    pack();
    pack();
    s.tex.destroy();
    const out = pack();
    const ids = only(out, Op.SPRITE_DRAW).map(c => c.words[3]);
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(ids).toContain(NO_ID);
  });

  it('a resolution change re-tessellates curved Graphics on a clean frame', async () => {
    // Immediate path: pack() sees the larger scale bucket and
    // re-tessellates. A clean retained frame visits no node, and
    // `renderer.resize(w, h, resolution)` bumps neither touch nor
    // drawEpoch, so the coarse mesh stays.
    const build = async (retained: boolean) => {
      const stage = new Container();
      const tex = Texture.fromPixels(4, 4, pixels());
      for (let i = 0; i < 8; i++) stage.addChild(new Sprite(tex));
      const g = stage.addChild(
        new Graphics()
          .moveTo(0, 0)
          .bezierCurveTo(50, -40, 100, 40, 150, 0)
          .stroke({ width: 3, color: 0xffffff }),
      );
      await g.ready;
      const p = packerFor(stage, retained);
      p.pack();
      p.pack();
      await tick();
      p.pack();
      p.pack();
      p.frame.resolution = 8;
      // Two frames: a deferred re-tessellation lands on the second.
      const out = [...p.pack(), ...p.pack()];
      return recordWrites(out).length + only(out, GfxOp.GFX_MESH_UPLOAD).length;
    };
    const immediate = await build(false);
    expect(immediate).toBeGreaterThan(0);
    expect(await build(true)).toBeGreaterThan(0);
  });
});

describe('static bakes: stale caches', () => {
  it('moving a baked sprite re-bakes; moving the container does not', async () => {
    const s = await staticScene();
    s.pack();
    s.sprites[0].x = 5;
    expect(draws(s.pack())).toContain(RetainOp.RETAIN_BEGIN);
    s.map.y = 9;
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('a baked sprite tint or texture swap re-bakes', async () => {
    const s = await staticScene();
    s.pack();
    s.sprites[1].tint = 0x00ff00;
    expect(draws(s.pack())).toContain(RetainOp.RETAIN_BEGIN);
    s.sprites[1].texture = Texture.fromPixels(4, 4, pixels());
    const out = s.pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, GfxOp.GFX_SET_TEXTURE_SLOTS)[0].words[1]).toBe(2);
  });

  it('a Graphics blend change inside re-bakes', async () => {
    const s = await staticScene();
    s.pack();
    s.shape.blendMode = 'add';
    expect(draws(s.pack())).toContain(RetainOp.RETAIN_BEGIN);
  });

  it('hiding a baked child re-bakes without it', async () => {
    const s = await staticScene();
    s.pack();
    s.sprites[2].visible = false;
    const out = s.pack();
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(3 * 6);
  });

  it('a child of a nested plain container re-bakes the static one', async () => {
    const s = await staticScene();
    const inner = s.map.addChild(new Container());
    s.pack();
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
    inner.addChild(new Sprite(s.tex));
    expect(only(s.pack(), GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(5 * 6);
  });

  it('a Graphics tint change inside re-bakes (or rewrites its records)', async () => {
    // Graphics.tint only bumps nodeStore.drawEpoch; the bake compares
    // `_drawVersion`, which covers context, blend and sharing but not tint,
    // so the baked fill keeps the old color.
    const s = await staticScene();
    s.pack();
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
    s.shape.tint = 0x00ff00;
    const out = s.pack();
    expect(recordWrites(out).length).toBeGreaterThan(0);
  });

  it('removing the Group that blocked the bake bakes again', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await staticScene();
    const group = Object.assign(new Container(), {
      _emitGroupBegin: () => true,
      _emitGroupEnd: () => {},
    });
    s.map.addChild(group);
    s.pack();
    s.pack();
    group.removeFromParent();
    s.pack();
    await tick();
    s.pack();
    warn.mockRestore();
    expect(s.map._sbLeaf).toBe(true);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('the frame a bake gives up still draws the container', async () => {
    // The container is a leaf in this frame's batch list, so its subtree
    // has no batches: the bake draws its last result once more, and the
    // packer walks the subtree from the next frame on.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await staticScene();
    s.pack();
    s.map.addChild(
      Object.assign(new Container(), {
        _emitGroupBegin: () => true,
        _emitGroupEnd: () => {},
      }),
    );
    const out = s.pack();
    expect(draws(out)).toEqual([RetainOp.RETAIN_DRAW]);
    expect(only(s.pack(), Op.SPRITE_DRAW).length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('zooming a static container re-tessellates its curved Graphics', async () => {
    // The bake tessellates with the transform relative to the container;
    // its world scale only reaches the transform slot, so a curve baked
    // at scale 1 stays coarse when the container (a map, a camera) zooms.
    const build = async (isStatic: boolean) => {
      const stage = new Container();
      const map = stage.addChild(new Container({ static: isStatic }));
      const g = map.addChild(
        new Graphics()
          .moveTo(0, 0)
          .bezierCurveTo(50, -40, 100, 40, 150, 0)
          .stroke({ width: 3, color: 0xffffff }),
      );
      await g.ready;
      if (isStatic) await baked(map);
      const p = packerFor(stage);
      p.pack();
      await tick();
      p.pack();
      p.pack();
      map.setScale(16);
      const out = [...p.pack(), ...p.pack()];
      return recordWrites(out).length + only(out, GfxOp.GFX_MESH_UPLOAD).length;
    };
    expect(await build(false)).toBeGreaterThan(0);
    expect(await build(true)).toBeGreaterThan(0);
  });

  it('a new generation re-bakes; textures are re-uploaded', async () => {
    const s = await staticScene();
    s.pack();
    s.frame.generation++;
    const out = s.pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, Op.TEXTURE_CREATE).length).toBe(1);
  });
});
