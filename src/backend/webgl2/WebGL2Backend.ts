/**
 * WebGL2 implementation of the RHI (ARCHITECTURE §13).
 * Loaded only through `import('./webgl2/WebGL2Backend')` in createBackend.ts.
 * DOM-free (worker-safe): OffscreenCanvas or HTMLCanvasElement via
 * `canvas.getContext('webgl2', …)`, `globalThis` only.
 *
 * - Canvas format `rgba8unorm`, premultiplied alpha, no default depth/MSAA
 *   (RenderCore's MSAA target is a multisampled renderbuffer blitted at the
 *   end of the pass).
 * - Programs are compiled from the `glsl` half of a ShaderSource; a module
 *   without it rejects pipeline creation with UNSUPPORTED.
 * - Context loss (`webglcontextlost`) is reported through `onDeviceLost`
 *   (reason 'unknown'); `restore()` waits for `webglcontextrestored`
 *   (0 / 500 / 2000 ms attempts) and resets every cache. All RHI objects from
 *   before the loss are dead, exactly like a WebGPU device loss.
 * - Render targets (RENDER_TARGET usage) hold rows bottom-up, as GL renders
 *   them; `readTexture` flips them so results are top row first like WebGPU.
 *   Sampling a rendered texture is therefore flipped relative to WebGPU
 *   (documented ceiling; the library never samples its own targets).
 */
import { CozyGPUError } from '../../types/errors';
import type { Canvas } from '../../types/types';
import {
  BufferUsage,
  TextureUsage,
  type Backend,
  type BackendOptions,
  type BindGroupDesc,
  type BindGroupLayoutDesc,
  type BufferDesc,
  type Capabilities,
  type CommandList,
  type ComputePipelineDesc,
  type DeviceLostInfo,
  type FeedbackPipelineDesc,
  type RenderPipelineDesc,
  type RhiBindGroup,
  type RhiBindGroupLayout,
  type RhiBuffer,
  type RhiComputePipeline,
  type RhiFeedbackPipeline,
  type RhiRenderPipeline,
  type RhiSampler,
  type RhiShaderModule,
  type RhiTexture,
  type SamplerDesc,
  type ShaderSource,
  type TextureDesc,
  type VertexBufferLayout,
  type ImportBufferDesc,
  type ReadbackRingDesc,
  type RhiReadbackRing,
  ReadbackState,
} from '../types';
import {
  align4,
  bytesPerTexel,
  isDebugEnabled,
  textureByteLength,
} from '../utils';
import { detectGLCapabilities } from './caps';
import { GLCommandList, type GLCommandHost } from './commands';
import {
  BLEND_KEYS,
  FormatKind,
  GL_EXTENSIONS,
  GL_TEXTURE_FORMATS,
  GL_TOPOLOGY,
  GL_VERTEX_FORMATS,
  glAddressMode,
  glFilter,
  glMinFilter,
  type GLVertexFormat,
} from './formats';
import * as G from './glconst';
import { FEEDBACK_FRAGMENT, linkProgram } from './program';
import type { GLReadbackRing } from './readbackRing';

/** The readback ring chunk once loaded (see loadReadbackRing). */
let ringModule: typeof import('./readbackRing') | null = null;
import {
  GLBindGroup,
  GLBindGroupLayout,
  GLBuffer,
  GLImportedBuffer,
  GLRenderPipeline,
  GLSampler,
  GLShaderModule,
  GLTexture,
  GLVertexArray,
  type GLProgram,
} from './resources';
import { GLState, toGLStencil } from './state';

/**
 * Readback pacing (see backlogged). Chrome's getBufferSubData waits for
 * every command issued before it, so frames issued while a readback waits
 * for its fence stall it; M2 (readTexture per pick, uncapped, 100k sprites)
 * measured 90 ms latency with 60+ ms main-thread stalls without pacing.
 * Frames are held once PACE_FRAMES frames ran while a readback waits (M2.5:
 * a ring slot only while its fence is unsignalled). A vsync-paced loop never
 * holds: the fence signals long before the next frame. A held frame costs a
 * display tick, so RenderCore answers picks when it releases a held frame.
 */
const PACE_FRAMES = 3;

/**
 * Queue-depth pacing, the other half of the same problem (ARCHITECTURE §7.1).
 * PACE_FRAMES only runs while a readback is in flight, so an uncapped loop
 * that has never read anything still queues as deep as the driver lets it —
 * and then the FIRST pick waits behind all of it. Measured at 100k sprites
 * plus a 200k swarm, vsync off, after a 6 s no-readback phase: the first pick
 * took 1.7 s, while later picks, which PACE_FRAMES already covers, took 19 ms.
 *
 * So the backend also holds when the GPU is more than QUEUE_FRAMES frames
 * behind, readback or not. The depth is measured by one fence at a time,
 * armed once the queue looks deep (QUEUE_PROBE). GL has no completion
 * callback, so the fence is both armed and polled in `backlogged()`, which
 * the core calls once per frame after submitting it and then on the 1 ms
 * timer that re-checks a held frame. A display-paced loop, where the GPU is
 * never more than a frame or two behind, arms one fence every QUEUE_PROBE
 * frames at most and never holds.
 *
 * The tradeoff is the WebGPU one: an uncapped loop is capped at roughly
 * QUEUE_FRAMES frames of queued work, so its throughput becomes GPU-bound and
 * `stats.skippedFrames` rises. Those frames were never displayed.
 */
