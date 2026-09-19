/**
 * cozygpu RHI (render hardware interface). SHARED + FROZEN during the M2
 * build (docs/ARCHITECTURE.md §7 and §13). Implementations:
 * src/backend/webgpu/** and src/backend/webgl2/** (owner "webgl2").
 *
 * A thin, *internal* abstraction over WebGPU (M1) and WebGL2 (M2).
 * Rules:
 *  - No WebGPU / WebGL types appear here. Implementations cast internally.
 *  - Nothing here may assume compute exists: check `caps.compute` etc.
 *  - This layer lives on the RENDER thread (main thread or worker). Public API
 *    objects never hold RHI objects; they talk to the core through the
 *    command stream (src/commands).
 *  - String unions intentionally mirror WebGPU spelling so the WebGPU
 *    implementation can pass them through without lookup tables.
 */

// ─── Kinds & capabilities ─────────────────────────────────────────────────────

export type BackendKind = 'webgpu' | 'webgl2';
/**
 * 'auto' tries WebGPU, then WebGL2 (ARCHITECTURE §13.5). A named kind never
 * falls back.
 */
export type BackendPreference = 'auto' | BackendKind;

/** Shader language a backend consumes (`ShaderSource.wgsl` or `.glsl`). */
export type ShaderLanguage = 'wgsl' | 'glsl300es';

/** Plain data, safe to post across threads and to expose publicly. */
export interface Capabilities {
  readonly backend: BackendKind;
  /** M2. 'wgsl' (WebGPU) or 'glsl300es' (WebGL2). Systems pick shader sources by this. */
  readonly shaderLanguage: ShaderLanguage;
  /** Compute shaders available (WebGPU: true, WebGL2: false). */
  readonly compute: boolean;
  /** Storage buffers readable from any stage (WebGL2: false). */
  readonly storageBuffers: boolean;
  /** Storage buffers readable from the vertex stage (false in WebGPU compat mode and WebGL2). */
  readonly vertexStorage: boolean;
  /** drawIndirect / drawIndexedIndirect available (WebGL2: false). */
  readonly indirectDraw: boolean;
  /** Non-zero firstInstance allowed in indirect draws. */
  readonly indirectFirstInstance: boolean;
  /**
   * M2. Transform feedback (`createFeedbackPipeline`, `beginFeedbackPass`).
   * WebGL2: true; WebGPU: false (use compute).
   */
  readonly transformFeedback: boolean;
  /** M2. Instanced draws (both backends: true; WebGL1 is not supported). */
  readonly instancing: boolean;
  /**
   * M2. Native non-zero `firstInstance` in `RenderPass.draw`. When false the
   * backend emulates it by offsetting instance-step attribute pointers, so
   * callers may pass firstInstance either way (WebGL2 without
   * WEBGL_draw_instanced_base_vertex_base_instance: false).
   */
  readonly baseInstance: boolean;
  /** M2. rgba16float / rgba32float are color-renderable (WebGL2: EXT_color_buffer_float). */
  readonly floatRenderTargets: boolean;
  /** M2. r32uint / rg32uint render targets + `readTexture` (picking). Both backends: true. */
  readonly integerRenderTargets: boolean;
  /** M2. Sampled textures per shader stage (WebGL2: MAX_TEXTURE_IMAGE_UNITS, >= 16). */
  readonly maxSampledTextures: number;
  readonly timestampQuery: boolean;
  readonly float32Filterable: boolean;
  readonly textureCompression: {
    /** BC1–BC5 (WebGPU texture-compression-bc; WebGL2 s3tc + rgtc). */
    readonly bc: boolean;
    /** M2. BC7 (WebGPU texture-compression-bc; WebGL2 EXT_texture_compression_bptc). */
    readonly bc7: boolean;
    /** ETC2 / EAC. */
    readonly etc2: boolean;
    /** ASTC 4×4 LDR. */
    readonly astc: boolean;
  };
  readonly maxTextureSize: number;
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxUniformBufferBindingSize: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  /** The ONE color format used for the canvas and every color target. */
  readonly canvasFormat: TextureFormat;
}

