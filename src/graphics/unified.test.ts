/**
 * The unified graphics batch (ARCHITECTURE §27.4), front and core: item
 * streams over persistent records, one GFX_DRAW_UNIFIED for mixed shapes and
 * paths, item regions per retained segment, item reuse, the sync path and
 * draw versions; the core's sources, transform slots, texture slots and the
 * WebGL2 data textures.
 */
import type {
  RenderPass,
  RhiBindGroup,
  RhiBuffer,
  RhiTexture,
} from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag } from '../commands/opcodes';
import {
  GFX_DRAW_UNIFIED_BYTES,
  GfxDrawFlag,
  GfxOp,
  GfxPoolKind,
} from '../commands/gfxOpcodes';
import type { CommandEncoder } from '../commands/types';
import {
  MaskBackend,
  RecordList,
  createFrameState,
  createMaskContext,
} from '../masks/testutil';
import { nodeStore } from '../scene/store';
import {
  GFX_ITEM_CORNER_BITS,
  GFX_ITEM_INDEX_MASK,
  GFX_ITEM_KIND_SHIFT,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GFX_TRANSFORM_BYTES,
  GFX_UVERTEX_BYTES,
  GUV_NODE,
  GfxItemKind,
} from '../types/gfxLayouts';
import { GraphicsCoreSystem, createGraphicsCoreSystem } from './core';
import { DataTexture, DATA_TEXTURE_WIDTH } from './dataTexture';
import { HEAVY_USERS, createGraphicsBinding, loadTess } from './emit';
import type { Binding } from './emit';
import type { Recorded } from './frame.testutil';
import { TestFrame } from './frame.testutil';
import { Graphics } from './Graphics';
import { GraphicsContext } from './GraphicsContext';
import { RecordStore } from './pools';

beforeAll(async () => {
  await loadTess();
});

let nextRenderer = 3000;
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

function node(ctx?: GraphicsContext): { node: Graphics; binding: Binding } {
  const n = new Graphics({ context: ctx });
  return { node: n, binding: createGraphicsBinding(n) };
}

function only(list: Recorded[], opcode: number): Recorded[] {
  return list.filter(c => c.opcode === opcode);
}

/** The u32 items of a GFX_POOL_UPLOAD (ITEMS) command. */
function items(up: Recorded): number[] {
  return up.words.slice(4, 4 + up.words[3]);
}

const kindOf = (item: number): number => item >>> GFX_ITEM_KIND_SHIFT;
const recordOf = (item: number): number =>
  (item & GFX_ITEM_INDEX_MASK) >>> GFX_ITEM_CORNER_BITS;

