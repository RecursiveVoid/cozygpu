/**
 * Graphics core (ARCHITECTURE §26.5): buffer and mesh uploads from
 * hand-built packets, pipeline selection per draw (blend, stencil-write,
 * pick), uv matrix slots, device restore.
 */
import type {
  Capabilities,
  IndexFormat,
  RenderPass,
  RenderPipelineDesc,
  RhiBindGroup,
  RhiBuffer,
} from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag } from '../commands/opcodes';
import {
  GFX_DRAW_MESH_BYTES,
  GFX_DRAW_SHAPES_BYTES,
  GFX_DRAW_UNIFIED_BYTES,
  GfxDrawFlag,
  GfxMeshFlag,
  GfxOp,
} from '../commands/gfxOpcodes';
import type { CommandEncoder } from '../commands/types';
import {
  MaskBackend,
  RecordList,
  RecordPass,
  createFrameState,
  createMaskContext,
  type MaskContext,
} from '../masks/testutil';
import { MASK_STENCIL_FORMAT, PICK_TARGET_FORMAT } from '../types/layouts';
import {
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
} from '../types/gfxLayouts';
import { GraphicsCoreSystem, createGraphicsCoreSystem } from './core';

const decoder = createCommandDecoder();

type GfxPass = RecordPass;

/** A recording list whose pass also logs bind offsets and indexed draws. */
function gfxList(): RecordList {
  const list = new RecordList();
  const pass = list.pass as unknown as RenderPass;
  const calls = list.pass.calls;
  pass.setBindGroup = (index, group, offsets) => {
    calls.push(
      `bind ${index} ${group.label ?? ''}${offsets ? ` @${offsets[0]}` : ''}`,
    );
  };
  pass.setIndexBuffer = (buffer: RhiBuffer, format: IndexFormat) => {
    calls.push(`index ${buffer.label ?? ''} ${format}`);
  };
  pass.drawIndexed = (
    indexCount,
    instanceCount = 1,
    firstIndex = 0,
    _b,
    firstInstance = 0,
  ) => {
    calls.push(
      `drawIndexed ${indexCount}x${instanceCount} i${firstIndex} @${firstInstance}`,
    );
  };
  return list;
}

/** Lets the async pipeline promises settle. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function setup(
  caps: Partial<Capabilities> = {},
  sampleCount: 1 | 4 = 1,
): Promise<{
  backend: MaskBackend;
  ctx: MaskContext;
  core: GraphicsCoreSystem;
}> {
  const backend = new MaskBackend();
  // The M4 split path (no vertex storage); unified.test.ts covers the
  // unified batch.
  backend.caps = { ...backend.caps, vertexStorage: false, ...caps };
  const ctx = createMaskContext(backend, sampleCount);
  const core = createGraphicsCoreSystem() as GraphicsCoreSystem;
  await core.init(ctx);
  await settle();
  // The identity transform slot written at init.
  backend.writes.length = 0;
  return { backend, ctx, core };
}

/** Feeds one packet through the core as RenderCore does (pick pass last). */
function run(
  core: GraphicsCoreSystem,
  encoder: CommandEncoder,
  frameId = 1,
  pick = false,
): GfxPass {
  const frame = createFrameState(frameId);
  decoder.reset(encoder.finish(frameId));
  const reader = decoder.reader;
  const draws: number[] = [];
  while (decoder.next()) {
    if ((reader.flags & CommandFlag.DRAW) !== 0) {
      draws.push(reader.commandOffset);
    } else core.execute(reader, frame);
  }
  const list = gfxList();
  const pass = list.beginRenderPass({
    label: 'main',
    color: { target: 'canvas', load: 'clear' },
  });
  for (let i = 0; i < draws.length; i++) {
    decoder.seek(draws[i]);
    core.draw(reader, pass, frame);
  }
  if (pick) {
    const view = { label: 'pickView', destroy() {} } as RhiBindGroup;
    for (let i = 0; i < draws.length; i++) {
      decoder.seek(draws[i]);
      core.drawPick(reader, pass, frame, view);
    }
  }

  return pass as GfxPass;
}

