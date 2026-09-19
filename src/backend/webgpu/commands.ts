/**
 * Owner: "backend". Reused per-frame recording wrappers.
 *
 * One `WebGPUCommandList`, one `WebGPURenderPass` and one `WebGPUComputePass`
 * exist per backend. Each frame creates a GPUCommandEncoder (unavoidable) but
 * the pass descriptors, attachment objects, clear value and submit array are
 * allocated once and mutated.
 */
import { CozyGPUError } from '../../types/errors';
import type {
  CommandList,
  ComputePass,
  FeedbackPass,
  IndexFormat,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiComputePipeline,
  RhiRenderPipeline,
  ColorTarget,
} from '../types';
import type {
  WebGPUBindGroup,
  WebGPUBuffer,
  WebGPUComputePipeline,
  WebGPURenderPipeline,
  WebGPUTexture,
} from './resources';

/** What the recording wrappers need from the backend. */
export interface CommandHost {
  readonly device: GPUDevice;
  readonly compute: boolean;
  /** This frame's swapchain view (cached per frame by the host). */
  canvasView(): GPUTextureView;
  /** Called by `submit()` after queue.submit (dev-mode error scopes). */
  afterSubmit(): void;
}

export class WebGPURenderPass implements RenderPass {
  encoder: GPURenderPassEncoder | null = null;

  setPipeline(pipeline: RhiRenderPipeline): void {
    this.encoder!.setPipeline((pipeline as WebGPURenderPipeline).raw);
  }

  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void {
    const raw = (group as WebGPUBindGroup).raw;
    if (dynamicOffsets) {
      // Typed-array overload: no intermediate array.
      this.encoder!.setBindGroup(
        index,
        raw,
        dynamicOffsets,
        0,
        dynamicOffsets.length,
      );
    } else {
      this.encoder!.setBindGroup(index, raw);
    }
  }

  setVertexBuffer(slot: number, buffer: RhiBuffer, offset = 0): void {
    this.encoder!.setVertexBuffer(slot, (buffer as WebGPUBuffer).raw, offset);
  }

  setIndexBuffer(buffer: RhiBuffer, format: IndexFormat, offset = 0): void {
    this.encoder!.setIndexBuffer((buffer as WebGPUBuffer).raw, format, offset);
  }

  setViewport(x: number, y: number, w: number, h: number): void {
    this.encoder!.setViewport(x, y, w, h, 0, 1);
  }

  setScissor(x: number, y: number, w: number, h: number): void {
    this.encoder!.setScissorRect(x, y, w, h);
  }

  draw(
    vertexCount: number,
    instanceCount = 1,
    firstVertex = 0,
    firstInstance = 0,
  ): void {
    this.encoder!.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    this.encoder!.drawIndexed(
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    );
  }

  drawIndirect(buffer: RhiBuffer, offset: number): void {
    this.encoder!.drawIndirect((buffer as WebGPUBuffer).raw, offset);
  }

  end(): void {
    this.encoder!.end();
    this.encoder = null;
  }
}

export class WebGPUComputePass implements ComputePass {
  encoder: GPUComputePassEncoder | null = null;

  setPipeline(pipeline: RhiComputePipeline): void {
    this.encoder!.setPipeline((pipeline as WebGPUComputePipeline).raw);
  }

  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void {
    const raw = (group as WebGPUBindGroup).raw;
    if (dynamicOffsets) {
      this.encoder!.setBindGroup(
        index,
        raw,
        dynamicOffsets,
        0,
        dynamicOffsets.length,
      );
    } else {
      this.encoder!.setBindGroup(index, raw);
    }
  }

  dispatch(x: number, y = 1, z = 1): void {
    this.encoder!.dispatchWorkgroups(x, y, z);
  }

  dispatchIndirect(buffer: RhiBuffer, offset: number): void {
    this.encoder!.dispatchWorkgroupsIndirect(
      (buffer as WebGPUBuffer).raw,
      offset,
    );
  }

  end(): void {
    this.encoder!.end();
    this.encoder = null;
  }
}

export class WebGPUCommandList implements CommandList {
  private encoder: GPUCommandEncoder | null = null;
  private readonly renderPass = new WebGPURenderPass();
  private readonly computePass = new WebGPUComputePass();
  private readonly submitArray: GPUCommandBuffer[] = [];

