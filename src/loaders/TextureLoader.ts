import EventEmitter from 'eventemitter3';

class TextureLoader extends EventEmitter {
  private _device: GPUDevice;

  private _manifest: Map<string, GPUTexture>;

  constructor(device: GPUDevice) {
    super();
    this._device = device;
    this._manifest = new Map();
  }

  public async loadTexture(url: string, description: string) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const imageData = await createImageBitmap(blob);
      const texture = await this._createTextureFromImageBitmap(imageData);
      this._manifest.set(description, texture);
      this.emit(TextureLoaderEvent.COMPLETE, texture);
    } catch (error) {
      this.emit(TextureLoaderEvent.FAIL, error);
    }
  }

  public getTexture(description: string): GPUTexture | null | undefined {
    if (this._manifest.has(description)) {
      return this._manifest.get(description);
    }
    return null;
  }

  private async _createTextureFromImageBitmap(
    imageData: ImageBitmap,
  ): Promise<GPUTexture> {
    const textureDescriptor: GPUTextureDescriptor = {
      size: {
        width: imageData.width,
        height: imageData.height,
      },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    };
    const texture = this._device.createTexture(textureDescriptor);
    this._device.queue.copyExternalImageToTexture(
      { source: imageData },
      { texture: texture },
      textureDescriptor.size,
    );
    return texture;
  }

  public destroy(): void {
    this._manifest.forEach(texture => {
      texture.destroy();
    });
    this.removeAllListeners();
  }
}

export { TextureLoader };
