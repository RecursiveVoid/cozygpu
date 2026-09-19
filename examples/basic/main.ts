// Owner: "webgl2" (M2; was "backend"). Entry points:
//   /examples/basic/               Public API: clear color + a textured quad (plus a tinted copy)
//                                  through createRenderer. Add ?worker=1 to render in a Web Worker.
//   /examples/basic/?mode=rhi      RHI demo: clear color + textured quads straight through the
//                                  backend (createBackend), animated by a compute pass (WebGPU) or
//                                  a transform feedback pass (WebGL2, see ./rhiGl.ts).
//   /examples/basic/?mode=glcheck  WebGL2 backend self-test (GL enum values, uploads, readbacks,
//                                  transform feedback, picking target); results in __basic.
// Query flags:
//   ?backend=auto|webgpu|webgl2    backend preference (default auto)
//   ?worker=1     (public API) OffscreenCanvas + worker core (/build/examples/cozygpu.worker.js)
//   ?msaa=1       4× MSAA target resolved into the canvas
//   ?debug=1      WebGPU error scopes around creation + frames
//   ?lose=1       simulate a device (WebGL2: context) loss after ~1 s and recover (RHI mode, or
//                 public API with ?debug=1 — works in worker mode too, M2)
//   ?badshader=1  (RHI mode) compile a broken shader to show the formatted error
import * as GPU from 'cozygpu';
import { createBackend } from '../../src/backend/createBackend';
import {
  BufferUsage,
  ShaderStage,
  TextureUsage,
  type Backend,
  type RhiBindGroup,
  type RhiBuffer,
  type RhiComputePipeline,
  type RhiRenderPipeline,
  type RhiTexture,
} from '../../src/backend/types';
import { fullMipLevelCount } from '../../src/backend/utils';
import { runGlCheck } from './glcheck';
import { runRhiGl } from './rhiGl';

const params = new URLSearchParams(location.search);
const backendParam = params.get('backend');
const preference: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';

/** Both backends expose this internal testing hook. */
type LossSimulator = { simulateDeviceLoss(): void };
/** @internal Renderer debug hook (see Transport.debug); dev-only. */
type Debuggable = { _debug(action: 'loseDevice'): void };
const hud = document.getElementById('hud') as HTMLElement;

/** Read by the headless check (puppeteer-core). */
const status = {
  mode: params.get('mode') ?? 'renderer',
  backend: '' as string,
  /** M2: set when backend 'auto' fell back to WebGL2 (renderer.info). */
  fallbackReason: undefined as string | undefined,
  worker: params.get('worker') === '1',
  frames: 0,
  restored: 0,
  lost: 0,
  pipelinesReady: false,
  caps: null as unknown,
  errors: [] as string[],
  /** glcheck results: name → 'ok' or a failure message. */
  checks: {} as Record<string, string>,
  done: false,
};
(globalThis as { __basic?: typeof status }).__basic = status;

// ─── Public API variant ───────────────────────────────────────────────────────

