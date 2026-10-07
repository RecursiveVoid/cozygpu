/**
 * The Graphics front (ARCHITECTURE §26.6): per-renderer arenas, change
 * detection, one upload per store per frame, draw coalescing across nodes,
 * shared meshes, device loss, masks and picking — decoded from the real
 * command stream.
 */
import { BlendModeId } from '../backend/types';
import { CommandFlag, Op } from '../commands/opcodes';
import { GfxDrawFlag, GfxOp } from '../commands/gfxOpcodes';
import { toPackedColor } from '../math/color';
import type { TextureHandle } from '../scene/types';
import { NO_ID } from '../types/ids';
import { SI_PICK_SHIFT } from '../types/layouts';
import {
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GN_COLOR,
  GN_FLAGS,
  GS_A,
  GS_FILL,
  GS_FLAGS,
} from '../types/gfxLayouts';
import { compile } from './compile';
import { createGraphicsBinding, loadTess } from './emit';
import type { Recorded } from './frame.testutil';
import { TestFrame } from './frame.testutil';
import { Graphics } from './Graphics';
import { GraphicsContext } from './GraphicsContext';
import type { GraphicsBinding } from './types';

beforeAll(async () => {
  await loadTess();
});

let nextRenderer = 100;
function frame(): TestFrame {
  const f = new TestFrame();
  f.rendererId = nextRenderer++;
  return f;
}

const W = new Float32Array(6 * 64);
function at(i: number, tx: number, ty: number, s = 1): number {
  W.set([s, 0, 0, s, tx, ty], i * 6);
  return i * 6;
}

interface Item {
  node: Graphics;
  binding: GraphicsBinding;
}
function node(ctx?: GraphicsContext, opts: Record<string, unknown> = {}): Item {
  const n = new Graphics({ context: ctx, ...opts });
  return { node: n, binding: createGraphicsBinding(n) };
}

function ops(list: Recorded[]): number[] {
  return list.map(c => c.opcode);
}
function only(list: Recorded[], opcode: number): Recorded[] {
  return list.filter(c => c.opcode === opcode);
}