function encoder(): CommandEncoder {
  const enc = createCommandEncoder();
  enc.reset();
  return enc;
}

function alloc(enc: CommandEncoder, op: number, id: number, capacity: number) {
  enc.begin(op, 8, 0);
  enc.u32(id);
  enc.u32(capacity);
  enc.end();
}

function upload(
  enc: CommandEncoder,
  op: number,
  id: number,
  first: number,
  count: number,
  stride: number,
): void {
  enc.begin(op, 12 + count * stride, 0);
  enc.u32(id);
  enc.u32(first);
  enc.u32(count);
  enc.bytes(new Uint8Array(count * stride));
  enc.end();
}

function drawShapes(
  enc: CommandEncoder,
  id: number,
  first: number,
  count: number,
  blend = 0,
  flags = 0,
): void {
  enc.begin(GfxOp.GFX_DRAW_SHAPES, GFX_DRAW_SHAPES_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  enc.u32(first);
  enc.u32(count);
  enc.u32(blend);
  enc.u32(flags);
  enc.end();
}

function meshUpload(
  enc: CommandEncoder,
  id: number,
  vertexCount: number,
  indexCount: number,
  wide = false,
): void {
  const vBytes = vertexCount * GFX_MESH_VERTEX_BYTES;
  const iBytes = indexCount * (wide ? 4 : 2);
  const iPadded = (iBytes + 3) & ~3;
  enc.begin(GfxOp.GFX_MESH_UPLOAD, 16 + vBytes + iPadded, 0);
  enc.u32(id);
  enc.u32(vertexCount);
  enc.u32(indexCount);
  enc.u32(wide ? GfxMeshFlag.U32_INDEX : 0);
  enc.bytes(new Uint8Array(vBytes));
  enc.bytes(new Uint8Array(iBytes));
  enc.end();
}

function drawMesh(
  enc: CommandEncoder,
  options: {
    mesh?: number;
    firstIndex?: number;
    indexCount?: number;
    nodes?: number;
    firstNode?: number;
    nodeCount?: number;
    tex?: number;
    blend?: number;
    flags?: number;
    uv?: number[];
  } = {},
): void {
  enc.begin(GfxOp.GFX_DRAW_MESH, GFX_DRAW_MESH_BYTES, CommandFlag.DRAW);
  enc.u32(options.mesh ?? 1);
  enc.u32(options.firstIndex ?? 0);
  enc.u32(options.indexCount ?? 3);
  enc.u32(options.nodes ?? 1);
  enc.u32(options.firstNode ?? 0);
  enc.u32(options.nodeCount ?? 1);
  enc.u32(options.tex ?? 0);
  enc.u32(options.blend ?? 0);
  enc.u32(options.flags ?? 0);
  const uv = options.uv ?? [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < 6; i++) enc.f32(uv[i]);
  enc.end();
}

/** A mesh (id 1, 4 vertices, 6 indices) and a node buffer (id 1, 4 slots). */
function meshScene(enc: CommandEncoder): void {
  meshUpload(enc, 1, 4, 6);
  alloc(enc, GfxOp.GFX_NODE_BUFFER_ALLOC, 1, 4);
  upload(enc, GfxOp.GFX_NODE_UPLOAD, 1, 0, 2, GFX_NODE_BYTES);
}

function pipelineDesc(
  backend: MaskBackend,
  label: string,
): RenderPipelineDesc | undefined {
  return backend.pipelines.find(p => p.label === label);
}

/** Normal and pick variants of every kind, warmed at init and restore. */
const INIT_PIPELINES = [
  'cozygpu.graphics.shape.0',
  'cozygpu.graphics.shape.6',
  'cozygpu.graphics.mesh.0',
  'cozygpu.graphics.mesh.6',
  'cozygpu.graphics.unified.0',
  'cozygpu.graphics.unified.6',
];

describe('graphics core: pipelines', () => {
  it('creates the normal and pick pipelines of both kinds at init', async () => {
    const { backend } = await setup();
    expect(backend.pipelines.map(p => p.label)).toEqual(INIT_PIPELINES);
    const shape = pipelineDesc(backend, 'cozygpu.graphics.shape.0')!;
    expect(shape.topology).toBe('triangle-strip');
    expect(shape.blend).toBe('normal');
    expect(shape.vertexBuffers[0].stride).toBe(GFX_SHAPE_BYTES);
    expect(shape.vertexBuffers[0].stepMode).toBe('instance');
    expect(shape.bindGroupLayouts).toHaveLength(1);
    const mesh = pipelineDesc(backend, 'cozygpu.graphics.mesh.0')!;
    expect(mesh.topology).toBe('triangle-list');
    expect(mesh.vertexBuffers.map(b => [b.stride, b.stepMode])).toEqual([
      [GFX_MESH_VERTEX_BYTES, 'vertex'],
      [GFX_NODE_BYTES, 'instance'],
    ]);
    expect(mesh.bindGroupLayouts).toHaveLength(3);
  });

  it('reports pick pipelines as pending until they compile', async () => {
    const backend = new MaskBackend();
    const ctx = createMaskContext(backend, 1);
    const deltas: number[] = [];
    (
      ctx as { pickPipelinePending?: (delta: 1 | -1) => void }
    ).pickPipelinePending = d => deltas.push(d);
    const core = createGraphicsCoreSystem() as GraphicsCoreSystem;
    await core.init(ctx);
    await settle();
    // One begin per pick variant (shapes, meshes), each ended once.
    expect(deltas.filter(d => d > 0)).toHaveLength(2);
    expect(deltas.reduce((a, d) => a + d, 0)).toBe(0);
  });

  it('matches the main pass sample count', async () => {
    const { backend } = await setup({}, 4);
    for (const p of backend.pipelines) {
      const pick = p.colorFormat === PICK_TARGET_FORMAT;
      expect(p.sampleCount).toBe(pick ? 1 : 4);
    }
  });

  it('creates other blend modes on first use and skips the draw meanwhile', async () => {
    const { backend, core } = await setup();
    backend.stallPipelines = true;
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 8);
    drawShapes(enc, 1, 0, 2, 1);
    drawShapes(enc, 1, 2, 3, 0);
    const pass = run(core, enc);
    expect(pipelineDesc(backend, 'cozygpu.graphics.shape.1')!.blend).toBe(
      'add',
    );
    // The add draw waits; the normal one draws.
    expect(pass.calls.filter(c => c.startsWith('draw'))).toEqual([
      'draw 4x3@2',
    ]);
    // Requested once, not every frame.
    const again = encoder();
    drawShapes(again, 1, 0, 2, 1);
    run(core, again, 2);
    expect(
      backend.pipelines.filter(p => p.label === 'cozygpu.graphics.shape.1'),
    ).toHaveLength(1);
  });

  it('uses the stencil-write variant for MASK_WRITE draws', async () => {
    const { backend, core } = await setup();
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 4);
    drawShapes(enc, 1, 0, 1, 0, GfxDrawFlag.MASK_WRITE);
    run(core, enc);
    await settle();
    const desc = pipelineDesc(backend, 'cozygpu.graphics.shape.5')!;
    expect(desc.fragmentEntry).toBe('fs_mask');
    expect(desc.colorWriteDisabled).toBe(true);
    expect(desc.depthFormat).toBe(MASK_STENCIL_FORMAT);
    expect(desc.stencil).toEqual({
      compare: 'equal',
      passOp: 'increment-clamp',
    });
    const enc2 = encoder();
    drawShapes(enc2, 1, 0, 1, 2, GfxDrawFlag.MASK_WRITE);
    const pass = run(core, enc2, 2);
    expect(pass.calls).toContain('pipeline cozygpu.graphics.shape.5');
    expect(pass.calls).toContain('draw 4x1@0');
  });

  it('never builds stencil pipelines without caps.stencil', async () => {
    const { backend, core } = await setup({ stencil: false });
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 4);
    drawShapes(enc, 1, 0, 1, 0, GfxDrawFlag.MASK_WRITE);
    const pass = run(core, enc);
    expect(pipelineDesc(backend, 'cozygpu.graphics.shape.5')).toBeUndefined();
    expect(pass.calls.some(c => c.startsWith('draw'))).toBe(false);
  });

  it('GLSL: one program per fragment variant, selected with a #define', async () => {
    const backend = new MaskBackend();
    backend.caps = { ...backend.caps, shaderLanguage: 'glsl300es' };
    const defines: string[] = [];
    const create = backend.createShaderModule.bind(backend);
    backend.createShaderModule = (source: {
      label?: string;
      glsl?: { fragment?: string };
    }) => {
      const second = source.glsl!.fragment!.split('\n')[1];
      defines.push(
        `${source.label} ${second.startsWith('#define') ? second : '-'}`,
      );
      return create(source);
    };
    const core = createGraphicsCoreSystem() as GraphicsCoreSystem;
    await core.init(createMaskContext(backend));
    await settle();
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 4);
    // WebGL2 draws shapes through the unified batch only.
    drawShapes(enc, 1, 0, 1, 0, GfxDrawFlag.MASK_WRITE);
    enc.begin(GfxOp.GFX_DRAW_UNIFIED, GFX_DRAW_UNIFIED_BYTES, CommandFlag.DRAW);
    for (const w of [1, 0, 6, 1, 0, 0, 0, 0, 0, 0, GfxDrawFlag.MASK_WRITE]) {
      enc.u32(w);
    }
    enc.end();
    run(core, enc);
    expect(defines).toEqual([
      'cozygpu.graphics.mesh -',
      'cozygpu.graphics.mesh #define PICK',
      'cozygpu.graphics.unified -',
      'cozygpu.graphics.unified #define PICK',
      'cozygpu.graphics.unified #define MASK',
    ]);
  });
});

