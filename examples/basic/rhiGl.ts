// WebGL2 variant of the basic RHI demo (?mode=rhi on a
// glsl300es backend): the same textured quads, animated by a transform
// feedback pass that ping-pongs two instance buffers instead of a compute
// pass writing a storage buffer.
import {
  BufferUsage,
  ShaderStage,
  TextureUsage,
  type Backend,
  type RhiBindGroup,
  type RhiBuffer,
  type RhiFeedbackPipeline,
  type RhiRenderPipeline,
  type RhiTexture,
} from '../../src/backend/types';
import { fullMipLevelCount } from '../../src/backend/utils';

const INSTANCES = 7;
const INSTANCE_BYTES = 32; // offset vec2, scale f32, angle f32, tint vec4
const GLOBALS_BYTES = 16; // resolution vec2, time f32, pad f32

const GLOBALS = `layout(std140) uniform G0_B0 { vec2 resolution; float time; float pad; } globals;`;

const SIM_VS = `#version 300 es
precision highp float;
${GLOBALS}
layout(location = 0) in vec4 a_prev0;
layout(location = 1) in vec4 a_prev1;
out vec4 o_a;
out vec4 o_b;
vec3 hue(float h) {
  return clamp(abs(fract(vec3(h, h + 0.6667, h + 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
void main() {
  float n = float(${INSTANCES});
  float i = float(gl_VertexID);
  vec2 center = globals.resolution * 0.5;
  float extent = min(center.x, center.y);
  // Fade in from the previous record: proves the input buffer is read.
  float alpha = min(1.0, a_prev1.a + 0.02);
  if (gl_VertexID == 0) {
    o_a = vec4(center, extent * 0.9, globals.time * 0.25);
    o_b = vec4(1.0, 1.0, 1.0, alpha);
    return;
  }
  float a = globals.time * 0.8 + i * 6.2831853 / (n - 1.0);
  o_a = vec4(center + vec2(cos(a), sin(a)) * extent * 0.72, extent * 0.26, -globals.time * 1.5 + i);
  o_b = vec4(hue(i / (n - 1.0)), alpha * 0.8);
}
`;

const RENDER_VS = `#version 300 es
precision highp float;
${GLOBALS}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_inst;
layout(location = 3) in vec4 a_tint;
out vec2 v_uv;
out vec4 v_tint;
void main() {
  float c = cos(a_inst.w);
  float s = sin(a_inst.w);
  vec2 p = vec2(a_corner.x * c - a_corner.y * s, a_corner.x * s + a_corner.y * c) * a_inst.z + a_inst.xy;
  gl_Position = vec4(p.x / globals.resolution.x * 2.0 - 1.0, 1.0 - p.y / globals.resolution.y * 2.0, 0.0, 1.0);
  v_uv = a_uv;
  v_tint = a_tint;
}
`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D G1_B0;
in vec2 v_uv;
in vec4 v_tint;
layout(location = 0) out vec4 o;
void main() {
  o = texture(G1_B0, v_uv) * vec4(v_tint.rgb * v_tint.a, v_tint.a);
}
`;

const BAD_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 o;
void main() {
  o = colr;
}
`;

interface Status {
  frames: number;
  restored: number;
  lost: number;
  pipelinesReady: boolean;
  errors: string[];
}

interface Scene {
  globals: RhiBuffer;
  instances: [RhiBuffer, RhiBuffer];
  vertices: RhiBuffer;
  indices: RhiBuffer;
  texture: RhiTexture;
  msaa: RhiTexture | null;
  globalsGroup: RhiBindGroup;
  textureGroup: RhiBindGroup;
  render: RhiRenderPipeline | null;
  sim: RhiFeedbackPipeline | null;
}