describe('SDF nodes', () => {
  it('first frame: one draw, then ALLOC + one upload at frame end', () => {
    const f = frame();
    const { binding } = node(
      new GraphicsContext().rect(0, 0, 10, 10).fill(0xff0000),
    );
    binding.emitDraw(f, W, at(0, 100, 50), 1);
    const out = f.end();
    expect(ops(out)).toEqual([
      GfxOp.GFX_DRAW_SHAPES,
      GfxOp.GFX_SHAPE_BUFFER_ALLOC,
      GfxOp.GFX_SHAPE_UPLOAD,
    ]);
    const draw = out[0];
    expect(draw.flags & CommandFlag.DRAW).toBe(CommandFlag.DRAW);
    expect(draw.words.slice(1, 5)).toEqual([0, 1, BlendModeId.normal, 0]);
    const up = out[2];
    expect(up.words[0]).toBe(draw.words[0]);
    expect(up.words.slice(1, 3)).toEqual([0, 1]);
    // The instance: world × local affine, colour.
    const inst = new Float32Array(
      up.bytes.buffer,
      up.bytes.byteOffset + 12,
      16,
    );
    const instU = new Uint32Array(
      up.bytes.buffer,
      up.bytes.byteOffset + 12,
      16,
    );
    expect(inst[(GS_A >> 2) + 4]).toBe(105);
    expect(inst[(GS_A >> 2) + 5]).toBe(55);
    expect(instU[GS_FILL >> 2]).toBe(toPackedColor(0xff0000));
  });

  it('a static scene uploads nothing; a moved node uploads its slot only', () => {
    const f = frame();
    const ctx = new GraphicsContext().circle(0, 0, 4).fill(0xffffff);
    const items = [node(ctx), node(ctx), node(ctx)];
    const draw = (moved: number): Recorded[] => {
      items.forEach((it, i) =>
        it.binding.emitDraw(f, W, at(i, i === moved ? 999 : i * 10, 0), 1),
      );
      return f.end();
    };
    draw(-1);
    expect(ops(draw(-1))).toEqual([GfxOp.GFX_DRAW_SHAPES]);
    const out = draw(1);
    const up = only(out, GfxOp.GFX_SHAPE_UPLOAD);
    expect(up.length).toBe(1);
    expect(up[0].words.slice(1, 3)).toEqual([1, 1]);
  });

  it('coalesces consecutive nodes into one draw (shared or not)', () => {
    const f = frame();
    const icon = new GraphicsContext().circle(0, 0, 4).fill(0xffffff);
    const items: Item[] = [];
    for (let i = 0; i < 40; i++)
      items.push(
        node(i % 2 ? icon : new GraphicsContext().rect(0, 0, 2, 2).fill(0)),
      );
    items.forEach((it, i) => it.binding.emitDraw(f, W, at(i, i, 0), 1));
    const draws = only(f.end(), GfxOp.GFX_DRAW_SHAPES);
    expect(draws.length).toBe(1);
    expect(draws[0].words[2]).toBe(40);
  });

  it('does not merge across another DRAW command, but does across non-DRAW ones', () => {
    const f = frame();
    const ctx = new GraphicsContext().rect(0, 0, 1, 1).fill(0);
    const a = node(ctx);
    const b = node(ctx);
    const c = node(ctx);
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.encoder.begin(Op.SET_CLEAR_COLOR, 16);
    f.encoder.end();
    b.binding.emitDraw(f, W, at(1, 1, 0), 1);
    f.encoder.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
    f.encoder.end();
    c.binding.emitDraw(f, W, at(2, 2, 0), 1);
    const draws = only(f.end(), GfxOp.GFX_DRAW_SHAPES);
    expect(draws.map(d => [d.words[1], d.words[2]])).toEqual([
      [0, 2],
      [2, 1],
    ]);
  });

  it('splits draws on blend mode and applies tint × alpha', () => {
    const f = frame();
    const ctx = new GraphicsContext().rect(0, 0, 1, 1).fill(0xffffff);
    node(ctx, { tint: 0xff0000 }).binding.emitDraw(f, W, at(0, 0, 0), 0.5);
    node(ctx, { blendMode: 'add' }).binding.emitDraw(f, W, at(1, 0, 0), 1);
    const out = f.end();
    const draws = only(out, GfxOp.GFX_DRAW_SHAPES);
    expect(draws.map(d => d.words[3])).toEqual([
      BlendModeId.normal,
      BlendModeId.add,
    ]);
    const up = only(out, GfxOp.GFX_SHAPE_UPLOAD)[0];
    const u = new Uint32Array(up.bytes.buffer, up.bytes.byteOffset + 12, 32);
    expect(u[GS_FILL >> 2]).toBe(toPackedColor(0xff0000, 0.5));
    expect(u[16 + (GS_FILL >> 2)]).toBe(toPackedColor(0xffffff));
  });

  it('writes the pick id only for pickable nodes', () => {
    const f = frame();
    const ctx = new GraphicsContext().rect(0, 0, 1, 1).fill(0);
    const a = node(ctx);
    const b = node(ctx, { pickable: true });
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    const up = only(f.end(), GfxOp.GFX_SHAPE_UPLOAD)[0];
    const u = new Uint32Array(up.bytes.buffer, up.bytes.byteOffset + 12, 32);
    expect(u[GS_FLAGS >> 2] >>> SI_PICK_SHIFT).toBe(0);
    expect(u[16 + (GS_FLAGS >> 2)] >>> SI_PICK_SHIFT).toBe(b.node.id);
  });

  it('redraws a cleared context every frame in the same arena', () => {
    const f = frame();
    const ctx = new GraphicsContext();
    const { binding } = node(ctx);
    for (let k = 0; k < 3; k++) {
      ctx.clear();
      for (let i = 0; i < 50; i++) ctx.circle(i + k, 0, 2).fill(0xff00ff);
      binding.emitDraw(f, W, at(0, 0, 0), 1);
      const out = f.end();
      expect(only(out, GfxOp.GFX_DRAW_SHAPES)[0].words[2]).toBe(50);
      expect(only(out, GfxOp.GFX_SHAPE_BUFFER_ALLOC).length).toBe(
        k === 0 ? 1 : 0,
      );
      expect(only(out, GfxOp.GFX_SHAPE_UPLOAD)[0].words[2]).toBe(50);
    }
  });

  it('draws nothing for an empty context', () => {
    const f = frame();
    node().binding.emitDraw(f, W, at(0, 0, 0), 1);
    expect(f.end()).toEqual([]);
  });

  it('waits for the core system: nothing drawn, mask geometry not ready', () => {
    const f = frame();
    f.ready = false;
    const { binding } = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    binding.emitDraw(f, W, at(0, 0, 0), 1);
    expect(binding.emitMaskGeometry(f, W, at(0, 0, 0), true)).toBe(false);
    expect(f.end()).toEqual([]);
  });

  it('uses the shared-memory upload when the core reads front memory', () => {
    const f = frame();
    f.sharedMemory = true;
    node(new GraphicsContext().rect(0, 0, 1, 1).fill(0)).binding.emitDraw(
      f,
      W,
      at(0, 0, 0),
      1,
    );
    const out = f.end();
    const up = only(out, GfxOp.GFX_SHAPE_UPLOAD_SHARED);
    expect(up.length).toBe(1);
    expect(up[0].words.slice(1, 5)).toEqual([0, 1, 1, 0]);
    expect(f.shared.length).toBe(1);
  });
});

