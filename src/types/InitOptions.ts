interface InitOptions {
  height?: number;
  width?: number;
  antiAliasing?: boolean;
  resize?: any;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  format?: GPUTextureFormat; // Optional: format of the texture used for rendering
  alphaMode?: GPUCanvasAlphaMode; // Optional: alpha mode for the canvas
  // Additional optional parameters can be added here based on your needs
  usage?: GPUTextureUsageFlags; // Optional: usage flags for the texture
  viewFormat?: GPUTextureFormat; // Optional: view format for the texture
  isOffscreenCanvas?: boolean;
  hello?: boolean;
  powerPreference?: string;
  backgroundColor?: number;
}

export { InitOptions };
