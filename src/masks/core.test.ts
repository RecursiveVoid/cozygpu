/**
 * Mask core: the scissor stack, the stencil attachment and its pass break,
 * the fallbacks that keep a mask from ever drawing unclipped, and device
 * restore (ARCHITECTURE §21.3).
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, MaskFlag, MaskOp } from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import type { CoreSystem } from '../types/core';
import { SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { createMaskCoreSystem } from './core';
import {
  MaskBackend,
  RecordList,
  createFrameState,
  createMaskContext,
  type MaskContext,
} from './testutil';

const decoder = createCommandDecoder();

/** Feeds one packet through a system the way RenderCore does. */
function run(
  system: CoreSystem,
  encoder: CommandEncoder,
  frameId: number,
  list = new RecordList(),
): RecordList {
  const frame = createFrameState(frameId);
  const packet = encoder.finish(frameId);
  decoder.reset(packet);
  const reader = decoder.reader;
  const draws: number[] = [];
  while (decoder.next()) {
    if ((reader.flags & CommandFlag.DRAW) !== 0)
      draws.push(reader.commandOffset);
    else system.execute(reader, frame);
  }
  let pass = list.beginRenderPass({
    label: 'main',
    color: { target: 'canvas', load: 'clear' },
  });
  for (let i = 0; i < draws.length; i++) {
    decoder.seek(draws[i]);
    if ((reader.flags & CommandFlag.PASS_BREAK) !== 0 && system.passBreak) {
      pass.end();
      const desc = system.passBreak(reader, list, frame);
      pass = list.beginRenderPass(
        desc ?? { label: 'main', color: { target: 'canvas', load: 'load' } },
      );
    }
    system.draw(reader, pass, frame);
  }
  pass.end();
  system.endFrame?.(frame);
  return list;
}

function pushScissor(
  encoder: CommandEncoder,
  id: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  encoder.begin(MaskOp.MASK_PUSH_SCISSOR, 24, CommandFlag.DRAW);
  encoder.u32(id);
  encoder.f32(x);
  encoder.f32(y);
  encoder.f32(w);
  encoder.f32(h);
  encoder.u32(0);
  encoder.end();
}

function pop(encoder: CommandEncoder, id: number, breakPass = false): void {
  encoder.begin(
    MaskOp.MASK_POP,
    4,
    breakPass ? CommandFlag.DRAW | CommandFlag.PASS_BREAK : CommandFlag.DRAW,
  );
  encoder.u32(id);
  encoder.end();
}

/** One 20×20 quad at (10, 10), uploaded into mask buffer `bufferId`. */
function uploadQuad(encoder: CommandEncoder, bufferId: number): void {
  encoder.begin(MaskOp.MASK_BUFFER_ALLOC, 8, 0);
  encoder.u32(bufferId);
  encoder.u32(1);
  encoder.end();
  const quad = new Float32Array(SPRITE_INSTANCE_BYTES / 4);
  quad[0] = 20;
  quad[3] = 20;
  quad[4] = 10;
  quad[5] = 10;
  encoder.begin(MaskOp.MASK_UPLOAD, 12 + SPRITE_INSTANCE_BYTES, 0);
  encoder.u32(bufferId);
  encoder.u32(0);
  encoder.u32(1);
  encoder.bytes(quad);
  encoder.end();
}

function pushStencil(
  encoder: CommandEncoder,
  id: number,
  bufferId: number,
  flags = MaskFlag.ALPHA_TEST,
  breakPass = true,
): void {
  encoder.begin(
    MaskOp.MASK_PUSH_STENCIL,
    28,
    breakPass ? CommandFlag.DRAW | CommandFlag.PASS_BREAK : CommandFlag.DRAW,
  );
  encoder.u32(id);
  encoder.u32(bufferId);
  encoder.u32(0);
  encoder.u32(1);
  encoder.u32(0);
  encoder.u32(flags);
  encoder.f32(0.5);
  encoder.end();
}

async function setup(sampleCount: 1 | 4 = 1): Promise<{
  system: CoreSystem;
  backend: MaskBackend;
  ctx: MaskContext;
  encoder: CommandEncoder;
}> {
  const backend = new MaskBackend();
  const ctx = createMaskContext(backend, sampleCount);
  const system = createMaskCoreSystem();
  await system.init(ctx);
  const encoder = createCommandEncoder(4096);
  encoder.reset();
  return { system, backend, ctx, encoder };
}

