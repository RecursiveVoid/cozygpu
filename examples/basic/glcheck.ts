// In-browser self-test of the WebGL2 backend
// (/examples/basic/?mode=glcheck). Every check writes 'ok' or a failure
// message to __basic.checks; __basic.done flips when all ran. Also usable in
// a worker-less headless run: no DOM besides one canvas.
import { createBackend } from '../../src/backend/createBackend';
import {
  BufferUsage,
  ShaderStage,
  TextureUsage,
  type Backend,
} from '../../src/backend/types';
import * as G from '../../src/backend/webgl2/glconst';
import spriteVert from '../../src/shaders/sprite/sprite.vert.glsl';
import spriteFrag from '../../src/shaders/sprite/sprite.frag.glsl';
import spritePick from '../../src/shaders/sprite/sprite.pick.frag.glsl';
import {
  PICK_TARGET_FORMAT,
  SPRITE_INSTANCE_BYTES,
  VIEW_UNIFORM_BYTES,
} from '../../src/types/layouts';

interface Status {
  checks: Record<string, string>;
  errors: string[];
  done: boolean;
  backend: string;
  caps: unknown;
}

/** Constants that live on extension objects rather than the context. */
const EXTENSION_CONSTANTS: Record<string, string> = {
  COMPRESSED_RGBA_S3TC_DXT1_EXT: 'WEBGL_compressed_texture_s3tc',
  COMPRESSED_RGBA_S3TC_DXT5_EXT: 'WEBGL_compressed_texture_s3tc',
  COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 'WEBGL_compressed_texture_s3tc_srgb',
  COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 'WEBGL_compressed_texture_s3tc_srgb',
  COMPRESSED_RED_RGTC1_EXT: 'EXT_texture_compression_rgtc',
  COMPRESSED_RED_GREEN_RGTC2_EXT: 'EXT_texture_compression_rgtc',
  COMPRESSED_RGBA_BPTC_UNORM_EXT: 'EXT_texture_compression_bptc',
  COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 'EXT_texture_compression_bptc',
  COMPRESSED_R11_EAC: 'WEBGL_compressed_texture_etc',
  COMPRESSED_RG11_EAC: 'WEBGL_compressed_texture_etc',
  COMPRESSED_RGB8_ETC2: 'WEBGL_compressed_texture_etc',
  COMPRESSED_SRGB8_ETC2: 'WEBGL_compressed_texture_etc',
  COMPRESSED_RGBA8_ETC2_EAC: 'WEBGL_compressed_texture_etc',
  COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 'WEBGL_compressed_texture_etc',
  COMPRESSED_RGBA_ASTC_4x4_KHR: 'WEBGL_compressed_texture_astc',
  COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 'WEBGL_compressed_texture_astc',
  COMPLETION_STATUS_KHR: 'KHR_parallel_shader_compile',
};

function near(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  tolerance: number,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (Math.abs(a[i] - b[i]) > tolerance) return false;
  return true;
}

