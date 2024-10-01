import { GPUAdapterHandler } from './handlers/GPUAdapterHandler';
import { GPUDeviceHandler } from './handlers/GPUDeviceHandler';
import { Renderer } from './renderer/Renderer';
import { InitOptions } from './types/InitOptions';

class CozyGPU {
  private _adapterHandler: GPUAdapterHandler;
  private _deviceHandler: GPUDeviceHandler;
  private _renderer!: Renderer;

  constructor() {
    this._adapterHandler = new GPUAdapterHandler();
    this._deviceHandler = new GPUDeviceHandler();
  }

  public async init(options: InitOptions): Promise<Renderer> {
    const { hello } = options;
    const adapter = await this._adapterHandler.getAdapter();
    if (!adapter) {
      throw new Error('Canvas is required for GPU rendering.');
    }
    const initDeviceType = await this._deviceHandler.initDevice(
      adapter,
      options,
    );
    // TODO, if its offscreen Canvas, run it in a worker instead
    this._renderer = new Renderer({
      initDeviceType,
    });
    if (hello) {
      console.log(
        'Your experience is powered by WebGPU 🚀. Thank you for using CozyJs-GPU. - Ergin ❤️',
      );
    }
    return this._renderer;
  }

  public destroy(): void {
    // TODO
  }
}

export { CozyGPU };
