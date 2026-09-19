/**
 * Owner: "backend". TEST-ONLY recording implementation of the RHI Backend.
 * Every call is appended to `calls` as a short string so tests can assert
 * ordering (execute → compute → draw → submit). Not part of the library.
 */
import type {
  Backend,
  BindGroupDesc,
  BindGroupLayoutDesc,
  BufferDesc,
  Capabilities,
  CommandList,
  ComputePass,
  ComputePipelineDesc,
  DeviceLostInfo,
  FeedbackPass,
  FeedbackPipelineDesc,
  RenderPass,
  RenderPassDesc,
  RenderPipelineDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiComputePipeline,
  RhiFeedbackPipeline,
  RhiRenderPipeline,
  RhiResource,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
  SamplerDesc,
  ShaderSource,
  TextureDesc,
} from '../../backend/types';

export const FAKE_CAPS: Capabilities = {
  backend: 'webgpu',
  shaderLanguage: 'wgsl',
  compute: true,
  storageBuffers: true,
  vertexStorage: true,
  indirectDraw: true,
  indirectFirstInstance: false,
  transformFeedback: false,
  instancing: true,
  baseInstance: true,
  floatRenderTargets: true,
  integerRenderTargets: true,
  maxSampledTextures: 16,
  timestampQuery: false,
  float32Filterable: false,
  textureCompression: { bc: false, bc7: false, etc2: false, astc: false },
  maxTextureSize: 8192,
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728,
  maxUniformBufferBindingSize: 65536,
  maxComputeWorkgroupSizeX: 256,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupsPerDimension: 65535,
  canvasFormat: 'bgra8unorm',
};

let nextId = 1;

class Resource implements RhiResource {
  readonly id = nextId++;
  destroyed = false;
  constructor(readonly label: string | undefined) {}
  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeBuffer extends Resource implements RhiBuffer {
  readonly bytes: Uint8Array;
  constructor(desc: BufferDesc) {
    super(desc.label);
    this.size = (desc.size + 3) & ~3;
    this.usage = desc.usage;
    this.bytes = new Uint8Array(this.size);
  }
  readonly size: number;
  readonly usage: number;
}

export class FakeTexture extends Resource implements RhiTexture {
  readonly width: number;
  readonly height: number;
  readonly format: TextureDesc['format'];
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  constructor(readonly desc: TextureDesc) {
    super(desc.label);
    this.width = desc.width;
    this.height = desc.height;
    this.format = desc.format;
    this.mipLevelCount = desc.mipLevelCount ?? 1;
    this.sampleCount = desc.sampleCount ?? 1;
  }
}

export class FakeBackend implements Backend {
  readonly kind = 'webgpu' as const;
  caps: Capabilities = { ...FAKE_CAPS };
  pixelWidth: number;
  pixelHeight: number;
  readonly calls: string[] = [];
  readonly textures: FakeTexture[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly textureWrites: {
    texture: RhiTexture;
    data: Uint8Array;
    x: number;
    y: number;
    w: number;
    h: number;
  }[] = [];
  lastPassDesc: {
    target: unknown;
    resolveTarget: unknown;
    clearColor: number[];
  } | null = null;
  lostCallback: ((info: DeviceLostInfo) => void) | null = null;
  restoreFailures = 0;
  destroyed = false;

  constructor(width = 300, height = 150) {
    this.pixelWidth = width;
    this.pixelHeight = height;
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    this.calls.push(`resize ${pixelWidth}x${pixelHeight}`);
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
  }

  createBuffer(desc: BufferDesc): RhiBuffer {
    this.calls.push(`createBuffer ${desc.label ?? ''}`);
    const buffer = new FakeBuffer(desc);
    this.buffers.push(buffer);
    return buffer;
  }

  writeBuffer(
    buffer: RhiBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset = 0,
    byteLength?: number,
  ): void {
    const n = byteLength ?? data.byteLength - dataOffset;
    (buffer as FakeBuffer).bytes.set(
      new Uint8Array(data.buffer, data.byteOffset + dataOffset, n),
      bufferOffset,
    );
    this.calls.push(`writeBuffer ${buffer.label ?? ''}`);
  }

  async readBuffer(
    buffer: RhiBuffer,
    offset: number,
    byteLength: number,
  ): Promise<ArrayBuffer> {
    return (buffer as FakeBuffer).bytes.slice(offset, offset + byteLength)
      .buffer;
  }

  createTexture(desc: TextureDesc): RhiTexture {
    this.calls.push(`createTexture ${desc.label ?? ''}`);
    const texture = new FakeTexture(desc);
    this.textures.push(texture);
    return texture;
  }

  writeTexture(
    texture: RhiTexture,
    data: ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.calls.push(`writeTexture ${texture.label ?? ''}`);
    this.textureWrites.push({
      texture,
      data: new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).slice(),
      x,
      y,
      w: width,
      h: height,
    });
  }