export async function runRhiGl(
  backend: Backend,
  canvas: HTMLCanvasElement,
  hud: HTMLElement,
  status: Status,
  fail: (err: unknown) => void,
  pixels: Uint8Array,
): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sampleCount = params.get('msaa') === '1' ? 4 : 1;
  const resize = (): void => {
    const dpr = globalThis.devicePixelRatio || 1;
    backend.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
  };
  resize();

  let generation = 0;
  const build = (): Scene => {
    const gen = ++generation;
    const globals = backend.createBuffer({
      label: 'gl globals',
      size: GLOBALS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const instances: [RhiBuffer, RhiBuffer] = [
      backend.createBuffer({
        label: 'gl instances A',
        size: INSTANCES * INSTANCE_BYTES,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
      }),
      backend.createBuffer({
        label: 'gl instances B',
        size: INSTANCES * INSTANCE_BYTES,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
      }),
    ];
    const vertices = backend.createBuffer({
      label: 'gl quad',
      size: 64,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(
      vertices,
      0,
      new Float32Array([
        -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, -0.5, 0.5, 0, 1, 0.5, 0.5, 1, 1,
      ]),
    );
    const indices = backend.createBuffer({
      label: 'gl indices',
      size: 12,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 2, 1, 3]));
    const size = 128;
    const texture = backend.createTexture({
      label: 'gl texture',
      width: size,
      height: size,
      format: 'rgba8unorm',
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
      mipLevelCount: fullMipLevelCount(size, size),
    });
    backend.writeTexture(texture, pixels, 0, 0, size, size);
    backend.generateMipmaps(texture);
    const sampler = backend.createSampler({
      label: 'gl sampler',
      mipmapFilter: 'linear',
    });
    const globalsLayout = backend.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: { kind: 'uniform', minBindingSize: GLOBALS_BYTES },
        },
      ],
    });
    const textureLayout = backend.createBindGroupLayout({
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
    const scene: Scene = {
      globals,
      instances,
      vertices,
      indices,
      texture,
      msaa: null,
      globalsGroup: backend.createBindGroup({
        layout: globalsLayout,
        entries: [{ binding: 0, resource: { buffer: globals } }],
      }),
      textureGroup: backend.createBindGroup({
        layout: textureLayout,
        entries: [
          { binding: 0, resource: { texture } },
          { binding: 1, resource: { sampler } },
        ],
      }),
      render: null,
      sim: null,
    };
    const simShader = backend.createShaderModule({
      label: 'gl sim',
      glsl: { vertex: SIM_VS },
    });
    const renderShader = backend.createShaderModule({
      label: 'gl render',
      glsl: { vertex: RENDER_VS, fragment: RENDER_FS },
    });
    const record = {
      stride: INSTANCE_BYTES,
      attributes: [
        { location: 0, format: 'float32x4' as const, offset: 0 },
        { location: 1, format: 'float32x4' as const, offset: 16 },
      ],
    };
    Promise.all([
      backend.createFeedbackPipeline({
        label: 'gl sim',
        shader: simShader,
        bindGroupLayouts: [globalsLayout],
        vertexBuffers: [{ ...record, stepMode: 'vertex' }],
        varyings: ['o_a', 'o_b'],
      }),
      backend.createRenderPipeline({
        label: 'gl render',
        shader: renderShader,
        bindGroupLayouts: [globalsLayout, textureLayout],
        vertexBuffers: [
          {
            stride: 16,
            stepMode: 'vertex',
            attributes: [
              { location: 0, format: 'float32x2', offset: 0 },
              { location: 1, format: 'float32x2', offset: 8 },
            ],
          },
          {
            stride: INSTANCE_BYTES,
            stepMode: 'instance',
            attributes: [
              { location: 2, format: 'float32x4', offset: 0 },
              { location: 3, format: 'float32x4', offset: 16 },
            ],
          },
        ],
        blend: 'normal',
        sampleCount: sampleCount as 1 | 4,
      }),
    ]).then(([sim, render]) => {
      if (gen !== generation) return;
      scene.sim = sim;
      scene.render = render;
      status.pipelinesReady = true;
    }, fail);
    return scene;
  };

  let scene = build();

  if (params.get('badshader') === '1') {
    const bad = backend.createShaderModule({
      label: 'broken.glsl',
      glsl: { vertex: RENDER_VS, fragment: BAD_FS },
    });
    backend
      .createRenderPipeline({
        label: 'broken',
        shader: bad,
        bindGroupLayouts: [],
        vertexBuffers: [],
      })
      .catch(err => {
        status.errors.push(String((err as Error).message));
        console.error(err);
      });
  }

  let lost = false;
  backend.onDeviceLost(info => {
    lost = true;
    status.lost++;
    status.pipelinesReady = false;
    console.warn(`[basic] context lost: ${info.message}; restoring…`);
    backend.restore().then(() => {
      scene = build();
      lost = false;
      status.restored++;
      console.info('[basic] context restored, resources rebuilt');
    }, fail);
  });
  if (params.get('lose') === '1') {
    setTimeout(
      () =>
        (
          backend as unknown as { simulateDeviceLoss(): void }
        ).simulateDeviceLoss(),
      1000,
    );
  }
  new ResizeObserver(resize).observe(canvas);

  const globalsData = new Float32Array(GLOBALS_BYTES / 4);
  const clearColor = new Float32Array([0.08, 0.08, 0.12, 1]);
  const passDesc = {
    label: 'gl main',
    color: {
      target: 'canvas' as RhiTexture | 'canvas',
      resolveTarget: undefined as 'canvas' | undefined,
      load: 'clear' as const,
      clearColor,
    },
  };
  const start = performance.now();
  let src = 0;

  const frame = (): void => {
    requestAnimationFrame(frame);
    const s = scene;
    if (lost || backend.pixelWidth === 0 || backend.pixelHeight === 0) return;
    const dpr = backend.pixelWidth / Math.max(1, canvas.clientWidth);
    globalsData[0] = backend.pixelWidth / dpr;
    globalsData[1] = backend.pixelHeight / dpr;
    globalsData[2] = (performance.now() - start) / 1000;
    backend.writeBuffer(s.globals, 0, globalsData);

    const list = backend.beginCommands();
    if (s.sim && s.render) {
      const fb = list.beginFeedbackPass('gl animate');
      fb.setPipeline(s.sim);
      fb.setBindGroup(0, s.globalsGroup);
      fb.setVertexBuffer(0, s.instances[src]);
      fb.run(s.instances[1 - src], 0, 0, INSTANCES);
      fb.end();
      src = 1 - src;
    }
    if (
      sampleCount === 4 &&
      (!s.msaa ||
        s.msaa.width !== backend.pixelWidth ||
        s.msaa.height !== backend.pixelHeight)
    ) {
      s.msaa?.destroy();
      s.msaa = backend.createTexture({
        label: 'gl msaa',
        width: backend.pixelWidth,
        height: backend.pixelHeight,
        format: backend.caps.canvasFormat,
        usage: TextureUsage.RENDER_TARGET,
        sampleCount: 4,
      });
    }
    if (s.msaa) {
      passDesc.color.target = s.msaa;
      passDesc.color.resolveTarget = 'canvas';
    }
    const pass = list.beginRenderPass(passDesc);
    if (s.render) {
      pass.setPipeline(s.render);
      pass.setBindGroup(0, s.globalsGroup);
      pass.setBindGroup(1, s.textureGroup);
      pass.setVertexBuffer(0, s.vertices);
      pass.setVertexBuffer(1, s.instances[src]);
      pass.setIndexBuffer(s.indices, 'uint16');
      pass.drawIndexed(6, INSTANCES);
    }
    pass.end();
    list.submit();
    status.frames++;
    if ((status.frames & 31) === 0) {
      hud.textContent = `basic (RHI) · ${backend.kind} · transform feedback · ${backend.pixelWidth}×${backend.pixelHeight} · msaa ${sampleCount} · frames ${status.frames} · restored ${status.restored}`;
    }
  };
  requestAnimationFrame(frame);
}
