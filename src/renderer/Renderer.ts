import { mat4 } from 'gl-matrix';

import shader from '../shaders/shaders.wgsl';

import { IRendererOptions } from '../types/IRendererOptions';
import { IRenderable } from '../types/IRenderable';
import { Canvas } from '../types/types';
import { TriangleMesh } from '../meshes/TriangleMesh';

class Renderer {
  private _canvas: Canvas;
  private _device: GPUDevice;
  private _context: GPUCanvasContext;
  private _format: GPUTextureFormat;

  // Legacy triangle demo
  private _pipeline: GPURenderPipeline;
  private _uniformBuffer: GPUBuffer;
  private _bindGroup!: GPUBindGroup;
  private _triangleMesh: TriangleMesh;
  private _rotation: number = 0;

  // Depth buffer
  private _depthTexture!: GPUTexture;

  // Pluggable renderables (SpriteBatch etc.)
  private _renderables: IRenderable[] = [];

  constructor(options: IRendererOptions) {
    const { initDeviceType } = options;
    this._canvas = initDeviceType.canvas;
    this._device = initDeviceType.device;
    this._context = initDeviceType.context;
    this._format = navigator.gpu.getPreferredCanvasFormat();

    this._triangleMesh = new TriangleMesh(this._device);

    this._uniformBuffer = this._device.createBuffer({
      size: 64 * 3, // model + view + projection
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._createDepthTexture();
    this._pipeline = this._preparePipeline();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  public addRenderable(renderable: IRenderable): void {
    this._renderables.push(renderable);
  }

  public render(): void {
    // Advance rotation for the demo triangle
    this._rotation += 0.01;
    if (this._rotation > 2.0 * Math.PI) {
      this._rotation -= 2.0 * Math.PI;
    }

    const projection = mat4.create();
    mat4.perspective(projection, Math.PI / 4, 800 / 600, 0.1, 10);

    const view = mat4.create();
    mat4.lookAt(view, [-2, 0, 2], [0, 0, 0], [0, 0, 1]);

    const model = mat4.create();
    mat4.rotate(model, model, this._rotation, [0, 0, 1]);

    this._device.queue.writeBuffer(
      this._uniformBuffer,
      0,
      model as unknown as ArrayBuffer,
    );
    this._device.queue.writeBuffer(
      this._uniformBuffer,
      64,
      view as unknown as ArrayBuffer,
    );
    this._device.queue.writeBuffer(
      this._uniformBuffer,
      128,
      projection as unknown as ArrayBuffer,
    );

    const { passEncoder, commandEncoder } = this._beginRenderPass();

    // Draw demo triangle
    passEncoder.setPipeline(this._pipeline);
    passEncoder.setBindGroup(0, this._bindGroup);
    passEncoder.setVertexBuffer(0, this._triangleMesh.buffer);
    passEncoder.draw(3, 1, 0, 0);

    // Draw all registered renderables (SpriteBatch etc.)
    for (const renderable of this._renderables) {
      renderable.render(passEncoder);
    }

    passEncoder.end();
    this._device.queue.submit([commandEncoder.finish()]);
  }

  public get canvas(): Canvas {
    return this._canvas;
  }

  public get device(): GPUDevice {
    return this._device;
  }

  public get format(): GPUTextureFormat {
    return this._format;
  }

  public destroy(): void {
    this._depthTexture.destroy();
    this._uniformBuffer.destroy();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _createDepthTexture(): void {
    const canvas = this._canvas as HTMLCanvasElement | OffscreenCanvas;
    this._depthTexture = this._device.createTexture({
      size: { width: canvas.width, height: canvas.height },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private _preparePipeline(): GPURenderPipeline {
    const bindGroupLayout = this._device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {},
        },
      ],
    });

    this._bindGroup = this._device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this._uniformBuffer },
        },
      ],
    });

    return this._createPipeline(bindGroupLayout);
  }

  private _createPipeline(
    bindGroupLayout: GPUBindGroupLayout,
  ): GPURenderPipeline {
    const pipelineLayout = this._device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    const shaderModule = this._device.createShaderModule({ code: shader });

    return this._device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [this._triangleMesh.bufferLayout],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this._format }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });
  }

  private _beginRenderPass(): {
    passEncoder: GPURenderPassEncoder;
    commandEncoder: GPUCommandEncoder;
  } {
    const commandEncoder = this._device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this._context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.08, g: 0.08, b: 0.12, a: 1.0 },
        },
      ],
      depthStencilAttachment: {
        view: this._depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    return { passEncoder, commandEncoder };
  }
}

export { Renderer };
