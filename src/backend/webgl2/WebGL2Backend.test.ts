import { CozyGPUError } from '../../types/errors';
import { BufferUsage, ShaderStage, TextureUsage } from '../types';
import type { Backend, RhiBindGroupLayout, RenderPassDesc } from '../types';
import {
  compressedBlockBytes,
  bytesPerTexel,
  textureByteLength,
  textureBytesPerRow,
} from '../utils';
import { detectGLCapabilities } from './caps';
import { createFakeGL, type FakeGL } from './fakeGL.testutil';
import {
  GL_BLEND,
  GL_TEXTURE_FORMATS,
  glMinFilter,
  glVaryingBytes,
} from './formats';
import { FLUSH_EVERY_DRAWS } from './commands';
import * as G from './glconst';
import { WebGL2Backend } from './WebGL2Backend';
import spriteVert from '../../shaders/sprite/sprite.vert.glsl';
import spriteFrag from '../../shaders/sprite/sprite.frag.glsl';
import spritePick from '../../shaders/sprite/sprite.pick.frag.glsl';
import spriteWGSL from '../../shaders/sprite/sprite.wgsl';

const tick = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 5));

async function makeBackend(
  extensions?: string[],
): Promise<{ fake: FakeGL; backend: WebGL2Backend }> {
  const fake = createFakeGL({ extensions });
  const backend = await WebGL2Backend.create(
    fake.canvas as unknown as OffscreenCanvas,
    { preference: 'webgl2' },
  );
  fake.clear();
  return { fake, backend };
}

function viewLayout(b: Backend): RhiBindGroupLayout {
  return b.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: ShaderStage.VERTEX, type: { kind: 'uniform' } },
    ],
  });
}

function textureLayout(b: Backend): RhiBindGroupLayout {
  return b.createBindGroupLayout({
    entries: [
      {
        binding: 1,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'sampler' },
      },
      {
        binding: 0,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'texture' },
      },
    ],
  });
}

describe('webgl2 utils + tables', () => {
  it('sizes compressed levels in whole 4×4 blocks', () => {
    expect(compressedBlockBytes('rgba8unorm')).toBe(0);
    expect(compressedBlockBytes('bc1-rgba-unorm')).toBe(8);
    expect(compressedBlockBytes('bc7-rgba-unorm')).toBe(16);
    expect(textureBytesPerRow('bc1-rgba-unorm', 5)).toBe(16);
    expect(textureByteLength('bc3-rgba-unorm', 5, 5)).toBe(2 * 16 * 2);
    expect(textureByteLength('astc-4x4-unorm', 1, 1)).toBe(16);
    expect(textureByteLength('rgba8unorm', 3, 2)).toBe(24);
    expect(bytesPerTexel('rg32uint')).toBe(8);
    expect(bytesPerTexel('r32uint')).toBe(4);
  });

  it('maps every RHI texture format', () => {
    expect(GL_TEXTURE_FORMATS.rgba8unorm.internal).toBe(G.RGBA8);
    expect(GL_TEXTURE_FORMATS.rg32uint).toMatchObject({
      internal: G.RG32UI,
      format: G.RG_INTEGER,
      type: G.UNSIGNED_INT,
      kind: 1,
    });
    expect(GL_TEXTURE_FORMATS['bc7-rgba-unorm'].ext).toBe(
      'EXT_texture_compression_bptc',
    );
    for (const [name, f] of Object.entries(GL_TEXTURE_FORMATS)) {
      expect(f.internal).toBeGreaterThan(0);
      // Compressed formats have no transfer format, uncompressed always do.
      expect(f.format === 0).toBe(compressedBlockBytes(name as never) > 0);
    }
  });

  it('matches the WebGPU blend presets and sampler filters', () => {
    expect(GL_BLEND.normal).toEqual([
      G.ONE,
      G.ONE_MINUS_SRC_ALPHA,
      G.ONE,
      G.ONE_MINUS_SRC_ALPHA,
    ]);
    expect(GL_BLEND.add?.slice(0, 2)).toEqual([G.ONE, G.ONE]);
    expect(GL_BLEND.none).toBeNull();
    expect(glMinFilter('linear', 'nearest')).toBe(G.LINEAR_MIPMAP_NEAREST);
    expect(glMinFilter('nearest', 'linear')).toBe(G.NEAREST_MIPMAP_LINEAR);
    expect(glVaryingBytes(G.FLOAT_VEC4, 1)).toBe(16);
    expect(glVaryingBytes(G.UNSIGNED_INT_VEC4, 1)).toBe(16);
    expect(glVaryingBytes(G.FLOAT_VEC2, 1)).toBe(8);
  });

  it('reports the WebGL2 capability row of ARCHITECTURE §7', () => {
    const fake = createFakeGL();
    const caps = detectGLCapabilities(
      fake.gl,
      name =>
        name === 'EXT_color_buffer_float' ||
        name === 'WEBGL_compressed_texture_etc',
    );
    expect(caps).toMatchObject({
      backend: 'webgl2',
      shaderLanguage: 'glsl300es',
      compute: false,
      storageBuffers: false,
      vertexStorage: false,
      indirectDraw: false,
      transformFeedback: true,
      instancing: true,
      baseInstance: false,
      floatRenderTargets: true,
      integerRenderTargets: true,
      stencil: true,
      maxSampledTextures: 16,
      maxTextureSize: 8192,
      canvasFormat: 'rgba8unorm',
    });
    expect(caps.textureCompression).toEqual({
      bc: false,
      bc7: false,
      etc2: true,
      astc: false,
    });
  });
});

