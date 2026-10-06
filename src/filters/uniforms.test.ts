/**
 * The filter pass uniform block and the target pool, the parts the main
 * suites leave out (ARCHITECTURE §22.2, §22.4): the prelude bytes each
 * recorded pass gets, one slot per pass with its own dynamic offset, the
 * css → target `unit` scale at a dpr and at a reduced resolution, the
 * composite's uv rect, and the pool's edges.
 */
import type { RhiTexture } from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, FilterOp } from '../commands/opcodes';
import type { CommandDecoder } from '../commands/types';
import {
  FakeBackend,
  FakeBuffer,
  FakeTexture,
} from '../renderer/testing/fakeBackend';
import type { CoreContext, CoreFrameState } from '../types/core';
import {
  FILTER_TARGET_GRANULARITY,
  FILTER_UNIFORM_OFFSET,
  FP_AREA,
  FP_PASS,
  FP_SIZE,
  FP_TEXEL,
  FP_TIME,
  FP_UNIT,
} from '../types/layouts';
import { createFilterCoreSystem } from './core';
import {
  TARGET_IDLE_FRAMES,
  createTargetPool,
  currentPassDesc,
  releaseTargetPool,
} from './targets';

/** One slot of the pass uniform ring (WebGPU's minimum dynamic alignment). */
const STRIDE = 256;

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

