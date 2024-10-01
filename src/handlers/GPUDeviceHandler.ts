import { InitDeviceType } from '../types/InitDeviceType';
import { InitOptions } from '../types/InitOptions';
import { Canvas } from '../types/types';

/**
 * Class representing a GPU device handler.
 * @class
 */
class GPUDeviceHandler {
  /**
   * Default height for the canvas.
   * @type {number}
   */
  private readonly DEFAULT_HEIGHT = 600;
  /**
   * Default width for the canvas.
   * @type {number}
   */
  private readonly DEFAULT_WIDTH = 800;

  /**
   * Initializes the GPU device and sets up the WebGPU context.
   * @param {GPUAdapter} adapter - The GPU adapter to request the device from.
   * @param {InitOptions} options - The options for initialization.
   * @returns {Promise<InitDeviceType>} A promise that resolves with the initialized GPU device and canvas.
   */
  public async initDevice(
    adapter: GPUAdapter,
    options: InitOptions,
  ): Promise<InitDeviceType> {
    const { canvas: optionalCanvas } = options;
    const canvas = optionalCanvas || this._createCanvas(options);
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get WebGPU context from the canvas.');
    }
    const device = await adapter.requestDevice();
    // add more options later.
    context.configure({
      device,
      format: options.format || 'bgra8unorm',
      alphaMode: options.alphaMode || 'opaque',
    });
    return { canvas, device, context };
  }

  private _createCanvas(options: InitOptions): Canvas {
    const { isOffscreenCanvas, height, width } = options;
    const calculatedHeight = height || this.DEFAULT_HEIGHT;
    const calculatedWidth = width || this.DEFAULT_WIDTH;
    if (isOffscreenCanvas) {
      return new OffscreenCanvas(calculatedWidth, calculatedHeight);
    }
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.height = calculatedHeight;
    canvas.width = calculatedWidth;
    return canvas;
  }
}

export { GPUDeviceHandler };