async function runRenderer(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const debug = params.get('debug') === '1';
  if (debug)
    (globalThis as { __COZYGPU_DEBUG__?: boolean }).__COZYGPU_DEBUG__ = true;
  const renderer = await GPU.createRenderer({
    canvas,
    backend: preference,
    background: 0x14141f,
    antialias: params.get('msaa') === '1',
    worker: status.worker
      ? { url: '/build/examples/cozygpu.worker.js' }
      : false,
    onDeviceLost: info => {
      status.lost++;
      console.warn(
        `[basic] device lost (willRestore ${info.willRestore}): ${info.message}`,
      );
    },
    onDeviceRestored: () => {
      status.restored++;
      console.info('[basic] device restored');
    },
    debug,
  });
  // Dev handle for the headless verification driver (examples only).
  (globalThis as { __renderer?: unknown }).__renderer = renderer;
  status.caps = renderer.info.capabilities;
  status.backend = renderer.info.backend;
  status.fallbackReason = renderer.info.fallbackReason;

  const size = 128;
  const texture = GPU.Texture.fromPixels(
    size,
    size,
    makeTexturePixels(size, false),
  );

  const quad = new GPU.Sprite({ texture, anchor: 0.5 });
  const tinted = new GPU.Sprite({ texture, anchor: 0.5, tint: 0xff88cc });
  tinted.alpha = 0.75;
  renderer.stage.addChild(quad);
  renderer.stage.addChild(tinted);

  if (params.get('lose') === '1') {
    setTimeout(() => {
      // M2: one path for both modes. `_debug` reaches the core through the
      // transport, so it works when the core lives in a worker; it is a no-op
      // unless the core was created with debug: true.
      (renderer as unknown as Debuggable)._debug('loseDevice');
      const core = (
        globalThis as { __COZYGPU_CORE__?: { backend: LossSimulator } }
      ).__COZYGPU_CORE__;
      if (!core && !status.worker) {
        fail(
          '?lose=1 needs ?debug=1 in public API mode (the core is exposed only in debug)',
        );
      }
    }, 1000);
  }

  let hudTimer = 0;
  GPU.ticker(renderer).add((dt, time) => {
    const w = renderer.width;
    const h = renderer.height;
    const extent = Math.min(w, h);
    quad.x = w / 2;
    quad.y = h / 2;
    quad.width = extent * 0.6;
    quad.height = extent * 0.6;
    quad.rotation = time * 0.25;
    tinted.x = w / 2 + Math.cos(time) * extent * 0.3;
    tinted.y = h / 2 + Math.sin(time) * extent * 0.3;
    tinted.width = extent * 0.25;
    tinted.height = extent * 0.25;
    tinted.rotation = -time;
    status.frames++;
    status.pipelinesReady = true;
    hudTimer += dt;
    if (hudTimer > 0.5) {
      hudTimer = 0;
      const s = renderer.stats;
      hud.textContent = `basic · ${renderer.info.backend} · ${status.worker ? 'worker' : 'main thread'} · ${renderer.width}×${renderer.height}@${renderer.resolution} · frame ${s.frameId} · draws ${s.drawCalls} · ${s.packetBytes} B · skipped ${s.skippedFrames}`;
    }
  });
}

// ─── RHI variant ──────────────────────────────────────────────────────────────

const INSTANCES = 7;
const INSTANCE_BYTES = 32; // struct Instance { offset: vec2f, scale: f32, angle: f32, tint: vec4f }
const GLOBALS_BYTES = 16; // struct Globals { resolution: vec2f, time: f32, _pad: f32 }

const SHARED_WGSL = /* wgsl */ `
struct Globals { resolution: vec2f, time: f32, _pad: f32 }
struct Instance { offset: vec2f, scale: f32, angle: f32, tint: vec4f }
@group(0) @binding(0) var<uniform> globals: Globals;
`;

const RENDER_WGSL = /* wgsl */ `${SHARED_WGSL}
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
@group(2) @binding(0) var<storage, read> instances: array<Instance>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) tint: vec4f,
}

@vertex
fn vs_main(@location(0) corner: vec2f, @location(1) uv: vec2f, @builtin(instance_index) ii: u32) -> VOut {
  let inst = instances[ii];
  let c = cos(inst.angle);
  let s = sin(inst.angle);
  let p = vec2f(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * inst.scale + inst.offset;
  var o: VOut;
  o.pos = vec4f(p.x / globals.resolution.x * 2.0 - 1.0, 1.0 - p.y / globals.resolution.y * 2.0, 0.0, 1.0);
  o.uv = uv;
  o.tint = inst.tint;
  return o;
}

@fragment
fn fs_main(v: VOut) -> @location(0) vec4f {
  // Texels are premultiplied; premultiply the straight tint and output premultiplied.
  let t = textureSample(tex, samp, v.uv);
  return t * vec4f(v.tint.rgb * v.tint.a, v.tint.a);
}
`;

