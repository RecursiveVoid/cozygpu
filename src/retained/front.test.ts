/**
 * Retained segments, front half (ARCHITECTURE §27.2): partition of the
 * packer's batch list, clean / dirty detection (structure, touch, drawEpoch,
 * texture ids, `_drawVersion`), replay with `_syncDraw`, id reuse across
 * structure changes and RETAIN_DESTROY. Decoded from the real stream.
 */
import { CommandFlag, Op } from '../commands/opcodes';
import { GfxOp } from '../commands/gfxOpcodes';
import { RetainOp } from '../commands/retainOpcodes';
import { Graphics, loadGraphics } from '../graphics/Graphics';
import type { Recorded } from '../graphics/frame.testutil';
import { TestFrame } from '../graphics/frame.testutil';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { nodeStore } from '../scene/store';
import type { TextureHandle } from '../scene/types';
import { SpriteScenePacker, loadSegments } from '../sprites/front';
import type { FrontFrame } from '../types/core';
import { NO_ID } from '../types/ids';

beforeAll(async () => {
  await Promise.all([loadSegments(), loadGraphics('all')]);
});

const VOLATILE_DRAW = 0x0310;

/** A CustomDrawable without `_syncDraw`: drawn every frame (like a Swarm). */
class Volatile extends Container {
  draws = 0;
  _emitDraw(frame: FrontFrame): void {
    this.draws++;
    frame.encoder.begin(VOLATILE_DRAW, 4, CommandFlag.DRAW);
    frame.encoder.u32(this.id);
    frame.encoder.end();
  }
}

const pixels = (): Uint8Array => new Uint8Array(4 * 4 * 4).fill(255);

function draws(list: Recorded[]): number[] {
  return list.filter(c => c.flags & CommandFlag.DRAW).map(c => c.opcode);
}
function only(list: Recorded[], opcode: number): Recorded[] {
  return list.filter(c => c.opcode === opcode);
}

interface Scene {
  stage: Container;
  packer: SpriteScenePacker;
  frame: TestFrame;
  sprites: Sprite[];
  shapes: Graphics[];
  /** Packs one frame and returns its commands. */
  pack(): Recorded[];
}

/** Sprites on two textures (two batches) and Graphics, in one container. */
async function scene(): Promise<Scene> {
  const stage = new Container();
  const a = Texture.fromPixels(4, 4, pixels());
  const b = Texture.fromPixels(4, 4, pixels());
  const sprites: Sprite[] = [];
  for (let i = 0; i < 4; i++) {
    sprites.push(stage.addChild(new Sprite(i < 2 ? a : b)));
  }
  const shapes: Graphics[] = [];
  for (let i = 0; i < 3; i++) {
    const g = new Graphics({ x: i * 10 }).circle(0, 0, 4).fill(0xff0000);
    shapes.push(stage.addChild(g));
  }
  await Promise.all(shapes.map(g => g.ready));
  const packer = new SpriteScenePacker();
  const frame = new TestFrame();
  frame.rendererId = 900 + nextRenderer++;
  const pack = (): Recorded[] => {
    packer.pack(stage, frame);
    return frame.end();
  };
  return { stage, packer, frame, sprites, shapes, pack };
}
let nextRenderer = 0;

