import { mat4 } from 'gl-matrix';

import shader from '../shaders/shaders.wgsl';

import { IRendererOptions } from '../types/IRendererOptions';
import { Canvas } from '../types/types';
import { TriangleMesh } from '../meshes/TriangleMesh';

class Renderer {
  private _canvas: Canvas;
  private _device: GPUDevice;
  private _context: GPUCanvasContext;
  private _pipeline: GPURenderPipeline;
  private _uniformBuffer: GPUBuffer;
  private _bindGroup!: GPUBindGroup;

  private _triangleMesh: TriangleMesh;

  private _test: number;

  constructor(options: IRendererOptions) {
    const { initDeviceType } = options;
    this._canvas = initDeviceType.canvas;
    this._device = initDeviceType.device;
    this._context = initDeviceType.context;
    this._triangleMesh = new TriangleMesh(this._device);
    this._test = 0.0;
    this._uniformBuffer = this._device.createBuffer({
      size: 64 * 3,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._pipeline = this._preparePipeline();
  }

  private _preparePipeline(): GPURenderPipeline {
    const bindGroupLayout = this._device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {}, // its nothing but its specified as buffer.
        },
      ],
    });
    this._bindGroup = this._device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this._uniformBuffer,
          },
        },
      ],
    });
    return this._createPipeline(bindGroupLayout);
  }

  public render(): void {
    this._test += 0.1;
    if (this._test > 2.0 * Math.PI) {
      this._test -= 2.0 * Math.PI;
    }
    const projection = mat4.create();
    mat4.perspective(projection, Math.PI / 4, 800 / 600, 0.1, 10);
    const view = mat4.create();
    mat4.lookAt(view, [-2, 0, 2], [0, 0, 0], [0, 0, 1]);
    const model = mat4.create();
    mat4.rotate(model, model, this._test, [0, 0, 1]);

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
    passEncoder.setPipeline(this._pipeline);
    passEncoder.setBindGroup(0, this._bindGroup);
    passEncoder.setVertexBuffer(0, this._triangleMesh.buffer);
    passEncoder.draw(3, 1, 0, 0);
    passEncoder.end();
    const buffer = this._getCommandBuffer(commandEncoder);
    this._submitCommand(buffer);
  }

  private _createEncoder(): GPUCommandEncoder {
    return this._device.createCommandEncoder();
  }

  private _getPreferredTextureFormat(): GPUTextureFormat {
    return navigator.gpu.getPreferredCanvasFormat();
  }

  private _beginRenderPass(): {
    passEncoder: GPURenderPassEncoder;
    commandEncoder: GPUCommandEncoder;
  } {
    const encoder = this._createEncoder();
    const clearColor = { r: 0.0, g: 0.5, b: 1.0, a: 1.0 };
    return {
      commandEncoder: encoder,
      passEncoder: encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this._context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: clearColor,
          },
        ],
      }),
    };
  }

  private _createPipeline(
    bindGroupLayout: GPUBindGroupLayout,
  ): GPURenderPipeline {
    const pipelineLayout = this._device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    return this._device.createRenderPipeline({
      vertex: {
        module: this._device.createShaderModule({
          code: shader,
        }),
        entryPoint: 'vs_main',
        buffers: [this._triangleMesh.bufferLayout],
      },
      fragment: {
        module: this._device.createShaderModule({
          code: shader,
        }),
        entryPoint: 'fs_main',
        targets: [
          {
            format: 'bgra8unorm', // TODO fetch it from the init option
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
      layout: pipelineLayout,
    });
  }

  private _getCommandBuffer(encoder: GPUCommandEncoder) {
    return encoder.finish();
  }

  private _submitCommand(commandBuffer: GPUCommandBuffer): void {
    this._device.queue.submit([commandBuffer]);
  }

  public get canvas(): Canvas {
    return this._canvas;
  }

  public destroy(): void {}
}

export { Renderer };
