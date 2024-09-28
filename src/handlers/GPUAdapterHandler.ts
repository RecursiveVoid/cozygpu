class GPUAdapterHandler {
  public async getAdapter(): Promise<GPUAdapter | null> {
    if (!navigator.gpu) {
      throw new Error("Web GPU is not supported");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("No appropriate GPUAdapter found.");
    }
    return adapter;
  }
}

export { GPUAdapterHandler };
