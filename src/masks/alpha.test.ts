/**
 * Soft (alpha) masks: the coverage pass, the captured target and the
 * composite, driven with a stand-in for the filter target pool
 * (ARCHITECTURE §21.3, §22.4). Until that pool exists a soft mask clips to
 * its bounds instead, which the last case pins.
 */
import type { RhiTexture, TextureFormat } from '../backend/types';
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

const acquired: RhiTexture[] = [];
const released: RhiTexture[] = [];
let poolWorks = true;
/** References taken on the shared pool minus references dropped (§22.4). */
let poolRefs = 0;

jest.mock('../filters/targets', () => ({
  releaseTargetPool: () => void poolRefs--,
  acquireTargetPool: (backend: {
    createTexture(desc: {
      label: string;
      width: number;
      height: number;
      format: TextureFormat;
      usage: number;
      sampleCount: 1 | 4;
    }): RhiTexture;
  }) => {
    if (!poolWorks) throw new Error('NOT_IMPLEMENTED: filter target pool');
    poolRefs++;
    return {
      acquire: (width: number, height: number, format: TextureFormat) => {
        const texture = backend.createTexture({
          label: `pool ${acquired.length}`,
          width,
          height,
          format,
          usage: 0,
          sampleCount: 1,
        });
        acquired.push(texture);
        return texture;
      },
      release: (target: RhiTexture) => void released.push(target),
      endFrame: () => {},
      bytes: 0,
      destroy: () => {},
    };
  },
}));

const decoder = createCommandDecoder();

function quadAndPush(encoder: CommandEncoder, invert = false): void {
  encoder.begin(MaskOp.MASK_BUFFER_ALLOC, 8, 0);
  encoder.u32(1);
  encoder.u32(1);
  encoder.end();
  const quad = new Float32Array(SPRITE_INSTANCE_BYTES / 4);
  quad[0] = 20;
  quad[3] = 20;
  quad[4] = 10;
  quad[5] = 10;
  encoder.begin(MaskOp.MASK_UPLOAD, 12 + SPRITE_INSTANCE_BYTES, 0);
  encoder.u32(1);
  encoder.u32(0);
  encoder.u32(1);
  encoder.bytes(quad);
  encoder.end();
  encoder.begin(
    MaskOp.MASK_PUSH_ALPHA,
    44,
    CommandFlag.DRAW | CommandFlag.PASS_BREAK,
  );
  encoder.u32(5);
  encoder.u32(1);
  encoder.u32(0);
  encoder.u32(1);
  encoder.u32(0);
  encoder.u32(MaskFlag.ALPHA_TEST | (invert ? MaskFlag.INVERT : 0));
  encoder.f32(10);
  encoder.f32(10);
  encoder.f32(20);
  encoder.f32(20);
  encoder.f32(1);
  encoder.end();
  encoder.begin(MaskOp.MASK_POP, 4, CommandFlag.DRAW | CommandFlag.PASS_BREAK);
  encoder.u32(5);
  encoder.end();
}

/** A stencil push + pop on the same quad buffer (buffer 1, one quad). */
function pushStencil(encoder: CommandEncoder): void {
  encoder.begin(
    MaskOp.MASK_PUSH_STENCIL,
    28,
    CommandFlag.DRAW | CommandFlag.PASS_BREAK,
  );
  encoder.u32(6);
  encoder.u32(1);
  encoder.u32(0);
  encoder.u32(1);
  encoder.u32(0);
  encoder.u32(MaskFlag.ALPHA_TEST);
  encoder.f32(0.5);
  encoder.end();
  encoder.begin(MaskOp.MASK_POP, 4, CommandFlag.DRAW);
  encoder.u32(6);
  encoder.end();
}

