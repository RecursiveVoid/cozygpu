/**
 * WebGPU implementation of the RHI (src/backend/types.ts).
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
  ImportBufferDesc,
  ReadbackRingDesc,
  RhiReadbackRing,
} from '../types';
import { BufferUsage } from '../types';
import { WebGPUCommandList, type CommandHost } from './commands';
import {
  COLOR_WRITE_ALL,
  GPU_BUFFER_USAGE,
  align4,
  bytesPerTexel,
  isDepthFormat,
  stencilKey,
  toGPUBlendState,
  toGPUBufferUsage,
  toGPUDepthStencil,
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
import { DedupLogger } from './diagnostics';
import {
  alignDown4,
  COMPRESSED_BLOCK_SIZE,
  compressedBlockBytes,
  isDebugEnabled,
  textureBytesPerRow,
} from '../utils';
import type { WebGPUReadbackRing } from './readbackRing';

/** The readback ring chunk once loaded (see loadReadbackRing). */
let ringModule: typeof import('./readbackRing') | null = null;
import {
  WebGPUBindGroup,
  WebGPUBindGroupLayout,
  WebGPUBuffer,
  WebGPUComputePipeline,
  WebGPUImportedBuffer,
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
 * uncapped loop (100k static sprites submit every ~0.06 ms), so the queue
 * grows to hundreds of frames and a readback (picking, swarm counters) waits
 * for all of them. M2.5: while a readback is in flight, at most PACE_FRAMES
 * more frames are submitted; later ones are held (the front skips) until it
 * lands. Nothing is paced without a readback in flight, and a vsync-paced
 * loop never holds (a pick lands in about 5 ms). A held frame costs a
 * display tick (Chrome sends the next rAF on its ~16.7 ms timer once a
 * callback produced no frame), so RenderCore answers picks when it releases
 * a held frame instead of waiting for the next render(). M2 fenced every
 * fast submit for 1 s after each request and held on fence age.
 */
const PACE_FRAMES = 3;

/**
 * Queue-depth pacing, the M3 half of the same problem. PACE_FRAMES only runs
 * while a readback is in flight, so an uncapped loop that has never read
 * anything still queues as deep as Chrome lets it — and then the FIRST pick
 * waits behind all of it. Measured at 100k static sprites, vsync off: the
 * first pick took 711 ms on WebGPU (7.8 s on WebGL2) while later picks, which
 * PACE_FRAMES already covers, took 18 ms.
 *
 * So the backend now also holds when the GPU is more than QUEUE_FRAMES
 * submits behind, readback or not. The depth is measured by one
 * `onSubmittedWorkDone()` probe at a time, armed only once the queue looks
 * deep (QUEUE_PROBE) and re-armed at the hold point, so a display-paced loop
 * — where the GPU is never more than a frame or two behind — arms one every
 * QUEUE_PROBE frames at most and never holds.
 *
 * M5: depth alone over-held cheap frames. A probe answers a few ms after the
 * GPU finished, and a 0.2 ms frame submits 16 times in that window, so a
 * 10k-shape static scene was held for a display tick every 16 frames (an
 * uncapped loop stuck near 470 fps with p99 ~19 ms while the GPU idled). The
 * queue now also has to be deep in TIME: the outstanding probe must be
 * QUEUE_MS old, i.e. the GPU is at least that far behind the submit it
 * covers. Cheap frames never hold; a GPU-bound uncapped loop still holds, so
 * the first pick waits for at most a few ticks of queued work.
 */
const QUEUE_FRAMES = 16;
const QUEUE_PROBE = 8;
const QUEUE_MS = 20;

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

  // Readback pacing (see PACE_FRAMES).
  /** Readbacks in flight: readBuffer / readTexture calls and mapping ring slots. */
  reads = 0;
  /** Live readback rings (afterSubmit starts their maps). */
  readonly rings: WebGPUReadbackRing[] = [];
  /** Submits so far, and their count when `reads` last left 0. */
  private submits = 0;
  private readSubmit = 0;
  private caughtUp: (() => void) | null = null;
  /** Queue-depth probe (see QUEUE_FRAMES): submits the GPU has finished. */
  private gpuDone = 0;
  /** `submits` when the outstanding probe was armed; 0 = none outstanding. */
  private probeAt = 0;
  /** performance.now() when the outstanding probe was armed. */
  private probeTime = 0;
  /** The probe's settle callback, created on the first probe and reused. */
  private probeCb: (() => void) | null = null;

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
        'canvas.getContext("webgpu") returned null (the canvas has another context?)',
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
    this.submits++;
    const rings = this.rings;
    for (let i = 0; i < rings.length; i++) rings[i].submitted();
    if (this.submits - this.gpuDone >= QUEUE_PROBE) this.probeQueue();
    if (this.frameScoped) {
      this.frameScoped = false;
      this.popScope('frame', undefined);
      this.popScope('frame', undefined);
    }
  }

  /**
   * @internal Frame pacing (not part of the RHI; RenderCore duck-types it).
   * True while a readback is in flight and PACE_FRAMES frames were submitted
   * since it started, or while the GPU is QUEUE_FRAMES submits and QUEUE_MS
   * behind.
   */
  backlogged(): boolean {
    return (
      (this.reads > 0 && this.submits - this.readSubmit >= PACE_FRAMES) ||
      this.queueDeep()
    );
  }

  /** The outstanding probe is QUEUE_FRAMES submits and QUEUE_MS old. */
  private queueDeep(): boolean {
    return (
      this.probeAt !== 0 &&
      this.submits - this.gpuDone >= QUEUE_FRAMES &&
      performance.now() - this.probeTime >= QUEUE_MS
    );
  }

  /** @internal A readback starts (ring slot mapping, readBuffer, readTexture). */
  readStarted(): void {
    if (this.reads++ === 0) this.readSubmit = this.submits;
  }

  /**
   * Arms the queue-depth probe unless one is outstanding. One pre-bound
   * callback, so only the promise itself is allocated.
   */
  private probeQueue(): void {
    if (this.probeAt !== 0 || this.lost || this.destroyed) return;
    this.probeAt = this.submits;
    this.probeTime = performance.now();
    let cb = this.probeCb;
    // Created once, never per probe; both settlements take the same path.
    if (!cb) cb = this.probeCb = () => this.probeLanded();
    this.device.queue.onSubmittedWorkDone().then(cb, cb);
  }

  private probeLanded(): void {
    if (this.probeAt > this.gpuDone) this.gpuDone = this.probeAt;
    this.probeAt = 0;
    // A lost or destroyed queue never answers again: stop holding on depth.
    if (this.lost || this.destroyed) this.gpuDone = this.submits;
    this.landed();
  }

  /**
   * @internal A readback landed (RingHost too), or the queue-depth probe
   * resolved: a held frame goes once nothing holds it any more, so the next
   * render() polls the ring.
   */
  landed(): void {
    const callback = this.caughtUp;
    const held = !this.lost && (this.reads > 0 || this.queueDeep());
    if (callback !== null && !held) {
      this.caughtUp = null;
      callback();
    } else {
      this.onReadbackLanded?.();
    }
  }

  /** @internal Set by RenderCore: answers landed picks (ARCHITECTURE §19.6). */
  onReadbackLanded: (() => void) | null = null;

  /**
   * @internal Calls `callback` once nothing holds the frame any more (or
   * now). The probe is armed here too: a frame held on queue depth alone has
   * no readback to wake it, so it needs one outstanding.
   */
  whenCaughtUp(callback: () => void): void {
    this.caughtUp = callback;
    this.probeQueue();
    this.landed();
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
    const skip = offset - start;
    return this.readStaging(
      'readBuffer',
      end - start,
      (enc, staging) =>
        enc.copyBufferToBuffer(src.raw, start, staging, 0, end - start),
      mapped => mapped.slice(skip, skip + byteLength),
    );
  }

  /**
   * @internal One-shot readback shared by readBuffer / readTexture
   * (allocates per call; picking uses the readback ring). Counts as a read
   * for pacing.
   */
  async readStaging(
    what: string,
    size: number,
    record: (enc: GPUCommandEncoder, staging: GPUBuffer) => void,
    extract: (mapped: ArrayBuffer) => ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const device = this.device;
    const staging = device.createBuffer({
      label: `cozygpu ${what}`,
      size: align4(size),
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    this.readStarted();
    try {
      const enc = device.createCommandEncoder();
      record(enc, staging);
      device.queue.submit([enc.finish()]);
      try {
        await staging.mapAsync(GPU_MAP_MODE_READ);
      } catch (err) {
        if (await this.deviceLostSoon(device)) {
          throw new CozyGPUError(
            'DEVICE_LOST',
            `${what}: ${(err as Error)?.message ?? String(err)}`,
          );
        }
        throw err;
      }
      return extract(staging.getMappedRange());
    } finally {
      staging.destroy();
      if (device === this.device) this.reads--;
      this.landed();
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
        if (info.messages.length === 0) return;
        import('./compileMessages').then(m => {
          const text = m.formatCompilationMessages(
            source.label,
            code,
            info.messages,
            debug ? 'warning' : 'error',
          );
          if (text) this.log.error(`WGSL compilation:\n${text}`);
        });
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
            // M3 (masks, §21.3): stencil-only draws write no color.
            writeMask: desc.colorWriteDisabled ? 0 : COLOR_WRITE_ALL,
          },
        ],
      },
      primitive: {
        topology: desc.topology ?? 'triangle-list',
        cullMode: 'none',
      },
      multisample: { count: desc.sampleCount ?? 1 },
      depthStencil: toGPUDepthStencil(desc.depthFormat, desc.stencil),
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

  // ─── M2.5: readback ring and interop (ARCHITECTURE §19.4, §19.6) ───────────

  /**
   * RHI (M2.5): loads the readback ring implementation, a lazy chunk kept
   * off the minimal program. `createReadbackRing` needs it; picking awaits
   * it first, and `readTexture` loads it on its first call.
   */
  loadReadbackRing(): Promise<void> {
    return import('./readbackRing').then(m => {
      ringModule = m;
    });
  }

  /**
   * M5 (ARCHITECTURE §27.3). Loads the bundle chunk, which installs
   * `createRenderBundleEncoder` and `RenderPass.executeBundle`.
   */
  loadRenderBundles(): Promise<void> {
    return import('./bundle').then(m => m.installRenderBundles(this));
  }

  createReadbackRing(desc: ReadbackRingDesc): RhiReadbackRing {
    if (!ringModule) {
      throw new CozyGPUError('INTERNAL', 'call loadReadbackRing() first');
    }
    return new ringModule.WebGPUReadbackRing(
      this,
      desc.slots,
      desc.slotBytes,
      desc.label,
    );
  }

  native(): unknown {
    return this.device;
  }

  /**
   * Wraps an outside GPUBuffer. WebGPU cannot tell which device made it, so
   * only its size and usage are checked; `destroy()` just forgets it.
   */
  importBuffer(native: unknown, desc: ImportBufferDesc): RhiBuffer {
    const raw = native as GPUBuffer;
    const need = toGPUBufferUsage(desc.usage);
    if (
      typeof raw?.usage !== 'number' ||
      raw.size < desc.size ||
      (raw.usage & need) !== need
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `importBuffer "${desc.label ?? ''}": need a GPUBuffer of >= ${desc.size} B with usage 0x${need.toString(16)}`,
      );
    }
    return new WebGPUImportedBuffer(
      raw,
      desc.size,
      desc.usage |
        (raw.usage & GPU_BUFFER_USAGE.COPY_SRC ? BufferUsage.COPY_SRC : 0),
      desc.label,
    );
  }

  /** WebGPU keeps no native state between frames. */
  resetState(): void {}

  /**
   * M2 (RHI parity). The implementation lives in the readback ring chunk
   * (rare; kept off the minimal program), so the first call loads it.
   */
  async readTexture(
    texture: RhiTexture,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<ArrayBuffer> {
    if (!ringModule) await this.loadReadbackRing();
    return ringModule!.readTexture(this, texture, x, y, width, height);
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
    // Rings and reads of the old device are dead (their owners recreate them),
    // and its queue took the outstanding depth probe with it.
    this.reads = 0;
    this.probeAt = 0;
    this.gpuDone = this.submits;
    this.rings.length = 0;
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
      this.landed(); // releases a held frame
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
    return `${key}|${desc.topology ?? 'triangle-list'}|${desc.colorFormat ?? this.caps.canvasFormat}|${desc.blend ?? ''}|${desc.depthFormat ?? ''}|${desc.sampleCount ?? 1}${stencilKey(desc.stencil, desc.colorWriteDisabled)}`;
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
      const m = await import('./compileMessages');
      details = m.formatCompilationMessages(
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
