/**
 * Core half of filters (ARCHITECTURE §22.2): the pass break, the ping-pong
 * chain passes and the composite, driven through the real command stream with
 * the recording fake backend.
 */
import type { RhiTexture } from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, FilterOp } from '../commands/opcodes';
import type { CommandDecoder } from '../commands/types';
import { FakeBackend } from '../renderer/testing/fakeBackend';
import type { CoreContext, CoreFrameState } from '../types/core';
import { FILTER_UNIFORM_OFFSET, MASK_MAX_DEPTH } from '../types/layouts';
import { createFilterCoreSystem } from './core';
import {
  TARGET_IDLE_FRAMES,
  acquireTargetPool,
  releaseTargetPool,
} from './targets';

const FRAME: CoreFrameState = {
  frameId: 1,
  time: 0,
  dt: 1 / 60,
  pixelWidth: 800,
  pixelHeight: 600,
  cssWidth: 800,
  cssHeight: 600,
  resolution: 1,
};

const SOURCE = `struct FilterPass {
  @size(8) texel: vec2f,
  @size(8) size: vec2f,
  @size(16) area: vec4f,
  @size(4) time: f32,
  @size(12) passIndex: u32,
  @size(16) k: f32,
}
@group(2) @binding(0) var<uniform> fpass: FilterPass;
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f { return cozySample(in.uv) * fpass.k; }`;

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

/** Encodes commands, then walks them with the real decoder. */
class Stream {
  readonly encoder = createCommandEncoder();
  private readonly decoder: CommandDecoder = createCommandDecoder();

  define(id: number, passes: number, uniformBytes: number): void {
    const bytes = new TextEncoder().encode(SOURCE).byteLength;
    this.encoder.begin(FilterOp.FILTER_DEFINE, 20 + bytes);
    this.encoder.u32(id);
    this.encoder.u32(passes);
    this.encoder.u32(uniformBytes);
    this.encoder.u32(0);
    this.encoder.u32(bytes);
    this.encoder.utf8(SOURCE);
  }

  uniforms(id: number, bytes: number): void {
    this.encoder.begin(FilterOp.FILTER_SET_UNIFORMS, 12 + bytes);
    this.encoder.u32(id);
    this.encoder.u32(0);
    this.encoder.u32(bytes);
    const payload = new Uint8Array(bytes);
    new Float32Array(payload.buffer)[FILTER_UNIFORM_OFFSET >> 2] = 2;
    this.encoder.bytes(payload, 0, bytes);
  }