const QUEUE_FRAMES = 16;
const QUEUE_PROBE = 8;

const RESTORE_DELAYS_MS = [0, 500, 2000] as const;
/** ImageBitmap scratch canvases up to this size stay allocated between uploads. */
const SCRATCH_KEEP_TEXELS = 1024 * 1024;

type LoseContext = { loseContext(): void; restoreContext(): void };

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lostError(what: string): CozyGPUError {
  return new CozyGPUError('DEVICE_LOST', `${what}: WebGL context lost`);
}

export class WebGL2Backend implements Backend, GLCommandHost {
  readonly kind = 'webgl2' as const;
  caps: Capabilities;
  pixelWidth: number;
  pixelHeight: number;
  readonly state: GLState;
  // Set by initContext (constructor and restore), hence `declare`.
  declare baseInstance: GLCommandHost['baseInstance'];
  declare transformFeedback: WebGLTransformFeedback | null;
  feedbackSerial = 0;
  /** True between a context loss and a successful restore(). */
  lost = false;
  /** Readbacks between their fence and getBufferSubData (see backlogged). */
  private readsInFlight = 0;
  private caughtUp: (() => void) | null = null;
  /** @internal beginCommands() count, and its value when the oldest readback began. */
  frameSerial = 0;
  private readFrame = 0;
  /** Queue-depth probe (see QUEUE_FRAMES): frames the GPU has finished. */
  private gpuDone = 0;
  /** The outstanding probe's fence and the frame serial it covers. */
  private probeSync: WebGLSync | null = null;
  private probeAt = 0;
  /** @internal Live readback rings (pacing looks at their fences). */
  readonly rings: GLReadbackRing[] = [];
  /**
   * @internal Set by RenderCore: answers landed picks. Ring fences are
   * watched on a 1 ms timer while a slot is in flight (ARCHITECTURE §19.6).
   */
  onReadbackLanded: (() => void) | null = null;

  /** @internal The backend's command list (readTexture records into it). */
  readonly list: GLCommandList;
  private readonly debug: boolean;
  declare private parallelCompile: boolean;
  declare private loseExt: LoseContext | null;
  private lostCallback: ((info: DeviceLostInfo) => void) | null = null;
  private destroyed = false;
  private simulated = false;
  /** @internal Bumped per context loss: readbacks started before it fail DEVICE_LOST. */
  epoch = 0;
  private restoredWaiters: (() => void)[] = [];
  private readonly programs = new Map<string, Promise<GLProgram>>();
  private readonly vertexArrays = new Map<string, GLVertexArray>();

  private constructor(
    private readonly canvas: Canvas,
    readonly gl: WebGL2RenderingContext,
    options: BackendOptions,
  ) {
    this.debug = isDebugEnabled(options);
    this.pixelWidth = canvas.width;
    this.pixelHeight = canvas.height;
    this.state = new GLState(gl);
    this.caps = this.initContext();
    this.list = new GLCommandList(this);
    const target = canvas as unknown as EventTarget;
    target.addEventListener('webglcontextlost', this.onLost);
    target.addEventListener('webglcontextrestored', this.onRestored);
  }