describe('mask core: scissor stack', () => {
  it('intersects nested rects and restores the outer one on pop', async () => {
    const { system, encoder } = await setup();
    pushScissor(encoder, 1, 10, 10, 100, 100);
    pushScissor(encoder, 2, 50, 0, 100, 40);
    pop(encoder, 2);
    pop(encoder, 1);
    const list = run(system, encoder, 1);
    expect(list.pass.calls.filter(c => c.startsWith('scissor'))).toEqual([
      'scissor 10 10 100 100',
      'scissor 50 10 60 30',
      'scissor 10 10 100 100',
      'scissor 0 0 400 300',
    ]);
  });

  it('scales the rect by the device pixel ratio and clips it to the canvas', async () => {
    const backend = new MaskBackend();
    const ctx = createMaskContext(backend);
    const system = createMaskCoreSystem();
    await system.init(ctx);
    const encoder = createCommandEncoder(1024);
    encoder.reset();
    pushScissor(encoder, 1, -20, 10, 1000, 20);
    const frame = createFrameState(1, 2);
    const packet = encoder.finish(1);
    decoder.reset(packet);
    const list = new RecordList();
    const pass = list.beginRenderPass({
      label: 'main',
      color: { target: 'canvas', load: 'clear' },
    });
    while (decoder.next()) system.draw(decoder.reader, pass, frame);
    expect(list.pass.calls).toContain('scissor 0 20 400 40');
  });

  it('ignores a pop whose mask is not on the stack', async () => {
    const { system, encoder } = await setup();
    pop(encoder, 99);
    const list = run(system, encoder, 1);
    expect(list.pass.calls.filter(c => c.startsWith('scissor'))).toHaveLength(
      0,
    );
  });
});

describe('mask core: stencil', () => {
  it('breaks the pass for the stencil attachment, then increments and decrements', async () => {
    const { system, backend, encoder } = await setup();
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    const stencilPass = list.passes.find(p => p.depth !== undefined)!;
    expect(stencilPass).toBeDefined();
    expect(stencilPass.depth!.stencilLoad).toBe('clear');
    expect(stencilPass.color.load).toBe('load');
    expect(
      backend.textures.some(t => t.format === 'depth24plus-stencil8'),
    ).toBe(true);
    const calls = list.pass.calls;
    expect(calls).toContain('pipeline cozygpu.mask.increment');
    expect(calls).toContain('pipeline cozygpu.mask.decrement');
    // The subtree draws at reference 1; the pop puts it back to 0.
    expect(calls.filter(c => c.startsWith('ref'))).toEqual([
      'ref 0',
      'ref 1',
      'ref 1',
      'ref 0',
    ]);
  });

  it('clears the stencil once per frame and keeps it for later masks', async () => {
    const { system, encoder } = await setup();
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const first = run(system, encoder, 1);
    expect(first.passes.find(p => p.depth)!.depth!.stencilLoad).toBe('clear');

    const encoder2 = createCommandEncoder(4096);
    encoder2.reset();
    pushStencil(encoder2, 8, 1);
    pop(encoder2, 8);
    const second = run(system, encoder2, 1);
    expect(second.passes.find(p => p.depth)!.depth!.stencilLoad).toBe('load');

    const encoder3 = createCommandEncoder(4096);
    encoder3.reset();
    pushStencil(encoder3, 9, 1);
    pop(encoder3, 9);
    const third = run(system, encoder3, 2);
    expect(third.passes.find(p => p.depth)!.depth!.stencilLoad).toBe('clear');
  });

  it('raises the whole canvas first for an inverted mask', async () => {
    const { system, encoder } = await setup();
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1, MaskFlag.ALPHA_TEST | MaskFlag.INVERT);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    const pipelines = list.pass.calls.filter(c => c.startsWith('pipeline'));
    expect(pipelines).toEqual([
      'pipeline cozygpu.mask.increment',
      'pipeline cozygpu.mask.decrement',
      'pipeline cozygpu.mask.increment',
      'pipeline cozygpu.mask.decrement',
    ]);
  });

  it('clips to the mask bounds when the main pass is multisampled', async () => {
    const { system, ctx, encoder } = await setup(4);
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    expect(list.passes.some(p => p.depth !== undefined)).toBe(false);
    expect(list.pass.calls).toContain('scissor 10 10 20 20');
    expect(ctx.messages.some(m => m.type === 'error')).toBe(true);
  });

  it('clips to the mask bounds while the pipelines are still compiling', async () => {
    const backend = new MaskBackend();
    backend.stallPipelines = true;
    const ctx = createMaskContext(backend);
    const system = createMaskCoreSystem();
    void system.init(ctx);
    await Promise.resolve();
    const encoder = createCommandEncoder(4096);
    encoder.reset();
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    expect(list.pass.calls).toContain('scissor 10 10 20 20');
    expect(list.pass.calls.some(c => c.startsWith('pipeline'))).toBe(false);
  });
});

describe('mask core: lifecycle', () => {
  it('rebuilds its pipelines after a device restore and drops the buffers', async () => {
    const { system, backend, ctx, encoder } = await setup();
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    run(system, encoder, 1);
    const before = backend.pipelines.length;
    await system.restore(ctx);
    expect(backend.pipelines.length).toBe(before * 2);

    // The front re-allocates on the generation bump; until then nothing draws
    // through the stencil, and the mask still clips (bounds are gone with the
    // buffer, so the push is simply not honoured).
    const next = createCommandEncoder(4096);
    next.reset();
    pushStencil(next, 7, 1);
    pop(next, 7);
    const list = run(system, next, 2);
    expect(list.pass.calls.some(c => c.startsWith('pipeline'))).toBe(false);
  });

  it('destroy releases the stencil texture and the buffers', async () => {
    const { system, backend, encoder } = await setup();
    uploadQuad(encoder, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    run(system, encoder, 1);
    system.destroy();
    expect(backend.textures.every(t => t.destroyed)).toBe(true);
  });
});
