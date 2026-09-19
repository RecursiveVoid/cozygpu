import type {
  Backend,
  BufferDesc,
  RenderPass,
  RenderPipelineDesc,
  RhiBuffer,
} from '../backend/types';
import { Op } from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import spriteWGSL from '../shaders/sprite/sprite.wgsl';
import type { CoreContext, CoreTexture } from '../types/core';
import {
  SI_A,
  SI_COLOR,
  SI_FLAGS,
  SI_TX,
  SI_U0,
  SPRITE_INSTANCE_BYTES,
  VIEW_UNIFORM_BYTES,
} from '../types/layouts';
import { SpriteCoreSystem } from './core';
import { SPRITE_VERTEX_LAYOUT } from './pipeline';

/** Reader over a hand-built payload of u32 words (+ optional blob). */
function reader(
  opcode: number,
  words: number[],
  blob?: Uint8Array,
): CommandReader {
  const bytes = words.length * 4 + (blob ? (blob.length + 3) & ~3 : 0);
  const buf = new ArrayBuffer(bytes + 8);
  const u32View = new Uint32Array(buf);
  const u8 = new Uint8Array(buf);
  words.forEach((w, i) => (u32View[i] = w));
  if (blob) u8.set(blob, words.length * 4);
  let at = 0;
  return {
    opcode,
    flags: 0,
    commandOffset: 0,
    payloadOffset: 0,
    payloadBytes: bytes,
    u8,
    u32View,
    f32View: new Float32Array(buf),
    u32: () => u32View[(at += 4) / 4 - 1],
    i32: () => u32View[(at += 4) / 4 - 1] | 0,
    f32: () => 0,
    blob(n: number) {
      const o = at;
      at += (n + 3) & ~3;
      return o;
    },
    utf8: () => '',
    skip(n: number) {
      at += n;
    },
    object: () => {
      throw new Error('unused');
    },
  } as CommandReader;
}

function fakeContext(sharedBytes = SPRITE_INSTANCE_BYTES * 8) {
  const writes: {
    offset: number;
    data: ArrayBufferView;
    dataOffset?: number;
    size?: number;
  }[] = [];
  const pipelines: RenderPipelineDesc[] = [];
  const buffers: RhiBuffer[] = [];
  const res = (label?: string) => ({ label, destroy: jest.fn() });
  const backend = {
    caps: { shaderLanguage: 'wgsl' },
    createShaderModule: (s: { label?: string }) => res(s.label),
    createRenderPipeline: async (d: RenderPipelineDesc) => {
      pipelines.push(d);
      return res(d.label);
    },
    createBuffer: (d: BufferDesc) => {
      const b = { ...res(d.label), size: d.size, usage: d.usage };
      buffers.push(b);
      return b;
    },
    writeBuffer: (
      _b: RhiBuffer,
      offset: number,
      data: ArrayBufferView,
      dataOffset?: number,
      size?: number,
    ) => writes.push({ offset, data, dataOffset, size }),
  } as unknown as Backend;
  const shared = new ArrayBuffer(sharedBytes);
  const texture = { bindGroup: res('tex') } as unknown as CoreTexture;
  const ctx = {
    backend,
    viewLayout: res('view'),
    viewBindGroup: res('viewBG'),
    textureLayout: res('texLayout'),
    whiteTexture: texture,
    getTexture: () => texture,
    getShared: (id: number) => (id === 9 ? shared : undefined),
    sampleCount: 4,
    post: () => undefined,
  } as unknown as CoreContext;
  return { ctx, writes, pipelines, buffers, shared };
}

