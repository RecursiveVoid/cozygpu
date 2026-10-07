/**
 * RHI resource wrappers around WebGPU objects.
 * The RHI interfaces are GPU-type free; these classes carry the raw object in
 * `raw` and are cast back inside the WebGPU backend only.
 */
import type {
  BufferUsageFlags,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiComputePipeline,
  RhiRenderPipeline,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
  TextureFormat,
} from '../types';

export class WebGPUBuffer implements RhiBuffer {
  /** Out-of-memory check of the allocation (see backend/allocation.ts). */
  allocated: Promise<boolean> | undefined = undefined;

  constructor(
    readonly raw: GPUBuffer,
    readonly size: number,
    readonly usage: BufferUsageFlags,
    readonly label: string | undefined,
  ) {}

  destroy(): void {
    this.raw.destroy();
  }
}

/** M2.5 `importBuffer`: an outside GPUBuffer; cozygpu never destroys it. */
export class WebGPUImportedBuffer extends WebGPUBuffer {
  destroy(): void {}
}

export class WebGPUTexture implements RhiTexture {
  /** Default full view, created once (bind groups and attachments reuse it). */
  readonly view: GPUTextureView;

  constructor(
    readonly raw: GPUTexture,
    readonly width: number,
    readonly height: number,
    readonly format: TextureFormat,
    readonly mipLevelCount: number,
    readonly sampleCount: number,
    readonly label: string | undefined,
  ) {
    this.view = raw.createView();
  }

  destroy(): void {
    this.raw.destroy();
  }
}

export class WebGPUSampler implements RhiSampler {
  constructor(
    readonly raw: GPUSampler,
    readonly label: string | undefined,
  ) {}

  destroy(): void {
    // Samplers have no explicit destroy in WebGPU; GC reclaims them.
  }
}

export class WebGPUShaderModule implements RhiShaderModule {
  constructor(
    readonly raw: GPUShaderModule,
    /** Kept for error formatting (line excerpts). */
    readonly source: string,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}

export class WebGPUBindGroupLayout implements RhiBindGroupLayout {
  constructor(
    readonly raw: GPUBindGroupLayout,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}

export class WebGPUBindGroup implements RhiBindGroup {
  constructor(
    readonly raw: GPUBindGroup,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}

export class WebGPURenderPipeline implements RhiRenderPipeline {
  constructor(
    readonly raw: GPURenderPipeline,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}

export class WebGPUComputePipeline implements RhiComputePipeline {
  constructor(
    readonly raw: GPUComputePipeline,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}