  // Reused descriptors (mutated per pass, never re-allocated).
  private readonly clearValue = { r: 0, g: 0, b: 0, a: 0 };
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    resolveTarget: undefined,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: this.clearValue,
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined as unknown as GPUTextureView,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
    depthClearValue: 1,
  };
  private readonly renderPassDesc: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: undefined,
    label: undefined,
  };
  private readonly computePassDesc: GPUComputePassDescriptor = {
    label: undefined,
  };

  constructor(private readonly host: CommandHost) {}

  /** @internal Starts a new frame on the host's current device. */
  begin(): this {
    this.encoder = this.host.device.createCommandEncoder();
    return this;
  }

  get recording(): boolean {
    return this.encoder !== null;
  }

  beginRenderPass(desc: RenderPassDesc): RenderPass {
    const enc = this.requireEncoder();
    const color = desc.color;
    const ca = this.colorAttachment;
    ca.view = this.resolveView(color.target);
    ca.resolveTarget = color.resolveTarget
      ? this.resolveView(color.resolveTarget)
      : undefined;
    // A multisampled target only feeds its resolve target.
    ca.storeOp = ca.resolveTarget ? 'discard' : 'store';
    ca.loadOp = color.load;
    const cc = color.clearColor;
    const format =
      color.target === 'canvas' ? '' : (color.target as WebGPUTexture).format;
    if (cc && (format === 'r32uint' || format === 'rg32uint')) {
      // Integer targets (picking): the values are ids, never premultiplied.
      this.clearValue.r = cc[0];
      this.clearValue.g = cc[1];
      this.clearValue.b = cc[2];
      this.clearValue.a = cc[3];
    } else if (cc) {
      // Render targets hold premultiplied color (ARCHITECTURE §4).
      const a = cc[3];
      this.clearValue.r = cc[0] * a;
      this.clearValue.g = cc[1] * a;
      this.clearValue.b = cc[2] * a;
      this.clearValue.a = a;
    } else {
      this.clearValue.r = 0;
      this.clearValue.g = 0;
      this.clearValue.b = 0;
      this.clearValue.a = 0;
    }
    const depth = desc.depth;
    if (depth) {
      const da = this.depthAttachment;
      da.view = (depth.target as WebGPUTexture).view;
      da.depthLoadOp = depth.load;
      da.depthClearValue = depth.clearValue ?? 1;
      this.renderPassDesc.depthStencilAttachment = da;
    } else {
      this.renderPassDesc.depthStencilAttachment = undefined;
    }
    this.renderPassDesc.label = desc.label;
    this.renderPass.encoder = enc.beginRenderPass(this.renderPassDesc);
    return this.renderPass;
  }

  beginComputePass(label?: string): ComputePass {
    if (!this.host.compute) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'compute passes are not available on this backend',
      );
    }
    const enc = this.requireEncoder();
    this.computePassDesc.label = label;
    this.computePass.encoder = enc.beginComputePass(this.computePassDesc);
    return this.computePass;
  }

  /** Transform feedback does not exist on WebGPU (use compute). */
  beginFeedbackPass(_label?: string): FeedbackPass {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'transform feedback passes are WebGL2-only; use compute on WebGPU',
    );
  }

  submit(): void {
    const enc = this.requireEncoder();
    // Close passes a caller forgot to end so finish() stays valid.
    if (this.renderPass.encoder) this.renderPass.end();
    if (this.computePass.encoder) this.computePass.end();
    this.submitArray[0] = enc.finish();
    this.encoder = null;
    this.host.device.queue.submit(this.submitArray);
    this.host.afterSubmit();
  }

  /** @internal Drops an unfinished frame (device lost mid-frame). */
  abandon(): void {
    this.renderPass.encoder = null;
    this.computePass.encoder = null;
    this.encoder = null;
  }

  private resolveView(target: ColorTarget): GPUTextureView {
    return target === 'canvas'
      ? this.host.canvasView()
      : (target as WebGPUTexture).view;
  }

  private requireEncoder(): GPUCommandEncoder {
    if (!this.encoder) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'CommandList used outside beginCommands()/submit()',
      );
    }
    return this.encoder;
  }
}