// ─── Enums as `as const` objects (isolatedModules-safe, no const enum) ────────

export const BufferUsage = {
  VERTEX: 1 << 0,
  INDEX: 1 << 1,
  UNIFORM: 1 << 2,
  STORAGE: 1 << 3,
  INDIRECT: 1 << 4,
  COPY_SRC: 1 << 5,
  COPY_DST: 1 << 6,
  MAP_READ: 1 << 7,
} as const;
export type BufferUsageFlags = number;

export const TextureUsage = {
  SAMPLED: 1 << 0,
  STORAGE: 1 << 1,
  RENDER_TARGET: 1 << 2,
  COPY_SRC: 1 << 3,
  COPY_DST: 1 << 4,
} as const;
export type TextureUsageFlags = number;

export const ShaderStage = {
  VERTEX: 1 << 0,
  FRAGMENT: 1 << 1,
  COMPUTE: 1 << 2,
} as const;
export type ShaderStageFlags = number;

export type TextureFormat =
  | 'rgba8unorm'
  | 'rgba8unorm-srgb'
  | 'bgra8unorm'
  | 'bgra8unorm-srgb'
  | 'r8unorm'
  | 'rgba16float'
  | 'rgba32float'
  // M2: integer targets for picking (never filterable; sampleType 'uint')
  | 'r32uint'
  | 'rg32uint'
  // M2: compressed (sampled only; upload each mip level with writeTexture)
  | 'bc1-rgba-unorm'
  | 'bc1-rgba-unorm-srgb'
  | 'bc3-rgba-unorm'
  | 'bc3-rgba-unorm-srgb'
  | 'bc4-r-unorm'
  | 'bc5-rg-unorm'
  | 'bc7-rgba-unorm'
  | 'bc7-rgba-unorm-srgb'
  | 'etc2-rgb8unorm'
  | 'etc2-rgb8unorm-srgb'
  | 'etc2-rgba8unorm'
  | 'etc2-rgba8unorm-srgb'
  | 'eac-r11unorm'
  | 'eac-rg11unorm'
  | 'astc-4x4-unorm'
  | 'astc-4x4-unorm-srgb'
  | 'depth24plus'
  | 'depth24plus-stencil8'
  | 'depth32float';

export type VertexFormat =
  | 'float32'
  | 'float32x2'
  | 'float32x3'
  | 'float32x4'
  | 'uint32'
  | 'uint16x4'
  | 'unorm8x4'
  | 'unorm16x4';

export type IndexFormat = 'uint16' | 'uint32';
export type Topology =
  | 'triangle-list'
  | 'triangle-strip'
  | 'line-list'
  | 'point-list';
export type FilterMode = 'nearest' | 'linear';
export type AddressMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';

/** Blend presets; custom factors are M3. */
export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen' | 'none';

/** Numeric ids for BlendMode used in the command stream. */
export const BlendModeId = {
  normal: 0,
  add: 1,
  multiply: 2,
  screen: 3,
  none: 4,
} as const satisfies Record<BlendMode, number>;

// ─── Resources ────────────────────────────────────────────────────────────────

export interface RhiResource {
  readonly label: string | undefined;
  destroy(): void;
}

export interface BufferDesc {
  label?: string;
  /** Bytes. Implementations round up to 4. */
  size: number;
  usage: BufferUsageFlags;
}

export interface RhiBuffer extends RhiResource {
  readonly size: number;
  readonly usage: BufferUsageFlags;
}

export interface TextureDesc {
  label?: string;
  width: number;
  height: number;
  format: TextureFormat;
  usage: TextureUsageFlags;
  mipLevelCount?: number;
  sampleCount?: 1 | 4;
}

export interface RhiTexture extends RhiResource {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
}

