/**
 * Cheap in-batch effects on the core side (ARCHITECTURE §22.7): the sprite
 * core swaps in the effect variant of its pipeline and binds the block with a
 * dynamic offset, and carries none of it until an effect is defined.
 */
import type { RenderPass, RhiBindGroup, RhiTexture } from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, Op } from '../commands/opcodes';
import { FakeBackend } from '../renderer/testing/fakeBackend';
import { createSpriteCoreSystem } from '../sprites/core';
import type { CoreContext, CoreFrameState } from '../types/core';
import {
  SE_MATRIX,
  SPRITE_EFFECT_BYTES,
  SPRITE_INSTANCE_BYTES,
} from '../types/layouts';

const FRAME: CoreFrameState = {
  frameId: 1,
  time: 0,
  dt: 1 / 60,
  pixelWidth: 400,
  pixelHeight: 300,
  cssWidth: 400,
  cssHeight: 300,
  resolution: 1,
};

function context(backend: FakeBackend): CoreContext {
  const resource = { label: undefined, destroy: () => {} };
  const texture = {
    texture: resource as unknown as RhiTexture,
    sampler: resource,
    bindGroup: resource,
    width: 1,
    height: 1,
  };
  return {
    backend,
    viewLayout: resource,
    viewBindGroup: resource,
    textureLayout: resource,
    whiteTexture: texture,
    getTexture: () => texture,
    getShared: () => undefined,
    sampleCount: 1,
    post: () => {},
  };
}

/** Records what a draw binds, which the recording fake backend does not. */
function recorder(): { pass: RenderPass; log: string[] } {
  const log: string[] = [];
  const pass: RenderPass = {
    setPipeline: p => log.push(`pipeline ${p.label ?? ''}`),
    setBindGroup: (i: number, _g: RhiBindGroup, offsets?: Uint32Array) =>
      log.push(`bind ${i}${offsets ? ` @${offsets[0]}` : ''}`),
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    setViewport: () => {},
    setScissor: () => {},
    setStencilReference: () => {},
    draw: n => log.push(`draw ${n}`),
    drawIndexed: () => {},
    drawIndirect: () => {},
    end: () => {},
  };
  return { pass, log };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('sprite core: cheap effects', () => {
  it('binds the effect block and uses the effect pipeline, then goes back', async () => {
    const backend = new FakeBackend(400, 300);
    const system = createSpriteCoreSystem();
    await system.init(context(backend));

    const encoder = createCommandEncoder();
    encoder.begin(Op.SPRITE_BUFFER_ALLOC, 8);
    encoder.u32(1);
    encoder.u32(4);
    const block = new Float32Array(SPRITE_EFFECT_BYTES >> 2);
    block[SE_MATRIX >> 2] = 0.25;
    encoder.begin(Op.SPRITE_DEFINE_EFFECT, 4 + SPRITE_EFFECT_BYTES);
    encoder.u32(3);
    encoder.bytes(block, 0, SPRITE_EFFECT_BYTES);
    encoder.begin(Op.SPRITE_SET_EFFECT, 4, CommandFlag.DRAW);
    encoder.u32(3);
    encoder.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
    encoder.u32(1);
    encoder.u32(0);
    encoder.u32(2);
    encoder.u32(0);
    encoder.u32(0);
    encoder.begin(Op.SPRITE_SET_EFFECT, 4, CommandFlag.DRAW);
    encoder.u32(0);
    encoder.begin(Op.SPRITE_DRAW, 20, CommandFlag.DRAW);
    encoder.u32(1);
    encoder.u32(0);
    encoder.u32(2);
    encoder.u32(0);
    encoder.u32(0);

    const decoder = createCommandDecoder();
    decoder.reset(encoder.finish(1));
    const offsets: number[] = [];
    while (decoder.next()) offsets.push(decoder.reader.commandOffset);

    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    decoder.seek(offsets[1]);
    system.execute(decoder.reader, FRAME);
    await settle();

    const { pass, log } = recorder();
    for (let i = 2; i < offsets.length; i++) {
      decoder.seek(offsets[i]);
      system.draw(decoder.reader, pass, FRAME);
    }
    expect(log).toEqual([
      'pipeline cozygpu.sprite.effect.normal',
      'bind 0',
      'bind 1',
      'bind 2 @0',
      'draw 4',
      'pipeline cozygpu.sprite.normal',
      'bind 0',
      'bind 1',
      'draw 4',
    ]);

    // The block reached the GPU exactly once, at the effect's slot.
    const buffer = backend.buffers.find(
      b => b.label === 'cozygpu.sprite.effects',
    );
    expect(buffer).toBeDefined();
    expect(new Float32Array(buffer!.bytes.buffer, 0, 1)[0]).toBeCloseTo(0.25);
    system.destroy();
  });

  it('never touches the effect chunk when no effect is defined', async () => {
    const backend = new FakeBackend(400, 300);
    const system = createSpriteCoreSystem();
    await system.init(context(backend));
    const encoder = createCommandEncoder();
    encoder.begin(Op.SPRITE_BUFFER_ALLOC, 8);
    encoder.u32(1);
    encoder.u32(4);
    const decoder = createCommandDecoder();
    decoder.reset(encoder.finish(1));
    decoder.next();
    system.execute(decoder.reader, FRAME);
    await settle();
    expect(
      backend.buffers.some(b => b.label === 'cozygpu.sprite.effects'),
    ).toBe(false);
    system.destroy();
  });

  it('re-uploads its effects after a device restore', async () => {
    const backend = new FakeBackend(400, 300);
    const ctx = context(backend);
    const system = createSpriteCoreSystem();
    await system.init(ctx);
    const encoder = createCommandEncoder();
    const block = new Uint8Array(SPRITE_EFFECT_BYTES);
    encoder.begin(Op.SPRITE_DEFINE_EFFECT, 4 + SPRITE_EFFECT_BYTES);
    encoder.u32(1);
    encoder.bytes(block, 0, SPRITE_EFFECT_BYTES);
    const decoder = createCommandDecoder();
    decoder.reset(encoder.finish(1));
    decoder.next();
    system.execute(decoder.reader, FRAME);
    await settle();
    const before = backend.buffers.filter(
      b => b.label === 'cozygpu.sprite.effects',
    ).length;
    expect(before).toBeGreaterThan(0);
    await system.restore(ctx);
    await settle();
    const effects = backend.buffers.filter(
      b => b.label === 'cozygpu.sprite.effects',
    );
    expect(effects.length).toBeGreaterThan(before);
    // The lost device's buffer is dropped, never deleted on the new one
    // (WebGL2 reports that as an error).
    expect((effects[0] as unknown as { destroyed: boolean }).destroyed).toBe(
      false,
    );
    system.destroy();
  });

  it('keeps the instance record at 40 bytes', () => {
    expect(SPRITE_INSTANCE_BYTES).toBe(40);
  });
});