describe('graphics core: uploads', () => {
  it('allocates, uploads and bounds-checks shape and node buffers', async () => {
    const { backend, core } = await setup();
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 2, 10);
    alloc(enc, GfxOp.GFX_NODE_BUFFER_ALLOC, 3, 5);
    upload(enc, GfxOp.GFX_SHAPE_UPLOAD, 2, 4, 3, GFX_SHAPE_BYTES);
    upload(enc, GfxOp.GFX_SHAPE_UPLOAD, 2, 9, 2, GFX_SHAPE_BYTES); // overflow
    upload(enc, GfxOp.GFX_NODE_UPLOAD, 3, 1, 4, GFX_NODE_BYTES);
    upload(enc, GfxOp.GFX_SHAPE_UPLOAD, 7, 0, 1, GFX_SHAPE_BYTES); // unknown
    run(core, enc);
    expect(backend.writes).toEqual([
      {
        label: 'cozygpu.graphics.shapes#2',
        offset: 4 * GFX_SHAPE_BYTES,
        bytes: 3 * GFX_SHAPE_BYTES,
      },
      {
        label: 'cozygpu.graphics.nodes#3',
        offset: GFX_NODE_BYTES,
        bytes: 4 * GFX_NODE_BYTES,
      },
    ]);
  });

  it('shared uploads read from byteOffset + first × stride', async () => {
    const { backend, ctx, core } = await setup();
    const shared = new ArrayBuffer(GFX_SHAPE_BYTES * 8);
    (ctx as { getShared: (id: number) => ArrayBuffer | undefined }).getShared =
      id => (id === 5 ? shared : undefined);
    const sources: number[] = [];
    const write = backend.writeBuffer.bind(backend);
    backend.writeBuffer = (buffer, offset, data, dataOffset = 0, bytes) => {
      sources.push(dataOffset);
      write(buffer, offset, data, dataOffset, bytes);
    };
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 8);
    enc.begin(GfxOp.GFX_SHAPE_UPLOAD_SHARED, 20, 0);
    enc.u32(1);
    enc.u32(2); // first
    enc.u32(3); // count
    enc.u32(5); // sharedId
    enc.u32(GFX_SHAPE_BYTES); // byteOffset of slot 0
    enc.end();
    run(core, enc);
    expect(sources).toEqual([3 * GFX_SHAPE_BYTES]);
    expect(backend.writes[0]).toMatchObject({
      offset: 2 * GFX_SHAPE_BYTES,
      bytes: 3 * GFX_SHAPE_BYTES,
    });
  });

  it('meshes: u16 indices padded to 4 bytes, buffers grow ×1.5 and never shrink', async () => {
    const { backend, core } = await setup();
    const created: { label: string; size: number }[] = [];
    const create = backend.createBuffer.bind(backend);
    backend.createBuffer = (desc: { label?: string; size: number }) => {
      created.push({ label: desc.label ?? '', size: desc.size });
      return create(desc);
    };
    const enc = encoder();
    meshUpload(enc, 1, 10, 3);
    run(core, enc);
    expect(created).toEqual([
      { label: 'cozygpu.graphics.mesh#1', size: 10 * GFX_MESH_VERTEX_BYTES },
      { label: 'cozygpu.graphics.indices#1', size: 8 },
    ]);
    expect(backend.writes.map(w => w.bytes)).toEqual([120, 8]);
    // Slightly larger: ×1.5; smaller: kept.
    const enc2 = encoder();
    meshUpload(enc2, 1, 11, 4);
    meshUpload(enc2, 1, 2, 3);
    run(core, enc2, 2);
    expect(created.slice(2)).toEqual([
      { label: 'cozygpu.graphics.mesh#1', size: 180 },
    ]);
  });

  it('meshes: u32 indices and destroy', async () => {
    const { backend, core } = await setup();
    const enc = encoder();
    meshUpload(enc, 4, 3, 3, true);
    alloc(enc, GfxOp.GFX_NODE_BUFFER_ALLOC, 1, 1);
    drawMesh(enc, { mesh: 4 });
    const pass = run(core, enc);
    expect(pass.calls).toContain('index cozygpu.graphics.indices#4 uint32');
    expect(backend.writes.map(w => w.bytes)).toEqual([36, 12]);
    const enc2 = encoder();
    enc2.begin(GfxOp.GFX_MESH_DESTROY, 4, 0);
    enc2.u32(4);
    enc2.end();
    drawMesh(enc2, { mesh: 4 });
    const pass2 = run(core, enc2, 2);
    expect(pass2.calls.some(c => c.startsWith('drawIndexed'))).toBe(false);
  });
});

