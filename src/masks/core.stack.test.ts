/**
 * Mask core, the stack cases the main suite leaves out (ARCHITECTURE §21.3):
 * a scissor restored across a stencil entry, nested stencil levels, the depth
 * limit, what an unbalanced frame leaves behind, and the MASK_UPLOAD /
 * MASK_BUFFER_DESTROY bookkeeping the scissor fallback depends on.
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, MaskFlag, MaskOp } from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import type { CoreSystem } from '../types/core';
import { MASK_MAX_DEPTH, SPRITE_INSTANCE_BYTES } from '../types/layouts';
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

function pop(encoder: CommandEncoder, id: number): void {
  encoder.begin(MaskOp.MASK_POP, 4, CommandFlag.DRAW);
  encoder.u32(id);
  encoder.end();
}

/** `count` quads of 20×20 at (10 + 40 i, 10), in mask buffer `bufferId`. */
function uploadQuads(
  encoder: CommandEncoder,
  bufferId: number,
  count: number,
  capacity = count,
): void {
  encoder.begin(MaskOp.MASK_BUFFER_ALLOC, 8, 0);
  encoder.u32(bufferId);
  encoder.u32(capacity);
  encoder.end();
  const words = SPRITE_INSTANCE_BYTES / 4;
  const quads = new Float32Array(words * count);
  for (let i = 0; i < count; i++) {
    const o = i * words;
    quads[o] = 20;
    quads[o + 3] = 20;
    quads[o + 4] = 10 + i * 40;
    quads[o + 5] = 10;
  }
  encoder.begin(MaskOp.MASK_UPLOAD, 12 + SPRITE_INSTANCE_BYTES * count, 0);
  encoder.u32(bufferId);
  encoder.u32(0);
  encoder.u32(count);
  encoder.bytes(quads);
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
  const encoder = createCommandEncoder(8192);
  encoder.reset();
  return { system, backend, ctx, encoder };
}

const scissors = (list: RecordList): string[] =>
  list.pass.calls.filter(c => c.startsWith('scissor'));
const refs = (list: RecordList): string[] =>
  list.pass.calls.filter(c => c.startsWith('ref'));

describe('mask core: the one stack holds every kind', () => {
  it('restores an outer scissor across an inner stencil mask', async () => {
    const { system, encoder } = await setup();
    uploadQuads(encoder, 1, 1);
    pushScissor(encoder, 1, 10, 10, 100, 100);
    pushStencil(encoder, 2, 1);
    pop(encoder, 2);
    pop(encoder, 1);
    const list = run(system, encoder, 1);
    // The stencil push breaks the pass, so the open scissor is put back on
    // the new one; the pop restores the canvas.
    expect(scissors(list)).toEqual([
      'scissor 10 10 100 100',
      'scissor 10 10 100 100',
      'scissor 0 0 400 300',
    ]);
  });

  it('counts nesting levels for two stencil masks and unwinds them', async () => {
    const { system, encoder } = await setup();
    uploadQuads(encoder, 1, 1);
    pushStencil(encoder, 1, 1);
    pushStencil(encoder, 2, 1, MaskFlag.ALPHA_TEST, false);
    pop(encoder, 2);
    pop(encoder, 1);
    const list = run(system, encoder, 1);
    // push: draw at the level in force, then raise the reference.
    // pop: lower it back. Levels go 0 → 1 → 2 → 1 → 0.
    expect(refs(list)).toEqual([
      'ref 0',
      'ref 1',
      'ref 1',
      'ref 2',
      'ref 2',
      'ref 1',
      'ref 1',
      'ref 0',
    ]);
  });

  it('breaks the pass only for the first stencil mask of the frame', async () => {
    const { system, encoder } = await setup();
    uploadQuads(encoder, 1, 1);
    pushStencil(encoder, 1, 1);
    pop(encoder, 1);
    pushStencil(encoder, 2, 1, MaskFlag.ALPHA_TEST, false);
    pop(encoder, 2);
    const list = run(system, encoder, 1);
    expect(list.passes.filter(p => p.depth !== undefined)).toHaveLength(1);
  });

  it('stops pushing past the stack depth without corrupting the rect', async () => {
    const { system, encoder } = await setup();
    const depth = MASK_MAX_DEPTH * 2;
    for (let i = 0; i < depth + 4; i++) {
      pushScissor(encoder, i + 1, 0, 0, 400 - i, 300);
    }
    for (let i = depth + 4; i > 0; i--) pop(encoder, i);
    const list = run(system, encoder, 1);
    // The pushes past the limit emit nothing, and the unwind still ends on
    // the whole canvas.
    expect(scissors(list)).toHaveLength(depth * 2);
    expect(scissors(list)[depth * 2 - 1]).toBe('scissor 0 0 400 300');
  });

  it('an intersection that misses entirely clips everything away', async () => {
    const { system, encoder } = await setup();
    pushScissor(encoder, 1, 0, 0, 50, 50);
    pushScissor(encoder, 2, 200, 200, 50, 50);
    const list = run(system, encoder, 1);
    const inner = scissors(list)[1].split(' ');
    expect([inner[3], inner[4]]).toEqual(['0', '0']);
  });

  it('an unbalanced frame starts the next one from the whole canvas', async () => {
    const { system, encoder } = await setup();
    pushScissor(encoder, 1, 10, 10, 50, 50);
    // no pop
    run(system, encoder, 1);

    const next = createCommandEncoder(1024);
    next.reset();
    pushScissor(next, 2, 0, 0, 200, 200);
    pop(next, 2);
    const list = run(system, next, 2);
    expect(scissors(list)).toEqual([
      'scissor 0 0 200 200',
      'scissor 0 0 400 300',
    ]);
  });

  it('recovers stencil masks after one unbalanced frame on WebGL2', async () => {
    // WebGL2 at one sample uses the canvas' own stencil buffer, which nobody
    // attaches and nobody clears mid-frame, so an unbalanced frame leaves
    // counts in it. The NEXT frame's main pass clears the canvas (and with it
    // that buffer), so the fallback must last one frame, not forever.
    const { system, encoder } = await setup();
    system.destroy();
    const backend = new MaskBackend();
    backend.caps = { ...backend.caps, backend: 'webgl2' };
    const ctx = createMaskContext(backend, 1);
    const gl = createMaskCoreSystem();
    await gl.init(ctx);
    void encoder;

    const good = createCommandEncoder(4096);
    good.reset();
    uploadQuads(good, 1, 1);
    pushStencil(good, 1, 1);
    pop(good, 1);
    expect(refs(run(gl, good, 1))).not.toHaveLength(0);

    // Unbalanced: push without a pop leaves level 1 behind.
    const broken = createCommandEncoder(4096);
    broken.reset();
    pushStencil(broken, 2, 1);
    run(gl, broken, 2);

    // Every later frame is back on the stencil, not clipped to the bounds
    // for the rest of the renderer's life.
    for (const frameId of [3, 4]) {
      const again = createCommandEncoder(4096);
      again.reset();
      pushStencil(again, frameId, 1);
      pop(again, frameId);
      const list = run(gl, again, frameId);
      expect(refs(list)).not.toHaveLength(0);
      expect(scissors(list)).toHaveLength(0);
    }
    gl.destroy();
  });

  it('pops the inner masks an unbalanced subtree left behind', async () => {
    const { system, encoder } = await setup();
    pushScissor(encoder, 1, 10, 10, 100, 100);
    pushScissor(encoder, 2, 20, 20, 100, 100);
    // Only the outer mask pops: the inner entry is dropped with it.
    pop(encoder, 1);
    pushScissor(encoder, 3, 0, 0, 40, 40);
    const list = run(system, encoder, 1);
    // After popping 1 the rect is the whole canvas again, so 3 is not
    // intersected with the stale inner rect.
    expect(scissors(list)[3]).toBe('scissor 0 0 40 40');
  });
});