const COMPUTE_WGSL = /* wgsl */ `${SHARED_WGSL}
@group(2) @binding(0) var<storage, read_write> instances: array<Instance>;

fn hue(h: f32) -> vec3f {
  return clamp(abs(fract(vec3f(h, h + 0.6667, h + 0.3333)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

@compute @workgroup_size(8)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let n = arrayLength(&instances);
  let i = gid.x;
  if (i >= n) { return; }
  let center = globals.resolution * 0.5;
  let extent = min(center.x, center.y);
  if (i == 0u) {
    instances[0].offset = center;
    instances[0].scale = extent * 0.9;
    instances[0].angle = globals.time * 0.25;
    instances[0].tint = vec4f(1.0, 1.0, 1.0, 1.0);
    return;
  }
  let a = globals.time * 0.8 + f32(i) * 6.2831853 / f32(n - 1u);
  instances[i].offset = center + vec2f(cos(a), sin(a)) * extent * 0.72;
  instances[i].scale = extent * 0.26;
  instances[i].angle = -globals.time * 1.5 + f32(i);
  instances[i].tint = vec4f(hue(f32(i) / f32(n - 1u)), 0.8);
}
`;

const BAD_WGSL = /* wgsl */ `
@fragment
fn fs_main() -> @location(0) vec4f {
  return colr;
}
`;

/** size² RGBA checkerboard disc with a soft edge (premultiplied when `premultiply`). */
function makeTexturePixels(size: number, premultiply = true): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const d = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, (r - d) / 3));
      const checker = ((x >> 4) + (y >> 4)) & 1;
      const red = checker ? 255 : 40;
      const green = checker ? 200 : 170;
      const blue = checker ? 80 : 255;
      const k = premultiply ? alpha : 1;
      px[i] = Math.round(red * k);
      px[i + 1] = Math.round(green * k);
      px[i + 2] = Math.round(blue * k);
      px[i + 3] = Math.round(255 * alpha);
    }
  }
  return px;
}

interface Scene {
  globals: RhiBuffer;
  instances: RhiBuffer;
  vertices: RhiBuffer;
  indices: RhiBuffer;
  texture: RhiTexture;
  msaa: RhiTexture | null;
  globalsGroup: RhiBindGroup;
  textureGroup: RhiBindGroup;
  emptyGroup: RhiBindGroup;
  renderInstancesGroup: RhiBindGroup;
  computeInstancesGroup: RhiBindGroup;
  renderPipeline: RhiRenderPipeline | null;
  computePipeline: RhiComputePipeline | null;
}

