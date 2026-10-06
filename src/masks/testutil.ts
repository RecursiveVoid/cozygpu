/**
 * TEST-ONLY fakes for the mask front and core (not part of the library).
 * A recording render pass, a command list and a core context with stencil
 * capable capabilities, plus a front frame over the real command encoder.
 */
import type {
  Backend,
  Capabilities,
  CommandList,
  ComputePass,
  FeedbackPass,
  RenderPass,
  RenderPassDesc,
  RenderPipelineDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiRenderPipeline,
  RhiSampler,
  RhiTexture,
  TextureDesc,
} from '../backend/types';
import { createCommandEncoder } from '../commands';
import type { CoreContext, CoreFrameState, FrontFrame } from '../types/core';
import type { CoreMessage } from '../types/transport';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';

export class RecordPass implements RenderPass {
  readonly calls: string[] = [];
  pipeline = '';

  setPipeline(pipeline: RhiRenderPipeline): void {
    this.pipeline = pipeline.label ?? '';
    this.calls.push(`pipeline ${this.pipeline}`);
  }
  setBindGroup(index: number, _group: RhiBindGroup): void {
    this.calls.push(`bind ${index}`);
  }
  setVertexBuffer(slot: number, buffer: RhiBuffer): void {
    this.calls.push(`vertex ${slot} ${buffer.label ?? ''}`);
  }
  setIndexBuffer(): void {}
  setViewport(): void {}
  setScissor(x: number, y: number, w: number, h: number): void {
    this.calls.push(`scissor ${x} ${y} ${w} ${h}`);
  }
  setStencilReference(reference: number): void {
    this.calls.push(`ref ${reference}`);
  }
  draw(
    vertexCount: number,
    instanceCount = 1,
    _first = 0,
    firstInstance = 0,
  ): void {
    this.calls.push(`draw ${vertexCount}x${instanceCount}@${firstInstance}`);
  }
  drawIndexed(): void {}
  drawIndirect(): void {}
  end(): void {
    this.calls.push('end');
  }
}

export class RecordList implements CommandList {
  readonly passes: RenderPassDesc[] = [];
  readonly pass = new RecordPass();

  beginRenderPass(desc: RenderPassDesc): RenderPass {
    this.passes.push({
      label: desc.label,
      color: { ...desc.color },
      depth: desc.depth ? { ...desc.depth } : undefined,
    });
    this.pass.calls.push(`beginPass ${desc.label ?? ''}`);
    return this.pass;
  }
  beginComputePass(): ComputePass {
    throw new Error('not used');
  }
  beginFeedbackPass(): FeedbackPass {
    throw new Error('not used');
  }
  submit(): void {}
}

class Res {
  destroyed = false;
  constructor(readonly label: string | undefined) {}
  destroy(): void {
    this.destroyed = true;
  }
}

class Tex extends Res implements RhiTexture {
  readonly width: number;
  readonly height: number;
  readonly format;
  readonly mipLevelCount = 1;
  readonly sampleCount: number;
  constructor(desc: TextureDesc) {
    super(desc.label);
    this.width = desc.width;
    this.height = desc.height;
    this.format = desc.format;
    this.sampleCount = desc.sampleCount ?? 1;
  }
}

/** Minimal Backend: only what the mask core touches, with a call log. */
export class MaskBackend {
  readonly calls: string[] = [];
  readonly pipelines: RenderPipelineDesc[] = [];
  readonly textures: Tex[] = [];
  readonly writes: { label: string; offset: number; bytes: number }[] = [];
  caps: Capabilities = { ...FAKE_CAPS, stencil: true };
  pixelWidth = 400;
  pixelHeight = 300;
  /** Test hook: pipeline creation never resolves while true. */
  stallPipelines = false;

  createBuffer(desc: { label?: string; size: number }): RhiBuffer {
    this.calls.push(`createBuffer ${desc.label ?? ''}`);
    return Object.assign(new Res(desc.label), {
      size: desc.size,
      usage: 0,
    }) as unknown as RhiBuffer;
  }
  writeBuffer(
    buffer: RhiBuffer,
    offset: number,
    data: ArrayBufferView,
    dataOffset = 0,
    byteLength?: number,
  ): void {
    this.writes.push({
      label: buffer.label ?? '',
      offset,
      bytes: byteLength ?? data.byteLength - dataOffset,
    });
  }
  createTexture(desc: TextureDesc): RhiTexture {
    this.calls.push(`createTexture ${desc.label ?? ''}`);
    const texture = new Tex(desc);
    this.textures.push(texture);
    return texture;
  }
  createSampler(): RhiSampler {
    return new Res('sampler');
  }
  createShaderModule(source: { label?: string }): RhiBindGroupLayout {
    this.calls.push(`shader ${source.label ?? ''}`);
    return new Res(source.label);
  }
  createBindGroupLayout(desc: { label?: string }): RhiBindGroupLayout {
    return new Res(desc.label);
  }
  createBindGroup(desc: { label?: string }): RhiBindGroup {
    this.calls.push(`bindGroup ${desc.label ?? ''}`);
    return new Res(desc.label);
  }
  createRenderPipeline(desc: RenderPipelineDesc): Promise<RhiRenderPipeline> {
    this.pipelines.push(desc);
    this.calls.push(`pipeline ${desc.label ?? ''}`);
    if (this.stallPipelines) return new Promise<RhiRenderPipeline>(() => {});
    return Promise.resolve(new Res(desc.label) as RhiRenderPipeline);
  }
}

export interface MaskContext extends CoreContext {
  readonly messages: CoreMessage[];
  readonly backend: Backend;
}

export function createMaskContext(
  backend: MaskBackend,
  sampleCount: 1 | 4 = 1,
): MaskContext {
  const messages: CoreMessage[] = [];
  const white = {
    texture: null as unknown as RhiTexture,
    sampler: null as unknown as RhiSampler,
    bindGroup: new Res('white') as RhiBindGroup,
    width: 1,
    height: 1,
  };
  return {
    backend: backend as unknown as Backend,
    viewLayout: new Res('view') as RhiBindGroupLayout,
    viewBindGroup: new Res('view') as RhiBindGroup,
    textureLayout: new Res('texture') as RhiBindGroupLayout,
    whiteTexture: white,
    getTexture: () => white,
    getShared: () => undefined,
    sampleCount,
    post: (message: CoreMessage) => void messages.push(message),
    messages,
  };
}

export function createFrameState(
  frameId: number,
  resolution = 1,
): CoreFrameState {
  return {
    frameId,
    time: 0,
    dt: 1 / 60,
    pixelWidth: 400,
    pixelHeight: 300,
    cssWidth: 400,
    cssHeight: 300,
    resolution,
  };
}

/** A FrontFrame over the real command encoder. */
export function createFrontFrame(options?: {
  caps?: Partial<Capabilities>;
  frameId?: number;
  ready?: boolean;
  resolution?: number;
}): FrontFrame & { _encoder: ReturnType<typeof createCommandEncoder> } {
  const encoder = createCommandEncoder();
  encoder.reset();
  return {
    rendererId: 1,
    caps: { ...FAKE_CAPS, stencil: true, ...options?.caps },
    encoder,
    _encoder: encoder,
    frameId: options?.frameId ?? 1,
    time: 0,
    dt: 1 / 60,
    cssWidth: 400,
    cssHeight: 300,
    resolution: options?.resolution ?? 1,
    sharedMemory: false,
    useSharedArrayBuffer: false,
    generation: 0,
    registerShared: () => 1,
    readback: () => Promise.reject(new Error('not used')),
    isSystemReady: () => options?.ready !== false,
  };
}
