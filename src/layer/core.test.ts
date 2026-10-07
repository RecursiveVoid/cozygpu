/**
 * SpriteLayer core (ARCHITECTURE §28.3) from hand-built packets: stream
 * buffers per LAYER_CREATE, uploads at the row offset, the frame table on
 * both backends, draws (instanced, culled, indirect), picking and restore.
 */
import { BufferUsage } from '../backend/types';
import { createCommandEncoder } from '../commands';
import { CommandFlag } from '../commands/opcodes';
import {
  LAYER_CREATE_BYTES,
  LAYER_CULL_BYTES,
  LAYER_DRAW_BYTES,
  LAYER_SET_SOURCE_BYTES,
  LayerDrawFlag,
  LayerFlag,
  LayerOp,
} from '../commands/layerOpcodes';
import type { CommandEncoder } from '../commands/types';
import { PICK_TARGET_FORMAT } from '../types/layouts';
import {
  LAYER_FRAME_BYTES,
  LAYER_INDIRECT_BYTES,
  LayerStream,
  LayerStreamBit,
} from '../types/layerLayouts';
import { SpriteLayerCoreSystem, createSpriteLayerCoreSystem } from './core';
import {
  LayerBackend,
  createContext,
  fakeTexture,
  runPacket,
  settle,
  type LayerContext,
} from './fakes.testutil';

const ALL =
  LayerStreamBit.POSITION | LayerStreamBit.XFORM | LayerStreamBit.COLOR;

async function setup(gl = false) {
  const backend = new LayerBackend();
  if (gl) {
    backend.caps = {
      ...backend.caps,
      backend: 'webgl2',
      shaderLanguage: 'glsl300es',
      compute: false,
      storageBuffers: false,
      vertexStorage: false,
      indirectDraw: false,
    };
  }
  const ctx = createContext(backend);
  const core = createSpriteLayerCoreSystem() as SpriteLayerCoreSystem;
  await core.init(ctx);
  return { backend, ctx, core, enc: createCommandEncoder() };
}

function create(
  enc: CommandEncoder,
  id: number,
  capacity: number,
  streams = ALL,
  flags = 0,
  blend = 0,
): void {
  enc.begin(LayerOp.LAYER_CREATE, LAYER_CREATE_BYTES);
  for (const v of [id, capacity, streams, flags, blend]) enc.u32(v);
}

/** One frame: 16×8 px, anchor 0.5, slot `slot`. */
function frames(enc: CommandEncoder, id: number, n = 1, slot = 0): void {
  enc.begin(LayerOp.LAYER_SET_FRAMES, 8 + n * LAYER_FRAME_BYTES);
  enc.u32(id);
  enc.u32(n);
  for (let i = 0; i < n; i++) {
    for (const v of [0, 0, 1, 1, 16, 8]) enc.f32(v);
    enc.u32(0x80008000);
    enc.u32(slot);
  }
}