describe('mask core: buffers and bounds', () => {
  it('measures the bounds of every uploaded quad for the fallback', async () => {
    const { system, encoder } = await setup(4);
    uploadQuads(encoder, 1, 3);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    // MSAA has no stencil attachment, so the push clips to the union of the
    // three quads: x 10..110, y 10..30.
    expect(scissors(list)).toContain('scissor 10 10 100 20');
  });

  it('ignores an upload that would run past the buffer', async () => {
    const { system, backend, encoder } = await setup(4);
    // Two quads into a buffer that holds one: the write must not happen, and
    // the reader still has to be left on the next command.
    uploadQuads(encoder, 1, 2, 1);
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    expect(backend.writes).toHaveLength(0);
    // The push still pops cleanly, and the fallback clips rather than draws.
    expect(scissors(list)).toHaveLength(2);
    expect(scissors(list)[1]).toBe('scissor 0 0 400 300');
  });

  it('an unknown mask buffer clips nothing and pops cleanly', async () => {
    const { system, encoder } = await setup(4);
    pushStencil(encoder, 7, 42);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    expect(scissors(list)).toHaveLength(0);
    expect(list.pass.calls.some(c => c.startsWith('pipeline'))).toBe(false);
  });

  it('an inverted mask that cannot use the stencil hides everything', async () => {
    const { system, encoder } = await setup(4);
    uploadQuads(encoder, 1, 1);
    pushStencil(encoder, 7, 1, MaskFlag.ALPHA_TEST | MaskFlag.INVERT);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    // One rectangle cannot express "outside this shape", so the fallback
    // clips the subtree away rather than show what the mask hides.
    expect(scissors(list)[0]).toBe('scissor 10 10 0 0');
  });

  it('MASK_BUFFER_DESTROY drops the buffer and its bounds', async () => {
    const { system, backend, encoder } = await setup(4);
    uploadQuads(encoder, 1, 1);
    encoder.begin(MaskOp.MASK_BUFFER_DESTROY, 4, 0);
    encoder.u32(1);
    encoder.end();
    pushStencil(encoder, 7, 1);
    pop(encoder, 7);
    const list = run(system, encoder, 1);
    expect(
      backend.calls.filter(c => c === 'createBuffer cozygpu.mask.quads#1'),
    ).toHaveLength(1);
    expect(scissors(list)).toHaveLength(0);
  });

  it('a second alloc under one id replaces the buffer', async () => {
    const { system, backend, encoder } = await setup();
    uploadQuads(encoder, 1, 1);
    uploadQuads(encoder, 1, 2);
    run(system, encoder, 1);
    expect(
      backend.calls.filter(c => c === 'createBuffer cozygpu.mask.quads#1'),
    ).toHaveLength(2);
  });
});