describe('retained segments', () => {
  it('records a segment once, then replays it with RETAIN_DRAW alone', async () => {
    const s = await scene();
    const first = s.pack();
    expect(draws(first)).toEqual([
      RetainOp.RETAIN_BEGIN,
      Op.SPRITE_DRAW,
      Op.SPRITE_DRAW,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    const id = only(first, RetainOp.RETAIN_BEGIN)[0].words[0];
    expect(only(first, RetainOp.RETAIN_END)[0].words[0]).toBe(id);
    const sync = jest.spyOn(s.shapes[0], '_syncDraw');
    // A clean frame: nothing but the replay, no node visited.
    const second = s.pack();
    expect(second.map(c => c.opcode)).toEqual([RetainOp.RETAIN_DRAW]);
    expect(second[0].words[0]).toBe(id);
    expect(sync).not.toHaveBeenCalled();
  });

  it('moving a sprite uploads it; the recording stays', async () => {
    const s = await scene();
    s.pack();
    s.pack();
    s.sprites[1].x = 30;
    const out = s.pack();
    expect(draws(out)).toEqual([RetainOp.RETAIN_DRAW]);
    expect(only(out, Op.SPRITE_UPLOAD).length).toBe(1);
  });

  it('moving or tinting a Graphics syncs its records without re-recording', async () => {
    const s = await scene();
    s.pack();
    s.pack();
    const sync = jest.spyOn(s.shapes[1], '_syncDraw');
    s.shapes[1].x = 99;
    let out = s.pack();
    expect(draws(out)).toEqual([RetainOp.RETAIN_DRAW]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(only(out, GfxOp.GFX_SHAPE_UPLOAD).length).toBe(1);
    // A tint touches no node: the draw epoch makes the frame a checked one.
    s.shapes[2].tint = 0x00ff00;
    out = s.pack();
    expect(draws(out)).toEqual([RetainOp.RETAIN_DRAW]);
    expect(only(out, GfxOp.GFX_SHAPE_UPLOAD).length).toBe(1);
  });

  it('a context edit (no node touched) re-records the segment', async () => {
    const s = await scene();
    s.pack();
    s.pack();
    s.shapes[0].clear().rect(0, 0, 3, 3).fill(0x0000ff).circle(0, 0, 2).fill(0);
    const out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_BEGIN,
      Op.SPRITE_DRAW,
      Op.SPRITE_DRAW,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    // 2 + 1 + 1 shapes, 6 items each.
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(4 * 6);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('a volatile drawable splits segments and is drawn every frame', async () => {
    const s = await scene();
    const v = s.stage.addChildAt(new Volatile(), 2);
    let out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_BEGIN,
      Op.SPRITE_DRAW,
      RetainOp.RETAIN_END,
      VOLATILE_DRAW,
      RetainOp.RETAIN_BEGIN,
      Op.SPRITE_DRAW,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_DRAW,
      VOLATILE_DRAW,
      RetainOp.RETAIN_DRAW,
    ]);
    expect(v.draws).toBe(2);
  });

  it('a structure change keeps unchanged segments and frees vanished ones', async () => {
    const s = await scene();
    const v = s.stage.addChildAt(new Volatile(), 4); // sprites | v | graphics
    const first = s.pack();
    const [idA, idB] = only(first, RetainOp.RETAIN_BEGIN).map(c => c.words[0]);
    // Add a Graphics to the second segment: the first one is still clean.
    await s.stage.addChild(new Graphics().rect(0, 0, 1, 1).fill(0)).ready;
    let out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_DRAW,
      VOLATILE_DRAW,
      RetainOp.RETAIN_BEGIN,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    expect(only(out, RetainOp.RETAIN_DRAW)[0].words[0]).toBe(idA);
    const idB2 = only(out, RetainOp.RETAIN_BEGIN)[0].words[0];
    expect(only(out, RetainOp.RETAIN_DESTROY).map(c => c.words[0])).toEqual([
      idB,
    ]);
    // Without the divider the two runs become one new segment.
    v.removeFromParent();
    out = s.pack();
    expect(draws(out)).toEqual([
      RetainOp.RETAIN_BEGIN,
      Op.SPRITE_DRAW,
      Op.SPRITE_DRAW,
      GfxOp.GFX_DRAW_UNIFIED,
      RetainOp.RETAIN_END,
    ]);
    expect(
      only(out, RetainOp.RETAIN_DESTROY)
        .map(c => c.words[0])
        .sort(),
    ).toEqual([idA, idB2].sort());
  });

  it('a new generation (device loss) re-records every segment', async () => {
    const s = await scene();
    s.pack();
    s.pack();
    s.frame.generation++;
    expect(draws(s.pack())).toContain(RetainOp.RETAIN_BEGIN);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });

  it('textures that are not ready are polled even on clean frames', async () => {
    const s = await scene();
    const handle = {
      sourceId: NO_ID,
      sourceWidth: 4,
      sourceHeight: 4,
      frame: { x: 0, y: 0, width: 4, height: 4 },
      width: 4,
      height: 4,
    } as unknown as TextureHandle;
    s.sprites[3].texture = handle;
    s.pack();
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
    (handle as { sourceId: number }).sourceId = 77;
    const out = s.pack();
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, Op.SPRITE_DRAW).map(c => c.words[3])).toContain(77);
  });

  it('retained = false keeps the immediate path', async () => {
    const s = await scene();
    s.packer.retained = false;
    s.pack();
    expect(draws(s.pack())).toEqual([
      Op.SPRITE_DRAW,
      Op.SPRITE_DRAW,
      GfxOp.GFX_DRAW_UNIFIED,
    ]);
  });

  it('a Graphics still loading keeps its segment re-recording until it draws', async () => {
    const s = await scene();
    const g = new Graphics().rect(0, 0, 2, 2).fill(0);
    s.stage.addChild(g);
    // The binding is created asynchronously: the first frames draw it as
    // nothing, then the node's version and the draw epoch change.
    s.pack();
    await g.ready;
    const epoch = nodeStore.drawEpoch;
    const out = s.pack();
    expect(nodeStore.drawEpoch).toBeGreaterThanOrEqual(epoch);
    expect(draws(out)).toContain(RetainOp.RETAIN_BEGIN);
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED)[0].words[2]).toBe(4 * 6);
    expect(draws(s.pack())).toEqual([RetainOp.RETAIN_DRAW]);
  });
});