describe('unified front', () => {
  const star = (): GraphicsContext =>
    new GraphicsContext().star(0, 0, 5, 10).fill(0xffcc00);

  it('draws mixed shapes and paths of many nodes as one GFX_DRAW_UNIFIED', () => {
    const f = frame();
    const nodes = [];
    for (let i = 0; i < 8; i++) {
      nodes.push(
        node(
          i % 4 === 3
            ? star()
            : new GraphicsContext().rect(0, 0, 4, 4).fill(0xff0000),
        ),
      );
    }
    nodes.forEach((n, i) => n.binding.emitDraw(f, W, at(i, i * 10, 0), 1));
    const out = f.end();
    const draws = out.filter(c => c.flags & CommandFlag.DRAW);
    expect(draws.map(d => d.opcode)).toEqual([GfxOp.GFX_DRAW_UNIFIED]);
    const d = draws[0].words;
    const up = only(out, GfxOp.GFX_POOL_UPLOAD).filter(
      c => c.words[0] === GfxPoolKind.ITEMS,
    );
    expect(up.length).toBe(1);
    const list = items(up[0]);
    expect(d[2]).toBe(list.length);
    // Six SHAPE items per rect (corners 0, 1, 2, 2, 1, 3); stars are mesh
    // VERTEX items.
    expect(list.slice(0, 6).map(i => i & 3)).toEqual([0, 1, 2, 2, 1, 3]);
    expect(kindOf(list[0])).toBe(GfxItemKind.SHAPE);
    expect(new Set(list.slice(0, 18).map(recordOf))).toEqual(
      new Set([0, 1, 2]),
    );
    expect(kindOf(list[18])).toBe(GfxItemKind.VERTEX);
    // Sources: shape buffer, vertex pool, node buffer, sprite pool.
    expect(d[3]).toBe(only(out, GfxOp.GFX_SHAPE_BUFFER_ALLOC)[0].words[0]);
    expect(d[5]).toBe(only(out, GfxOp.GFX_NODE_BUFFER_ALLOC)[0].words[0]);
    expect([d[7], d[8], d[10]]).toEqual([0, 0, 0]);
  });

  it('a unified vertex names its node record; moving a node rewrites only that record', () => {
    const f = frame();
    const a = node(star());
    const b = node(star());
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 50, 0), 1);
    let out = f.end();
    const verts = only(out, GfxOp.GFX_POOL_UPLOAD).find(
      c => c.words[0] === GfxPoolKind.VERTICES,
    )!;
    const n = verts.words[3];
    const u32 = new Uint32Array(
      verts.bytes.buffer,
      verts.bytes.byteOffset + 16,
      (n * GFX_UVERTEX_BYTES) / 4,
    );
    const nodeOf = (v: number): number =>
      u32[(v * GFX_UVERTEX_BYTES + GUV_NODE) >> 2];
    expect(nodeOf(0)).toBe(0);
    expect(nodeOf(n - 1)).toBe(1);
    a.binding.emitDraw(f, W, at(0, 5, 5), 1);
    b.binding.emitDraw(f, W, at(1, 50, 0), 1);
    out = f.end();
    expect(
      out.filter(c => (c.flags & CommandFlag.DRAW) === 0).map(c => c.opcode),
    ).toEqual([GfxOp.GFX_NODE_UPLOAD]);
    expect(only(out, GfxOp.GFX_NODE_UPLOAD)[0].words.slice(1, 3)).toEqual([
      0, 1,
    ]);
  });

  it('a static frame rewrites no items and uploads nothing', () => {
    const f = frame();
    const a = node(new GraphicsContext().circle(0, 0, 3).fill(0));
    const b = node(star());
    const draw = (): Recorded[] => {
      a.binding.emitDraw(f, W, at(0, 0, 0), 1);
      b.binding.emitDraw(f, W, at(1, 9, 0), 1);
      return f.end();
    };
    draw();
    expect(draw().map(c => c.opcode)).toEqual([GfxOp.GFX_DRAW_UNIFIED]);
    // A node that was hidden for a frame comes back: its place is rewritten.
    b.binding.emitDraw(f, W, at(1, 9, 0), 1);
    f.end();
    const out = draw();
    const up = only(out, GfxOp.GFX_POOL_UPLOAD).filter(
      c => c.words[0] === GfxPoolKind.ITEMS,
    );
    expect(up.length).toBe(1);
  });

  it('items go to the region of the segment being recorded', () => {
    const f = frame();
    const a = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    const b = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    f.retainSegment = 7;
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.retainSegment = 0;
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    const out = f.end();
    const draws = only(out, GfxOp.GFX_DRAW_UNIFIED);
    expect(draws.length).toBe(2);
    expect(draws[0].words[0]).not.toBe(draws[1].words[0]);
    expect(draws.map(d => d.words[1])).toEqual([0, 0]);
    const allocs = only(out, GfxOp.GFX_POOL_ALLOC).filter(
      c => c.words[0] === GfxPoolKind.ITEMS,
    );
    expect(allocs.map(c => c.words[1]).sort()).toEqual(
      draws.map(d => d.words[0]).sort(),
    );
  });

  it('sync rewrites records only and reports what it cannot sync', () => {
    const f = frame();
    const ctx = new GraphicsContext().rect(0, 0, 1, 1).fill(0);
    const a = node(ctx);
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.end();
    const v = a.binding.drawVersion;
    a.binding.syncDraw(f, W, at(0, 7, 0), 0.5);
    let out = f.end();
    expect(out.map(c => c.opcode)).toEqual([GfxOp.GFX_SHAPE_UPLOAD]);
    expect(a.binding.drawVersion).toBe(v);
    // A context edit changes the version; sync then leaves the records and
    // asks for a new recording (draw epoch).
    ctx.circle(0, 0, 2).fill(0);
    const edited = a.binding.drawVersion;
    expect(edited).not.toBe(v);
    const epoch = nodeStore.drawEpoch;
    a.binding.syncDraw(f, W, at(0, 7, 0), 0.5);
    out = f.end();
    expect(out).toEqual([]);
    expect(nodeStore.drawEpoch).not.toBe(epoch);
    expect(a.binding.drawVersion).not.toBe(edited);
  });

  it('the draw version follows blend mode and context swaps, not transforms', () => {
    const f = frame();
    const a = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    f.end();
    const v0 = a.binding.drawVersion;
    a.binding.emitDraw(f, W, at(0, 40, 0), 0.3);
    f.end();
    expect(a.binding.drawVersion).toBe(v0);
    a.node.blendMode = 'add';
    const v1 = a.binding.drawVersion;
    expect(v1).not.toBe(v0);
    a.node.context = new GraphicsContext().circle(0, 0, 1).fill(0);
    expect(a.binding.drawVersion).not.toBe(v1);
  });

  it('a context shared by HEAVY_USERS nodes keeps the instanced mesh draw', () => {
    const f = frame();
    const ctx = star();
    const nodes = [];
    for (let i = 0; i < HEAVY_USERS; i++) nodes.push(node(ctx));
    nodes.forEach((n, i) => n.binding.emitDraw(f, W, at(i, i, 0), 1));
    const out = f.end();
    expect(only(out, GfxOp.GFX_DRAW_UNIFIED).length).toBe(0);
    const mesh = only(out, GfxOp.GFX_DRAW_MESH);
    expect(mesh.length).toBe(1);
    expect(mesh[0].words[5]).toBe(HEAVY_USERS);
  });

  it('mask geometry carries MASK_WRITE in its own draw', () => {
    const f = frame();
    const a = node(new GraphicsContext().circle(0, 0, 5).fill(0));
    expect(a.binding.emitMaskGeometry(f, W, at(0, 0, 0), true)).toBe(true);
    a.binding.emitDraw(f, W, at(1, 0, 0), 1);
    const draws = only(f.end(), GfxOp.GFX_DRAW_UNIFIED);
    expect(draws.map(d => d.words[10])).toEqual([GfxDrawFlag.MASK_WRITE, 0]);
  });

  it('destroying a node returns its records', () => {
    const f = frame();
    const a = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    const b = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    a.binding.emitDraw(f, W, at(0, 0, 0), 1);
    b.binding.emitDraw(f, W, at(1, 0, 0), 1);
    f.end();
    a.binding.destroy();
    const c = node(new GraphicsContext().rect(0, 0, 1, 1).fill(0));
    c.binding.emitDraw(f, W, at(2, 0, 0), 1);
    const up = only(f.end(), GfxOp.GFX_SHAPE_UPLOAD);
    expect(up[0].words.slice(1, 3)).toEqual([0, 1]); // a's record, reused
  });
});