describe('graphics core: draws', () => {
  it('draws one instanced quad strip per GFX_DRAW_SHAPES', async () => {
    const { core } = await setup();
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 100);
    drawShapes(enc, 1, 10, 90);
    drawShapes(enc, 1, 90, 20); // past the buffer: skipped
    drawShapes(enc, 1, 0, 0); // empty: skipped
    const pass = run(core, enc);
    expect(pass.calls).toEqual([
      'beginPass main',
      'pipeline cozygpu.graphics.shape.0',
      'bind 0 view',
      'vertex 0 cozygpu.graphics.shapes#1',
      'draw 4x90@10',
    ]);
  });

  it('draws an index range once per run of node records', async () => {
    const { core } = await setup();
    const enc = encoder();
    meshScene(enc);
    drawMesh(enc, { firstIndex: 3, indexCount: 3, firstNode: 1, nodeCount: 3 });
    drawMesh(enc, { firstIndex: 3, indexCount: 6 }); // past the indices
    drawMesh(enc, { firstNode: 2, nodeCount: 3 }); // past the nodes
    const pass = run(core, enc);
    expect(pass.calls).toEqual([
      'beginPass main',
      'pipeline cozygpu.graphics.mesh.0',
      'bind 0 view',
      'bind 1 white',
      'bind 2 cozygpu.graphics.uv @0',
      'vertex 0 cozygpu.graphics.mesh#1',
      'vertex 1 cozygpu.graphics.nodes#1',
      'index cozygpu.graphics.indices#1 uint16',
      'drawIndexed 3x3 i3 @1',
    ]);
  });

  it('textured draws take one uv slot each (equal matrices share it)', async () => {
    const { backend, core } = await setup();
    const enc = encoder();
    meshScene(enc);
    const uv = [0.5, 0, 0, 0.25, 0.1, 0.2];
    drawMesh(enc, { flags: GfxDrawFlag.TEXTURED, tex: 7, uv });
    drawMesh(enc, { flags: GfxDrawFlag.TEXTURED, tex: 7, uv });
    drawMesh(enc, { flags: GfxDrawFlag.TEXTURED, uv: [2, 0, 0, 2, 0, 0] });
    drawMesh(enc); // untextured: slot 0
    const before = backend.writes.length;
    const pass = run(core, enc);
    expect(pass.calls.filter(c => c.startsWith('bind 2'))).toEqual([
      'bind 2 cozygpu.graphics.uv @256',
      'bind 2 cozygpu.graphics.uv @256',
      'bind 2 cozygpu.graphics.uv @512',
      'bind 2 cozygpu.graphics.uv @0',
    ]);
    const uvWrites = backend.writes
      .slice(before)
      .filter(w => w.label === 'cozygpu.graphics.uv');
    expect(uvWrites).toEqual([
      { label: 'cozygpu.graphics.uv', offset: 256, bytes: 32 },
      { label: 'cozygpu.graphics.uv', offset: 512, bytes: 32 },
    ]);
    // The next frame starts at slot 1 again.
    const enc2 = encoder();
    drawMesh(enc2, { flags: GfxDrawFlag.TEXTURED, uv });
    const pass2 = run(core, enc2, 2);
    expect(pass2.calls).toContain('bind 2 cozygpu.graphics.uv @256');
  });

  it('grows the uv buffer mid-frame and retires the old one after the frame', async () => {
    const backend = new MaskBackend();
    const uvBuffers: RhiBuffer[] = [];
    const create = backend.createBuffer.bind(backend);
    backend.createBuffer = (desc: { label?: string; size: number }) => {
      const buffer = create(desc);
      if (desc.label === 'cozygpu.graphics.uv') uvBuffers.push(buffer);
      return buffer;
    };
    const ctx = createMaskContext(backend);
    const core = createGraphicsCoreSystem() as GraphicsCoreSystem;
    await core.init(ctx);
    await settle();
    const enc = encoder();
    meshScene(enc);
    for (let i = 0; i < 20; i++) {
      drawMesh(enc, {
        flags: GfxDrawFlag.TEXTURED,
        uv: [i + 1, 0, 0, 1, 0, 0],
      });
    }
    const pass = run(core, enc);
    expect(pass.calls.filter(c => c.startsWith('bind 2')).pop()).toBe(
      'bind 2 cozygpu.graphics.uv @5120',
    );
    expect(uvBuffers.map(b => b.size)).toEqual([16 * 256, 32 * 256]);
    // run() ended the frame: the outgrown buffer is gone, the new one stays.
    const flags = uvBuffers.map(
      b => (b as unknown as { destroyed: boolean }).destroyed,
    );
    expect(flags).toEqual([true, false]);
  });
});