describe('sprite GLSL', () => {
  it('follows the §13.3 conventions and mirrors the WGSL attributes', () => {
    for (const src of [spriteVert, spriteFrag, spritePick] as string[]) {
      expect(src.startsWith('#version 300 es')).toBe(true);
    }
    const vert = spriteVert as string;
    expect(vert).toMatch(/uniform G0_B0/);
    for (let loc = 1; loc <= 5; loc++) {
      expect(vert).toMatch(new RegExp(`layout\\(location = ${loc}\\) in`));
      expect(spriteWGSL as string).toMatch(new RegExp(`@location\\(${loc}\\)`));
    }
    // View block members in WGSL order (std140 offsets equal the WGSL layout).
    const members = [
      'col0',
      'col1',
      'translate',
      'resolution',
      'time',
      'dt',
      'dpr',
      '_pad',
    ];
    let at = 0;
    for (const m of members) {
      const i = vert.indexOf(` ${m};`);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(spriteFrag as string).toMatch(/uniform sampler2D G1_B0;/);
    expect(spritePick as string).toMatch(/out uvec4/);
    expect(spritePick as string).toMatch(/< 0\.5\) discard/);
  });
});

describe('WebGL2Backend (fake context)', () => {
  it('creates a premultiplied context and enables extensions', async () => {
    const fake = createFakeGL();
    const getContext = jest.fn(() => fake.gl);
    fake.canvas.getContext = getContext;
    const backend = await WebGL2Backend.create(
      fake.canvas as unknown as OffscreenCanvas,
      { preference: 'webgl2', powerPreference: 'low-power' },
    );
    expect(getContext).toHaveBeenCalledWith(
      'webgl2',
      expect.objectContaining({
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        powerPreference: 'low-power',
      }),
    );
    expect(backend.kind).toBe('webgl2');
    expect(backend.caps.floatRenderTargets).toBe(true);
    expect(fake.calls).toContain('getExtension(EXT_color_buffer_float)');
    expect(fake.calls).toContain('pixelStorei(3317, 1)');
  });

  it('rejects UNSUPPORTED when WebGL2 is unavailable', async () => {
    const fake = createFakeGL();
    fake.canvas.getContext = () => null;
    await expect(
      WebGL2Backend.create(fake.canvas as unknown as OffscreenCanvas, {
        preference: 'webgl2',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('maps buffers to targets and writes zero-copy in element units', async () => {
    const { fake, backend } = await makeBackend();
    const vb = backend.createBuffer({
      size: 10,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    expect(vb.size).toBe(12);
    expect(fake.calls).toContain(
      `bufferData(${G.COPY_WRITE_BUFFER}, 12, ${G.DYNAMIC_DRAW})`,
    );
    fake.clear();
    backend.writeBuffer(vb, 4, new Float32Array(4), 4, 8);
    expect(fake.calls).toContain(
      `bufferSubData(${G.COPY_WRITE_BUFFER}, 4, Float32Array(16), 1, 2)`,
    );
    fake.clear();
    backend.createBuffer({ size: 6, usage: BufferUsage.INDEX });
    expect(fake.calls[1]).toBe('bindVertexArray(null)');
    expect(() =>
      backend.createBuffer({ size: 8, usage: BufferUsage.STORAGE }),
    ).toThrow(CozyGPUError);
  });

  it('allocates immutable textures, multisampled renderbuffers, and checks extensions', async () => {
    const { fake, backend } = await makeBackend();
    const tex = backend.createTexture({
      width: 64,
      height: 32,
      format: 'rgba8unorm',
      usage: TextureUsage.SAMPLED,
      mipLevelCount: 7,
    });
    expect(fake.calls).toContain(
      `texStorage2D(${G.TEXTURE_2D}, 7, ${G.RGBA8}, 64, 32)`,
    );
    expect(tex.mipLevelCount).toBe(7);
    fake.clear();
    const msaa = backend.createTexture({
      width: 10,
      height: 10,
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_TARGET,
      sampleCount: 4,
    });
    expect(msaa.sampleCount).toBe(4);
    expect(fake.calls).toContain(
      `renderbufferStorageMultisample(${G.RENDERBUFFER}, 4, ${G.RGBA8}, 10, 10)`,
    );
    expect(() =>
      backend.createTexture({
        width: 4,
        height: 4,
        format: 'bc1-rgba-unorm',
        usage: TextureUsage.SAMPLED,
      }),
    ).toThrow(/unavailable/);
  });

  it('uploads compressed levels by blocks and bitmaps premultiplied at an origin', async () => {
    const { fake, backend } = await makeBackend([
      'WEBGL_compressed_texture_s3tc',
    ]);
    const tex = backend.createTexture({
      width: 8,
      height: 8,
      format: 'bc1-rgba-unorm',
      usage: TextureUsage.SAMPLED,
      mipLevelCount: 2,
    });
    fake.clear();
    backend.writeTexture(tex, new Uint8Array(64), 0, 0, 8, 8, 0);
    backend.writeTexture(
      tex,
      new Uint8Array(100).subarray(0, 8),
      0,
      0,
      4,
      4,
      1,
    );
    expect(
      fake.calls.filter(c => c.startsWith('compressedTexSubImage2D')),
    ).toEqual([
      `compressedTexSubImage2D(${G.TEXTURE_2D}, 0, 0, 0, 8, 8, ${G.COMPRESSED_RGBA_S3TC_DXT1_EXT}, Uint8Array(32))`,
      `compressedTexSubImage2D(${G.TEXTURE_2D}, 1, 0, 0, 4, 4, ${G.COMPRESSED_RGBA_S3TC_DXT1_EXT}, Uint8Array(8))`,
    ]);
    const atlas = backend.createTexture({
      width: 16,
      height: 16,
      format: 'rgba8unorm',
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
    });
    fake.clear();
    backend.copyExternalImage(
      { width: 10, height: 4 } as ImageBitmap,
      atlas,
      true,
      8,
      2,
    );
    expect(fake.calls).toContain(
      `pixelStorei(${G.UNPACK_PREMULTIPLY_ALPHA_WEBGL}, true)`,
    );
    expect(fake.calls).toContain(`pixelStorei(${G.UNPACK_FLIP_Y_WEBGL}, true)`);
    // Clamped to the texture: 16 - 8 = 8 wide.
    expect(fake.calls).toContain(
      `texSubImage2D(${G.TEXTURE_2D}, 0, 8, 2, 8, 4, ${G.RGBA}, ${G.UNSIGNED_BYTE}, obj)`,
    );
  });

  it('rejects pipelines without GLSL and links programs with G{g}_B{b} bindings', async () => {
    const { fake, backend } = await makeBackend();
    const wgslOnly = backend.createShaderModule({
      label: 'w',
      wgsl: 'fn main() {}',
    });
    await expect(
      backend.createRenderPipeline({
        shader: wgslOnly,
        bindGroupLayouts: [],
        vertexBuffers: [],
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const shader = backend.createShaderModule({
      label: 'sprite',
      glsl: { vertex: spriteVert as string, fragment: spriteFrag as string },
    });
    const layouts = [viewLayout(backend), textureLayout(backend)];
    fake.clear();
    const desc = {
      shader,
      bindGroupLayouts: layouts,
      vertexBuffers: [
        {
          stride: 40,
          stepMode: 'instance' as const,
          attributes: [
            { location: 1, format: 'float32x4' as const, offset: 0 },
            { location: 5, format: 'uint32' as const, offset: 36 },
          ],
        },
      ],
      topology: 'triangle-strip' as const,
    };
    const [a, b] = await Promise.all([
      backend.createRenderPipeline({ ...desc, blend: 'normal' }),
      backend.createRenderPipeline({ ...desc, blend: 'add' }),
    ]);
    expect(a).not.toBe(b);
    // One program for both blend variants, bindings from the naming convention.
    expect(fake.calls.filter(c => c.startsWith('linkProgram'))).toHaveLength(1);
    expect(fake.calls).toContain(
      'getUniformBlockIndex(Program#' +
        fake.calls
          .find(c => c.startsWith('getUniformBlockIndex'))!
          .match(/#(\d+)/)![1] +
        ', G0_B0)',
    );
    expect(
      fake.calls.some(c =>
        /^uniformBlockBinding\(Program#\d+, 0, 0\)$/.test(c),
      ),
    ).toBe(true);
    expect(
      fake.calls.some(c => /^uniform1i\(loc:G1_B0#\d+, 0\)$/.test(c)),
    ).toBe(true);
    expect(fake.calls.filter(c => c.startsWith('vertexAttribDivisor'))).toEqual(
      ['vertexAttribDivisor(1, 1)', 'vertexAttribDivisor(5, 1)'],
    );
  });

  it('draws with latched groups, y-flipped viewport and firstInstance emulation', async () => {
    const { fake, backend } = await makeBackend();
    const shader = backend.createShaderModule({
      glsl: { vertex: spriteVert as string, fragment: spriteFrag as string },
    });
    const vLayout = viewLayout(backend);
    const tLayout = textureLayout(backend);
    const pipeline = await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [vLayout, tLayout],
      vertexBuffers: [
        {
          stride: 40,
          stepMode: 'instance',
          attributes: [
            { location: 1, format: 'float32x4', offset: 0 },
            { location: 3, format: 'unorm8x4', offset: 24 },
          ],
        },
      ],
      topology: 'triangle-strip',
      blend: 'add',
    });
    const ubo = backend.createBuffer({
      size: 48,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const inst = backend.createBuffer({
      size: 400,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const tex = backend.createTexture({
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      usage: TextureUsage.SAMPLED,
    });
    const sampler = backend.createSampler({});
    const g0 = backend.createBindGroup({
      layout: vLayout,
      entries: [{ binding: 0, resource: { buffer: ubo } }],
    });
    const g1 = backend.createBindGroup({
      layout: tLayout,
      entries: [
        { binding: 0, resource: { texture: tex } },
        { binding: 1, resource: { sampler } },
      ],
    });

    const clear = new Float32Array([1, 0.5, 0, 0.5]);
    const passDesc: RenderPassDesc = {
      color: { target: 'canvas', load: 'clear', clearColor: clear },
    };
    fake.clear();
    const list = backend.beginCommands();
    const pass = list.beginRenderPass(passDesc);
    // Bind groups before the pipeline: still applied at draw time.
    pass.setBindGroup(0, g0);
    pass.setBindGroup(1, g1);
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, inst);
    pass.setViewport(10, 20, 100, 50);
    pass.draw(4, 3, 0, 0);
    pass.draw(4, 2, 0, 3);
    pass.end();
    list.submit();

    const calls = fake.calls;
    expect(calls).toContain('bindFramebuffer(36160, null)');
    expect(calls).toContain('clearColor(0.5, 0.25, 0, 0.5)');
    expect(calls).toContain('viewport(10, 80, 100, 50)'); // 150 - 20 - 50
    expect(calls).toContain(
      `blendFuncSeparate(${G.ONE}, ${G.ONE}, ${G.ONE}, ${G.ONE_MINUS_SRC_ALPHA})`,
    );
    expect(
      calls.some(c =>
        /^bindBufferRange\(35345, 0, Buffer#\d+, 0, 48\)$/.test(c),
      ),
    ).toBe(true);
    expect(calls.some(c => /^bindSampler\(0, Sampler#\d+\)$/.test(c))).toBe(
      true,
    );
    expect(calls).toContain('vertexAttribPointer(1, 4, 5126, false, 40, 0)');
    expect(calls).toContain('vertexAttribPointer(3, 4, 5121, true, 40, 24)');
    expect(calls).toContain('drawArraysInstanced(5, 0, 4, 3)');
    // Emulated firstInstance = 3: instance attributes re-pointed by 3 × 40.
    expect(calls).toContain('vertexAttribPointer(1, 4, 5126, false, 40, 120)');
    expect(calls).toContain('drawArraysInstanced(5, 0, 4, 2)');
    // Second draw did not rebind groups (nothing changed).
    expect(calls.filter(c => c.startsWith('bindBufferRange'))).toHaveLength(1);
  });

  it('uses the base-instance extension when present', async () => {
    const { fake, backend } = await makeBackend([
      'WEBGL_draw_instanced_base_vertex_base_instance',
    ]);
    expect(backend.caps.baseInstance).toBe(true);
    const shader = backend.createShaderModule({
      glsl: { vertex: 'v', fragment: 'f' },
    });
    const pipeline = await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [],
      vertexBuffers: [
        {
          stride: 40,
          stepMode: 'instance',
          attributes: [{ location: 1, format: 'float32x4', offset: 0 }],
        },
      ],
    });
    const inst = backend.createBuffer({ size: 400, usage: BufferUsage.VERTEX });
    fake.clear();
    const pass = backend
      .beginCommands()
      .beginRenderPass({ color: { target: 'canvas', load: 'load' } });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, inst);
    pass.draw(6, 2, 0, 5);
    expect(fake.calls).toContain(
      'drawArraysInstancedBaseInstance(4, 0, 6, 2, 5)',
    );
    expect(fake.calls).toContain(
      'vertexAttribPointer(1, 4, 5126, false, 40, 0)',
    );
  });

  it('clears integer targets with clearBufferuiv and resolves MSAA to the canvas', async () => {
    const { fake, backend } = await makeBackend();
    const pick = backend.createTexture({
      width: 1,
      height: 1,
      format: 'rg32uint',
      usage: TextureUsage.RENDER_TARGET | TextureUsage.COPY_SRC,
    });
    fake.clear();
    const list = backend.beginCommands();
    list.beginRenderPass({ color: { target: pick, load: 'clear' } }).end();
    expect(fake.calls).toContain(
      `framebufferTexture2D(${G.FRAMEBUFFER}, ${G.COLOR_ATTACHMENT0}, ${G.TEXTURE_2D}, Texture#${fake.calls.find(c => c.startsWith('framebufferTexture2D'))!.match(/Texture#(\d+)/)![1]}, 0)`,
    );
    expect(fake.calls).toContain('clearBufferuiv(6144, 0, Uint32Array(16))');

    const msaa = backend.createTexture({
      width: 300,
      height: 150,
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_TARGET,
      sampleCount: 4,
    });
    fake.clear();
    const pass = list.beginRenderPass({
      color: { target: msaa, resolveTarget: 'canvas', load: 'clear' },
    });
    pass.end();
    list.submit();
    expect(fake.calls).toContain(
      `blitFramebuffer(0, 0, 300, 150, 0, 0, 300, 150, ${G.COLOR_BUFFER_BIT}, ${G.NEAREST})`,
    );
  });

  it('runs transform feedback into a buffer range with rasterizer discard', async () => {
    const { fake, backend } = await makeBackend();
    const shader = backend.createShaderModule({ glsl: { vertex: 'v' } });
    const pipeline = await backend.createFeedbackPipeline({
      shader,
      bindGroupLayouts: [],
      vertexBuffers: [
        {
          stride: 40,
          stepMode: 'vertex',
          attributes: [{ location: 0, format: 'float32x4', offset: 0 }],
        },
      ],
      varyings: ['o_h0', 'o_h1'],
    });
    expect(
      fake.calls.some(
        c =>
          c.startsWith('transformFeedbackVaryings(') &&
          c.endsWith(`[o_h0,o_h1], ${G.INTERLEAVED_ATTRIBS})`),
      ),
    ).toBe(true);
    const src = backend.createBuffer({
      size: 400,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const dst = backend.createBuffer({
      size: 400,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    fake.clear();
    const list = backend.beginCommands();
    const pass = list.beginFeedbackPass();
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, src);
    pass.run(dst, 80, 2, 5);
    pass.end();
    list.submit();
    const calls = fake.calls;
    const i = (prefix: string): number =>
      calls.findIndex(c => c.startsWith(prefix));
    expect(calls).toContain(`enable(${G.RASTERIZER_DISCARD})`);
    // 2 × vec4 varyings (fake reports FLOAT_VEC4) = 32 B per record.
    expect(
      calls.some(c =>
        /^bindBufferRange\(35982, 0, Buffer#\d+, 80, 160\)$/.test(c),
      ),
    ).toBe(true);
    expect(i('beginTransformFeedback(0)')).toBeLessThan(
      i('drawArrays(0, 2, 5)'),
    );
    expect(i('drawArrays(0, 2, 5)')).toBeLessThan(i('endTransformFeedback'));
    expect(calls).toContain(
      `bindBufferBase(${G.TRANSFORM_FEEDBACK_BUFFER}, 0, null)`,
    );
    expect(calls).toContain(`disable(${G.RASTERIZER_DISCARD})`);
    expect(() => {
      const p2 = backend.beginCommands().beginFeedbackPass();
      p2.setPipeline(pipeline);
      p2.setVertexBuffer(0, src);
      p2.run(dst, 0, 0, 20);
    }).toThrow(/exceeds buffer/);
    expect(() => backend.beginCommands().beginComputePass()).toThrow(
      /not available/,
    );
  });

  it('re-attaches a render target after a transform feedback draw (ANGLE/Metal stale framebuffer)', async () => {
    const { fake, backend } = await makeBackend();
    const pick = backend.createTexture({
      width: 1,
      height: 1,
      format: 'rg32uint',
      usage: TextureUsage.RENDER_TARGET | TextureUsage.COPY_SRC,
    });
    const pipeline = await backend.createFeedbackPipeline({
      shader: backend.createShaderModule({ glsl: { vertex: 'v' } }),
      bindGroupLayouts: [],
      vertexBuffers: [
        {
          stride: 16,
          stepMode: 'vertex',
          attributes: [{ location: 0, format: 'float32x4', offset: 0 }],
        },
      ],
      varyings: ['o_h0'],
    });
    const src = backend.createBuffer({ size: 64, usage: BufferUsage.VERTEX });
    const dst = backend.createBuffer({ size: 64, usage: BufferUsage.VERTEX });
    const pickPass = (): string[] => {
      fake.clear();
      const list = backend.beginCommands();
      list.beginRenderPass({ color: { target: pick, load: 'clear' } }).end();
      list.submit();
      return fake.calls.filter(c => c.startsWith('framebufferTexture2D('));
    };
    const attach = `framebufferTexture2D(${G.FRAMEBUFFER}, ${G.COLOR_ATTACHMENT0}, ${G.TEXTURE_2D}`;
    // First use creates and attaches once; a second use without feedback
    // in between reuses the framebuffer untouched.
    expect(pickPass()).toHaveLength(1);
    expect(pickPass()).toHaveLength(0);
    // A swarm frame: feedback draw, then the pick pass must detach and
    // re-attach color 0 before it clears (else ANGLE drops the writes).
    const list = backend.beginCommands();
    const fb = list.beginFeedbackPass();
    fb.setPipeline(pipeline);
    fb.setVertexBuffer(0, src);
    fb.run(dst, 0, 0, 4);
    fb.end();
    list.submit();
    const calls = pickPass();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(`${attach}, null, 0)`);
    expect(calls[1]).toMatch(/Texture#\d+, 0\)$/);
    const clearAt = fake.calls.findIndex(c => c.startsWith('clearBufferuiv'));
    expect(fake.calls.indexOf(calls[1])).toBeLessThan(clearAt);
    // Only once per feedback run.
    expect(pickPass()).toHaveLength(0);
  });

  // Regression: ~200k unbatched draws in one frame exhausted ANGLE/Metal
  // host memory and lost the context; the pass now flushes in chunks.
  it('flushes every FLUSH_EVERY_DRAWS draw calls', async () => {
    const { fake, backend } = await makeBackend();
    const pipeline = await backend.createRenderPipeline({
      shader: backend.createShaderModule({
        glsl: { vertex: 'fv', fragment: 'ff' },
      }),
      bindGroupLayouts: [],
      vertexBuffers: [],
    });
    const list = backend.beginCommands();
    const pass = list.beginRenderPass({
      color: { target: 'canvas', load: 'clear' },
    });
    pass.setPipeline(pipeline);
    fake.clear();
    const draws = FLUSH_EVERY_DRAWS * 2 + 10;
    for (let i = 0; i < draws; i++) pass.draw(6, 1);
    pass.end();
    list.submit();
    expect(
      fake.calls.filter(c => c.startsWith('drawArraysInstanced(')),
    ).toHaveLength(draws);
    expect(fake.calls.filter(c => c === 'flush()')).toHaveLength(2);
    const firstFlush = fake.calls.indexOf('flush()');
    expect(
      fake.calls
        .slice(0, firstFlush)
        .filter(c => c.startsWith('drawArraysInstanced(')),
    ).toHaveLength(FLUSH_EVERY_DRAWS);
  });

  it('reads buffers after a fence and textures packed top row first', async () => {
    const { fake, backend } = await makeBackend();
    const buf = backend.createBuffer({
      size: 16,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_SRC,
    });
    fake.readData.bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    fake.syncResults.push(0x911b /* TIMEOUT_EXPIRED */);
    const data = await backend.readBuffer(buf, 4, 4);
    expect(Array.from(new Uint8Array(data))).toEqual([9, 8, 7, 6]);
    expect(fake.calls.filter(c => c.startsWith('clientWaitSync'))).toHaveLength(
      2,
    );
    await expect(backend.readBuffer(buf, 12, 8)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    // rg32uint 1×2 render target: GL rows are bottom-up; read RGBA_INTEGER, keep RG.
    const pick = backend.createTexture({
      width: 1,
      height: 2,
      format: 'rg32uint',
      usage: TextureUsage.RENDER_TARGET,
    });
    const raw = new Uint32Array([1, 2, 0, 0, 3, 4, 0, 0]); // GL row 0, row 1
    fake.readData.bytes = new Uint8Array(raw.buffer);
    fake.clear();
    const out = new Uint32Array(await backend.readTexture(pick, 0, 0, 1, 2));
    expect(Array.from(out)).toEqual([3, 4, 1, 2]);
    expect(fake.calls).toContain(
      `readPixels(0, 0, 1, 2, ${G.RGBA_INTEGER}, ${G.UNSIGNED_INT}, 0)`,
    );
  });

  it('holds frames once PACE_FRAMES frames ran during a readback', async () => {
    const { fake, backend } = await makeBackend();
    const buf = backend.createBuffer({
      size: 16,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_SRC,
    });
    fake.readData.bytes = new Uint8Array(4);
    fake.syncResults.push(0x911b /* TIMEOUT_EXPIRED */);
    backend.beginCommands();
    const read = backend.readBuffer(buf, 0, 4);
    const held = jest.fn();
    for (let i = 0; i < 2; i++) {
      backend.beginCommands();
      expect(backend.backlogged()).toBe(false);
    }
    backend.beginCommands(); // PACE_FRAMES = 3
    expect(backend.backlogged()).toBe(true);
    backend.whenCaughtUp(held);
    expect(held).not.toHaveBeenCalled();
    await read;
    expect(held).toHaveBeenCalledTimes(1);
    expect(backend.backlogged()).toBe(false);
    const now = jest.fn();
    backend.whenCaughtUp(now);
    expect(now).toHaveBeenCalledTimes(1);
  });

  // Regression: a context lost while the core re-created programs rejected
  // DEVICE_LOST before webglcontextlost was dispatched, so RenderCore took the
  // rejection as fatal and destroyed the renderer. The loss must be reported
  // first, and the late event must not report it twice.
  it('reports a loss noticed by program creation before the pipeline rejects', async () => {
    const { fake, backend } = await makeBackend();
    const order: string[] = [];
    backend.onDeviceLost(info => order.push(`lost:${info.message}`));
    const shader = backend.createShaderModule({
      glsl: { vertex: 'v2', fragment: 'f2' },
    });
    fake.lost.value = true; // lost, event still queued
    await backend
      .createRenderPipeline({ shader, bindGroupLayouts: [], vertexBuffers: [] })
      .catch((err: CozyGPUError) => order.push(`reject:${err.code}`));
    expect(order).toEqual(['lost:WebGL context lost', 'reject:DEVICE_LOST']);
    expect(backend.lost).toBe(true);
    fake.fire('webglcontextlost');
    expect(order).toHaveLength(2);
    expect(fake.calls).toContain('preventDefault(webglcontextlost)');
  });

  it('reports context loss once, waits for restore and resets caches', async () => {
    const { fake, backend } = await makeBackend();
    const lost = jest.fn();
    backend.onDeviceLost(lost);
    const shader = backend.createShaderModule({
      glsl: { vertex: 'v', fragment: 'f' },
    });
    await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [],
      vertexBuffers: [],
    });
    const buf = backend.createBuffer({ size: 8, usage: BufferUsage.VERTEX });

    backend.simulateDeviceLoss();
    fake.fire('webglcontextlost');
    fake.fire('webglcontextlost');
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toEqual({
      reason: 'unknown',
      message: 'simulated device loss',
    });
    expect(fake.calls).toContain('preventDefault(webglcontextlost)');
    await expect(backend.readBuffer(buf, 0, 4)).rejects.toMatchObject({
      code: 'DEVICE_LOST',
    });

    fake.clear();
    const restoring = backend.restore();
    await tick();
    fake.fire('webglcontextrestored');
    await restoring;
    expect(backend.lost).toBe(false);
    expect(fake.calls).toContain('getExtension(EXT_color_buffer_float)');
    // Program cache was dropped: a new pipeline links again.
    fake.clear();
    await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [],
      vertexBuffers: [],
    });
    expect(fake.calls.filter(c => c.startsWith('linkProgram'))).toHaveLength(1);

    backend.destroy();
    expect(fake.listeners.get('webglcontextlost')).toHaveLength(0);
  });
});