export interface SamplerDesc {
  label?: string;
  minFilter?: FilterMode;
  magFilter?: FilterMode;
  mipmapFilter?: FilterMode;
  addressU?: AddressMode;
  addressV?: AddressMode;
}

export type RhiSampler = RhiResource;

/**
 * Accepts both forms so a backend can pick what it understands
 * (`caps.shaderLanguage`). A module without the backend's language rejects
 * with CozyGPUError('UNSUPPORTED') at pipeline creation.
 *
 * GLSL ES 3.0 conventions (ARCHITECTURE §13.3), so bind groups map without
 * reflection tables:
 *  - uniform buffer at (group g, binding b):
 *      `layout(std140) uniform G{g}_B{b} { ... } name;`
 *  - texture at (g, b): `uniform sampler2D G{g}_B{b};` (usampler2D for 'uint');
 *    the 'sampler' entry at (g, b + 1) is applied to that texture unit.
 *  - vertex attribute `@location(n)` ⇒ `layout(location = n) in ...;`
 *  - storage bindings are not available (caps.storageBuffers === false).
 *  - the fragment output is `layout(location = 0) out`, premultiplied.
 *  - both sources start with `#version 300 es`.
 */
export interface ShaderSource {
  label?: string;
  wgsl?: string;
  /**
   * M2 (WebGL2). `fragment` may be omitted for transform-feedback-only
   * programs (the backend supplies a trivial one).
   */
  glsl?: { vertex: string; fragment?: string };
}

export type RhiShaderModule = RhiResource;

// ─── Bind groups ──────────────────────────────────────────────────────────────

export type BindingType =
  | { kind: 'uniform'; hasDynamicOffset?: boolean; minBindingSize?: number }
  | { kind: 'storage'; readOnly: boolean; minBindingSize?: number }
  | { kind: 'texture'; sampleType?: 'float' | 'unfilterable-float' | 'uint' }
  | { kind: 'sampler'; filtering?: boolean };

export interface BindGroupLayoutEntry {
  binding: number;
  visibility: ShaderStageFlags;
  type: BindingType;
}

export interface BindGroupLayoutDesc {
  label?: string;
  entries: BindGroupLayoutEntry[];
}

export type RhiBindGroupLayout = RhiResource;

export type BindingResource =
  | { buffer: RhiBuffer; offset?: number; size?: number }
  | { texture: RhiTexture }
  | { sampler: RhiSampler };

export interface BindGroupDesc {
  label?: string;
  layout: RhiBindGroupLayout;
  entries: { binding: number; resource: BindingResource }[];
}

export type RhiBindGroup = RhiResource;

// ─── Pipelines ────────────────────────────────────────────────────────────────

export interface VertexAttribute {
  location: number;
  format: VertexFormat;
  offset: number;
}

export interface VertexBufferLayout {
  stride: number;
  stepMode: 'vertex' | 'instance';
  attributes: VertexAttribute[];
}

export interface RenderPipelineDesc {
  label?: string;
  shader: RhiShaderModule;
  vertexEntry?: string; // default 'vs_main'
  fragmentEntry?: string; // default 'fs_main'
  bindGroupLayouts: RhiBindGroupLayout[];
  /** Empty for pipelines that derive geometry from vertex_index. */
  vertexBuffers: VertexBufferLayout[];
  topology?: Topology;
  /** Defaults to caps.canvasFormat. */
  colorFormat?: TextureFormat;
  blend?: BlendMode;
  depthFormat?: TextureFormat;
  sampleCount?: 1 | 4;
}

export type RhiRenderPipeline = RhiResource;

export interface ComputePipelineDesc {
  label?: string;
  shader: RhiShaderModule;
  entry?: string; // default 'cs_main'
  bindGroupLayouts: RhiBindGroupLayout[];
}

export type RhiComputePipeline = RhiResource;

/**
 * M2. Transform feedback (WebGL2 only; `caps.transformFeedback`). A vertex
 * program that reads `vertexBuffers` and writes `varyings`, interleaved in
 * declaration order, into one output buffer range. Rasterization is
 * discarded. This is how Swarm simulates without compute (ARCHITECTURE §14.2).
 */