describe('graphics core: picking', () => {
  it('replays shapes and meshes with the pick variants, never mask geometry', async () => {
    const { backend, core } = await setup();
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 4);
    meshScene(enc);
    drawShapes(enc, 1, 0, 2, 3);
    drawShapes(enc, 1, 2, 1, 0, GfxDrawFlag.MASK_WRITE);
    drawMesh(enc, { flags: GfxDrawFlag.TEXTURED, tex: 3 });
    run(core, enc, 1, true);
    await settle();
    const shapePick = pipelineDesc(backend, 'cozygpu.graphics.shape.6')!;
    expect(shapePick.colorFormat).toBe(PICK_TARGET_FORMAT);
    expect(shapePick.sampleCount).toBe(1);
    expect(shapePick.blend).toBe('none');
    expect(shapePick.fragmentEntry).toBe('fs_pick');
    expect(pipelineDesc(backend, 'cozygpu.graphics.mesh.6')).toBeDefined();
    const enc2 = encoder();
    drawShapes(enc2, 1, 0, 2, 3);
    drawShapes(enc2, 1, 2, 1, 0, GfxDrawFlag.MASK_WRITE);
    drawMesh(enc2, { flags: GfxDrawFlag.TEXTURED, tex: 3 });
    const pass = run(core, enc2, 2, true);
    const pick = pass.calls.slice(
      pass.calls.lastIndexOf('pipeline cozygpu.graphics.shape.6'),
    );
    expect(pick).toEqual([
      'pipeline cozygpu.graphics.shape.6',
      'bind 0 pickView',
      'vertex 0 cozygpu.graphics.shapes#1',
      'draw 4x2@0',
      'pipeline cozygpu.graphics.mesh.6',
      'bind 0 pickView',
      'bind 1 white',
      'bind 2 cozygpu.graphics.uv @0',
      'vertex 0 cozygpu.graphics.mesh#1',
      'vertex 1 cozygpu.graphics.nodes#1',
      'index cozygpu.graphics.indices#1 uint16',
      'drawIndexed 3x1 i0 @0',
    ]);
  });

  it('is invisible to picking without integer render targets', async () => {
    const { backend, core } = await setup({ integerRenderTargets: false });
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 4);
    drawShapes(enc, 1, 0, 1);
    run(core, enc, 1, true);
    expect(pipelineDesc(backend, 'cozygpu.graphics.shape.6')).toBeUndefined();
  });
});

