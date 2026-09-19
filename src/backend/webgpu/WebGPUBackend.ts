/**
 * Owner: "backend". WebGPU implementation of the RHI (src/backend/types.ts).
 *
 * - DOM-free: works on the main thread and in a worker (OffscreenCanvas).
 * - One color format everywhere: `navigator.gpu.getPreferredCanvasFormat()`.
 * - Per-frame recording reuses one CommandList and its pass wrappers.
 * - Device loss is reported once per device through `onDeviceLost`;
 *   `restore()` re-acquires adapter + device (0 ms, 500 ms, 2000 ms) and
 *   reconfigures the canvas with the same format. Every RHI object created
 *   before the loss is dead afterwards and must be recreated by the caller.
 * - Debug mode (`debug: true` or `globalThis.__COZYGPU_DEBUG__ = true`) wraps
 *   resource creation and every frame in validation / out-of-memory error
 *   scopes and logs shader warnings. WGSL *errors* are always reported with
 *   source excerpts, because pipeline creation is async and rare anyway.
 */
import { CozyGPUError } from '../../types/errors';
import type { Canvas } from '../../types/types';
import type {
  Backend,
  BackendOptions,
  BindGroupDesc,
  BindGroupLayoutDesc,
  BindingType,
  BufferDesc,
  Capabilities,
  CommandList,
  ComputePipelineDesc,
  DeviceLostInfo,
  FeedbackPipelineDesc,
  RenderPipelineDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiComputePipeline,
  RhiFeedbackPipeline,
  RhiRenderPipeline,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
  SamplerDesc,
  ShaderSource,
  TextureDesc,
  TextureFormat,
} from '../types';
import { WebGPUCommandList, type CommandHost } from './commands';
import {
  GPU_BUFFER_USAGE,
  align4,
  bytesPerTexel,
  isDepthFormat,
  toGPUBlendState,
  toGPUBufferUsage,
  toGPUShaderStage,
  toGPUTextureUsage,
} from './convert';
import {
  acquireDevice,
  delay,
  detectCapabilities,
  getGPU,
  preferredCanvasFormat,
} from './device';
import { DedupLogger, formatCompilationMessages } from './diagnostics';
import {
  alignDown4,
  COMPRESSED_BLOCK_SIZE,
  compressedBlockBytes,
  isDebugEnabled,
  textureBytesPerRow,
} from '../utils';
import {
  WebGPUBindGroup,
  WebGPUBindGroupLayout,
  WebGPUBuffer,
  WebGPUComputePipeline,
  WebGPURenderPipeline,
  WebGPUSampler,
  WebGPUShaderModule,
  WebGPUTexture,
} from './resources';

export { isDebugEnabled };

/** @deprecated alias: `debug` is part of BackendOptions now. */
export type WebGPUBackendOptions = BackendOptions;

/** GPUMapMode.READ (spec value; avoids the global). */
const GPU_MAP_MODE_READ = 0x0001;

const RESTORE_DELAYS_MS = [0, 500, 2000] as const;