export async function runGlCheck(status: Status): Promise<void> {
  const check = async (
    name: string,
    fn: () => Promise<string | void> | string | void,
  ): Promise<void> => {
    try {
      const result = await fn();
      status.checks[name] = result ?? 'ok';
    } catch (err) {
      status.checks[name] = `FAIL: ${(err as Error)?.message ?? String(err)}`;
    }
  };

  // 1. Every numeric constant equals the real enum.
  await check('constants', () => {
    const probe = new OffscreenCanvas(1, 1).getContext(
      'webgl2',
    ) as unknown as Record<string, unknown> & WebGL2RenderingContext;
    const bad: string[] = [];
    let skipped = 0;
    for (const [name, value] of Object.entries(G)) {
      const extName = EXTENSION_CONSTANTS[name];
      const source = extName
        ? (probe.getExtension(extName) as Record<string, unknown> | null)
        : probe;
      if (!source) {
        skipped++;
        continue;
      }
      if (source[name] !== value)
        bad.push(`${name}=${String(source[name])} (have ${value})`);
    }
    if (bad.length) throw new Error(bad.join(', '));
    return skipped ? `ok (${skipped} extension constants skipped)` : 'ok';
  });

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  const backend: Backend = await createBackend(canvas, {
    preference:
      (params.get('backend') as 'auto' | 'webgpu' | 'webgl2') ?? 'webgl2',
    debug: true,
  });
  status.backend = backend.kind;
  status.caps = backend.caps;
  backend.resize(64, 64);
  // On WebGPU only the backend-agnostic checks run (RHI parity: readTexture,
  // integer clears, external image origins, MSAA resolve).
  const gl = backend.caps.shaderLanguage === 'glsl300es';
  const glOnly = async (
    name: string,
    fn: () => Promise<string | void>,
  ): Promise<void> => (gl ? check(name, fn) : undefined);

  const rt = (format: 'rgba8unorm' | 'rg32uint' | 'r32uint', w = 1, h = 1) =>
    backend.createTexture({
      width: w,
      height: h,
      format,
      usage:
        TextureUsage.RENDER_TARGET |
        TextureUsage.COPY_SRC |
        TextureUsage.SAMPLED |
        TextureUsage.COPY_DST,
    });

  // 2. Integer clear + readTexture (tight RG packing).
  await check('readTexture rg32uint clear', async () => {
    const tex = rt('rg32uint');
    const list = backend.beginCommands();
    list
      .beginRenderPass({
        color: {
          target: tex,
          load: 'clear',
          clearColor: new Float32Array([7, 9, 0, 0]),
        },
      })
      .end();
    list.submit();
    const out = Array.from(
      new Uint32Array(await backend.readTexture(tex, 0, 0, 1, 1)),
    );
    if (out.join() !== '7,9') throw new Error(`got ${out}`);
  });

  // 3. writeTexture rows round-trip (non render target: no flip).
  await check('writeTexture/readTexture rows', async () => {
    const tex = backend.createTexture({
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      usage:
        TextureUsage.SAMPLED | TextureUsage.COPY_DST | TextureUsage.COPY_SRC,
    });
    const px = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    backend.writeTexture(tex, px, 0, 0, 2, 2);
    const out = new Uint8Array(await backend.readTexture(tex, 0, 1, 2, 1));
    if (Array.from(out).join() !== '9,10,11,12,13,14,15,16')
      throw new Error(`got ${Array.from(out)}`);
  });

  // 4. Straight-alpha ImageBitmap / ImageData uploads become premultiplied.
  const straight = new ImageData(
    new Uint8ClampedArray([255, 0, 0, 128, 0, 255, 0, 255]),
    2,
    1,
  );
  await check('copyExternalImage ImageData premultiplies', async () => {
    const tex = backend.createTexture({
      width: 4,
      height: 1,
      format: 'rgba8unorm',
      usage:
        TextureUsage.SAMPLED | TextureUsage.COPY_DST | TextureUsage.COPY_SRC,
    });
    backend.copyExternalImage(straight, tex, false, 2, 0);
    const out = new Uint8Array(await backend.readTexture(tex, 2, 0, 2, 1));
    if (!near(out, [128, 0, 0, 128, 0, 255, 0, 255], 2))
      throw new Error(`got ${Array.from(out)}`);
  });
  await check(
    'copyExternalImage ImageBitmap premultiplies + flipY',
    async () => {
      const bitmap = await createImageBitmap(
        new ImageData(
          new Uint8ClampedArray([255, 0, 0, 128, 0, 0, 255, 255]),
          1,
          2,
        ),
        {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        },
      );
      const tex = backend.createTexture({
        width: 1,
        height: 2,
        format: 'rgba8unorm',
        usage:
          TextureUsage.SAMPLED | TextureUsage.COPY_DST | TextureUsage.COPY_SRC,
      });
      backend.copyExternalImage(bitmap, tex, false);
      const plain = new Uint8Array(await backend.readTexture(tex, 0, 0, 1, 2));
      backend.copyExternalImage(bitmap, tex, true);
      const flipped = new Uint8Array(
        await backend.readTexture(tex, 0, 0, 1, 2),
      );
      const msg = `plain ${Array.from(plain)} flipped ${Array.from(flipped)}`;
      if (!near(plain, [128, 0, 0, 128, 0, 0, 255, 255], 2))
        throw new Error(`not premultiplied: ${msg}`);
      if (!near(flipped, [0, 0, 255, 255, 128, 0, 0, 128], 2))
        throw new Error(`flipY ignored: ${msg}`);
    },
  );

  await check(
    'copyExternalImage default-alpha ImageBitmap into an atlas origin',
    async () => {
      const bitmap = await createImageBitmap(straight);
      const tex = backend.createTexture({
        width: 4,
        height: 2,
        format: 'rgba8unorm',
        usage:
          TextureUsage.SAMPLED | TextureUsage.COPY_DST | TextureUsage.COPY_SRC,
      });
      backend.writeTexture(tex, new Uint8Array(32).fill(9), 0, 0, 4, 2);
      backend.copyExternalImage(bitmap, tex, false, 1, 1);
      const out = new Uint8Array(await backend.readTexture(tex, 0, 1, 4, 1));
      if (
        !near(out, [9, 9, 9, 9, 128, 0, 0, 128, 0, 255, 0, 255, 9, 9, 9, 9], 2)
      )
        throw new Error(`got ${Array.from(out)}`);
      const top = new Uint8Array(await backend.readTexture(tex, 0, 0, 4, 1));
      if (!near(top, new Array(16).fill(9), 0))
        throw new Error(`row 0 touched: ${Array.from(top)}`);
    },
  );

  // 5. Buffers: write + fenced readBuffer.
  await check('writeBuffer/readBuffer', async () => {
    const buf = backend.createBuffer({
      size: 16,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    });
    backend.writeBuffer(buf, 4, new Uint32Array([0xdeadbeef, 42]));
    const out = Array.from(
      new Uint32Array(await backend.readBuffer(buf, 4, 8)),
    );
    if (out.join() !== `${0xdeadbeef},42`) throw new Error(`got ${out}`);
  });

  // 6. Transform feedback: out = in * 2 + gl_VertexID, written at an offset.
  await glOnly('transform feedback run', async () => {
    const shader = backend.createShaderModule({
      glsl: {
        vertex: `#version 300 es
layout(std140) uniform G0_B0 { float k; float p0; float p1; float p2; } u;
layout(location = 0) in vec4 a_in;
out vec4 o_v;
flat out uvec4 o_u;
void main() { o_v = a_in * u.k + float(gl_VertexID); o_u = uvec4(gl_VertexID); }`,
      },
    });
    const layout = backend.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX,
          type: { kind: 'uniform' },
        },
      ],
    });
    const pipeline = await backend.createFeedbackPipeline({
      shader,
      bindGroupLayouts: [layout],
      vertexBuffers: [
        {
          stride: 4,
          stepMode: 'vertex',
          attributes: [{ location: 0, format: 'float32', offset: 0 }],
        },
      ],
      varyings: ['o_v', 'o_u'],
    });
    const ubo = backend.createBuffer({
      size: 16,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(ubo, 0, new Float32Array([2, 0, 0, 0]));
    const group = backend.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: ubo } }],
    });
    const input = backend.createBuffer({
      size: 16,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(input, 0, new Float32Array([10, 20, 30, 40]));
    const output = backend.createBuffer({
      size: 32 * 4,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_SRC,
    });
    const list = backend.beginCommands();
    const pass = list.beginFeedbackPass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, input);
    pass.run(output, 32, 1, 2);
    pass.end();
    list.submit();
    const data = await backend.readBuffer(output, 32, 64);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    // Record 0 = vertex 1: in (20, 0, 0, 1) × 2 + 1 = (41, 1, 1, 3); uvec4(1).
    const got = `${Array.from(f.subarray(0, 4))} | ${Array.from(u.subarray(4, 8))} | ${Array.from(f.subarray(8, 12))}`;
    if (got !== '41,1,1,3 | 1,1,1,1 | 62,2,2,4') throw new Error(`got ${got}`);
  });

  // 7. Sprite GLSL: draw two sprites instanced (firstInstance 1) into a pick
  // target and an rgba target; read back the center pixel.
  await glOnly('sprite GLSL draw + pick', async () => {
    const viewLayout = backend.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: { kind: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
        },
      ],
    });
    const textureLayout = backend.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: { kind: 'texture', sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: { kind: 'sampler', filtering: true },
        },
      ],
    });
    const layouts = [viewLayout, textureLayout];
    const vertexBuffers = [
      {
        stride: SPRITE_INSTANCE_BYTES,
        stepMode: 'instance' as const,
        attributes: [
          { location: 1, format: 'float32x4' as const, offset: 0 },
          { location: 2, format: 'float32x2' as const, offset: 16 },
          { location: 3, format: 'unorm8x4' as const, offset: 24 },
          { location: 4, format: 'unorm16x4' as const, offset: 28 },
          { location: 5, format: 'uint32' as const, offset: 36 },
        ],
      },
    ];
    const shader = backend.createShaderModule({
      glsl: { vertex: spriteVert as string, fragment: spriteFrag as string },
    });
    const pickShader = backend.createShaderModule({
      glsl: { vertex: spriteVert as string, fragment: spritePick as string },
    });
    const [draw, pick] = await Promise.all([
      backend.createRenderPipeline({
        shader,
        bindGroupLayouts: layouts,
        vertexBuffers,
        topology: 'triangle-strip',
        blend: 'normal',
      }),
      backend.createRenderPipeline({
        shader: pickShader,
        bindGroupLayouts: layouts,
        vertexBuffers,
        topology: 'triangle-strip',
        blend: 'none',
        colorFormat: PICK_TARGET_FORMAT,
      }),
    ]);
    const view = new Float32Array([1, 0, 0, 1, 0, 0, 8, 8, 0, 0, 1, 0]);
    const ubo = backend.createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(ubo, 0, view);
    const white = backend.createTexture({
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
    });
    backend.writeTexture(
      white,
      new Uint8Array([255, 255, 255, 255]),
      0,
      0,
      1,
      1,
    );
    const sampler = backend.createSampler({});
    const g0 = backend.createBindGroup({
      layout: viewLayout,
      entries: [{ binding: 0, resource: { buffer: ubo } }],
    });
    const g1 = backend.createBindGroup({
      layout: textureLayout,
      entries: [
        { binding: 0, resource: { texture: white } },
        { binding: 1, resource: { sampler } },
      ],
    });
    // Instance 0: far away. Instance 1: covers the top-left 4×4 of the 8×8 view, red, pick id 77.
    const bytes = new ArrayBuffer(SPRITE_INSTANCE_BYTES * 2);
    const f = new Float32Array(bytes);
    const u8 = new Uint8Array(bytes);
    const u32 = new Uint32Array(bytes);
    const u16 = new Uint16Array(bytes);
    f.set([4, 0, 0, 4, 100, 100], 0);
    f.set([4, 0, 0, 4, 0, 0], 10);
    u8.set([255, 0, 0, 255], 40 + 24);
    u16.set([0, 0, 65535, 65535], (40 + 28) / 2);
    u32[(40 + 36) / 4] = 77 << 8;
    const inst = backend.createBuffer({
      size: bytes.byteLength,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(inst, 0, u8);

    const color = rt('rgba8unorm', 8, 8);
    const ids = rt('rg32uint', 8, 8);
    const list = backend.beginCommands();
    for (const [target, pipeline] of [
      [color, draw],
      [ids, pick],
    ] as const) {
      const pass = list.beginRenderPass({
        color: {
          target,
          load: 'clear',
          clearColor: new Float32Array([0, 0, 0, 0]),
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, g0);
      pass.setBindGroup(1, g1);
      pass.setVertexBuffer(0, inst);
      pass.draw(4, 1, 0, 1);
      pass.end();
    }
    list.submit();
    // Top-left pixel (RHI coordinates, top row first) is inside the sprite.
    const inside = Array.from(
      new Uint8Array(await backend.readTexture(color, 1, 1, 1, 1)),
    );
    const outside = Array.from(
      new Uint8Array(await backend.readTexture(color, 6, 6, 1, 1)),
    );
    const pickInside = Array.from(
      new Uint32Array(await backend.readTexture(ids, 1, 1, 1, 1)),
    );
    const pickOutside = Array.from(
      new Uint32Array(await backend.readTexture(ids, 1, 6, 1, 1)),
    );
    const got = `color in ${inside} out ${outside}; pick in ${pickInside} out ${pickOutside}`;
    if (
      inside.join() !== '255,0,0,255' ||
      outside.join() !== '0,0,0,0' ||
      pickInside.join() !== '77,0' ||
      pickOutside.join() !== '0,0'
    ) {
      throw new Error(got);
    }
  });

  // 8. Compressed writeTexture lands whole 4×4 blocks at block-aligned
  // origins (utils.textureBytesPerRow / textureByteLength). BC1 blocks with
  // colour1 = 0 and index 0 everywhere decode to a flat colour0, so the
  // 8×8 texture is four solid quadrants; a second write replaces one block.
  await glOnly('compressed writeTexture blocks', async () => {
    if (!backend.caps.textureCompression.bc) return 'skipped (no BC support)';
    const block = (rgb565: number): number[] => [
      rgb565 & 255,
      rgb565 >> 8,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    const RED = 0xf800;
    const GREEN = 0x07e0;
    const BLUE = 0x001f;
    const WHITE = 0xffff;
    const YELLOW = 0xffe0;
    const tex = backend.createTexture({
      label: 'bc1 quadrants',
      width: 8,
      height: 8,
      format: 'bc1-rgba-unorm',
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
    });
    // Block row 0 = (red, green), block row 1 = (blue, white).
    backend.writeTexture(
      tex,
      new Uint8Array([
        ...block(RED),
        ...block(GREEN),
        ...block(BLUE),
        ...block(WHITE),
      ]),
      0,
      0,
      8,
      8,
    );
    // One block at the bottom-right block origin: white → yellow.
    backend.writeTexture(tex, new Uint8Array(block(YELLOW)), 4, 4, 4, 4);

    const shader = backend.createShaderModule({
      label: 'bc1 blit',
      glsl: {
        vertex: `#version 300 es
void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);
}`,
        // gl_FragCoord is bottom-up; v is flipped so target row r shows texture row r.
        fragment: `#version 300 es
precision highp float;
uniform sampler2D G0_B0;
layout(location = 0) out vec4 o;
void main() { o = texture(G0_B0, vec2(gl_FragCoord.x / 8.0, 1.0 - gl_FragCoord.y / 8.0)); }`,
      },
    });
    const layout = backend.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.FRAGMENT,
          type: { kind: 'texture' },
        },
        {
          binding: 1,
          visibility: ShaderStage.FRAGMENT,
          type: { kind: 'sampler' },
        },
      ],
    });
    const pipeline = await backend.createRenderPipeline({
      label: 'bc1 blit',
      shader,
      bindGroupLayouts: [layout],
      vertexBuffers: [],
      topology: 'triangle-strip',
    });
    const group = backend.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { texture: tex } },
        {
          binding: 1,
          resource: {
            sampler: backend.createSampler({
              minFilter: 'nearest',
              magFilter: 'nearest',
            }),
          },
        },
      ],
    });
    const target = rt('rgba8unorm', 8, 8);
    const list = backend.beginCommands();
    const pass = list.beginRenderPass({
      color: {
        target,
        load: 'clear',
        clearColor: new Float32Array([0, 0, 0, 1]),
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(4);
    pass.end();
    list.submit();
    const at = async (x: number, y: number): Promise<string> =>
      Array.from(
        new Uint8Array(await backend.readTexture(target, x, y, 1, 1)),
      ).join();
    const got = `${await at(2, 2)} | ${await at(6, 2)} | ${await at(2, 6)} | ${await at(6, 6)}`;
    if (got !== '255,0,0,255 | 0,255,0,255 | 0,0,255,255 | 255,255,0,255')
      throw new Error(`quadrants ${got}`);
  });

  // 9. MSAA renderbuffer resolved into a texture target.
  await check('msaa resolve', async () => {
    const msaa = backend.createTexture({
      width: 4,
      height: 4,
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_TARGET,
      sampleCount: 4,
    });
    const target = rt('rgba8unorm', 4, 4);
    const list = backend.beginCommands();
    list
      .beginRenderPass({
        color: {
          target: msaa,
          resolveTarget: target,
          load: 'clear',
          clearColor: new Float32Array([0, 1, 0, 1]),
        },
      })
      .end();
    list.submit();
    const out = Array.from(
      new Uint8Array(await backend.readTexture(target, 3, 3, 1, 1)),
    );
    if (out.join() !== '0,255,0,255') throw new Error(`got ${out}`);
  });

  // 10. GLSL compile errors are SHADER_COMPILE with the offending line.
  await glOnly('shader error formatting', async () => {
    const bad = backend.createShaderModule({
      label: 'bad',
      glsl: {
        vertex: '#version 300 es\nvoid main() { gl_Position = vec4(nope); }',
        fragment:
          '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
      },
    });
    try {
      await backend.createRenderPipeline({
        shader: bad,
        bindGroupLayouts: [],
        vertexBuffers: [],
      });
    } catch (err) {
      const e = err as { code?: string; message: string };
      if (e.code !== 'SHADER_COMPILE' || !e.message.includes('2 | void main()'))
        throw new Error(`${e.code}: ${e.message}`);
      return;
    }
    throw new Error('no error');
  });

  // 11. Context loss + restore through WEBGL_lose_context.
  await glOnly('context loss + restore', async () => {
    const info = await new Promise<string>((resolve, reject) => {
      backend.onDeviceLost(i => {
        backend.restore().then(() => resolve(i.message), reject);
      });
      (
        backend as unknown as { simulateDeviceLoss(): void }
      ).simulateDeviceLoss();
      setTimeout(() => reject(new Error('no loss event')), 5000);
    });
    const tex = rt('r32uint');
    const list = backend.beginCommands();
    list
      .beginRenderPass({
        color: {
          target: tex,
          load: 'clear',
          clearColor: new Float32Array([5, 0, 0, 0]),
        },
      })
      .end();
    list.submit();
    const out = Array.from(
      new Uint32Array(await backend.readTexture(tex, 0, 0, 1, 1)),
    );
    if (out.join() !== '5') throw new Error(`after restore got ${out}`);
    return `ok (${info})`;
  });

  status.done = true;
  const failed = Object.entries(status.checks).filter(([, v]) =>
    v.startsWith('FAIL'),
  );
  const hud = document.getElementById('hud');
  if (hud)
    hud.textContent = `glcheck · ${backend.kind} · ${Object.keys(status.checks).length - failed.length}/${Object.keys(status.checks).length} ok`;
  for (const [name, message] of Object.entries(status.checks)) {
    console.info(`[glcheck] ${name}: ${message}`);
  }
}