describe('mesh nodes', () => {
  const star = (): GraphicsContext =>
    new GraphicsContext().star(0, 0, 5, 10).fill(0xffcc00);

  it('uploads a shared mesh once and draws all its nodes in one instanced draw', () => {
    const f = frame();
    const ctx = star();
    const items = [node(ctx), node(ctx, { tint: 0x00ff00 }), node(ctx)];
    items.forEach((it, i) =>
      it.binding.emitDraw(f, W, at(i, i * 20, 0), i === 2 ? 0.5 : 1),
    );
    const out = f.end();
    expect(only(out, GfxOp.GFX_MESH_UPLOAD).length).toBe(1);
    const draws = only(out, GfxOp.GFX_DRAW_MESH);
    expect(draws.length).toBe(1);
    const d = draws[0].words;
    expect(d[2]).toBe(ctx.info.meshTriangles * 3);
    expect([d[4], d[5]]).toEqual([0, 3]);
    expect(d[6]).toBe(NO_ID);
    const nodes = only(out, GfxOp.GFX_NODE_UPLOAD)[0];
    expect(nodes.words.slice(1, 3)).toEqual([0, 3]);
    const rec = new Uint32Array(
      nodes.bytes.buffer,
      nodes.bytes.byteOffset + 12,
      24,
    );
    const recF = new Float32Array(
      nodes.bytes.buffer,
      nodes.bytes.byteOffset + 12,
      24,
    );
    expect(recF[GFX_NODE_BYTES / 4 + 4]).toBe(20);
    expect(rec[GN_COLOR >> 2]).toBe(0xffffffff);
    expect(rec[GFX_NODE_BYTES / 4 + (GN_COLOR >> 2)]).toBe(
      toPackedColor(0x00ff00),
    );
    expect(rec[2 * (GFX_NODE_BYTES / 4) + (GN_COLOR >> 2)] >>> 24).toBe(128);
    expect(rec[GN_FLAGS >> 2]).toBe(0);
    // Mesh payload: vertices then u16 indices.
    const m = only(out, GfxOp.GFX_MESH_UPLOAD)[0].words;
    expect(m[1]).toBe(ctx.info.meshVertices);
    expect(m[3]).toBe(0);
    // Next frame: nothing but the draw.
    items.forEach((it, i) =>
      it.binding.emitDraw(f, W, at(i, i * 20, 0), i === 2 ? 0.5 : 1),
    );
    expect(ops(f.end())).toEqual([GfxOp.GFX_DRAW_MESH]);
  });

  it('keeps painter order SDF, mesh, SDF and merges the SDF runs of the next node', () => {
    const f = frame();
    const ctx = new GraphicsContext()
      .rect(0, 0, 4, 4)
      .fill(0)
      .poly([0, 0, 4, 0, 2, 3])
      .fill(0)
      .circle(0, 0, 2)
      .fill(0);
    node(ctx).binding.emitDraw(f, W, at(0, 0, 0), 1);
    node(ctx).binding.emitDraw(f, W, at(1, 10, 0), 1);
    const draws = f.end().filter(c => c.flags & CommandFlag.DRAW);
    expect(ops(draws)).toEqual([
      GfxOp.GFX_DRAW_SHAPES,
      GfxOp.GFX_DRAW_MESH,
      GfxOp.GFX_DRAW_SHAPES,
      GfxOp.GFX_DRAW_MESH,
      GfxOp.GFX_DRAW_SHAPES,
    ]);
    expect(draws[2].words.slice(1, 3)).toEqual([1, 2]); // A's circle + B's rect
    expect(draws[3].words.slice(4, 6)).toEqual([1, 1]);
  });

  it('re-tessellates once when a node needs a finer scale bucket, never when shrinking', () => {
    const f = frame();
    const ctx = new GraphicsContext()
      .moveTo(0, 0)
      .quadraticCurveTo(50, 80, 100, 0)
      .stroke({ width: 2 });
    const { binding } = node(ctx);
    binding.emitDraw(f, W, at(0, 0, 0, 1), 1);
    const v1 = ctx.info.meshVertices;
    expect(only(f.end(), GfxOp.GFX_MESH_UPLOAD).length).toBe(1);
    binding.emitDraw(f, W, at(0, 0, 0, 3), 1);
    expect(only(f.end(), GfxOp.GFX_MESH_UPLOAD).length).toBe(1);
    expect(ctx.info.meshVertices).toBeGreaterThan(v1);
    binding.emitDraw(f, W, at(0, 0, 0, 4), 1); // same bucket (4)
    binding.emitDraw(f, W, at(1, 0, 0, 0.5), 1);
    expect(only(f.end(), GfxOp.GFX_MESH_UPLOAD).length).toBe(0);
  });

  it('a polygon (scale independent) never re-tessellates on scale', () => {
    const f = frame();
    const ctx = new GraphicsContext().poly([0, 0, 10, 0, 5, 5]).fill(0);
    const { binding } = node(ctx);
    binding.emitDraw(f, W, at(0, 0, 0, 1), 1);
    f.end();
    const stamp = compile(ctx).meshStamp;
    binding.emitDraw(f, W, at(0, 0, 0, 64), 1);
    expect(only(f.end(), GfxOp.GFX_MESH_UPLOAD).length).toBe(0);
    expect(compile(ctx).meshStamp).toBe(stamp);
  });

  it('textured parts carry the texture and the TEXTURED flag; skip until the texture is ready', () => {
    const f = frame();
    const tex = {
      sourceId: 42,
      sourceWidth: 8,
      sourceHeight: 8,
      frame: { x: 0, y: 0, width: 8, height: 8 },
    } as unknown as TextureHandle;
    const missing = { ...tex, sourceId: NO_ID } as TextureHandle;
    node(
      new GraphicsContext().poly([0, 0, 8, 0, 8, 8]).fill({ texture: tex }),
    ).binding.emitDraw(f, W, at(0, 0, 0), 1);
    node(
      new GraphicsContext().poly([0, 0, 8, 0, 8, 8]).fill({ texture: missing }),
    ).binding.emitDraw(f, W, at(1, 0, 0), 1);
    const draws = only(f.end(), GfxOp.GFX_DRAW_MESH);
    expect(draws.length).toBe(1);
    expect(draws[0].words[6]).toBe(42);
    expect(draws[0].words[8] & GfxDrawFlag.TEXTURED).toBeTruthy();
    expect(draws[0].floats[9]).toBeCloseTo(1 / 8, 6);
  });

  it('destroying a context frees its mesh on every renderer', () => {
    const f = frame();
    const ctx = star();
    node(ctx).binding.emitDraw(f, W, at(0, 0, 0), 1);
    const meshId = only(f.end(), GfxOp.GFX_MESH_UPLOAD)[0].words[0];
    ctx.destroy();
    const out = f.end();
    expect(ops(out)).toEqual([GfxOp.GFX_MESH_DESTROY]);
    expect(out[0].words[0]).toBe(meshId);
  });
});