const MIPMAP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  let uv = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  o.uv = uv;
  return o;
}
@fragment fn fs_main(v: VOut) -> @location(0) vec4f {
  return textureSample(src, samp, v.uv);
}`;

/**
 * Readback pacing (see `backlogged`). Chrome does not throttle submits in an
 * uncapped loop, so the queue can grow to hundreds of frames and a readback
 * (picking, swarm counters) waits for all of them. While readbacks are in
 * use, frames submitted closer together than PACE_FAST_MS are fenced, and a
 * frame is held (the front skips) once a fence is PACE_MAX_LAG_MS old.
 * Chrome reports a finished fence about 3 ms late even on an idle GPU, and a
 * skipped frame costs a display tick, so pacing stays off otherwise: a
 * vsync-paced loop, or one without readbacks, never fences or allocates.
 */
const PACE_FAST_MS = 6;
const PACE_MAX_LAG_MS = 4;
/** How long pacing stays on after the last readback request (ms). */
const PACE_WINDOW_MS = 1000;

export class WebGPUBackend implements Backend, CommandHost {
  readonly kind = 'webgpu' as const;
  caps: Capabilities;
  device: GPUDevice;
  pixelWidth: number;
  pixelHeight: number;
  /** True between a device loss and a successful restore(). */
  lost = false;

  private readonly list: WebGPUCommandList;
  private readonly log = new DedupLogger('[cozygpu:webgpu]');
  private readonly debug: boolean;
  private readonly alphaMode: GPUCanvasAlphaMode;
  private lostCallback: ((info: DeviceLostInfo) => void) | null = null;
  private destroyed = false;
  private simulatingLoss = false;
  private frameScoped = false;

  private canvasTexture: GPUTexture | null = null;
  private canvasTextureView: GPUTextureView | null = null;

  private mipmapSampler: GPUSampler | null = null;

  // Readback pacing (see PACE_FAST_MS).
  private paceUntil = 0;
  private fenceTime = 0;
  private fencePending = false;
  private lastSubmitTime = -1e9;
  private caughtUp: (() => void) | null = null;
  private readonly onFence = (): void => {
    this.fencePending = false;
    const callback = this.caughtUp;
    if (callback !== null) {
      this.caughtUp = null;
      callback();
    }
  };

  // Creation-time caches (per device; cleared by installDevice). Keys are
  // built only when creating resources, never per frame.
  private readonly shaderCache = new Map<string, GPUShaderModule>();
  private readonly renderPipelineCache = new Map<
    string,
    Promise<GPURenderPipeline>
  >();
  private readonly computePipelineCache = new Map<
    string,
    Promise<GPUComputePipeline>
  >();
  private readonly objectIds = new WeakMap<object, number>();
  private nextObjectId = 1;
  private readonly mipmapPipelines = new Map<string, GPURenderPipeline>();

  // Reused upload descriptors (uploads are not per-frame, but cheap to keep).
  private readonly texOrigin = { x: 0, y: 0, z: 0 };
  private readonly texDest: GPUTexelCopyTextureInfo = {
    texture: undefined as unknown as GPUTexture,
    mipLevel: 0,
    origin: this.texOrigin,
  };
  private readonly texLayout = { offset: 0, bytesPerRow: 0 };
  private readonly texSize = { width: 0, height: 0, depthOrArrayLayers: 1 };
  private readonly extSource: GPUCopyExternalImageSourceInfo = {
    source: undefined as unknown as ImageBitmap,
    flipY: false,
  };
  private readonly extOrigin = { x: 0, y: 0 };
  private readonly extDest: GPUCopyExternalImageDestInfo = {
    texture: undefined as unknown as GPUTexture,
    origin: this.extOrigin,
    premultipliedAlpha: true,
  };

  private constructor(
    private readonly canvas: Canvas,
    private readonly context: GPUCanvasContext,
    device: GPUDevice,
    readonly format: TextureFormat,
    private readonly options: WebGPUBackendOptions,
  ) {
    this.debug = isDebugEnabled(options);
    this.alphaMode = options.alphaMode ?? 'premultiplied';
    this.device = device;
    this.caps = detectCapabilities(device, format);
    this.pixelWidth = canvas.width;
    this.pixelHeight = canvas.height;
    this.list = new WebGPUCommandList(this);
    this.installDevice(device);
  }

  static async create(
    canvas: Canvas,
    options: WebGPUBackendOptions,
  ): Promise<WebGPUBackend> {
    const gpu = getGPU();
    if (!gpu) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'WebGPU is not available (navigator.gpu is undefined).',
      );
    }
    // Device first: a canvas that got a 'webgpu' context can never become a
    // WebGL2 canvas, so 'auto' could not fall back after getContext().
    const { device } = await acquireDevice(options);
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      device.destroy();
      throw new CozyGPUError(
        'UNSUPPORTED',
        'canvas.getContext("webgpu") returned null (the canvas may already have a 2d/webgl context).',
      );
    }
    return new WebGPUBackend(
      canvas,
      context,
      device,
      preferredCanvasFormat(gpu),
      options,
    );
  }

  // ─── CommandHost ───────────────────────────────────────────────────────────

  get compute(): boolean {
    return this.caps.compute;
  }

  canvasView(): GPUTextureView {
    if (!this.canvasTextureView) {
      this.canvasTexture = this.context.getCurrentTexture();
      this.canvasTextureView = this.canvasTexture.createView();
    }
    return this.canvasTextureView;
  }

  afterSubmit(): void {
    this.canvasTexture = null;
    this.canvasTextureView = null;
    const t = globalThis.performance.now();
    if (
      !this.fencePending &&
      t < this.paceUntil &&
      t - this.lastSubmitTime < PACE_FAST_MS
    ) {
      this.fencePending = true;
      this.fenceTime = t;
      this.device.queue.onSubmittedWorkDone().then(this.onFence, this.onFence);
    }
    this.lastSubmitTime = t;
    if (this.frameScoped) {
      this.frameScoped = false;
      this.popScope('frame', undefined);
      this.popScope('frame', undefined);
    }
  }

  /**
   * @internal Frame pacing (not part of the RHI; RenderCore duck-types it).
   * True when the GPU has not reached a fence issued more than
   * PACE_MAX_LAG_MS ago (see PACE_FAST_MS).
   */
  backlogged(): boolean {
    return (
      this.fencePending &&
      globalThis.performance.now() - this.fenceTime > PACE_MAX_LAG_MS
    );
  }

  /** @internal A readback was requested: pace frames for a while. */
  paceReadbacks(): void {
    this.paceUntil = globalThis.performance.now() + PACE_WINDOW_MS;
  }

  /** @internal Calls `callback` once the pending fence resolves (or now). */
  whenCaughtUp(callback: () => void): void {
    if (this.fencePending && !this.lost) this.caughtUp = callback;
    else callback();
  }

  // ─── Size ──────────────────────────────────────────────────────────────────

  resize(pixelWidth: number, pixelHeight: number): void {
    const max = this.caps.maxTextureSize;
    const w = Math.max(0, Math.min(max, Math.round(pixelWidth)));
    const h = Math.max(0, Math.min(max, Math.round(pixelHeight)));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.pixelWidth = w;
    this.pixelHeight = h;
    // The swapchain texture follows the canvas size automatically; any cached
    // view of the old texture must not be reused.
    this.canvasTexture = null;
    this.canvasTextureView = null;
  }

  // ─── Buffers ───────────────────────────────────────────────────────────────

  createBuffer(desc: BufferDesc): RhiBuffer {
    const size = Math.max(4, align4(desc.size));
    if (size > this.caps.maxBufferSize) {
      throw new CozyGPUError(
        'OUT_OF_CAPACITY',
        `buffer "${desc.label ?? ''}" of ${size} B exceeds maxBufferSize ${this.caps.maxBufferSize} (use limits: 'max')`,
      );
    }
    this.pushScope();
    // Out-of-memory is only reported asynchronously; always capture it so a
    // failed allocation is observable (buffer.allocated) instead of silently
    // invalidating every command buffer that binds the buffer.
    const device = this.device;
    device.pushErrorScope('out-of-memory');
    const raw = device.createBuffer({
      label: desc.label,
      size,
      usage: toGPUBufferUsage(desc.usage),
    });
    const oom = device.popErrorScope();
    this.popScope('createBuffer', desc.label);
    const buffer = new WebGPUBuffer(raw, size, desc.usage, desc.label);
    buffer.allocated = oom.then(
      error => {
        if (!error) return true;
        this.log.error(
          `createBuffer "${desc.label ?? ''}" (${size} B): ${error.message}`,
        );
        return false;
      },
      // Device lost while creating: the buffer dies with the device anyway.
      () => true,
    );
    return buffer;
  }

  writeBuffer(
    buffer: RhiBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset = 0,
    byteLength?: number,
  ): void {
    // Byte-based overload on the underlying (Shared)ArrayBuffer: no copies,
    // no subarray, and element-size independent.
    this.device.queue.writeBuffer(
      (buffer as WebGPUBuffer).raw,
      bufferOffset,
      data.buffer as ArrayBuffer,
      data.byteOffset + dataOffset,
      byteLength ?? data.byteLength - dataOffset,
    );
  }

  async readBuffer(
    buffer: RhiBuffer,
    offset: number,
    byteLength: number,
  ): Promise<ArrayBuffer> {
    const src = buffer as WebGPUBuffer;
    if (offset < 0 || byteLength < 0 || offset + byteLength > src.size) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `readBuffer range [${offset}, ${offset + byteLength}) is outside buffer "${src.label ?? ''}" (${src.size} B)`,
      );
    }
    if (byteLength === 0) return new ArrayBuffer(0);
    // Copies must be 4-byte aligned; buffer sizes already are.
    const start = alignDown4(offset);
    const end = Math.min(src.size, align4(offset + byteLength));
    const device = this.device;
    const staging = device.createBuffer({
      label: 'cozygpu readback',
      size: end - start,
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    try {
      const enc = device.createCommandEncoder({ label: 'cozygpu readback' });
      enc.copyBufferToBuffer(src.raw, start, staging, 0, end - start);
      device.queue.submit([enc.finish()]);
      try {
        await staging.mapAsync(GPU_MAP_MODE_READ);
      } catch (err) {
        if (await this.deviceLostSoon(device)) {
          throw new CozyGPUError(
            'DEVICE_LOST',
            `readBuffer: ${(err as Error)?.message ?? String(err)}`,
          );
        }
        throw err;
      }
      const skip = offset - start;
      return staging.getMappedRange().slice(skip, skip + byteLength);
    } finally {
      staging.destroy();
    }
  }

  /**
   * True when `device` is (or within a short grace period becomes) lost.
   * mapAsync can reject before `device.lost` resolves. Error path only.
   */
  private deviceLostSoon(device: GPUDevice): Promise<boolean> {
    if (device !== this.device || this.lost || this.destroyed) {
      return Promise.resolve(true);
    }
    return Promise.race([
      device.lost.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
  }

  // ─── Textures & samplers ───────────────────────────────────────────────────

  createTexture(desc: TextureDesc): RhiTexture {
    const width = Math.max(1, desc.width | 0);
    const height = Math.max(1, desc.height | 0);
    const max = this.caps.maxTextureSize;
    if (width > max || height > max) {
      throw new CozyGPUError(
        'OUT_OF_CAPACITY',
        `texture "${desc.label ?? ''}" ${width}×${height} exceeds maxTextureSize ${max}`,
      );
    }
    const mipLevelCount = desc.mipLevelCount ?? 1;
    const sampleCount = desc.sampleCount ?? 1;
    this.pushScope();
    const raw = this.device.createTexture({
      label: desc.label,
      size: { width, height },
      format: desc.format,
      usage: toGPUTextureUsage(desc.usage, desc.format, mipLevelCount),
      mipLevelCount,
      sampleCount,
    });
    const tex = new WebGPUTexture(
      raw,
      width,
      height,
      desc.format,
      mipLevelCount,
      sampleCount,
      desc.label,
    );
    this.popScope('createTexture', desc.label);
    return tex;
  }

  writeTexture(
    texture: RhiTexture,
    data: ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
    mipLevel = 0,
  ): void {
    const tex = texture as WebGPUTexture;
    this.texDest.texture = tex.raw;
    this.texDest.mipLevel = mipLevel;
    this.texOrigin.x = x;
    this.texOrigin.y = y;
    // Tight rows; compressed formats count whole 4×4 blocks.
    this.texLayout.bytesPerRow = textureBytesPerRow(tex.format, width);
    // WebGPU validates the copy extent against the PHYSICAL mip extent (the
    // logical size rounded up to whole blocks), so a 2×2 BC1 level must be
    // copied as 4×4. Callers pass logical texels of `mipLevel` per the RHI
    // contract, so round up here.
    if (compressedBlockBytes(tex.format) > 0) {
      const b = COMPRESSED_BLOCK_SIZE;
      this.texSize.width = Math.ceil(width / b) * b;
      this.texSize.height = Math.ceil(height / b) * b;
    } else {
      this.texSize.width = width;
      this.texSize.height = height;
    }
    this.device.queue.writeTexture(
      this.texDest,
      data as unknown as ArrayBuffer,
      this.texLayout,
      this.texSize,
    );
  }

  copyExternalImage(
    source: ImageBitmap | OffscreenCanvas | ImageData,
    texture: RhiTexture,
    flipY = false,
    destX = 0,
    destY = 0,
  ): void {
    const tex = texture as WebGPUTexture;
    this.extSource.source = source;
    this.extSource.flipY = flipY;
    this.extDest.texture = tex.raw;
    this.extOrigin.x = destX;
    this.extOrigin.y = destY;
    this.texSize.width = Math.min(source.width, tex.width - destX);
    this.texSize.height = Math.min(source.height, tex.height - destY);
    if (this.texSize.width === 0 || this.texSize.height === 0) return;
    this.device.queue.copyExternalImageToTexture(
      this.extSource,
      this.extDest,
      this.texSize,
    );
    // Do not keep the source alive through the reused descriptor.
    this.extSource.source = undefined as unknown as ImageBitmap;
  }

  generateMipmaps(texture: RhiTexture): void {
    const tex = texture as WebGPUTexture;
    if (tex.mipLevelCount <= 1 || isDepthFormat(tex.format)) return;
    const device = this.device;
    let pipeline = this.mipmapPipelines.get(tex.format);
    if (!pipeline) {
      const module = device.createShaderModule({
        label: 'cozygpu mipmap',
        code: MIPMAP_WGSL,
      });
      pipeline = device.createRenderPipeline({
        label: `cozygpu mipmap ${tex.format}`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{ format: tex.format }],
        },
        primitive: { topology: 'triangle-list' },
      });
      this.mipmapPipelines.set(tex.format, pipeline);
    }
    if (!this.mipmapSampler) {
      this.mipmapSampler = device.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
      });
    }
    const layout = pipeline.getBindGroupLayout(0);
    const enc = device.createCommandEncoder({ label: 'cozygpu mipmaps' });
    for (let level = 1; level < tex.mipLevelCount; level++) {
      const src = tex.raw.createView({
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });
      const dst = tex.raw.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: src },
          { binding: 1, resource: this.mipmapSampler },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([enc.finish()]);
  }

  createSampler(desc: SamplerDesc): RhiSampler {
    const raw = this.device.createSampler({
      label: desc.label,
      minFilter: desc.minFilter ?? 'linear',
      magFilter: desc.magFilter ?? 'linear',
      mipmapFilter: desc.mipmapFilter ?? 'nearest',
      addressModeU: desc.addressU ?? 'clamp-to-edge',
      addressModeV: desc.addressV ?? 'clamp-to-edge',
    });
    return new WebGPUSampler(raw, desc.label);
  }

  // ─── Shaders, layouts, bind groups ─────────────────────────────────────────

  createShaderModule(source: ShaderSource): RhiShaderModule {
    if (source.wgsl === undefined) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `shader "${source.label ?? ''}" has no WGSL source (GLSL is WebGL2-only)`,
      );
    }
    const code = source.wgsl;
    const cached = this.shaderCache.get(code);
    if (cached) return new WebGPUShaderModule(cached, code, source.label);
    const raw = this.device.createShaderModule({ label: source.label, code });
    this.shaderCache.set(code, raw);
    // Compilation messages are async; report them without blocking the caller.
    const debug = this.debug;
    raw.getCompilationInfo().then(
      info => {
        const text = formatCompilationMessages(
          source.label,
          code,
          info.messages,
          debug ? 'warning' : 'error',
        );
        if (text) this.log.error(`WGSL compilation:\n${text}`);
      },
      () => {},
    );
    return new WebGPUShaderModule(raw, code, source.label);
  }

  createBindGroupLayout(desc: BindGroupLayoutDesc): RhiBindGroupLayout {
    const entries: GPUBindGroupLayoutEntry[] = [];
    for (let i = 0; i < desc.entries.length; i++) {
      const e = desc.entries[i];
      const entry: GPUBindGroupLayoutEntry = {
        binding: e.binding,
        visibility: toGPUShaderStage(e.visibility),
      };
      applyBindingType(entry, e.type);
      entries.push(entry);
    }
    this.pushScope();
    const raw = this.device.createBindGroupLayout({
      label: desc.label,
      entries,
    });
    this.popScope('createBindGroupLayout', desc.label);
    return new WebGPUBindGroupLayout(raw, desc.label);
  }

  createBindGroup(desc: BindGroupDesc): RhiBindGroup {
    const entries: GPUBindGroupEntry[] = [];
    for (let i = 0; i < desc.entries.length; i++) {
      const e = desc.entries[i];
      const r = e.resource;
      let resource: GPUBindingResource;
      if ('buffer' in r) {
        resource = {
          buffer: (r.buffer as WebGPUBuffer).raw,
          offset: r.offset,
          size: r.size,
        };
      } else if ('texture' in r) {
        resource = (r.texture as WebGPUTexture).view;
      } else {
        resource = (r.sampler as WebGPUSampler).raw;
      }
      entries.push({ binding: e.binding, resource });
    }
    this.pushScope();
    const raw = this.device.createBindGroup({
      label: desc.label,
      layout: (desc.layout as WebGPUBindGroupLayout).raw,
      entries,
    });
    this.popScope('createBindGroup', desc.label);
    return new WebGPUBindGroup(raw, desc.label);
  }

  // ─── Pipelines (async) ─────────────────────────────────────────────────────

  async createRenderPipeline(
    desc: RenderPipelineDesc,
  ): Promise<RhiRenderPipeline> {
    const device = this.device;
    const shader = desc.shader as WebGPUShaderModule;
    const key = this.renderPipelineKey(desc);
    const cached = this.renderPipelineCache.get(key);
    if (cached) {
      try {
        return new WebGPURenderPipeline(await cached, desc.label);
      } catch (err) {
        throw await this.pipelineError(
          'render pipeline',
          desc.label,
          shader,
          err,
        );
      }
    }
    const buffers: GPUVertexBufferLayout[] = [];
    for (let i = 0; i < desc.vertexBuffers.length; i++) {
      const b = desc.vertexBuffers[i];
      const attributes: GPUVertexAttribute[] = [];
      for (let j = 0; j < b.attributes.length; j++) {
        const a = b.attributes[j];
        attributes.push({
          shaderLocation: a.location,
          format: a.format,
          offset: a.offset,
        });
      }
      buffers.push({ arrayStride: b.stride, stepMode: b.stepMode, attributes });
    }
    const descriptor: GPURenderPipelineDescriptor = {
      label: desc.label,
      layout: this.createPipelineLayout(desc.label, desc.bindGroupLayouts),
      vertex: {
        module: shader.raw,
        entryPoint: desc.vertexEntry ?? 'vs_main',
        buffers,
      },
      fragment: {
        module: shader.raw,
        entryPoint: desc.fragmentEntry ?? 'fs_main',
        targets: [
          {
            format: desc.colorFormat ?? this.caps.canvasFormat,
            blend: toGPUBlendState(desc.blend),
          },
        ],
      },
      primitive: {
        topology: desc.topology ?? 'triangle-list',
        cullMode: 'none',
      },
      multisample: { count: desc.sampleCount ?? 1 },
      depthStencil: desc.depthFormat
        ? {
            format: desc.depthFormat,
            depthWriteEnabled: true,
            depthCompare: 'less-equal',
          }
        : undefined,
    };
    const pending = device.createRenderPipelineAsync(descriptor);
    this.renderPipelineCache.set(key, pending);
    try {
      const raw = await pending;
      return new WebGPURenderPipeline(raw, desc.label);
    } catch (err) {
      if (this.renderPipelineCache.get(key) === pending) {
        this.renderPipelineCache.delete(key);
      }
      throw await this.pipelineError(
        'render pipeline',
        desc.label,
        shader,
        err,
      );
    }
  }

  /** Transform feedback does not exist on WebGPU (use compute). */
  createFeedbackPipeline(
    _desc: FeedbackPipelineDesc,
  ): Promise<RhiFeedbackPipeline> {
    return Promise.reject(
      new CozyGPUError(
        'UNSUPPORTED',
        'transform feedback pipelines are WebGL2-only; use compute on WebGPU',
      ),
    );
  }

  /**
   * M2 (RHI parity): copyTextureToBuffer into a MAP_READ staging buffer,
   * then strip WebGPU's 256-byte row alignment so rows come back tight,
   * top row first.
   */
  async readTexture(
    texture: RhiTexture,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<ArrayBuffer> {
    const tex = texture as WebGPUTexture;
    if (
      x < 0 ||
      y < 0 ||
      width < 0 ||
      height < 0 ||
      x + width > tex.width ||
      y + height > tex.height
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `readTexture rect ${x},${y} ${width}×${height} is outside texture "${tex.label ?? ''}" (${tex.width}×${tex.height})`,
      );
    }
    if (
      compressedBlockBytes(tex.format) > 0 ||
      isDepthFormat(tex.format) ||
      tex.sampleCount > 1
    ) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        `readTexture: ${tex.sampleCount > 1 ? 'multisampled' : tex.format} textures cannot be read back`,
      );
    }
    if (width === 0 || height === 0) return new ArrayBuffer(0);
    const bpp = bytesPerTexel(tex.format);
    const rowBytes = width * bpp;
    const paddedRow = Math.ceil(rowBytes / 256) * 256;
    const size = paddedRow * (height - 1) + rowBytes;
    const device = this.device;
    const staging = device.createBuffer({
      label: 'cozygpu texture readback',
      size: align4(size),
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    try {
      const enc = device.createCommandEncoder({
        label: 'cozygpu texture readback',
      });
      enc.copyTextureToBuffer(
        { texture: tex.raw, mipLevel: 0, origin: { x, y, z: 0 } },
        {
          buffer: staging,
          offset: 0,
          bytesPerRow: paddedRow,
          rowsPerImage: height,
        },
        { width, height, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
      try {
        await staging.mapAsync(GPU_MAP_MODE_READ);
      } catch (err) {
        if (await this.deviceLostSoon(device)) {
          throw new CozyGPUError(
            'DEVICE_LOST',
            `readTexture: ${(err as Error)?.message ?? String(err)}`,
          );
        }
        throw err;
      }
      const mapped = new Uint8Array(staging.getMappedRange());
      const out = new Uint8Array(rowBytes * height);
      for (let row = 0; row < height; row++) {
        const from = row * paddedRow;
        out.set(mapped.subarray(from, from + rowBytes), row * rowBytes);
      }
      return out.buffer;
    } finally {
      staging.destroy();
    }
  }

  async createComputePipeline(
    desc: ComputePipelineDesc,
  ): Promise<RhiComputePipeline> {
    if (!this.caps.compute) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'compute pipelines are unavailable',
      );
    }
    const shader = desc.shader as WebGPUShaderModule;
    const key = `${this.objectId(shader.raw)}|${desc.entry ?? 'cs_main'}|${this.layoutsKey(desc.bindGroupLayouts)}`;
    const cached = this.computePipelineCache.get(key);
    if (cached) {
      try {
        return new WebGPUComputePipeline(await cached, desc.label);
      } catch (err) {
        throw await this.pipelineError(
          'compute pipeline',
          desc.label,
          shader,
          err,
        );
      }
    }
    const descriptor: GPUComputePipelineDescriptor = {
      label: desc.label,
      layout: this.createPipelineLayout(desc.label, desc.bindGroupLayouts),
      compute: { module: shader.raw, entryPoint: desc.entry ?? 'cs_main' },
    };
    const pending = this.device.createComputePipelineAsync(descriptor);
    this.computePipelineCache.set(key, pending);
    try {
      const raw = await pending;
      return new WebGPUComputePipeline(raw, desc.label);
    } catch (err) {
      if (this.computePipelineCache.get(key) === pending) {
        this.computePipelineCache.delete(key);
      }
      throw await this.pipelineError(
        'compute pipeline',
        desc.label,
        shader,
        err,
      );
    }
  }

  // ─── Frame ─────────────────────────────────────────────────────────────────

  beginCommands(): CommandList {
    if (this.debug && !this.frameScoped) {
      this.frameScoped = true;
      this.device.pushErrorScope('validation');
      this.device.pushErrorScope('out-of-memory');
    }
    this.canvasTexture = null;
    this.canvasTextureView = null;
    return this.list.begin();
  }

  // ─── Device loss ───────────────────────────────────────────────────────────

  onDeviceLost(callback: (info: DeviceLostInfo) => void): void {
    this.lostCallback = callback;
  }

  async restore(): Promise<void> {
    if (this.destroyed) {
      throw new CozyGPUError('DESTROYED', 'backend was destroyed');
    }
    let lastError: unknown;
    for (let i = 0; i < RESTORE_DELAYS_MS.length; i++) {
      if (RESTORE_DELAYS_MS[i] > 0) await delay(RESTORE_DELAYS_MS[i]);
      if (this.destroyed) {
        throw new CozyGPUError('DESTROYED', 'backend was destroyed');
      }
      try {
        const { device } = await acquireDevice(this.options);
        this.installDevice(device);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw new CozyGPUError(
      'DEVICE_LOST',
      `could not restore the GPU device after ${RESTORE_DELAYS_MS.length} attempts: ${
        (lastError as Error)?.message ?? String(lastError)
      }`,
    );
  }

  /**
   * @internal Testing hook: destroys the device but reports the loss as
   * `reason: 'unknown'`, exercising the same path as a real GPU reset.
   */
  simulateDeviceLoss(): void {
    if (this.destroyed || this.lost) return;
    this.simulatingLoss = true;
    this.device.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lostCallback = null;
    this.list.abandon();
    try {
      this.context.unconfigure();
    } catch {
      // Context may already be gone with the canvas.
    }
    // device.destroy() blocks until the GPU finishes every queued frame
    // (tens of ms when frames are queued, e.g. at 1000+ fps). Release it once
    // the queue is idle instead; nothing uses the device after this point.
    const device = this.device;
    const release = (): void => device.destroy();
    device.queue.onSubmittedWorkDone().then(release, release);
    this.mipmapPipelines.clear();
    this.mipmapSampler = null;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private installDevice(device: GPUDevice): void {
    this.device = device;
    this.lost = false;
    this.frameScoped = false;
    this.fencePending = false;
    this.list.abandon();
    this.canvasTexture = null;
    this.canvasTextureView = null;
    this.mipmapPipelines.clear();
    this.mipmapSampler = null;
    this.shaderCache.clear();
    this.renderPipelineCache.clear();
    this.computePipelineCache.clear();
    this.context.configure({
      device,
      format: this.format,
      alphaMode: this.alphaMode,
    });
    this.caps = detectCapabilities(device, this.format);

    device.addEventListener('uncapturederror', event => {
      const error = (event as GPUUncapturedErrorEvent).error;
      this.log.error(error.message);
    });

    device.lost.then(info => {
      if (device !== this.device || this.destroyed) return;
      const simulated = this.simulatingLoss;
      this.simulatingLoss = false;
      this.lost = true;
      this.list.abandon();
      this.onFence(); // releases a held frame
      const callback = this.lostCallback;
      if (!callback) return;
      callback({
        reason:
          !simulated && info.reason === 'destroyed' ? 'destroyed' : 'unknown',
        message: simulated
          ? 'simulated device loss'
          : info.message || 'GPU device lost',
      });
    });
  }

  private objectId(object: object): number {
    let id = this.objectIds.get(object);
    if (id === undefined) {
      id = this.nextObjectId++;
      this.objectIds.set(object, id);
    }
    return id;
  }

  private layoutsKey(layouts: RhiBindGroupLayout[]): string {
    let key = '';
    for (let i = 0; i < layouts.length; i++) {
      key += `${this.objectId((layouts[i] as WebGPUBindGroupLayout).raw)},`;
    }
    return key;
  }

  /** Identity of everything that shapes a GPURenderPipeline (label excluded). */
  private renderPipelineKey(desc: RenderPipelineDesc): string {
    let key = `${this.objectId((desc.shader as WebGPUShaderModule).raw)}|${desc.vertexEntry ?? 'vs_main'}|${desc.fragmentEntry ?? 'fs_main'}|${this.layoutsKey(desc.bindGroupLayouts)}|`;
    for (let i = 0; i < desc.vertexBuffers.length; i++) {
      const b = desc.vertexBuffers[i];
      key += `${b.stride}${b.stepMode[0]}`;
      for (let j = 0; j < b.attributes.length; j++) {
        const a = b.attributes[j];
        key += `:${a.location}/${a.format}/${a.offset}`;
      }
      key += ';';
    }
    return `${key}|${desc.topology ?? 'triangle-list'}|${desc.colorFormat ?? this.caps.canvasFormat}|${desc.blend ?? ''}|${desc.depthFormat ?? ''}|${desc.sampleCount ?? 1}`;
  }

  private createPipelineLayout(
    label: string | undefined,
    layouts: RhiBindGroupLayout[],
  ): GPUPipelineLayout {
    const raw: GPUBindGroupLayout[] = [];
    for (let i = 0; i < layouts.length; i++) {
      raw.push((layouts[i] as WebGPUBindGroupLayout).raw);
    }
    this.pushScope();
    const layout = this.device.createPipelineLayout({
      label,
      bindGroupLayouts: raw,
    });
    this.popScope('createPipelineLayout', label);
    return layout;
  }

  private async pipelineError(
    kind: string,
    label: string | undefined,
    shader: WebGPUShaderModule,
    err: unknown,
  ): Promise<CozyGPUError> {
    let details = '';
    try {
      const info = await shader.raw.getCompilationInfo();
      details = formatCompilationMessages(
        shader.label ?? label,
        shader.source,
        info.messages,
      );
    } catch {
      // Device lost while compiling: the base message is all we have.
    }
    const base = (err as Error)?.message ?? String(err);
    return new CozyGPUError(
      'SHADER_COMPILE',
      `${kind} "${label ?? shader.label ?? ''}" failed: ${base}${details ? `\n${details}` : ''}`,
    );
  }

  private pushScope(): void {
    if (this.debug) this.device.pushErrorScope('validation');
  }

  private popScope(what: string, label: string | undefined): void {
    if (!this.debug) return;
    this.device.popErrorScope().then(
      error => {
        if (error) {
          this.log.error(
            `${what}${label ? ` "${label}"` : ''}: ${error.message}`,
          );
        }
      },
      () => {},
    );
  }
}

function applyBindingType(
  entry: GPUBindGroupLayoutEntry,
  type: BindingType,
): void {
  switch (type.kind) {
    case 'uniform':
      entry.buffer = {
        type: 'uniform',
        hasDynamicOffset: type.hasDynamicOffset ?? false,
        minBindingSize: type.minBindingSize ?? 0,
      };
      break;
    case 'storage':
      entry.buffer = {
        type: type.readOnly ? 'read-only-storage' : 'storage',
        minBindingSize: type.minBindingSize ?? 0,
      };
      break;
    case 'texture':
      entry.texture = {
        sampleType: type.sampleType ?? 'float',
        viewDimension: '2d',
      };
      break;
    case 'sampler':
      entry.sampler = {
        type: type.filtering === false ? 'non-filtering' : 'filtering',
      };
      break;
  }
}