function frameState(
  pixelWidth: number,
  pixelHeight: number,
  cssWidth = pixelWidth,
  cssHeight = pixelHeight,
): CoreFrameState {
  return {
    frameId: 1,
    time: 0.25,
    dt: 1 / 60,
    pixelWidth,
    pixelHeight,
    cssWidth,
    cssHeight,
    resolution: pixelWidth / cssWidth,
  };
}

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

  uniforms(id: number, bytes: number, k: number): void {
    this.encoder.begin(FilterOp.FILTER_SET_UNIFORMS, 12 + bytes);
    this.encoder.u32(id);
    this.encoder.u32(0);
    this.encoder.u32(bytes);
    const payload = new Uint8Array(bytes);
    new Float32Array(payload.buffer)[FILTER_UNIFORM_OFFSET >> 2] = k;
    this.encoder.bytes(payload, 0, bytes);
  }

  begin(
    groupId: number,
    resolution: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
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

  end(groupId: number, ids: number[], alpha = 1): void {
    this.encoder.begin(
      FilterOp.FILTER_END,
      16 + ids.length * 4,
      CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    this.encoder.u32(groupId);
    this.encoder.u32(0);
    this.encoder.f32(alpha);
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

function ring(backend: FakeBackend): Float32Array {
  const buffer = backend.buffers.find(
    b => b.label === 'cozygpu.filter.passUniforms',
  ) as FakeBuffer;
  return new Float32Array(
    buffer.bytes.buffer,
    buffer.bytes.byteOffset,
    buffer.bytes.byteLength >> 2,
  );
}

/** Runs one group through define / uniforms / begin / end. */
async function runGroup(options: {
  passes: number;
  resolution: number;
  area: [number, number, number, number];
  pixel: [number, number];
  css?: [number, number];
  alpha?: number;
}): Promise<{
  backend: FakeBackend;
  offsets: number[];
  frame: CoreFrameState;
}> {
  const [pw, ph] = options.pixel;
  const [cw, ch] = options.css ?? options.pixel;
  const backend = new FakeBackend(pw, ph);
  const frame = frameState(pw, ph, cw, ch);
  const system = createFilterCoreSystem();
  await system.init(context(backend));
  const stream = new Stream();
  stream.define(1, options.passes, 64);
  stream.uniforms(1, 64, 3);
  stream.begin(7, options.resolution, ...options.area);
  stream.end(7, [1], options.alpha ?? 1);
  const { decoder, offsets } = stream.seekAll();
  decoder.seek(offsets[0]);
  system.execute(decoder.reader, frame);
  decoder.seek(offsets[1]);
  system.execute(decoder.reader, frame);
  await settle();
  const list = backend.beginCommands();
  backend.calls.length = 0;
  decoder.seek(offsets[2]);
  const capture = system.passBreak!(decoder.reader, list, frame)!;
  system.draw(decoder.reader, list.beginRenderPass(capture), frame);
  decoder.seek(offsets[3]);
  system.passBreak!(decoder.reader, list, frame);
  system.draw(decoder.reader, list.beginRenderPass(capture), frame);
  system.endFrame!(frame);
  return { backend, offsets, frame };
}

describe('the pass uniform prelude', () => {
  it('describes the target, the css area and the pass index', async () => {
    const { backend } = await runGroup({
      passes: 2,
      resolution: 1,
      area: [100, 50, 200, 100],
      pixel: [800, 600],
    });
    const u = ring(backend);
    const target = backend.textures.find(t =>
      (t.label ?? '').startsWith('cozygpu.filter.target'),
    ) as FakeTexture;
    for (let p = 0; p < 2; p++) {
      const base = (p * STRIDE) >> 2;
      expect(u[base + FP_TEXEL / 4]).toBeCloseTo(1 / target.width, 6);
      expect(u[base + FP_TEXEL / 4 + 1]).toBeCloseTo(1 / target.height, 6);
      expect(u[base + FP_SIZE / 4]).toBe(target.width);
      expect(u[base + FP_SIZE / 4 + 1]).toBe(target.height);
      expect(
        Array.from(u.subarray(base + FP_AREA / 4, base + FP_AREA / 4 + 4)),
      ).toEqual([100, 50, 200, 100]);
      expect(u[base + FP_TIME / 4]).toBeCloseTo(0.25, 6);
      // At resolution 1 and dpr 1, one css px is one target px.
      expect(u[base + FP_UNIT / 4]).toBeCloseTo(1, 6);
      expect(u[base + FP_UNIT / 4 + 1]).toBeCloseTo(1, 6);
    }
    const asU32 = new Uint32Array(u.buffer, u.byteOffset, u.length);
    expect(asU32[FP_PASS / 4]).toBe(0);
    expect(asU32[(STRIDE >> 2) + FP_PASS / 4]).toBe(1);
  });

  it('copies the filter params in after the prelude', async () => {
    const { backend } = await runGroup({
      passes: 1,
      resolution: 1,
      area: [0, 0, 800, 600],
      pixel: [800, 600],
    });
    const u = ring(backend);
    expect(u[FILTER_UNIFORM_OFFSET >> 2]).toBe(3);
  });

  it('scales `unit` by the dpr so a width in css px means the same', async () => {
    const { backend } = await runGroup({
      passes: 1,
      resolution: 1,
      area: [0, 0, 400, 300],
      pixel: [800, 600],
      css: [400, 300],
    });
    const u = ring(backend);
    expect(u[FP_UNIT / 4]).toBeCloseTo(2, 6);
    expect(u[FP_UNIT / 4 + 1]).toBeCloseTo(2, 6);
  });

  it('halves `unit` at filterOptions.resolution 0.5', async () => {
    const { backend } = await runGroup({
      passes: 1,
      resolution: 0.5,
      area: [0, 0, 800, 600],
      pixel: [800, 600],
    });
    const u = ring(backend);
    expect(u[FP_UNIT / 4]).toBeCloseTo(0.5, 6);
    expect(u[FP_UNIT / 4 + 1]).toBeCloseTo(0.5, 6);
  });

  it('gives each pass its own slot, so the uniforms do not collapse', async () => {
    const { backend } = await runGroup({
      passes: 4,
      resolution: 1,
      area: [0, 0, 800, 600],
      pixel: [800, 600],
    });
    const asU32 = new Uint32Array(
      ring(backend).buffer,
      ring(backend).byteOffset,
    );
    for (let p = 0; p < 4; p++) {
      expect(asU32[((p * STRIDE) >> 2) + FP_PASS / 4]).toBe(p);
    }
  });

  it('writes the composite slot with the area uv rect and the world alpha', async () => {
    const { backend } = await runGroup({
      passes: 1,
      resolution: 1,
      area: [64, 32, 128, 64],
      pixel: [800, 600],
      alpha: 0.75,
    });
    const u = ring(backend);
    // Slot 0 is the chain pass, slot 1 the composite.
    const base = STRIDE >> 2;
    expect(Array.from(u.subarray(base, base + 4))).toEqual([64, 32, 128, 64]);
    const target = backend.textures.find(t =>
      (t.label ?? '').startsWith('cozygpu.filter.target'),
    ) as FakeTexture;
    expect(u[base + 4]).toBeCloseTo(64 / target.width, 6);
    expect(u[base + 5]).toBeCloseTo(32 / target.height, 6);
    expect(u[base + 6]).toBeCloseTo((64 + 128) / target.width, 6);
    expect(u[base + 7]).toBeCloseTo((32 + 64) / target.height, 6);
    expect(u[base + 8]).toBeCloseTo(0.75, 6);
  });
});

describe('target pool edges', () => {
  it('never asks for a texture larger than the backend allows', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const max = backend.caps.maxTextureSize;
    const t = pool.acquire(max * 4, max * 4) as FakeTexture;
    expect(t.width).toBeLessThanOrEqual(max);
    expect(t.height).toBeLessThanOrEqual(max);
    pool.destroy();
  });

  it('never goes below one granule, whatever is asked for', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const t = pool.acquire(1, 1) as FakeTexture;
    expect(t.width).toBe(FILTER_TARGET_GRANULARITY);
    expect(t.height).toBe(FILTER_TARGET_GRANULARITY);
    pool.destroy();
  });

  it('ignores a release of a texture it never handed out', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const mine = pool.acquire(128, 128);
    const foreign = backend.createTexture({
      width: 128,
      height: 128,
      format: 'rgba8unorm',
      usage: 0,
    });
    pool.release(foreign);
    // `mine` is still in use, so the next acquire is a different texture.
    expect(pool.acquire(128, 128)).not.toBe(mine);
    pool.destroy();
  });

  it('counts every sample of a multisampled target in its bytes', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const single = pool.acquire(128, 128, 'rgba8unorm', 1) as FakeTexture;
    const bytes = pool.bytes;
    pool.acquire(128, 128, 'rgba8unorm', 4);
    expect(pool.bytes).toBe(bytes * 5);
    expect(single.sampleCount).toBe(1);
    pool.destroy();
  });

  it('creates a fresh texture again after an idle one was destroyed', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const first = pool.acquire(128, 128) as FakeTexture;
    for (let i = 0; i <= TARGET_IDLE_FRAMES + 1; i++) pool.endFrame();
    expect(first.destroyed).toBe(true);
    const second = pool.acquire(128, 128) as FakeTexture;
    expect(second).not.toBe(first);
    expect(second.destroyed).toBe(false);
    expect(pool.bytes).toBe(128 * 128 * 4);
    pool.destroy();
  });

  it('releasing a backend nobody acquired is a no-op', () => {
    const backend = new FakeBackend();
    expect(() => releaseTargetPool(backend)).not.toThrow();
    expect(currentPassDesc(backend)).toBeNull();
  });
});