export interface FeedbackPipelineDesc {
  label?: string;
  /** `glsl.vertex` is required; `glsl.fragment` is ignored. */
  shader: RhiShaderModule;
  bindGroupLayouts: RhiBindGroupLayout[];
  /** Inputs. May be empty (the program then uses gl_VertexID only). */
  vertexBuffers: VertexBufferLayout[];
  /** Output varying names, interleaved in this order (INTERLEAVED_ATTRIBS). */
  varyings: string[];
}

export type RhiFeedbackPipeline = RhiResource;

// ─── Passes ───────────────────────────────────────────────────────────────────

/** 'canvas' = the current swapchain texture for this frame. */
export type ColorTarget = 'canvas' | RhiTexture;

export interface RenderPassDesc {
  label?: string;
  color: {
    target: ColorTarget;
    /** MSAA resolve target when `target` is multisampled. */
    resolveTarget?: ColorTarget;
    load: 'clear' | 'load';
    /** Straight RGBA 0..1. Read from a reusable Float32Array: no allocation. */
    clearColor?: Float32Array;
  };
  depth?: { target: RhiTexture; load: 'clear' | 'load'; clearValue?: number };
}

export interface RenderPass {
  setPipeline(pipeline: RhiRenderPipeline): void;
  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void;
  setVertexBuffer(slot: number, buffer: RhiBuffer, offset?: number): void;
  setIndexBuffer(buffer: RhiBuffer, format: IndexFormat, offset?: number): void;
  setViewport(x: number, y: number, w: number, h: number): void;
  setScissor(x: number, y: number, w: number, h: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number,
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number,
  ): void;
  /** Requires caps.indirectDraw. */
  drawIndirect(buffer: RhiBuffer, offset: number): void;
  end(): void;
}

export interface ComputePass {
  setPipeline(pipeline: RhiComputePipeline): void;
  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void;
  dispatch(x: number, y?: number, z?: number): void;
  dispatchIndirect(buffer: RhiBuffer, offset: number): void;
  end(): void;
}

/**
 * M2. Transform feedback pass (WebGL2). WebGL2 executes immediately, so
 * "recording" order is execution order; `writeBuffer` calls made before the
 * pass are visible to it (same rule as WebGPU's queue writes).
 */
export interface FeedbackPass {
  setPipeline(pipeline: RhiFeedbackPipeline): void;
  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void;
  setVertexBuffer(slot: number, buffer: RhiBuffer, offset?: number): void;
  /**
   * Runs vertices [first, first + count) and writes `count` output records to
   * `output` starting at byte `outputOffset` (bindBufferRange). `output` must
   * not also be bound as an input (ping-pong two buffers instead).
   */
  run(
    output: RhiBuffer,
    outputOffset: number,
    first: number,
    count: number,
  ): void;
  end(): void;
}

/** One per frame. Passes are recorded in order and submitted together. */
export interface CommandList {
  beginRenderPass(desc: RenderPassDesc): RenderPass;
  /** Throws CozyGPUError('UNSUPPORTED') when !caps.compute. */
  beginComputePass(label?: string): ComputePass;
  /** M2. Throws CozyGPUError('UNSUPPORTED') when !caps.transformFeedback. */
  beginFeedbackPass(label?: string): FeedbackPass;
  submit(): void;
}

// ─── Device lost ──────────────────────────────────────────────────────────────

export interface DeviceLostInfo {
  /**
   * 'destroyed' = the GPUDevice was destroyed rather than lost. The backend
   * never reports its own destroy() (it drops the callback first), so this
   * means outside code destroyed the device; RenderCore restores it.
   */
  reason: 'destroyed' | 'unknown';
  message: string;
}

// ─── Backend ──────────────────────────────────────────────────────────────────

