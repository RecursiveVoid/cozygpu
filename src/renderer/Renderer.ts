import { IRendererOptions } from '../types/IRendererOptions';
import { Canvas } from '../types/types';
import shader from '../shaders/shaders.wgsl';

class Renderer {
  private _canvas: Canvas;
  private _device: GPUDevice;
  private _context: GPUCanvasContext;

  constructor(options: IRendererOptions) {
    const { initDeviceType } = options;
    this._canvas = initDeviceType.canvas;
    this._device = initDeviceType.device;
    this._context = initDeviceType.context;
    this.render();
  }

  public render(): void {
    const { passEncoder, commandEncoder } = this._beginRenderPass();
    const pipeline = this._createPipeline();
    passEncoder.setPipeline(pipeline);
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

  private _createPipeline(): GPURenderPipeline {
    return this._device.createRenderPipeline({
      vertex: {
        module: this._device.createShaderModule({
          code: shader,
        }),
        entryPoint: 'vs_main',
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
      layout: 'auto',
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
