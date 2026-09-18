interface IRenderable {
  render(passEncoder: GPURenderPassEncoder): void;
}

export { IRenderable };