  begin(groupId: number, resolution = 1, x = 0, y = 0, w = 800, h = 600): void {
    this.encoder.begin(
      FilterOp.FILTER_BEGIN,
      28,
      CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    this.encoder.u32(groupId);
    this.encoder.f32(x);
    this.encoder.f32(y);
    this.encoder.f32(w);
    this.encoder.f32(h);
    this.encoder.f32(resolution);
    this.encoder.u32(0);
  }

  end(groupId: number, ids: number[]): void {
    this.encoder.begin(
      FilterOp.FILTER_END,
      16 + ids.length * 4,
      CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    this.encoder.u32(groupId);
    this.encoder.u32(0);
    this.encoder.f32(1);
    this.encoder.u32(ids.length);
    for (const id of ids) this.encoder.u32(id);
  }

  seekAll(): { decoder: CommandDecoder; offsets: number[] } {
    const packet = this.encoder.finish(1);
    this.decoder.reset(packet);
    const offsets: number[] = [];
    while (this.decoder.next()) offsets.push(this.decoder.reader.commandOffset);
    return { decoder: this.decoder, offsets };
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('filter core system', () => {
  it('captures into a pooled target and reopens the main pass', async () => {
    const backend = new FakeBackend(800, 600);
    const ctx = context(backend);
    const system = createFilterCoreSystem();
    await system.init(ctx);

    const stream = new Stream();
    stream.define(1, 2, 64);
    stream.uniforms(1, 64);
    stream.begin(7);
    stream.end(7, [1]);
    const { decoder, offsets } = stream.seekAll();

    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    decoder.seek(offsets[1]);
    system.execute(decoder.reader, FRAME);
    await settle();

    const list = backend.beginCommands();
    backend.calls.length = 0;

    decoder.seek(offsets[2]);
    const captureDesc = system.passBreak!(decoder.reader, list, FRAME);
    expect(captureDesc).not.toBeNull();
    expect(captureDesc!.color.load).toBe('clear');
    const target = captureDesc!.color.target as RhiTexture;
    expect(target).not.toBe('canvas');
    expect(target.width).toBeGreaterThanOrEqual(800);
    system.draw(
      decoder.reader,
      backend.beginCommands().beginRenderPass(captureDesc!),
      FRAME,
    );

    backend.calls.length = 0;
    decoder.seek(offsets[3]);
    const after = system.passBreak!(decoder.reader, list, FRAME);
    // Two passes for the program, each into its own pooled target.
    expect(backend.calls.filter(c => c === 'beginRenderPass')).toHaveLength(2);
    expect(backend.calls.filter(c => c === 'draw 3')).toHaveLength(2);
    // null = reopen the frame's main pass.
    expect(after).toBeNull();

    backend.calls.length = 0;
    system.draw(decoder.reader, list.beginRenderPass(captureDesc!), FRAME);
    expect(backend.calls).toContain('draw 4');

    system.endFrame!(FRAME);
    system.destroy();
  });

  it('ping-pongs between two targets instead of one per pass', async () => {
    const backend = new FakeBackend(800, 600);
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.define(1, 4, 64);
    stream.begin(7);
    stream.end(7, [1]);
    const { decoder, offsets } = stream.seekAll();
    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    await settle();
    const list = backend.beginCommands();
    decoder.seek(offsets[1]);
    system.passBreak!(decoder.reader, list, FRAME);
    decoder.seek(offsets[2]);
    system.passBreak!(decoder.reader, list, FRAME);
    // capture + two ping-pong targets, never one per pass.
    const created = backend.calls.filter(c =>
      c.startsWith('createTexture cozygpu.filter.target'),
    );
    expect(created).toHaveLength(3);
    system.endFrame!(FRAME);
    system.destroy();
  });

  it('a nested group reopens the enclosing capture, not the canvas', async () => {
    const backend = new FakeBackend(800, 600);
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.define(1, 1, 64);
    stream.begin(1);
    stream.begin(2);
    stream.end(2, [1]);
    stream.end(1, [1]);
    const { decoder, offsets } = stream.seekAll();
    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    await settle();
    const list = backend.beginCommands();

    decoder.seek(offsets[1]);
    const outer = system.passBreak!(decoder.reader, list, FRAME);
    decoder.seek(offsets[2]);
    const inner = system.passBreak!(decoder.reader, list, FRAME);
    expect(inner).not.toBe(outer);
    decoder.seek(offsets[3]);
    const backToOuter = system.passBreak!(decoder.reader, list, FRAME);
    expect(backToOuter).toBe(outer);
    expect(backToOuter!.color.load).toBe('load');
    decoder.seek(offsets[4]);
    expect(system.passBreak!(decoder.reader, list, FRAME)).toBeNull();
    system.endFrame!(FRAME);
    system.destroy();
  });

  it('reuses the pool across frames: no texture is created in a steady state', async () => {
    const backend = new FakeBackend(800, 600);
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.define(1, 2, 64);
    stream.begin(7);
    stream.end(7, [1]);
    const { decoder, offsets } = stream.seekAll();
    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    await settle();
    for (let frame = 0; frame < 3; frame++) {
      if (frame === 1) backend.calls.length = 0;
      const list = backend.beginCommands();
      decoder.seek(offsets[1]);
      const desc = system.passBreak!(decoder.reader, list, FRAME);
      system.draw(decoder.reader, list.beginRenderPass(desc!), FRAME);
      decoder.seek(offsets[2]);
      system.passBreak!(decoder.reader, list, FRAME);
      system.draw(decoder.reader, list.beginRenderPass(desc!), FRAME);
      system.endFrame!(FRAME);
    }
    expect(backend.calls.filter(c => c.startsWith('createTexture'))).toEqual(
      [],
    );
    system.destroy();
  });

  it('halves the target with resolution 0.5', async () => {
    const backend = new FakeBackend(1280, 720);
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.begin(7, 0.5);
    const { decoder, offsets } = stream.seekAll();
    const list = backend.beginCommands();
    decoder.seek(offsets[0]);
    const desc = system.passBreak!(decoder.reader, list, {
      ...FRAME,
      pixelWidth: 1280,
      pixelHeight: 720,
      cssWidth: 1280,
      cssHeight: 720,
    });
    const target = desc!.color.target as RhiTexture;
    expect(target.width).toBeGreaterThanOrEqual(640);
    expect(target.width).toBeLessThan(768);
    system.endFrame!(FRAME);
    system.destroy();
  });

  it('drops a capture nested past the stack depth without popping its parent', async () => {
    const backend = new FakeBackend(800, 600);
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.define(1, 1, 64);
    // One group more than the stack holds, properly nested.
    const over = MASK_MAX_DEPTH + 1;
    for (let i = 1; i <= over; i++) stream.begin(i);
    for (let i = over; i >= 1; i--) stream.end(i, [1]);
    const { decoder, offsets } = stream.seekAll();
    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    await settle();
    const list = backend.beginCommands();

    const begins: (ReturnType<NonNullable<typeof system.passBreak>> | null)[] =
      [];
    for (let i = 0; i < over; i++) {
      decoder.seek(offsets[1 + i]);
      begins.push(system.passBreak!(decoder.reader, list, FRAME));
    }
    // The captures that fit opened a target each; the overflowing one did not.
    expect(begins[MASK_MAX_DEPTH - 1]).not.toBeNull();
    expect(begins[MASK_MAX_DEPTH]).toBeNull();

    // Its FILTER_END must pop nothing: with the stack corrupted it would
    // reopen the capture of group MASK_MAX_DEPTH - 1 instead.
    decoder.seek(offsets[1 + over]);
    expect(system.passBreak!(decoder.reader, list, FRAME)).toBeNull();
    // The innermost capture that DID open is still the one that ends next.
    decoder.seek(offsets[2 + over]);
    const back = system.passBreak!(decoder.reader, list, FRAME);
    expect(back).toBe(begins[MASK_MAX_DEPTH - 2]);
    system.endFrame!(FRAME);
    system.destroy();
  });

  it('keeps one reference on the shared pool across a device restore', async () => {
    const backend = new FakeBackend(800, 600);
    // The test holds a reference too, so the pool survives until it lets go.
    const pool = acquireTargetPool(backend);
    const ctx = context(backend);
    const system = createFilterCoreSystem();
    await system.init(ctx);
    await system.restore!(ctx);
    system.destroy();
    // One acquire per system, whatever the restore count: the test's own
    // reference is now the last one, and dropping it destroys the pool.
    releaseTargetPool(backend);
    expect(() => pool.acquire(64, 64)).toThrow(/DESTROYED/);
  });

  it('drops the source bind group of a target the pool destroyed', async () => {
    const backend = new FakeBackend(800, 600);
    const sources: { destroyed: boolean }[] = [];
    const create = backend.createBindGroup.bind(backend);
    backend.createBindGroup = desc => {
      const group = create(desc);
      if (desc.label === 'cozygpu.filter.source') {
        sources.push(group as unknown as { destroyed: boolean });
      }
      return group;
    };
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.define(1, 1, 64);
    stream.begin(7);
    stream.end(7, [1]);
    const { decoder, offsets } = stream.seekAll();
    decoder.seek(offsets[0]);
    system.execute(decoder.reader, FRAME);
    await settle();
    const list = backend.beginCommands();
    decoder.seek(offsets[1]);
    system.passBreak!(decoder.reader, list, FRAME);
    decoder.seek(offsets[2]);
    system.passBreak!(decoder.reader, list, FRAME);
    system.endFrame!(FRAME);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some(g => g.destroyed)).toBe(false);

    // Idle long enough for the pool to drop the targets: their bind groups
    // must go with them instead of piling up for textures that are gone.
    for (let i = 0; i <= TARGET_IDLE_FRAMES + 1; i++) system.endFrame!(FRAME);
    expect(sources.every(g => g.destroyed)).toBe(true);
    system.destroy();
  });

  it('composites the raw capture when the chain has no ready program', async () => {
    const backend = new FakeBackend(400, 300);
    const system = createFilterCoreSystem();
    await system.init(context(backend));
    const stream = new Stream();
    stream.begin(7);
    stream.end(7, [99]);
    const { decoder, offsets } = stream.seekAll();
    const list = backend.beginCommands();
    decoder.seek(offsets[0]);
    const desc = system.passBreak!(decoder.reader, list, FRAME);
    decoder.seek(offsets[1]);
    system.passBreak!(decoder.reader, list, FRAME);
    backend.calls.length = 0;
    system.draw(decoder.reader, list.beginRenderPass(desc!), FRAME);
    expect(backend.calls).toContain('draw 4');
    system.endFrame!(FRAME);
    system.destroy();
  });
});
