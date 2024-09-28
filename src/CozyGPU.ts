import { GPUAdapterHandler } from "./handlers/GPUAdapterHandler";
import { GPUDeviceHandler } from "./handlers/GPUDeviceHandler";
import { Renderer } from "./renderer/Renderer";
import { InitOptions } from "./types/InitOptions";

class CozyGPU {

  private adapterHandler: GPUAdapterHandler;
  private deviceHandler: GPUDeviceHandler;
  private _renderer!: Renderer;

  constructor() {
    this.adapterHandler = new GPUAdapterHandler();
    this.deviceHandler = new GPUDeviceHandler();
  }

  public async init(options: InitOptions): Promise<Renderer> {
    const { hello } = options;
    const adapter = await this.adapterHandler.getAdapter();
    if(!adapter) {
      throw new Error("Canvas is required for GPU rendering.");;
    }
    const canvas = await this.deviceHandler.initDevice(adapter, options);
    this._renderer = new Renderer(canvas);
    if (hello) {
      console.log('Your experience is powered by WebGPU 🚀. Thank you for using CozyJs-GPU. - Ergin ❤️');
    }
    return this._renderer;
  }

  public destroy(): void {
    // TODO
  }
}

export { CozyGPU };