describe('device loss, masks', () => {
  it('a new generation re-allocates, re-uploads everything and re-sends meshes', () => {
    const f = frame();
    const a = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    const b = node(new GraphicsContext().star(0, 0, 5, 4).fill(0));
    const draw = (): Recorded[] => {
      a.binding.emitDraw(f, W, at(0, 0, 0), 1);
      b.binding.emitDraw(f, W, at(1, 0, 0), 1);
      return f.end();
    };
    draw();
    expect(
      ops(draw()).filter(
        o => o !== GfxOp.GFX_DRAW_SHAPES && o !== GfxOp.GFX_DRAW_MESH,
      ),
    ).toEqual([]);
    f.generation++;
    const out = draw();
    expect(only(out, GfxOp.GFX_SHAPE_BUFFER_ALLOC).length).toBe(1);
    expect(only(out, GfxOp.GFX_NODE_BUFFER_ALLOC).length).toBe(1);
    expect(only(out, GfxOp.GFX_MESH_UPLOAD).length).toBe(1);
    expect(only(out, GfxOp.GFX_SHAPE_UPLOAD)[0].words.slice(1, 3)).toEqual([
      0, 1,
    ]);
    expect(only(out, GfxOp.GFX_NODE_UPLOAD)[0].words.slice(1, 3)).toEqual([
      0, 1,
    ]);
  });

  it('stencil mask geometry carries MASK_WRITE and keeps its own slots', () => {
    const f = frame();
    const { binding } = node(new GraphicsContext().circle(0, 0, 5).fill(0));
    for (let k = 0; k < 2; k++) {
      expect(binding.emitMaskGeometry(f, W, at(0, 0, 0), true)).toBe(true);
      binding.emitDraw(f, W, at(1, 50, 0), 1);
      const out = f.end();
      const draws = only(out, GfxOp.GFX_DRAW_SHAPES);
      expect(draws.map(d => [d.words[1], d.words[4]])).toEqual([
        [0, GfxDrawFlag.MASK_WRITE],
        [1, 0],
      ]);
      // Second frame: both copies are unchanged → no upload.
      expect(only(out, GfxOp.GFX_SHAPE_UPLOAD).length).toBe(k === 0 ? 1 : 0);
    }
    // Alpha masks draw normally.
    expect(binding.emitMaskGeometry(f, W, at(0, 0, 0), false)).toBe(true);
    expect(only(f.end(), GfxOp.GFX_DRAW_SHAPES)[0].words[4]).toBe(0);
  });

  it('maskRect reports a plain rect in local space', () => {
    const out = new Float32Array(4);
    expect(
      node(new GraphicsContext().rect(1, 2, 3, 4).fill(0)).binding.maskRect(
        out,
      ),
    ).toBe(true);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(
      node(new GraphicsContext().circle(1, 2, 3).fill(0)).binding.maskRect(out),
    ).toBe(false);
  });

  it('ready is a promise for the chunks the context needs', () => {
    const { binding } = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    const p = binding.ready;
    p.catch(() => {});
    expect(p).toBeInstanceOf(Promise);
  });
});

it('keeps the instance stride of the layouts', () => {
  expect(GFX_SHAPE_BYTES).toBe(64);
});