  static async create(
    canvas: Canvas,
    options: BackendOptions,
  ): Promise<WebGL2Backend> {
    const getContext = (canvas as { getContext?: unknown }).getContext;
    if (typeof getContext !== 'function') {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'createBackend: canvas has no getContext()',
      );
    }
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      // M3 (masks, ARCHITECTURE §21.3): the default framebuffer needs a
      // stencil buffer, because the canvas is the main pass' color target
      // whenever MSAA is off.
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: options.powerPreference ?? 'default',
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'no WebGL2 context (unsupported, or the canvas has another one)',
      );
    }
    if (gl.isContextLost()) {
      throw new CozyGPUError('UNSUPPORTED', 'the WebGL2 context is lost');
    }
    return new WebGL2Backend(canvas, gl, options);
  }

  // ─── Context setup ─────────────────────────────────────────────────────────

  /** (Re)enables extensions, detects caps, resets caches. Per context. */
  private initContext(): Capabilities {
    const gl = this.gl;
    const available = new Set<string>();
    for (let i = 0; i < GL_EXTENSIONS.length; i++) {
      const ext = gl.getExtension(GL_EXTENSIONS[i]);
      if (ext) available.add(GL_EXTENSIONS[i]);
    }
    this.baseInstance = gl.getExtension(
      'WEBGL_draw_instanced_base_vertex_base_instance',
    );
    this.loseExt = gl.getExtension('WEBGL_lose_context') as LoseContext | null;
    this.parallelCompile = available.has('KHR_parallel_shader_compile');
    this.state.reset(gl);
    this.transformFeedback = gl.createTransformFeedback();
    this.programs.clear();
    this.vertexArrays.clear();
    const caps = detectGLCapabilities(gl, name => available.has(name));
    this.extensions = available;
    return caps;
  }

  declare private extensions: Set<string>;

  // ─── Size ──────────────────────────────────────────────────────────────────

  resize(pixelWidth: number, pixelHeight: number): void {
    const max = this.caps.maxTextureSize;
    const w = Math.max(0, Math.min(max, Math.round(pixelWidth)));
    const h = Math.max(0, Math.min(max, Math.round(pixelHeight)));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.pixelWidth = w;
    this.pixelHeight = h;
  }

  // ─── Buffers ───────────────────────────────────────────────────────────────

  createBuffer(desc: BufferDesc): RhiBuffer {
    const size = Math.max(4, align4(desc.size));
    if (desc.usage & (BufferUsage.STORAGE | BufferUsage.INDIRECT)) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        `buffer "${desc.label ?? ''}": no STORAGE / INDIRECT on WebGL2`,
      );
    }
    if (size > this.caps.maxBufferSize) {
      throw new CozyGPUError(
        'OUT_OF_CAPACITY',
        `buffer "${desc.label ?? ''}" of ${size} B exceeds maxBufferSize ${this.caps.maxBufferSize}`,
      );
    }
    const gl = this.gl;
    const index = (desc.usage & BufferUsage.INDEX) !== 0;
    const target = index ? G.ELEMENT_ARRAY_BUFFER : G.COPY_WRITE_BUFFER;
    const raw = gl.createBuffer();
    const buffer = new GLBuffer(
      this,
      raw,
      target,
      size,
      desc.usage,
      desc.label,
    );
    this.bindForWrite(buffer);
    gl.bufferData(target, size, G.DYNAMIC_DRAW);
    return buffer;
  }

  /** ELEMENT_ARRAY_BUFFER binds into the current VAO: unbind it first. */
  private bindForWrite(buffer: GLBuffer): void {
    if (buffer.target === G.ELEMENT_ARRAY_BUFFER)
      this.state.bindVertexArray(null);
    this.gl.bindBuffer(buffer.target, buffer.raw);
  }

  writeBuffer(
    buffer: RhiBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset = 0,
    byteLength?: number,
  ): void {
    const dst = buffer as GLBuffer;
    const bytes = byteLength ?? data.byteLength - dataOffset;
    if (bytes <= 0) return;
    this.bindForWrite(dst);
    // srcOffset / length count elements of the view type: stay zero-copy when
    // the byte range is element-aligned (always true for Uint8Array).
    const bpe =
      (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ??
      1;
    if (dataOffset % bpe === 0 && bytes % bpe === 0) {
      this.gl.bufferSubData(
        dst.target,
        bufferOffset,
        data,
        dataOffset / bpe,
        bytes / bpe,
      );
    } else {
      this.gl.bufferSubData(
        dst.target,
        bufferOffset,
        new Uint8Array(data.buffer, data.byteOffset + dataOffset, bytes),
      );
    }
  }

  /**
   * Waits for a fence, then getBufferSubData. The implementation lives in
   * the readback ring chunk (rare; kept off the minimal program); pacing
   * counts the read from this call on.
   */
  readBuffer(
    buffer: RhiBuffer,
    offset: number,
    byteLength: number,
  ): Promise<ArrayBuffer> {
    const epoch = this.epoch;
    this.startRead();
    return (ringModule ? Promise.resolve() : this.loadReadbackRing())
      .then(() =>
        ringModule!.readBuffer(this, buffer, offset, byteLength, epoch),
      )
      .finally(() => this.endRead());
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
    const format = GL_TEXTURE_FORMATS[desc.format];
    if (!format || (format.ext && !this.extensions.has(format.ext))) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        `texture "${desc.label ?? ''}": format ${desc.format} unavailable`,
      );
    }
    const gl = this.gl;
    const mipLevelCount = desc.mipLevelCount ?? 1;
    const sampleCount = desc.sampleCount ?? 1;
    const renderTarget = (desc.usage & TextureUsage.RENDER_TARGET) !== 0;
    if (sampleCount > 1) {
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(G.RENDERBUFFER, rb);
      const samples = Math.min(
        sampleCount,
        Number(gl.getParameter(G.MAX_SAMPLES)) || 4,
      );
      gl.renderbufferStorageMultisample(
        G.RENDERBUFFER,
        samples,
        format.internal,
        width,
        height,
      );
      gl.bindRenderbuffer(G.RENDERBUFFER, null);
      return new GLTexture(
        this,
        null,
        rb,
        format,
        width,
        height,
        desc.format,
        1,
        sampleCount,
        true,
        desc.label,
      );
    }
    const raw = gl.createTexture();
    this.state.bindTextureForUpload(raw);
    gl.texStorage2D(
      G.TEXTURE_2D,
      mipLevelCount,
      format.internal,
      width,
      height,
    );
    return new GLTexture(
      this,
      raw,
      null,
      format,
      width,
      height,
      desc.format,
      mipLevelCount,
      1,
      renderTarget,
      desc.label,
    );
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
    const tex = texture as GLTexture;
    if (!tex.raw || width <= 0 || height <= 0) return;
    const gl = this.gl;
    const format = tex.gl;
    this.state.bindTextureForUpload(tex.raw);
    const bytes = textureByteLength(tex.format, width, height);
    if (format.format === 0) {
      const view =
        data.byteLength === bytes && data instanceof Uint8Array
          ? data
          : new Uint8Array(
              data.buffer,
              data.byteOffset,
              Math.min(bytes, data.byteLength),
            );
      gl.compressedTexSubImage2D(
        G.TEXTURE_2D,
        mipLevel,
        x,
        y,
        width,
        height,
        format.internal,
        view,
      );
      return;
    }
    this.state.setUnpack(false, false);
    gl.texSubImage2D(
      G.TEXTURE_2D,
      mipLevel,
      x,
      y,
      width,
      height,
      format.format,
      format.type,
      pixelView(data, format.type, bytes),
      0,
    );
  }

  /**
   * ImageData / OffscreenCanvas honour UNPACK_PREMULTIPLY_ALPHA_WEBGL and
   * UNPACK_FLIP_Y_WEBGL. ImageBitmaps ignore both (WebGL spec) and upload in
   * whatever alpha mode they were decoded with, which JS cannot query, so
   * they are first drawn into a reused 2D OffscreenCanvas (which knows the
   * bitmap's alpha mode) and uploaded from there.
   */
  copyExternalImage(
    source: ImageBitmap | OffscreenCanvas | ImageData,
    texture: RhiTexture,
    flipY = false,
    destX = 0,
    destY = 0,
  ): void {
    const tex = texture as GLTexture;
    if (!tex.raw || !source) return;
    const width = Math.min(source.width, tex.width - destX);
    const height = Math.min(source.height, tex.height - destY);
    if (width <= 0 || height <= 0) return;
    let upload: TexImageSource = source;
    const scratch = this.scratchFor(source, width, height);
    if (scratch) {
      scratch.ctx.drawImage(source as ImageBitmap, 0, 0);
      upload = scratch.canvas;
    }
    this.state.bindTextureForUpload(tex.raw);
    this.state.setUnpack(flipY, true);
    this.gl.texSubImage2D(
      G.TEXTURE_2D,
      0,
      destX,
      destY,
      width,
      height,
      tex.gl.format,
      tex.gl.type,
      upload,
    );
    if (scratch && width * height > SCRATCH_KEEP_TEXELS) {
      // Do not keep a large canvas alive between uploads.
      scratch.canvas.width = 1;
      scratch.canvas.height = 1;
    }
  }

  private scratch: {
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
  } | null = null;

  /** Cleared scratch 2D canvas of exactly width × height, for ImageBitmap sources only. */
  private scratchFor(
    source: ImageBitmap | OffscreenCanvas | ImageData,
    width: number,
    height: number,
  ): {
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
  } | null {
    if (typeof ImageBitmap === 'undefined' || !(source instanceof ImageBitmap))
      return null;
    if (typeof OffscreenCanvas === 'undefined') return null;
    let scratch = this.scratch;
    if (!scratch) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return null;
      scratch = this.scratch = { canvas, ctx };
    }
    const canvas = scratch.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      // Resizing clears the canvas.
      canvas.width = width;
      canvas.height = height;
    } else {
      scratch.ctx.clearRect(0, 0, width, height);
    }
    return scratch;
  }

  generateMipmaps(texture: RhiTexture): void {
    const tex = texture as GLTexture;
    const kind = tex.gl.kind;
    if (!tex.raw || tex.mipLevelCount <= 1 || tex.gl.format === 0) return;
    if (kind === FormatKind.UINT || kind === FormatKind.DEPTH) return;
    if (kind === FormatKind.FLOAT && !this.caps.floatRenderTargets) return;
    this.state.bindTextureForUpload(tex.raw);
    this.gl.generateMipmap(G.TEXTURE_2D);
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

  createReadbackRing(desc: ReadbackRingDesc): RhiReadbackRing {
    if (!ringModule) {
      throw new CozyGPUError('INTERNAL', 'call loadReadbackRing() first');
    }
    return new ringModule.GLReadbackRing(
      this,
      desc.slots,
      desc.slotBytes,
      desc.label,
    );
  }

  native(): unknown {
    return this.gl;
  }

  /**
   * Wraps an outside WebGLBuffer of this context (`gl.isBuffer` must accept
   * it, so it must have been bound once). `desc` is trusted; `destroy()`
   * just forgets it.
   */
  importBuffer(native: unknown, desc: ImportBufferDesc): RhiBuffer {
    const raw = native as WebGLBuffer;
    if (this.lost || !this.gl.isBuffer(raw)) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `importBuffer "${desc.label ?? ''}": not a buffer of this context`,
      );
    }
    return new GLImportedBuffer(
      this,
      raw,
      G.COPY_WRITE_BUFFER,
      desc.size,
      desc.usage,
      desc.label,
    );
  }

  /**
   * Outside code made GL calls: forget cached bindings and restore the
   * defaults the backend relies on.
   */
  resetState(): void {
    const gl = this.gl;
    if (this.lost) return;
    this.state.reset(gl);
    gl.bindBuffer(G.PIXEL_PACK_BUFFER, null);
    gl.bindBuffer(G.PIXEL_UNPACK_BUFFER, null);
    gl.bindTransformFeedback(G.TRANSFORM_FEEDBACK, null);
    gl.disable(G.CULL_FACE);
    gl.disable(G.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
  }

  /**
   * A one-slot readback ring polled on a timer (allocates per call). Rare,
   * so it lives in the ring chunk; the first call loads it.
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

  /**
   * @internal Readback pacing (not part of the RHI; RenderCore duck-types
   * it). Chrome's getBufferSubData waits until the GPU process has run every
   * command issued before it, even after the fence signaled, so frames issued
   * while a readback waits for its fence would stall it (and the page) by the
   * whole queue: 30-180 ms in an uncapped loop. Once PACE_FRAMES frames ran
   * during a readback, frameDone waits and the front skips frames instead.
   */
  backlogged(): boolean {
    this.pollProbe();
    // Called once per frame from the acknowledgement, after the frame's
    // commands were submitted, and again on the timer that re-checks a held
    // frame: the one place the depth is measured and acted on.
    const depth = this.frameSerial - this.gpuDone;
    if (depth >= QUEUE_PROBE) this.probeQueue();
    if (depth >= QUEUE_FRAMES) return true;
    const serial = this.frameSerial - PACE_FRAMES;
    if (this.readsInFlight > 0 && this.readFrame <= serial) return true;
    const rings = this.rings;
    for (let i = 0; i < rings.length; i++) {
      if (rings[i].lagging(serial)) return true;
    }
    return false;
  }

  /** Arms the queue-depth fence unless one is already outstanding. */
  private probeQueue(): void {
    if (this.probeSync !== null || this.lost || this.destroyed) return;
    const gl = this.gl;
    const sync = gl.fenceSync(G.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      // Nothing can measure the depth here, so never hold on it.
      this.gpuDone = this.frameSerial;
      return;
    }
    gl.flush();
    this.probeSync = sync;
    this.probeAt = this.frameSerial;
  }

  /** Polls the outstanding fence. One GL call, wherever the depth is read. */
  private pollProbe(): void {
    const sync = this.probeSync;
    if (sync === null) return;
    const gl = this.gl;
    // A lost context never answers again, and neither does a failed wait:
    // either way stop holding on the depth. (markLost and restore drop the
    // fence themselves, so this only catches a loss GL has not reported yet.)
    const dead = this.lost || gl.isContextLost();
    const status = dead ? G.WAIT_FAILED : gl.clientWaitSync(sync, 0, 0);
    if (status === G.TIMEOUT_EXPIRED) return;
    this.probeSync = null;
    if (!dead) gl.deleteSync(sync);
    if (status === G.WAIT_FAILED) this.gpuDone = this.frameSerial;
    else if (this.probeAt > this.gpuDone) this.gpuDone = this.probeAt;
  }

  /**
   * @internal Calls `callback` once the backlog is gone (or now). Ring
   * fences are re-checked on a 1 ms timer while a frame is held (no packet
   * runs meanwhile, so nothing else would poll them).
   */
  whenCaughtUp(callback: () => void): void {
    this.caughtUp = callback;
    // No fence is armed here: `backlogged()` arms one when the DEPTH is what
    // holds the frame, and a readback hold already watches its own. Arming
    // one per held frame would cost a WebGLSync per frame, which the pick
    // allocation budget (§10) does not have room for.
    this.checkCaughtUp();
  }

  /** @internal GLRingHost: an acknowledgement is held (see whenCaughtUp). */
  get frameHeld(): boolean {
    return this.caughtUp !== null;
  }

  private readonly checkCaughtUp = (): void => {
    const callback = this.caughtUp;
    if (callback === null) return;
    if (!this.lost && this.backlogged()) {
      setTimeout(this.checkCaughtUp, 1);
      return;
    }
    this.caughtUp = null;
    callback();
    // The rings' own fence watch stood down while the frame was held.
    const rings = this.rings;
    for (let i = 0; i < rings.length; i++) rings[i].resumeWatch();
  };

  /** @internal A readback starts (readBuffer, readTexture): pacing counts it. */
  startRead(): void {
    if (this.readsInFlight++ === 0) this.readFrame = this.frameSerial;
  }

  /** @internal The readback finished or failed. */
  endRead(): void {
    if (--this.readsInFlight === 0) this.checkCaughtUp();
  }

  /** @internal GLCommandHost: binds (creating on first use) the texture's framebuffer. */
  bindTargetFramebuffer(texture: GLTexture, depth: GLTexture | null): void {
    const gl = this.gl;
    const state = this.state;
    if (!texture.fbo) {
      texture.fbo = gl.createFramebuffer();
      state.bindFramebuffer(texture.fbo);
      if (texture.renderbuffer) {
        gl.framebufferRenderbuffer(
          G.FRAMEBUFFER,
          G.COLOR_ATTACHMENT0,
          G.RENDERBUFFER,
          texture.renderbuffer,
        );
      } else {
        gl.framebufferTexture2D(
          G.FRAMEBUFFER,
          G.COLOR_ATTACHMENT0,
          G.TEXTURE_2D,
          texture.raw,
          0,
        );
      }
    } else {
      state.bindFramebuffer(texture.fbo);
      if (texture.fboFeedbackSerial !== this.feedbackSerial) {
        // ANGLE over Metal: after a transform feedback draw, a framebuffer
        // created earlier silently stops taking clears and draws (its cached
        // render target goes stale), so the pick target kept answering its
        // first value once a Swarm was drawn. Re-attaching color 0 refreshes
        // it; the cost is two calls per render-target pass after feedback.
        if (texture.renderbuffer) {
          gl.framebufferRenderbuffer(
            G.FRAMEBUFFER,
            G.COLOR_ATTACHMENT0,
            G.RENDERBUFFER,
            null,
          );
          gl.framebufferRenderbuffer(
            G.FRAMEBUFFER,
            G.COLOR_ATTACHMENT0,
            G.RENDERBUFFER,
            texture.renderbuffer,
          );
        } else {
          gl.framebufferTexture2D(
            G.FRAMEBUFFER,
            G.COLOR_ATTACHMENT0,
            G.TEXTURE_2D,
            null,
            0,
          );
          gl.framebufferTexture2D(
            G.FRAMEBUFFER,
            G.COLOR_ATTACHMENT0,
            G.TEXTURE_2D,
            texture.raw,
            0,
          );
        }
      }
    }
    texture.fboFeedbackSerial = this.feedbackSerial;
    if (texture.fboDepth !== depth) {
      const prev = texture.fboDepth ?? depth!;
      const attachment = (d: GLTexture): number =>
        d.format === 'depth24plus-stencil8'
          ? G.DEPTH_STENCIL_ATTACHMENT
          : G.DEPTH_ATTACHMENT;
      if (texture.fboDepth) {
        detach(gl, attachment(prev), prev);
      }
      if (depth) {
        if (depth.renderbuffer) {
          gl.framebufferRenderbuffer(
            G.FRAMEBUFFER,
            attachment(depth),
            G.RENDERBUFFER,
            depth.renderbuffer,
          );
        } else {
          gl.framebufferTexture2D(
            G.FRAMEBUFFER,
            attachment(depth),
            G.TEXTURE_2D,
            depth.raw,
            0,
          );
        }
      }
      texture.fboDepth = depth;
    }
  }

  createSampler(desc: SamplerDesc): RhiSampler {
    const gl = this.gl;
    const raw = gl.createSampler();
    if (raw) {
      gl.samplerParameteri(
        raw,
        G.TEXTURE_MIN_FILTER,
        glMinFilter(desc.minFilter, desc.mipmapFilter),
      );
      gl.samplerParameteri(raw, G.TEXTURE_MAG_FILTER, glFilter(desc.magFilter));
      gl.samplerParameteri(raw, G.TEXTURE_WRAP_S, glAddressMode(desc.addressU));
      gl.samplerParameteri(raw, G.TEXTURE_WRAP_T, glAddressMode(desc.addressV));
    }
    return new GLSampler(this, raw, desc.label);
  }

  // ─── Shaders, layouts, bind groups ─────────────────────────────────────────

  createShaderModule(source: ShaderSource): RhiShaderModule {
    return new GLShaderModule(source, source.label);
  }

  createBindGroupLayout(desc: BindGroupLayoutDesc): RhiBindGroupLayout {
    return new GLBindGroupLayout(desc.entries.slice(), desc.label);
  }

  createBindGroup(desc: BindGroupDesc): RhiBindGroup {
    const group = new GLBindGroup(desc.layout as GLBindGroupLayout, desc.label);
    for (let i = 0; i < desc.entries.length; i++) {
      const { binding, resource } = desc.entries[i];
      if ('buffer' in resource) {
        group.buffers[binding] = resource.buffer as GLBuffer;
        group.offsets[binding] = resource.offset ?? 0;
        group.sizes[binding] = resource.size ?? -1;
      } else if ('texture' in resource) {
        group.textures[binding] = resource.texture as GLTexture;
      } else {
        group.samplers[binding] = resource.sampler as GLSampler;
      }
    }
    return group;
  }

  // ─── Pipelines (async) ─────────────────────────────────────────────────────

  async createRenderPipeline(
    desc: RenderPipelineDesc,
  ): Promise<RhiRenderPipeline> {
    const program = await this.program(
      desc.shader,
      desc.bindGroupLayouts,
      null,
      desc.label,
    );
    const colorFormat =
      GL_TEXTURE_FORMATS[desc.colorFormat ?? this.caps.canvasFormat];
    const blend =
      colorFormat && colorFormat.kind === FormatKind.UINT
        ? 4
        : BLEND_KEYS.indexOf(desc.blend ?? 'normal');
    return new GLRenderPipeline(
      program,
      this.vertexArray(program, desc.vertexBuffers),
      GL_TOPOLOGY[desc.topology ?? 'triangle-list'],
      blend,
      // M3: a stencil pipeline attaches a depth/stencil buffer but keeps
      // depth testing off (cozygpu is 2D).
      desc.depthFormat !== undefined && desc.stencil === undefined,
      desc.label,
      desc.stencil ? toGLStencil(desc.stencil) : null,
      desc.colorWriteDisabled === true,
    );
  }

  async createFeedbackPipeline(
    desc: FeedbackPipelineDesc,
  ): Promise<RhiFeedbackPipeline> {
    if (!desc.varyings || desc.varyings.length === 0) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `feedback pipeline "${desc.label ?? ''}" has no varyings`,
      );
    }
    const program = await this.program(
      desc.shader,
      desc.bindGroupLayouts,
      desc.varyings,
      desc.label,
    );
    return new GLRenderPipeline(
      program,
      this.vertexArray(program, desc.vertexBuffers),
      G.POINTS,
      4,
      false,
      desc.label,
    );
  }

  createComputePipeline(
    _desc: ComputePipelineDesc,
  ): Promise<RhiComputePipeline> {
    return Promise.reject(
      new CozyGPUError(
        'UNSUPPORTED',
        'compute pipelines are not available on WebGL2',
      ),
    );
  }

  private program(
    shader: RhiShaderModule,
    layouts: RhiBindGroupLayout[],
    varyings: string[] | null,
    label: string | undefined,
  ): Promise<GLProgram> {
    const source = (shader as GLShaderModule).source;
    const glsl = source.glsl;
    const name = label ?? source.label ?? '';
    if (!glsl || !glsl.vertex || (!glsl.fragment && !varyings)) {
      return Promise.reject(
        new CozyGPUError('UNSUPPORTED', `shader "${name}" has no GLSL source`),
      );
    }
    if (this.lost) return Promise.reject(lostError(`pipeline "${name}"`));
    const fragment = varyings ? FEEDBACK_FRAGMENT : glsl.fragment!;
    const glLayouts = layouts as GLBindGroupLayout[];
    let key = `${glsl.vertex}\0${fragment}\0${varyings ? varyings.join(',') : ''}\0`;
    for (let i = 0; i < glLayouts.length; i++) key += `${glLayouts[i].key}|`;
    let pending = this.programs.get(key);
    if (!pending) {
      pending = linkProgram(this.gl, this.state, this.parallelCompile, {
        label: name,
        vertex: glsl.vertex,
        fragment,
        varyings,
        layouts: glLayouts,
      });
      this.programs.set(key, pending);
      const programs = this.programs;
      // Registered first, so it runs before any caller's rejection handler.
      pending.catch(() => {
        if (programs.get(key) === pending) programs.delete(key);
        this.noticeLoss();
      });
    }
    return pending;
  }

  /** One VAO per (program, vertex layout); enables attributes + divisors once. */
  private vertexArray(
    program: GLProgram,
    layouts: VertexBufferLayout[],
  ): GLVertexArray {
    let key = '';
    for (let i = 0; i < layouts.length; i++) {
      const b = layouts[i];
      key += `${b.stride}${b.stepMode[0]}`;
      for (let j = 0; j < b.attributes.length; j++) {
        const a = b.attributes[j];
        key += `:${a.location}/${a.format}/${a.offset}`;
      }
      key += ';';
    }
    let ids = this.programIds.get(program.program);
    if (ids === undefined) {
      ids = this.programIds.size + 1;
      this.programIds.set(program.program, ids);
    }
    key = `${ids}|${key}`;
    const cached = this.vertexArrays.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    this.state.bindVertexArray(vao);
    const formats: GLVertexFormat[][] = [];
    for (let i = 0; i < layouts.length; i++) {
      const b = layouts[i];
      const list: GLVertexFormat[] = [];
      for (let j = 0; j < b.attributes.length; j++) {
        const a = b.attributes[j];
        list.push(GL_VERTEX_FORMATS[a.format]);
        gl.enableVertexAttribArray(a.location);
        gl.vertexAttribDivisor(a.location, b.stepMode === 'instance' ? 1 : 0);
      }
      formats.push(list);
    }
    const va = new GLVertexArray(vao, layouts.slice(), formats);
    this.vertexArrays.set(key, va);
    return va;
  }

  private readonly programIds = new Map<WebGLProgram, number>();

  // ─── Frame ─────────────────────────────────────────────────────────────────

  beginCommands(): CommandList {
    this.frameSerial++;
    return this.list;
  }

  // ─── Context loss (ARCHITECTURE §13.6) ─────────────────────────────────────

  onDeviceLost(callback: (info: DeviceLostInfo) => void): void {
    this.lostCallback = callback;
  }

  private readonly onLost = (event: Event): void => {
    // Without preventDefault() the context is never restored.
    event.preventDefault();
    this.markLost();
  };

  /**
   * Called when a GL call finds the context lost before `webglcontextlost`
   * was dispatched (the event is queued as a task): reports the loss now, so
   * the core sees it before the failing call's DEVICE_LOST rejection instead
   * of treating that rejection as fatal. The late event only preventDefaults.
   */
  /** @internal */
  noticeLoss(): void {
    if (!this.lost && this.gl.isContextLost()) this.markLost();
  }

  private markLost(): void {
    if (this.destroyed || this.lost) return;
    this.lost = true;
    this.epoch++;
    this.list.abandon();
    // The fence belongs to the dead context and never signals again.
    this.probeSync = null;
    this.gpuDone = this.frameSerial;
    const held = this.caughtUp; // releases a held frame
    this.caughtUp = null;
    held?.();
    const simulated = this.simulated;
    const callback = this.lostCallback;
    if (callback) {
      callback({
        reason: 'unknown',
        message: simulated ? 'simulated device loss' : 'WebGL context lost',
      });
    }
  }

  private readonly onRestored = (): void => {
    const waiters = this.restoredWaiters;
    this.restoredWaiters = [];
    for (let i = 0; i < waiters.length; i++) waiters[i]();
  };

  async restore(): Promise<void> {
    const gl = this.gl;
    for (let i = 0; i < RESTORE_DELAYS_MS.length; i++) {
      // Always yield: restoreContext() is refused inside the lost event.
      await delay(RESTORE_DELAYS_MS[i]);
      if (this.destroyed) break;
      if (gl.isContextLost()) {
        const restored = new Promise<void>(resolve =>
          this.restoredWaiters.push(resolve),
        );
        if ((this.simulated || this.debug) && this.loseExt) {
          try {
            this.loseExt.restoreContext();
          } catch {
            // Not lost through WEBGL_lose_context: wait for the browser.
          }
        }
        await Promise.race([restored, delay(1000)]);
      }
      if (this.destroyed) break;
      if (!gl.isContextLost()) {
        this.simulated = false;
        this.rings.length = 0;
        this.programIds.clear();
        this.caps = this.initContext();
        this.list.abandon();
        this.probeSync = null;
        this.gpuDone = this.frameSerial;
        this.lost = false;
        return;
      }
    }
    if (this.destroyed)
      throw new CozyGPUError('DESTROYED', 'backend was destroyed');
    throw new CozyGPUError(
      'DEVICE_LOST',
      `WebGL2 context not restored after ${RESTORE_DELAYS_MS.length} tries`,
    );
  }

  /**
   * @internal Testing hook: loses the context through WEBGL_lose_context,
   * exercising the same path as a real GPU reset.
   */
  simulateDeviceLoss(): void {
    if (this.destroyed || this.lost || !this.loseExt) return;
    this.simulated = true;
    this.loseExt.loseContext();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lostCallback = null;
    this.list.abandon();
    const target = this.canvas as unknown as EventTarget;
    target.removeEventListener('webglcontextlost', this.onLost);
    target.removeEventListener('webglcontextrestored', this.onRestored);
    this.onRestored();
    const gl = this.gl;
    const probe = this.probeSync;
    this.probeSync = null;
    if (!gl.isContextLost()) {
      if (probe) gl.deleteSync(probe);
      this.programs.forEach(p =>
        p.then(
          info => gl.deleteProgram(info.program),
          () => {},
        ),
      );
      this.vertexArrays.forEach(va => gl.deleteVertexArray(va.vao));
      gl.deleteTransformFeedback(this.transformFeedback);
    }
    this.programs.clear();
    this.vertexArrays.clear();
    this.programIds.clear();
  }
}

function detach(
  gl: WebGL2RenderingContext,
  attachment: number,
  depth: GLTexture,
): void {
  if (depth.renderbuffer)
    gl.framebufferRenderbuffer(G.FRAMEBUFFER, attachment, G.RENDERBUFFER, null);
  else
    gl.framebufferTexture2D(G.FRAMEBUFFER, attachment, G.TEXTURE_2D, null, 0);
}

/** texSubImage2D needs the view type that matches the pixel type. */
function pixelView(
  data: ArrayBufferView,
  type: number,
  bytes: number,
): ArrayBufferView {
  const want =
    type === G.FLOAT
      ? Float32Array
      : type === G.UNSIGNED_INT
        ? Uint32Array
        : type === G.HALF_FLOAT
          ? Uint16Array
          : Uint8Array;
  if (data instanceof want && data.byteLength === bytes) return data;
  return new want(
    data.buffer as ArrayBuffer,
    data.byteOffset,
    Math.floor(Math.min(bytes, data.byteLength) / want.BYTES_PER_ELEMENT),
  );
}