export interface BackendOptions {
  preference: BackendPreference;
  powerPreference?: 'low-power' | 'high-performance';
  /** 'max' requests adapter maxima for buffer sizes (multi-million Swarms). */
  limits?: 'default' | 'max';
  alphaMode?: 'opaque' | 'premultiplied';
  /** Error scopes around creation + frames, shader warnings. Default: `globalThis.__COZYGPU_DEBUG__ === true`. */
  debug?: boolean;
}

export interface Backend {
  readonly kind: BackendKind;
  readonly caps: Capabilities;
  /**
   * M2. Set by `createBackend` only when `preference: 'auto'` asked for WebGPU
   * and ended up on WebGL2: why WebGPU was not used (§13.5). Undefined when the
   * backend was the first choice. Surfaces as `renderer.info.fallbackReason`.
   */
  fallbackReason?: string;

  /** Physical pixel size of the drawing buffer. Recreate size-dependent targets on change. */
  resize(pixelWidth: number, pixelHeight: number): void;
  readonly pixelWidth: number;
  readonly pixelHeight: number;

  createBuffer(desc: BufferDesc): RhiBuffer;
  /** Zero-copy: `data` may be a view into a larger (Shared)ArrayBuffer. */
  writeBuffer(
    buffer: RhiBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset?: number,
    byteLength?: number,
  ): void;
  /** Async readback (picking, bounds, debugging). Never on a hot path. */
  readBuffer(
    buffer: RhiBuffer,
    offset: number,
    byteLength: number,
  ): Promise<ArrayBuffer>;

  createTexture(desc: TextureDesc): RhiTexture;
  /**
   * `width`/`height` are texels of `mipLevel`. For compressed formats `data`
   * holds whole blocks (bytes per row = ceil(width / blockWidth) × blockBytes)
   * and x, y must be 0 (whole level).
   */
  writeTexture(
    texture: RhiTexture,
    data: ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
    mipLevel?: number,
  ): void;
  /**
   * ImageBitmap / OffscreenCanvas / ImageData. Typed loosely to stay GPU-type free.
   * M2: `destX`/`destY` place the image inside a larger texture (atlas pages);
   * the copied size is clamped to the texture.
   */
  copyExternalImage(
    source: ImageBitmap | OffscreenCanvas | ImageData,
    texture: RhiTexture,
    flipY?: boolean,
    destX?: number,
    destY?: number,
  ): void;
  generateMipmaps(texture: RhiTexture): void;
  /**
   * M2. Async readback of a texel rectangle of mip 0 (picking: 1×1 rg32uint).
   * Bytes are tightly packed rows (no WebGPU 256-byte row padding), top row
   * first. Never on a hot path.
   */
  readTexture(
    texture: RhiTexture,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<ArrayBuffer>;
  createSampler(desc: SamplerDesc): RhiSampler;

  createShaderModule(source: ShaderSource): RhiShaderModule;
  createBindGroupLayout(desc: BindGroupLayoutDesc): RhiBindGroupLayout;
  createBindGroup(desc: BindGroupDesc): RhiBindGroup;
  /** Async variants avoid main-thread stalls; prefer them outside the frame loop. */
  createRenderPipeline(desc: RenderPipelineDesc): Promise<RhiRenderPipeline>;
  createComputePipeline(desc: ComputePipelineDesc): Promise<RhiComputePipeline>;
  /** M2. Rejects with CozyGPUError('UNSUPPORTED') when !caps.transformFeedback. */
  createFeedbackPipeline(
    desc: FeedbackPipelineDesc,
  ): Promise<RhiFeedbackPipeline>;

  /** Begin recording a frame. Returns a reused object (no per-frame allocation). */
  beginCommands(): CommandList;

  /**
   * Called once when the device is lost. The backend does NOT auto-restore;
   * RenderCore calls `restore()` and then re-inits its systems.
   */
  onDeviceLost(callback: (info: DeviceLostInfo) => void): void;
  /** Re-acquire adapter/device and reconfigure the canvas. Rejects if impossible. */
  restore(): Promise<void>;

  destroy(): void;
}