async function runRhi(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const sampleCount = params.get('msaa') === '1' ? 4 : 1;
  const backend: Backend = await createBackend(canvas, {
    preference,
    alphaMode: 'premultiplied',
    debug: params.get('debug') === '1',
  } as Parameters<typeof createBackend>[1]);
  status.caps = backend.caps;
  status.backend = backend.kind;
  if (backend.caps.shaderLanguage === 'glsl300es') {
    await runRhiGl(backend, canvas, hud, status, fail, makeTexturePixels(128));
    return;
  }
  if (!backend.caps.compute || !backend.caps.vertexStorage) {
    throw new GPU.CozyGPUError(
      'UNSUPPORTED',
      'this demo needs compute + vertex storage buffers',
    );
  }

  const resize = (): void => {
    const dpr = globalThis.devicePixelRatio || 1;
    backend.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
  };
  resize();

  let scene: Scene | null = null;
  let generation = 0;

  const build = (): Scene => {
    const gen = ++generation;
    const globals = backend.createBuffer({
      label: 'basic globals',
      size: GLOBALS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const instances = backend.createBuffer({
      label: 'basic instances',
      size: INSTANCES * INSTANCE_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    });
    const vertices = backend.createBuffer({
      label: 'basic quad',
      size: 16 * 4,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    // corner.xy, uv.xy
    backend.writeBuffer(
      vertices,
      0,
      new Float32Array([
        -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, -0.5, 0.5, 0, 1, 0.5, 0.5, 1, 1,
      ]),
    );
    const indices = backend.createBuffer({
      label: 'basic indices',
      size: 12,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 2, 1, 3]));

    const size = 128;
    const texture = backend.createTexture({
      label: 'basic texture',
      width: size,
      height: size,
      format: 'rgba8unorm',
      usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
      mipLevelCount: fullMipLevelCount(size, size),
    });
    backend.writeTexture(texture, makeTexturePixels(size), 0, 0, size, size);
    backend.generateMipmaps(texture);
    const sampler = backend.createSampler({
      label: 'basic sampler',
      mipmapFilter: 'linear',
    });

    const globalsLayout = backend.createBindGroupLayout({
      label: 'basic globals',
      entries: [
        {
          binding: 0,
          visibility:
            ShaderStage.VERTEX | ShaderStage.FRAGMENT | ShaderStage.COMPUTE,
          type: { kind: 'uniform', minBindingSize: GLOBALS_BYTES },
        },
      ],
    });
    const textureLayout = backend.createBindGroupLayout({
      label: 'basic texture',
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
    const emptyLayout = backend.createBindGroupLayout({
      label: 'basic empty',
      entries: [],
    });
    const renderInstancesLayout = backend.createBindGroupLayout({
      label: 'basic instances (read)',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX,
          type: { kind: 'storage', readOnly: true },
        },
      ],
    });
    const computeInstancesLayout = backend.createBindGroupLayout({
      label: 'basic instances (read_write)',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.COMPUTE,
          type: { kind: 'storage', readOnly: false },
        },
      ],
    });

    const next: Scene = {
      globals,
      instances,
      vertices,
      indices,
      texture,
      msaa: null,
      globalsGroup: backend.createBindGroup({
        label: 'basic globals',
        layout: globalsLayout,
        entries: [{ binding: 0, resource: { buffer: globals } }],
      }),
      textureGroup: backend.createBindGroup({
        label: 'basic texture',
        layout: textureLayout,
        entries: [
          { binding: 0, resource: { texture } },
          { binding: 1, resource: { sampler } },
        ],
      }),
      emptyGroup: backend.createBindGroup({
        label: 'basic empty',
        layout: emptyLayout,
        entries: [],
      }),
      renderInstancesGroup: backend.createBindGroup({
        label: 'basic instances (read)',
        layout: renderInstancesLayout,
        entries: [{ binding: 0, resource: { buffer: instances } }],
      }),
      computeInstancesGroup: backend.createBindGroup({
        label: 'basic instances (read_write)',
        layout: computeInstancesLayout,
        entries: [{ binding: 0, resource: { buffer: instances } }],
      }),
      renderPipeline: null,
      computePipeline: null,
    };

    const renderShader = backend.createShaderModule({
      label: 'basic.render.wgsl',
      wgsl: RENDER_WGSL,
    });
    const computeShader = backend.createShaderModule({
      label: 'basic.compute.wgsl',
      wgsl: COMPUTE_WGSL,
    });
    Promise.all([
      backend.createRenderPipeline({
        label: 'basic render',
        shader: renderShader,
        bindGroupLayouts: [globalsLayout, textureLayout, renderInstancesLayout],
        vertexBuffers: [
          {
            stride: 16,
            stepMode: 'vertex',
            attributes: [
              { location: 0, format: 'float32x2', offset: 0 },
              { location: 1, format: 'float32x2', offset: 8 },
            ],
          },
        ],
        topology: 'triangle-list',
        blend: 'normal',
        sampleCount: sampleCount as 1 | 4,
      }),
      backend.createComputePipeline({
        label: 'basic compute',
        shader: computeShader,
        bindGroupLayouts: [globalsLayout, emptyLayout, computeInstancesLayout],
      }),
    ]).then(
      ([render, compute]) => {
        if (gen !== generation) return; // superseded by a restore
        next.renderPipeline = render;
        next.computePipeline = compute;
        status.pipelinesReady = true;
      },
      err => fail(err),
    );
    return next;
  };

  const ensureMsaa = (s: Scene): void => {
    if (sampleCount !== 4) return;
    if (
      s.msaa &&
      s.msaa.width === backend.pixelWidth &&
      s.msaa.height === backend.pixelHeight
    )
      return;
    s.msaa?.destroy();
    s.msaa = backend.createTexture({
      label: 'basic msaa',
      width: backend.pixelWidth,
      height: backend.pixelHeight,
      format: backend.caps.canvasFormat,
      usage: TextureUsage.RENDER_TARGET,
      sampleCount: 4,
    });
  };

  scene = build();

  if (params.get('badshader') === '1') {
    const bad = backend.createShaderModule({
      label: 'broken.wgsl',
      wgsl: BAD_WGSL,
    });
    backend
      .createRenderPipeline({
        label: 'broken',
        shader: bad,
        vertexEntry: 'fs_main',
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
    if (info.reason === 'destroyed') return;
    lost = true;
    status.lost++;
    status.pipelinesReady = false;
    console.warn(`[basic] device lost: ${info.message}; restoring…`);
    backend.restore().then(
      () => {
        scene = build();
        lost = false;
        status.restored++;
        console.info('[basic] device restored, resources rebuilt');
      },
      err => fail(err),
    );
  });
  if (params.get('lose') === '1') {
    setTimeout(
      () => (backend as unknown as LossSimulator).simulateDeviceLoss(),
      1000,
    );
  }

  new ResizeObserver(resize).observe(canvas);

  const globalsData = new Float32Array(GLOBALS_BYTES / 4);
  const clearColor = new Float32Array([0.08, 0.08, 0.12, 1]);
  const passDesc = {
    label: 'basic main',
    color: {
      target: 'canvas' as RhiTexture | 'canvas',
      resolveTarget: undefined as 'canvas' | undefined,
      load: 'clear' as const,
      clearColor,
    },
  };
  const start = performance.now();

  const frame = (): void => {
    requestAnimationFrame(frame);
    const s = scene;
    if (lost || !s || backend.pixelWidth === 0 || backend.pixelHeight === 0)
      return;
    const time = (performance.now() - start) / 1000;
    const dpr = backend.pixelWidth / Math.max(1, canvas.clientWidth);
    globalsData[0] = backend.pixelWidth / dpr;
    globalsData[1] = backend.pixelHeight / dpr;
    globalsData[2] = time;
    backend.writeBuffer(s.globals, 0, globalsData);

    const list = backend.beginCommands();
    if (s.computePipeline && s.renderPipeline) {
      const cpass = list.beginComputePass('basic animate');
      cpass.setPipeline(s.computePipeline);
      cpass.setBindGroup(0, s.globalsGroup);
      cpass.setBindGroup(1, s.emptyGroup);
      cpass.setBindGroup(2, s.computeInstancesGroup);
      cpass.dispatch(Math.ceil(INSTANCES / 8));
      cpass.end();
    }
    ensureMsaa(s);
    if (s.msaa) {
      passDesc.color.target = s.msaa;
      passDesc.color.resolveTarget = 'canvas';
    }
    const pass = list.beginRenderPass(passDesc);
    if (s.renderPipeline && s.computePipeline) {
      pass.setPipeline(s.renderPipeline);
      pass.setBindGroup(0, s.globalsGroup);
      pass.setBindGroup(1, s.textureGroup);
      pass.setBindGroup(2, s.renderInstancesGroup);
      pass.setVertexBuffer(0, s.vertices);
      pass.setIndexBuffer(s.indices, 'uint16');
      pass.drawIndexed(6, INSTANCES);
    }
    pass.end();
    list.submit();
    status.frames++;
    if ((status.frames & 31) === 0) {
      hud.textContent = `basic (RHI) · ${backend.kind} · ${backend.caps.canvasFormat} · ${backend.pixelWidth}×${backend.pixelHeight} · msaa ${sampleCount} · frames ${status.frames} · restored ${status.restored}`;
    }
  };
  requestAnimationFrame(frame);
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  status.errors.push(message);
  hud.textContent = message;
  console.error(err);
}

(status.mode === 'rhi'
  ? runRhi()
  : status.mode === 'glcheck'
    ? runGlCheck(status)
    : runRenderer()
).catch(fail);