function run(
  system: CoreSystem,
  encoder: CommandEncoder,
  frameId: number,
): RecordList {
  const frame = createFrameState(frameId);
  decoder.reset(encoder.finish(frameId));
  const reader = decoder.reader;
  const list = new RecordList();
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

async function setup(): Promise<{
  system: CoreSystem;
  backend: MaskBackend;
  ctx: MaskContext;
}> {
  const backend = new MaskBackend();
  const ctx = createMaskContext(backend);
  const system = createMaskCoreSystem();
  await system.init(ctx);
  return { system, backend, ctx };
}

beforeEach(() => {
  acquired.length = 0;
  released.length = 0;
  poolWorks = true;
  poolRefs = 0;
});

/** Pushes a soft mask, lets the chunk land, and pushes it again. */
async function pushTwice(system: CoreSystem): Promise<RecordList> {
  const first = createCommandEncoder(4096);
  first.reset();
  quadAndPush(first);
  run(system, first, 1);
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = createCommandEncoder(4096);
  second.reset();
  quadAndPush(second);
  return run(system, second, 2);
}

describe('soft masks', () => {
  it('captures the group and composites it against the coverage target', async () => {
    const { system } = await setup();
    // The first soft mask starts the import of the alpha half; that frame
    // falls back to the bounds scissor.
    const first = createCommandEncoder(4096);
    first.reset();
    quadAndPush(first);
    const fallback = run(system, first, 1);
    expect(fallback.pass.calls).toContain('scissor 10 10 20 20');
    await new Promise(resolve => setTimeout(resolve, 0));

    const second = createCommandEncoder(4096);
    second.reset();
    quadAndPush(second);
    const list = run(system, second, 2);
    // Coverage pass, capture pass, then back to the main pass.
    const labels = list.passes.map(p => p.label);
    expect(labels).toContain('cozygpu mask coverage');
    expect(labels).toContain('cozygpu mask capture');
    expect(acquired).toHaveLength(2);
    expect(released).toHaveLength(2);
    expect(list.pass.calls).toContain('pipeline cozygpu.mask.composite');
    expect(list.pass.calls).toContain('draw 3x1@0');
  });

  it('uses the inverted composite for an inverted soft mask', async () => {
    const { system } = await setup();
    const first = createCommandEncoder(4096);
    first.reset();
    quadAndPush(first, true);
    run(system, first, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = createCommandEncoder(4096);
    second.reset();
    quadAndPush(second, true);
    const list = run(system, second, 2);
    expect(list.pass.calls).toContain('pipeline cozygpu.mask.composite.invert');
  });

  it('clips to the mask bounds while the target pool is unavailable', async () => {
    poolWorks = false;
    const { system, ctx } = await setup();
    const first = createCommandEncoder(4096);
    first.reset();
    quadAndPush(first);
    run(system, first, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = createCommandEncoder(4096);
    second.reset();
    quadAndPush(second);
    const list = run(system, second, 2);
    expect(list.pass.calls).toContain('scissor 10 10 20 20');
    expect(list.passes.some(p => p.label === 'cozygpu mask capture')).toBe(
      false,
    );
    expect(ctx.messages.some(m => m.type === 'error')).toBe(true);
  });

  it('shares the filter target pool instead of building a second one', async () => {
    const { system } = await setup();
    const list = await pushTwice(system);
    expect(list.passes.map(p => p.label)).toContain('cozygpu mask capture');
    // One reference on the ONE pool per backend (§22.4), dropped on destroy
    // so the last holder — not the mask core — destroys it.
    expect(poolRefs).toBe(1);
    system.destroy();
    expect(poolRefs).toBe(0);
  });

  it('retries the soft-mask build after a failed attempt', async () => {
    poolWorks = false;
    const { system, ctx } = await setup();
    const failed = await pushTwice(system);
    expect(failed.pass.calls).toContain('scissor 10 10 20 20');
    expect(ctx.messages.some(m => m.type === 'error')).toBe(true);

    // Whatever made it fail is gone (the filter chunk landed, a restore
    // finished): the next push must try again instead of clipping forever.
    poolWorks = true;
    const recovered = await pushTwice(system);
    expect(recovered.passes.map(p => p.label)).toContain(
      'cozygpu mask capture',
    );
  });

  it('posts one message per reason, and only one per reason', async () => {
    poolWorks = false;
    // MSAA with no main pass to name: stencil masks warn their own reason,
    // which must not swallow the soft-mask one (or the other way round).
    const backend = new MaskBackend();
    const ctx = createMaskContext(backend, 4);
    const system = createMaskCoreSystem();
    await system.init(ctx);
    for (let frame = 1; frame <= 2; frame++) {
      const encoder = createCommandEncoder(4096);
      encoder.reset();
      quadAndPush(encoder);
      pushStencil(encoder);
      run(system, encoder, frame);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const reasons = new Set(
      ctx.messages
        .filter(m => m.type === 'error')
        .map(m => (m as { message: string }).message),
    );
    expect(ctx.messages.filter(m => m.type === 'error')).toHaveLength(
      reasons.size,
    );
    expect(reasons.size).toBe(2);
  });
});