describe('graphics core: device loss', () => {
  it('restore drops GPU objects without destroying them and rebuilds pipelines', async () => {
    const { backend, ctx, core } = await setup();
    const enc = encoder();
    alloc(enc, GfxOp.GFX_SHAPE_BUFFER_ALLOC, 1, 4);
    meshScene(enc);
    run(core, enc);
    backend.calls.length = 0;
    backend.pipelines.length = 0;
    await core.restore(ctx);
    await settle();
    expect(backend.pipelines.map(p => p.label)).toEqual(INIT_PIPELINES);
    // Nothing of the lost device survives: the draws wait for re-uploads.
    const enc2 = encoder();
    drawShapes(enc2, 1, 0, 1);
    drawMesh(enc2);
    const pass = run(core, enc2, 2);
    expect(pass.calls.some(c => c.startsWith('draw'))).toBe(false);
  });

  it('drops pipelines that resolve after a restore', async () => {
    const backend = new MaskBackend();
    backend.caps = { ...backend.caps, vertexStorage: false };
    const ctx = createMaskContext(backend);
    const core = createGraphicsCoreSystem();
    const resolvers: (() => void)[] = [];
    const destroyed: string[] = [];
    backend.createRenderPipeline = (desc: RenderPipelineDesc) => {
      backend.pipelines.push(desc);
      return new Promise(resolve => {
        resolvers.push(() =>
          resolve({
            label: desc.label,
            destroy: () => destroyed.push(desc.label ?? ''),
          }),
        );
      });
    };
    await core.init(ctx);
    const stale = resolvers.splice(0);
    await core.restore(ctx);
    for (const r of stale) r();
    await settle();
    expect(destroyed).toEqual(INIT_PIPELINES);
    core.destroy();
  });
});