function draw(
  enc: CommandEncoder,
  id: number,
  count: number,
  flags = 0,
  pickId = 0,
): void {
  enc.begin(LayerOp.LAYER_DRAW, LAYER_DRAW_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  for (const v of [1, 0, 0, 1, 0, 0, 1]) enc.f32(v);
  enc.u32(count);
  enc.u32(pickId);
  enc.u32(flags);
}

const labels = (b: LayerBackend) =>
  b.buffers.filter(x => !x.destroyed).map(x => `${x.label} ${x.size}`);

describe('SpriteLayer core', () => {
  it('allocates one buffer per stream and writes uploads at row offsets', async () => {
    const { backend, core, enc } = await setup();
    create(enc, 3, 100);
    enc.begin(LayerOp.LAYER_UPLOAD, 16 + 16);
    for (const v of [3, LayerStream.POSITION, 10, 2]) enc.u32(v);
    for (const v of [1, 2, 3, 4]) enc.f32(v);
    runPacket(core, enc);
    expect(labels(backend)).toEqual(
      expect.arrayContaining([
        'cozygpu.layer#3.0 800',
        'cozygpu.layer#3.1 800',
        'cozygpu.layer#3.2 400',
      ]),
    );
    expect(labels(backend).some(l => l.startsWith('cozygpu.layer#3.3'))).toBe(
      false,
    );
    const w = backend.writes.find(x => x.label === 'cozygpu.layer#3.0')!;
    expect(w.offset).toBe(80);
    expect(Array.from(new Float32Array(w.bytes.buffer))).toEqual([1, 2, 3, 4]);
    expect(backend.buffers[3].usage & BufferUsage.STORAGE).toBeTruthy();
  });

  it('reads shared uploads from byteOffset + first × stride', async () => {
    const { backend, ctx, core, enc } = await setup();
    const store = new Uint32Array(64);
    store[10 + 5] = 0xdeadbeef;
    ctx.sharedMap.set(1, store.buffer);
    create(enc, 1, 32);
    enc.begin(LayerOp.LAYER_UPLOAD_SHARED, 24);
    for (const v of [1, LayerStream.COLOR, 5, 1, 1, 40]) enc.u32(v);
    runPacket(core, enc);
    const w = backend.writes.find(x => x.label === 'cozygpu.layer#1.2')!;
    expect(w.offset).toBe(20);
    expect(new Uint32Array(w.bytes.buffer)[0]).toBe(0xdeadbeef);
  });

  it('keeps the streams when only flags or blend change', async () => {
    const { backend, core, enc } = await setup();
    create(enc, 1, 10);
    runPacket(core, enc);
    const before = backend.buffers.length;
    create(enc, 1, 10, ALL, LayerFlag.CULL, 1);
    runPacket(core, enc);
    expect(backend.buffers.slice(0, before).every(b => !b.destroyed)).toBe(
      true,
    );
    expect(labels(backend)).toEqual(
      expect.arrayContaining([
        'cozygpu.layer#1.4 40',
        `cozygpu.layer#1.6 ${LAYER_INDIRECT_BYTES}`,
      ]),
    );
    create(enc, 1, 20, ALL, LayerFlag.CULL, 1);
    runPacket(core, enc);
    expect(
      backend.buffers.find(b => b.label === 'cozygpu.layer#1.0')!.destroyed,
    ).toBe(true);
  });

  it('draws one instanced strip once the pipeline is ready', async () => {
    const { backend, ctx, core, enc } = await setup();
    ctx.textures.set(5, fakeTexture('atlas'));
    create(enc, 1, 10);
    frames(enc, 1);
    enc.begin(LayerOp.LAYER_SET_TEXTURES, 12);
    for (const v of [1, 1, 5]) enc.u32(v);
    draw(enc, 1, 7);
    expect(runPacket(core, enc).pass.calls).toEqual([]);
    await settle();
    draw(enc, 1, 7);
    const { pass } = runPacket(core, enc);
    expect(pass.calls).toEqual([
      expect.stringMatching(/^pipeline /),
      'bind 0 view',
      expect.stringMatching(/^bind 1 /),
      expect.stringMatching(/^bind 2 /),
      'bind 3 group1 @0',
      'draw 4x7',
    ]);
    const p = backend.pipelines[0];
    expect(p.topology).toBe('triangle-strip');
    expect(p.vertexBuffers).toEqual([]);
    expect(backend.modules[0].wgsl!.startsWith('const STREAMS=7u;')).toBe(true);
    // Texture slot group: slot 0 = the atlas, the rest white.
    const tex = backend.groups.find(g =>
      g.entries.some(e => 'texture' in e.resource),
    )!;
    expect(tex.entries).toHaveLength(16);
    expect(
      (tex.entries[0].resource as { texture: { label: string } }).texture.label,
    ).toBe('atlas');
    expect(
      (tex.entries[2].resource as { texture: { label: string } }).texture.label,
    ).toBe('white');
    // The draw slot carries affine, alpha, pick id, culled.
    const uni = backend.writes.filter(w => w.label === 'cozygpu.layer.draw');
    expect(
      Array.from(new Float32Array(uni[uni.length - 1].bytes.buffer, 0, 7)),
    ).toEqual([1, 0, 0, 1, 0, 0, 1]);
  });

  it('clamps the count to the rows the streams hold', async () => {
    const { core, enc } = await setup();
    create(enc, 1, 10);
    frames(enc, 1);
    draw(enc, 1, 99);
    runPacket(core, enc);
    await settle();
    draw(enc, 1, 99);
    expect(runPacket(core, enc).pass.calls.pop()).toBe('draw 4x10');
  });

  it('culls in three ordered dispatches and draws indirectly', async () => {
    const { core, enc } = await setup();
    create(enc, 1, 1000, ALL, LayerFlag.CULL);
    frames(enc, 1);
    const cull = () => {
      enc.begin(LayerOp.LAYER_CULL, LAYER_CULL_BYTES, CommandFlag.COMPUTE);
      enc.u32(1);
      enc.u32(600);
      for (const v of [1, 0, 0, 1, 0, 0, 8]) enc.f32(v);
    };
    cull();
    draw(enc, 1, 600, LayerDrawFlag.CULLED);
    expect(runPacket(core, enc, 1).compute.calls).toEqual([]);
    await settle();
    cull();
    draw(enc, 1, 600, LayerDrawFlag.CULLED);
    const { pass, compute } = runPacket(core, enc, 2);
    expect(compute.calls.filter(c => c.startsWith('dispatch'))).toEqual([
      'dispatch 3x1',
      'dispatch 1x1',
      'dispatch 3x1',
    ]);
    expect(pass.calls.pop()).toBe('drawIndirect cozygpu.layer#1.6 0');
    // A cull that did not run this frame falls back to the full draw.
    draw(enc, 1, 600, LayerDrawFlag.CULLED);
    expect(runPacket(core, enc, 3).pass.calls.pop()).toBe('draw 4x600');
  });

  it('draws from external buffers and their indirect count', async () => {
    const { ctx, core, enc } = await setup();
    const pos = { label: 'ext.pos', size: 8 * 50, usage: 0, destroy() {} };
    const args = { label: 'ext.args', size: 16, usage: 0, destroy() {} };
    ctx.external.set(9, pos);
    ctx.external.set(10, args);
    create(enc, 1, 10, LayerStreamBit.POSITION);
    frames(enc, 1);
    enc.begin(LayerOp.LAYER_SET_SOURCE, LAYER_SET_SOURCE_BYTES);
    for (const v of [1, 9, 0, 0, 0, 10]) enc.u32(v);
    draw(enc, 1, 50, LayerDrawFlag.INDIRECT);
    runPacket(core, enc);
    await settle();
    draw(enc, 1, 50, LayerDrawFlag.INDIRECT);
    expect(runPacket(core, enc).pass.calls.pop()).toBe(
      'drawIndirect ext.args 0',
    );
    draw(enc, 1, 50);
    expect(runPacket(core, enc).pass.calls.pop()).toBe('draw 4x50');
    // A released registration draws nothing.
    ctx.external.delete(9);
    draw(enc, 1, 50);
    expect(runPacket(core, enc).pass.calls).toEqual([]);
  });

  it('replays draws into the pick pass with the pick variant', async () => {
    const { backend, core, enc } = await setup();
    create(enc, 1, 10, ALL | LayerStreamBit.USER);
    frames(enc, 1);
    draw(enc, 1, 3, 0, 42);
    runPacket(core, enc);
    await settle();
    draw(enc, 1, 3, 0, 42);
    draw(enc, 1, 3, 0, 0);
    const calls = runPacket(core, enc, 2, true).pass.calls;
    expect(calls.filter(c => c.startsWith('draw'))).toEqual([
      'draw 4x3',
      'draw 4x3',
      'draw 4x3',
    ]);
    expect(calls).toContain('bind 0 pickView');
    const pick = backend.pipelines.find(
      p => p.colorFormat === PICK_TARGET_FORMAT,
    )!;
    expect(pick.fragmentEntry).toBe('fs_pick');
    expect(pick.blend).toBe('none');
  });

  it('WebGL2: instanced attributes and a data-texture frame table', async () => {
    const { backend, core, enc } = await setup(true);
    create(enc, 1, 10, LayerStreamBit.POSITION | LayerStreamBit.COLOR);
    frames(enc, 1, 2500);
    draw(enc, 1, 4);
    runPacket(core, enc);
    expect(backend.calls).toEqual([
      'createTexture 2048x3',
      `writeTexture 0,0 2048x1 ${1024 * LAYER_FRAME_BYTES}`,
      `writeTexture 0,1 2048x1 ${1024 * LAYER_FRAME_BYTES}`,
      `writeTexture 0,2 904x1 ${452 * LAYER_FRAME_BYTES}`,
    ]);
    await settle();
    draw(enc, 1, 4);
    const calls = runPacket(core, enc).pass.calls;
    expect(calls.slice(-3)).toEqual([
      'vertex 0 cozygpu.layer#1.0',
      'vertex 1 cozygpu.layer#1.2',
      'draw 4x4',
    ]);
    const p = backend.pipelines[0];
    expect(p.vertexBuffers.map(l => l.attributes[0])).toEqual([
      { location: 0, format: 'float32x2', offset: 0 },
      { location: 2, format: 'unorm8x4', offset: 0 },
    ]);
    expect(backend.modules[0].glsl!.vertex).toMatch(/^#define COLOR$/m);
    expect(backend.modules[0].glsl!.vertex).not.toMatch(/^#define XFORM$/m);
    expect(backend.buffers[1].usage & BufferUsage.VERTEX).toBeTruthy();
  });

  it('drops every layer on restore and frees on destroy', async () => {
    const { backend, ctx, core, enc } = await setup();
    create(enc, 1, 10);
    frames(enc, 1);
    runPacket(core, enc);
    await core.restore(ctx as LayerContext);
    await settle();
    draw(enc, 1, 3);
    expect(runPacket(core, enc).pass.calls).toEqual([]);
    create(enc, 2, 10);
    enc.begin(LayerOp.LAYER_DESTROY, 4);
    enc.u32(2);
    runPacket(core, enc);
    expect(backend.buffers.slice(-3).every(b => b.destroyed)).toBe(true);
    core.destroy();
  });
});
