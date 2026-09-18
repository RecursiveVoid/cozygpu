/**
 * Indexed unit quad centered at origin.
 * Vertex layout: vec3 position, vec2 uv — stride 20 bytes.
 */
class QuadMesh {
  private _vertexBuffer: GPUBuffer;
  private _indexBuffer: GPUBuffer;
  private _vertexLayout: GPUVertexBufferLayout;

  constructor(device: GPUDevice) {
    // x, y, z, u, v  (each row = one vertex)
    const vertices = new Float32Array([
      -0.5,
      0.5,
      0.0,
      0.0,
      0.0, // top-left
      0.5,
      0.5,
      0.0,
      1.0,
      0.0, // top-right
      0.5,
      -0.5,
      0.0,
      1.0,
      1.0, // bottom-right
      -0.5,
      -0.5,
      0.0,
      0.0,
      1.0, // bottom-left
    ]);

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    this._vertexBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this._vertexBuffer.getMappedRange()).set(vertices);
    this._vertexBuffer.unmap();

    this._indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint16Array(this._indexBuffer.getMappedRange()).set(indices);
    this._indexBuffer.unmap();

    // 5 floats × 4 bytes = 20 byte stride
    this._vertexLayout = {
      arrayStride: 20,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, format: 'float32x3', offset: 0 }, // position
        { shaderLocation: 1, format: 'float32x2', offset: 12 }, // uv
      ],
    };
  }

  public get vertexBuffer(): GPUBuffer {
    return this._vertexBuffer;
  }

  public get indexBuffer(): GPUBuffer {
    return this._indexBuffer;
  }

  public get vertexLayout(): GPUVertexBufferLayout {
    return this._vertexLayout;
  }

  public get indexCount(): number {
    return 6;
  }

  public destroy(): void {
    this._vertexBuffer.destroy();
    this._indexBuffer.destroy();
  }
}

export { QuadMesh };
