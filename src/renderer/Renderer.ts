import { IRendererOptions } from '../types/IRendererOptions';
import { Canvas } from '../types/types';

class Renderer {
  private _canvas: Canvas;
  private _device: GPUDevice;
  private _context: GPUCanvasContext;

  constructor(options: IRendererOptions) {
    const { initDeviceType } = options;
    this._canvas = initDeviceType.canvas;
    this._device = initDeviceType.device;
    this._context = initDeviceType.context;
    const { passEncoder, commandEncoder } = this._beginRenderPass();
    // Whatever you put here will be drawn.
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
    // TODO use color array instead [0,0.5,1.0,1.0]
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