describe('SpriteCoreSystem', () => {
  it('creates one pipeline per blend mode with the instance layout', async () => {
    const { ctx, pipelines } = fakeContext();
    const sys = new SpriteCoreSystem();
    await sys.init(ctx);
    expect(pipelines.map(p => p.blend)).toEqual([
      'normal',
      'add',
      'multiply',
      'screen',
      'none',
    ]);
    expect(pipelines[0].topology).toBe('triangle-strip');
    expect(pipelines[0].sampleCount).toBe(4);
    expect(pipelines[0].vertexBuffers).toEqual([SPRITE_VERTEX_LAYOUT]);
  });

  it('allocates, uploads inline and shared, and draws', async () => {
    const { ctx, writes, buffers, shared } = fakeContext();
    const sys = new SpriteCoreSystem();
    await sys.init(ctx);
    const frame = {} as never;
    sys.execute(reader(Op.SPRITE_BUFFER_ALLOC, [3, 8]), frame);
    expect(buffers[0].size).toBe(8 * SPRITE_INSTANCE_BYTES);

    const blob = new Uint8Array(2 * SPRITE_INSTANCE_BYTES).fill(7);
    sys.execute(reader(Op.SPRITE_UPLOAD, [3, 1, 2], blob), frame);
    expect(writes[0].offset).toBe(SPRITE_INSTANCE_BYTES);
    expect(writes[0].dataOffset).toBe(12);
    expect(writes[0].size).toBe(2 * SPRITE_INSTANCE_BYTES);

    sys.execute(reader(Op.SPRITE_UPLOAD_SHARED, [3, 4, 2, 9, 0]), frame);
    expect((writes[1].data as Uint8Array).buffer).toBe(shared);
    expect(writes[1].dataOffset).toBe(4 * SPRITE_INSTANCE_BYTES);
    // out of range → ignored
    sys.execute(reader(Op.SPRITE_UPLOAD_SHARED, [3, 7, 2, 9, 0]), frame);
    expect(writes.length).toBe(2);

    const calls: unknown[][] = [];
    const pass = new Proxy(
      {},
      {
        get:
          (_t, name) =>
          (...args: unknown[]) =>
            calls.push([name, ...args]),
      },
    ) as RenderPass;
    sys.draw(reader(Op.SPRITE_DRAW, [3, 2, 5, 1, 1]), pass, frame);
    expect(calls.map(c => c[0])).toEqual([
      'setPipeline',
      'setBindGroup',
      'setBindGroup',
      'setVertexBuffer',
      'draw',
    ]);
    expect(calls[4].slice(1)).toEqual([4, 5, 0, 2]);
  });

  it('widens shared uploads in [1 MiB, 4 MiB) to 4 MiB when both buffers have room', async () => {
    const MiB = 1 << 20;
    const cap = 131072; // 5.24 MB of instances
    const { ctx, writes } = fakeContext(cap * SPRITE_INSTANCE_BYTES);
    const sys = new SpriteCoreSystem();
    await sys.init(ctx);
    const frame = {} as never;
    sys.execute(reader(Op.SPRITE_BUFFER_ALLOC, [1, cap]), frame);

    // 100k instances from 0: grows at the end.
    sys.execute(reader(Op.SPRITE_UPLOAD_SHARED, [1, 0, 100000, 9, 0]), frame);
    expect(writes[0]).toMatchObject({
      offset: 0,
      dataOffset: 0,
      size: 4 * MiB,
    });

    // Near the end: grows backwards, source and destination stay aligned.
    const first = cap - 30000;
    sys.execute(
      reader(Op.SPRITE_UPLOAD_SHARED, [1, first, 30000, 9, 0]),
      frame,
    );
    const end = cap * SPRITE_INSTANCE_BYTES;
    expect(writes[1]).toMatchObject({
      offset: end - 4 * MiB,
      dataOffset: end - 4 * MiB,
      size: 4 * MiB,
    });

    // Small writes are left alone.
    sys.execute(reader(Op.SPRITE_UPLOAD_SHARED, [1, 10, 100, 9, 0]), frame);
    expect(writes[2]).toMatchObject({
      offset: 10 * SPRITE_INSTANCE_BYTES,
      size: 100 * SPRITE_INSTANCE_BYTES,
    });

    // No room (buffer smaller than 4 MiB): unchanged.
    sys.execute(reader(Op.SPRITE_BUFFER_ALLOC, [2, 50000]), frame);
    sys.execute(reader(Op.SPRITE_UPLOAD_SHARED, [2, 0, 40000, 9, 0]), frame);
    expect(writes[3]).toMatchObject({
      offset: 0,
      size: 40000 * SPRITE_INSTANCE_BYTES,
    });
  });
});

describe('sprite.wgsl', () => {
  const src = spriteWGSL as string;

  it('declares instance attributes matching the vertex layout', () => {
    const formats: Record<string, string> = {
      float32x4: 'vec4f',
      float32x2: 'vec2f',
      unorm8x4: 'vec4f',
      unorm16x4: 'vec4f',
      uint32: 'u32',
    };
    for (const attr of SPRITE_VERTEX_LAYOUT.attributes) {
      const re = new RegExp(
        `@location\\(${attr.location}\\)\\s+\\w+:\\s*${formats[attr.format]}`,
      );
      expect(src).toMatch(re);
    }
    expect(SPRITE_VERTEX_LAYOUT.attributes.map(a => a.offset)).toEqual([
      SI_A,
      SI_TX,
      SI_COLOR,
      SI_U0,
      SI_FLAGS,
    ]);
  });

  it('View struct is 48 bytes (12 f32 fields worth of vec2f/f32)', () => {
    const body = /struct View \{([^}]*)\}/.exec(src)?.[1] ?? '';
    let bytes = 0;
    for (const m of body.matchAll(/:\s*(vec2f|f32)/g)) {
      bytes += m[1] === 'vec2f' ? 8 : 4;
    }
    expect(bytes).toBe(VIEW_UNIFORM_BYTES);
  });
});
