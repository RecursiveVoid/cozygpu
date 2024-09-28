import { InitOptions } from "../types/InitOptions";
import { Canvas } from "../types/types";

class GPUDeviceHandler {
  private device: GPUDevice | null = null;
  private readonly DEFAULT_HEIGHT = 600;
  private readonly DEFAULT_WIDTH = 800;

  public async initDevice(adapter: GPUAdapter, options: InitOptions): Promise<Canvas> {
    const { canvas: optionalCanvas } = options;
    const canvas = optionalCanvas || this._createCanvas(options);
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error("Failed to get WebGPU context from the canvas.");
    }
    this.device = await adapter.requestDevice();
    context.configure({
      device: this.device,
      format: options.format || 'bgra8unorm',
      alphaMode: options.alphaMode || 'opaque',
    });
    return canvas;
  }

  private _createCanvas(options:  InitOptions): Canvas {
    const { isOffscreenCanvas, height, width } = options;
    const calculatedHeight = height || this.DEFAULT_HEIGHT;
    const calculatedWidth = width || this.DEFAULT_WIDTH;
    if(isOffscreenCanvas) {
      return new OffscreenCanvas(calculatedWidth, calculatedHeight);
    }
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.height = calculatedHeight;
    canvas.width = calculatedWidth;
    return canvas;
  }
}

export { GPUDeviceHandler };