  copyExternalImage(
    _source: ImageBitmap | OffscreenCanvas | ImageData,
    texture: RhiTexture,
  ): void {
    this.calls.push(`copyExternalImage ${texture.label ?? ''}`);
  }

  generateMipmaps(texture: RhiTexture): void {
    this.calls.push(`generateMipmaps ${texture.label ?? ''}`);
  }

  /** Test hook: bytes returned by the next readTexture (default 8 zero bytes). */
  nextTextureRead: Uint8Array | null = null;

  async readTexture(
    texture: RhiTexture,
    _x: number,
    _y: number,
    width: number,
    height: number,
  ): Promise<ArrayBuffer> {
    this.calls.push(`readTexture ${texture.label ?? ''}`);
    const next = this.nextTextureRead;
    this.nextTextureRead = null;
    return next ? next.slice().buffer : new ArrayBuffer(width * height * 8);
  }

  createSampler(desc: SamplerDesc): RhiSampler {
    return new Resource(desc.label);
  }

  createShaderModule(source: ShaderSource): RhiShaderModule {
    return new Resource(source.label);
  }

  createBindGroupLayout(desc: BindGroupLayoutDesc): RhiBindGroupLayout {
    return new Resource(desc.label);
  }

  createBindGroup(desc: BindGroupDesc): RhiBindGroup {
    return new Resource(desc.label);
  }

  async createRenderPipeline(
    desc: RenderPipelineDesc,
  ): Promise<RhiRenderPipeline> {
    return new Resource(desc.label);
  }

  async createComputePipeline(
    desc: ComputePipelineDesc,
  ): Promise<RhiComputePipeline> {
    return new Resource(desc.label);
  }

  async createFeedbackPipeline(
    desc: FeedbackPipelineDesc,
  ): Promise<RhiFeedbackPipeline> {
    return new Resource(desc.label);
  }

  private readonly feedbackPass: FeedbackPass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    run: (_output: RhiBuffer, _offset: number, _first: number, count: number) =>
      void this.calls.push(`feedback ${count}`),
    end: () => void this.calls.push('feedbackPass.end'),
  };

  private readonly renderPass: RenderPass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    setViewport: () => {},
    setScissor: () => {},
    draw: (count: number) => void this.calls.push(`draw ${count}`),
    drawIndexed: () => {},
    drawIndirect: () => {},
    end: () => void this.calls.push('pass.end'),
  };

  private readonly computePass: ComputePass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    dispatch: (x: number) => void this.calls.push(`dispatch ${x}`),
    dispatchIndirect: () => {},
    end: () => void this.calls.push('computePass.end'),
  };

  private readonly list: CommandList = {
    beginRenderPass: (desc: RenderPassDesc) => {
      this.calls.push('beginRenderPass');
      this.lastPassDesc = {
        target: desc.color.target,
        resolveTarget: desc.color.resolveTarget,
        clearColor: Array.from(desc.color.clearColor ?? []),
      };
      return this.renderPass;
    },
    beginComputePass: () => {
      this.calls.push('beginComputePass');
      return this.computePass;
    },
    beginFeedbackPass: () => {
      this.calls.push('beginFeedbackPass');
      return this.feedbackPass;
    },
    submit: () => void this.calls.push('submit'),
  };

  beginCommands(): CommandList {
    this.calls.push('beginCommands');
    return this.list;
  }

  onDeviceLost(callback: (info: DeviceLostInfo) => void): void {
    this.lostCallback = callback;
  }

  async restore(): Promise<void> {
    this.calls.push('restore');
    if (this.restoreFailures > 0) {
      this.restoreFailures--;
      throw new Error('restore failed');
    }
  }

  destroy(): void {
    this.calls.push('destroy');
    this.destroyed = true;
  }

  /** Simulates the backend reporting a lost device. */
  loseDevice(reason: DeviceLostInfo['reason'] = 'unknown'): void {
    this.lostCallback?.({ reason, message: 'fake loss' });
  }
}