describe('record stores', () => {
  it('allocate first fit, merge freed blocks and shrink the top', () => {
    const s = new RecordStore(4, GfxPoolKind.VERTICES);
    expect([s.alloc(3, false), s.alloc(2, false), s.alloc(4, false)]).toEqual([
      0, 3, 5,
    ]);
    s.free(0, 3);
    s.free(3, 2);
    expect(s.freeRecords).toBe(5);
    expect(s.alloc(4, false)).toBe(0);
    expect(s.alloc(2, false)).toBe(9);
    s.free(9, 2);
    s.free(5, 4);
    // [4, 5) was free below the freed tail: the top falls to 4.
    expect(s.top).toBe(4);
    expect(s.freeRecords).toBe(0);
  });
});

// ── core ─────────────────────────────────────────────────────────────────────

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/** The mask tests' backend plus the buffer and texture logs the batch needs. */
class GfxBackend extends MaskBackend {
  readonly buffers: RhiBuffer[] = [];
  readonly textureWrites: {
    texture: RhiTexture;
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  override createBuffer(desc: { label?: string; size: number }): RhiBuffer {
    const b = super.createBuffer(desc);
    this.buffers.push(b);
    return b;
  }
  writeTexture(
    texture: RhiTexture,
    _data: ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.textureWrites.push({ texture, x, y, width, height });
  }
}

async function core(gl = false): Promise<{
  backend: GfxBackend;
  core: GraphicsCoreSystem;
}> {
  const backend = new GfxBackend();
  if (gl) backend.caps = { ...backend.caps, shaderLanguage: 'glsl300es' };
  const ctx = createMaskContext(backend);
  const c = createGraphicsCoreSystem() as GraphicsCoreSystem;
  await c.init(ctx);
  await settle();
  return { backend, core: c };
}

function words(enc: CommandEncoder, op: number, w: number[], flags = 0) {
  enc.begin(op, w.length * 4, flags);
  for (const x of w) enc.u32(x);
  enc.end();
}

function poolUpload(
  enc: CommandEncoder,
  kind: number,
  id: number,
  first: number,
  data: Uint32Array,
  stride: number,
): void {
  const count = data.byteLength / stride;
  enc.begin(GfxOp.GFX_POOL_UPLOAD, 16 + data.byteLength);
  enc.u32(kind);
  enc.u32(id);
  enc.u32(first);
  enc.u32(count);
  enc.bytes(data);
  enc.end();
}

function drawUnified(enc: CommandEncoder, w: Partial<Record<string, number>>) {
  enc.begin(GfxOp.GFX_DRAW_UNIFIED, GFX_DRAW_UNIFIED_BYTES, CommandFlag.DRAW);
  for (const k of [
    'items',
    'first',
    'count',
    'shapes',
    'verts',
    'nodes',
    'sprites',
    'slots',
    'transform',
    'blend',
    'flags',
  ]) {
    enc.u32(w[k] ?? 0);
  }
  enc.end();
}

function run(c: GraphicsCoreSystem, enc: CommandEncoder, pick = false) {
  const decoder = createCommandDecoder();
  decoder.reset(enc.finish(1));
  const frame = createFrameState(1);
  const r = decoder.reader;
  const draws: number[] = [];
  while (decoder.next()) {
    if (r.flags & CommandFlag.DRAW) draws.push(r.commandOffset);
    else c.execute(r, frame);
  }
  const list = new RecordList();
  const pass = list.beginRenderPass({
    label: 'main',
    color: { target: 'canvas', load: 'clear' },
  }) as RenderPass & { calls: string[] };
  const calls: string[] = [];
  pass.setBindGroup = (i: number, g: RhiBindGroup, o?: Uint32Array) =>
    void calls.push(`bind ${i} ${g.label}${o ? ` @${o[0]}` : ''}`);
  pass.setIndexBuffer = b => void calls.push(`index ${b.label}`);
  pass.drawIndexed = (n, inst = 1, first = 0) =>
    void calls.push(`drawIndexed ${n}x${inst} i${first}`);
  pass.setPipeline = p => void calls.push(`pipeline ${p.label}`);
  for (const at of draws) {
    decoder.seek(at);
    if (pick) c.drawPick(r, pass, frame, { label: 'pick', destroy() {} });
    else c.draw(r, pass, frame);
  }
  return calls;
}

function encoder(): CommandEncoder {
  const enc = createCommandEncoder();
  enc.reset();
  return enc;
}

describe('unified core', () => {
  it('draws an item range as one indexed draw with sources, slots and transform', async () => {
    const { backend, core: c } = await core();
    const enc = encoder();
    words(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, [1, 4]);
    words(enc, GfxOp.GFX_POOL_ALLOC, [GfxPoolKind.ITEMS, 2, 64]);
    poolUpload(enc, GfxPoolKind.ITEMS, 2, 0, new Uint32Array(12), 4);
    words(enc, GfxOp.GFX_SET_TRANSFORM, [3, 0, 0, 0, 0, 0, 0, 0]);
    drawUnified(enc, { items: 2, first: 6, count: 6, shapes: 1, transform: 3 });
    const calls = run(c, enc);
    expect(calls).toEqual([
      'pipeline cozygpu.graphics.unified.0',
      'bind 0 view',
      'bind 1 cozygpu.graphics.sources',
      'bind 2 cozygpu.graphics.slots',
      'bind 3 cozygpu.graphics.transforms @768',
      'index cozygpu.graphics.items#2',
      'drawIndexed 6x1 i6',
    ]);
    // Storage on WebGPU; the transform slot at 256-byte steps.
    const shapes = backend.buffers.find(
      b => b.label === 'cozygpu.graphics.shapes#1',
    )!;
    expect(shapes).toBeDefined();
    const xf = backend.writes.find(
      w => w.label === 'cozygpu.graphics.transforms' && w.offset === 768,
    )!;
    expect(xf.bytes).toBe(GFX_TRANSFORM_BYTES);
  });

  it('skips ranges past the item pool and tells the retain core', async () => {
    const { core: c } = await core();
    const skipped = jest.fn();
    (c as unknown as { ctx: { retain: unknown } }).ctx.retain = {
      invalidate() {},
      skipped,
    };
    const enc = encoder();
    words(enc, GfxOp.GFX_POOL_ALLOC, [GfxPoolKind.ITEMS, 1, 4]);
    drawUnified(enc, { items: 1, first: 2, count: 6 });
    expect(run(c, enc).filter(x => x.startsWith('draw'))).toEqual([]);
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it('re-allocations invalidate recorded segments; the source group is rebuilt', async () => {
    const { core: c } = await core();
    const invalidate = jest.fn();
    (c as unknown as { ctx: { retain: unknown } }).ctx.retain = {
      invalidate,
      skipped() {},
    };
    let enc = encoder();
    words(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, [1, 4]);
    words(enc, GfxOp.GFX_POOL_ALLOC, [GfxPoolKind.ITEMS, 1, 8]);
    drawUnified(enc, { items: 1, count: 6, shapes: 1 });
    run(c, enc);
    const before = invalidate.mock.calls.length;
    enc = encoder();
    words(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, [1, 16]);
    drawUnified(enc, { items: 1, count: 6, shapes: 1 });
    run(c, enc);
    // The ALLOC itself and the source group built over the new buffer.
    expect(invalidate.mock.calls.length).toBe(before + 2);
  });

  it('picks with the pick variant; mask geometry never picks', async () => {
    const { core: c } = await core();
    const enc = encoder();
    words(enc, GfxOp.GFX_POOL_ALLOC, [GfxPoolKind.ITEMS, 1, 8]);
    drawUnified(enc, { items: 1, count: 6 });
    drawUnified(enc, { items: 1, count: 6, flags: GfxDrawFlag.MASK_WRITE });
    const calls = run(c, enc, true);
    expect(calls.filter(x => x.startsWith('pipeline'))).toEqual([
      'pipeline cozygpu.graphics.unified.6',
    ]);
    expect(calls).toContain('bind 0 pick');
  });

  it('texture slot tables bind the textures of their ids, white elsewhere', async () => {
    const { backend, core: c } = await core();
    const groups: { label?: string; entries: { binding: number }[] }[] = [];
    const create = backend.createBindGroup.bind(backend);
    backend.createBindGroup = desc => {
      groups.push(desc as (typeof groups)[number]);
      return create(desc);
    };
    const enc = encoder();
    words(enc, GfxOp.GFX_POOL_ALLOC, [GfxPoolKind.ITEMS, 1, 8]);
    words(enc, GfxOp.GFX_SET_TEXTURE_SLOTS, [4, 2, 11, 12]);
    drawUnified(enc, { items: 1, count: 6, slots: 4 });
    run(c, enc);
    const slots = groups.filter(g => g.label === 'cozygpu.graphics.slots');
    // The default table at the first draw would have been built too, but
    // this draw only needs table 4: 8 textures + 1 sampler.
    expect(slots.length).toBe(1);
    expect(slots[0].entries.length).toBe(9);
  });

  it('a slot table set with count 0 is released, and its id can come back', async () => {
    const { core: c } = await core();
    const tables = (c as unknown as { slotTables: unknown[] }).slotTables;
    let enc = encoder();
    words(enc, GfxOp.GFX_SET_TEXTURE_SLOTS, [4, 2, 11, 12]);
    run(c, enc);
    expect(tables[4]).toBeTruthy();
    enc = encoder();
    words(enc, GfxOp.GFX_SET_TEXTURE_SLOTS, [4, 0]);
    // An id the core never saw: nothing happens.
    words(enc, GfxOp.GFX_SET_TEXTURE_SLOTS, [40, 0]);
    run(c, enc);
    expect(tables[4]).toBeNull();
    expect(tables.length).toBe(5);
    enc = encoder();
    words(enc, GfxOp.GFX_SET_TEXTURE_SLOTS, [4, 1, 13]);
    run(c, enc);
    expect(tables[4]).toBeTruthy();
  });

  it('WebGL2: sources are rgba32uint data textures written by row', async () => {
    const { backend, core: c } = await core(true);
    const enc = encoder();
    words(enc, GfxOp.GFX_NODE_BUFFER_ALLOC, [1, 4]);
    words(enc, GfxOp.GFX_POOL_ALLOC, [GfxPoolKind.SPRITES, 1, 3]);
    const sprite = new Uint32Array(10).map((_, i) => i + 1);
    poolUpload(enc, GfxPoolKind.SPRITES, 1, 1, sprite, 40);
    run(c, enc);
    const tex = backend.textures.filter(
      t => t.label === 'cozygpu.graphics.sprites#1',
    );
    expect(tex.length).toBe(1);
    expect(tex[0].format).toBe('rgba32uint');
    // Record 1 = bytes 40..80 = texels 2..4 (40 / 16 = 2.5 → texel 2).
    const w = backend.textureWrites.filter(x => x.texture === tex[0]);
    expect(w.map(x => [x.x, x.y, x.width, x.height])).toEqual([[2, 0, 3, 1]]);
    // The node buffer keeps a vertex buffer (instanced meshes) and a texture.
    expect(
      backend.buffers.some(b => b.label === 'cozygpu.graphics.nodes#1'),
    ).toBe(true);
    expect(
      backend.textures.some(t => t.label === 'cozygpu.graphics.nodes#1'),
    ).toBe(true);
  });
});

describe('data textures', () => {
  it('spans rows of DATA_TEXTURE_WIDTH texels and keeps neighbouring words', () => {
    const backend = new GfxBackend();
    const t = new DataTexture(
      backend as never,
      DATA_TEXTURE_WIDTH * 16 * 2 + 16,
      'd',
    );
    expect([t.texture.width, t.texture.height]).toEqual([
      DATA_TEXTURE_WIDTH,
      3,
    ]);
    const src = new Uint8Array(8).fill(7);
    // 8 bytes at the end of row 0 and the start of row 1: two full rows.
    t.write(backend as never, DATA_TEXTURE_WIDTH * 16 - 4, src, 0, 8);
    const w = backend.textureWrites.at(-1)!;
    expect([w.x, w.y, w.width, w.height]).toEqual([
      0,
      0,
      DATA_TEXTURE_WIDTH,
      2,
    ]);
    expect(t.words[DATA_TEXTURE_WIDTH * 4 - 1]).toBe(0x07070707);
    expect(t.words[DATA_TEXTURE_WIDTH * 4]).toBe(0x07070707);
    expect(t.words[DATA_TEXTURE_WIDTH * 4 - 2]).toBe(0);
  });
});

it('keeps the record strides the shaders read', () => {
  expect(GFX_SHAPE_BYTES / 16).toBe(4);
  expect(GFX_NODE_BYTES / 16).toBe(2);
  expect(GFX_UVERTEX_BYTES / 16).toBe(1);
});
