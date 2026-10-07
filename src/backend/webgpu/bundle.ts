/**
 * Render bundles for the WebGPU backend (ARCHITECTURE §27.3), a lazily
 * loaded chunk (`WebGPUBackend.loadRenderBundles`), so programs without
 * retained rendering do not carry it.
 *
 * Installs `createRenderBundleEncoder` on the backend and
 * `executeBundle` on its render pass, and makes `beginRenderPass` remember
 * the attachment formats of each pass: a bundle runs only in a pass with
 * the color format, sample count and depth/stencil format it was recorded
 * for (anything else returns false and the caller re-records). WebGPU
 * resets the pass' pipeline, bind groups and buffers after
 * `executeBundles`; the pass wrapper caches none of them.
 */
import type {
  IndexFormat,
  RenderBundleEncoder,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiRenderBundle,
  RhiRenderPipeline,
  TextureFormat,
} from '../types';
import type { WebGPUCommandList, WebGPURenderPass } from './commands';
import type {
  WebGPUBindGroup,
  WebGPUBuffer,
  WebGPURenderPipeline,
  WebGPUTexture,
} from './resources';

/** The attachment formats a pass was begun with (set by beginRenderPass). */
interface PassFormats {
  _color?: GPUTextureFormat;
  _samples?: number;
  _depth?: GPUTextureFormat | undefined;
}

class WebGPUBundle implements RhiRenderBundle {
  /** Reused argument of executeBundles (no array per call). */
  readonly list: GPURenderBundle[];

  constructor(
    raw: GPURenderBundle,
    readonly color: GPUTextureFormat,
    readonly samples: number,
    readonly depth: GPUTextureFormat | undefined,
  ) {
    this.list = [raw];
  }

  get label(): string | undefined {
    return this.list[0].label;
  }

  destroy(): void {}
}

class WebGPUBundleEncoder implements RenderBundleEncoder {
  private readonly raw: GPURenderBundleEncoder;
  private ok = true;

  constructor(
    device: GPUDevice,
    private readonly color: GPUTextureFormat,
    private readonly samples: number,
    private readonly depth: GPUTextureFormat | undefined,
  ) {
    this.raw = device.createRenderBundleEncoder({
      label: 'cozygpu.retained',
      colorFormats: [color],
      depthStencilFormat: depth,
      sampleCount: samples,
    });
  }

  setPipeline(pipeline: RhiRenderPipeline): void {
    this.raw.setPipeline((pipeline as WebGPURenderPipeline).raw);
  }

  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void {
    const raw = (group as WebGPUBindGroup).raw;
    if (dynamicOffsets) {
      this.raw.setBindGroup(
        index,
        raw,
        dynamicOffsets,
        0,
        dynamicOffsets.length,
      );
    } else {
      this.raw.setBindGroup(index, raw);
    }
  }

  setVertexBuffer(slot: number, buffer: RhiBuffer, offset = 0): void {
    this.raw.setVertexBuffer(slot, (buffer as WebGPUBuffer).raw, offset);
  }

  setIndexBuffer(buffer: RhiBuffer, format: IndexFormat, offset = 0): void {
    this.raw.setIndexBuffer((buffer as WebGPUBuffer).raw, format, offset);
  }

  /** Pass state: a bundle cannot hold it. */
  setViewport(): void {
    this.ok = false;
  }

  setScissor(): void {
    this.ok = false;
  }

  setStencilReference(): void {
    this.ok = false;
  }

  draw(
    vertexCount: number,
    instanceCount = 1,
    firstVertex = 0,
    firstInstance = 0,
  ): void {
    this.raw.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    this.raw.drawIndexed(
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    );
  }

  drawIndirect(buffer: RhiBuffer, offset: number): void {
    this.raw.drawIndirect((buffer as WebGPUBuffer).raw, offset);
  }

  end(): void {
    this.ok = false;
  }

  finish(): RhiRenderBundle | null {
    const raw = this.raw.finish();
    return this.ok
      ? new WebGPUBundle(raw, this.color, this.samples, this.depth)
      : null;
  }
}

interface BundleHost {
  readonly device: GPUDevice;
  readonly caps: { readonly canvasFormat: TextureFormat };
  createRenderBundleEncoder?(pass: RenderPass): RenderBundleEncoder;
}

/** The recording wrappers, reached through the backend (no runtime import). */
interface Wrappers {
  readonly list: object & { readonly renderPass: object };
}

let patched = false;

/** Installs bundles on `backend` (idempotent). */
export function installRenderBundles(backend: BundleHost): void {
  const canvas = backend.caps.canvasFormat as GPUTextureFormat;
  backend.createRenderBundleEncoder = (pass: RenderPass) => {
    const f = pass as unknown as PassFormats;
    return new WebGPUBundleEncoder(
      backend.device,
      f._color ?? canvas,
      f._samples ?? 1,
      f._depth,
    );
  };
  if (patched) return;
  patched = true;
  const wrappers = (backend as unknown as Wrappers).list;
  const list = Object.getPrototypeOf(wrappers) as WebGPUCommandList;
  const begin = list.beginRenderPass;
  list.beginRenderPass = function (
    this: WebGPUCommandList,
    desc: RenderPassDesc,
  ): RenderPass {
    const pass = begin.call(this, desc);
    const f = pass as unknown as PassFormats;
    const target = desc.color.target;
    if (target === 'canvas') {
      f._color = canvas;
      f._samples = 1;
    } else {
      f._color = (target as WebGPUTexture).format as GPUTextureFormat;
      f._samples = (target as WebGPUTexture).sampleCount;
    }
    const depth = desc.depth?.target as WebGPUTexture | undefined;
    f._depth = depth ? (depth.format as GPUTextureFormat) : undefined;
    return pass;
  };
  (Object.getPrototypeOf(wrappers.renderPass) as RenderPass).executeBundle =
    function (this: WebGPURenderPass, bundle: RhiRenderBundle): boolean {
      const b = bundle as WebGPUBundle;
      const f = this as unknown as PassFormats;
      if (
        b.color !== f._color ||
        b.samples !== f._samples ||
        b.depth !== f._depth
      ) {
        return false;
      }
      this.encoder!.executeBundles(b.list);
      return true;
    };
}
