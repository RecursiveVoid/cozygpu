class TriangleMesh {
  private _buffer: GPUBuffer;
  private _bufferLayout: GPUVertexBufferLayout;

  constructor(device: GPUDevice) {
    // x y r g b
    const verticies = new Float32Array([
      0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 0.0, -0.5, -0.5, 1.0, 1.0, 1.0, 0.5, 0.0,
      -0.5, 1.0, 1.0, 1.0,
    ]);
    const bufferUsage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
    const bufferDescriptor: GPUBufferDescriptor = {
      size: verticies.byteLength,
      usage: bufferUsage,
      mappedAtCreation: true,
    };
    this._buffer = device.createBuffer(bufferDescriptor);
    const arrayBuffer = new Float32Array(this._buffer.getMappedRange());
    arrayBuffer.set(verticies);
    this._buffer.unmap();
    // floats are 4 bytes
    this._bufferLayout = {
      arrayStride: 24,
      attributes: [
        {
          shaderLocation: 0,
          format: 'float32x3', // x,y,z
          offset: 0,
        },
        {
          shaderLocation: 1,
          format: 'float32x3',
          offset: 12,
        },
      ],
    };
  }

  public get bufferLayout(): GPUVertexBufferLayout {
    return this._bufferLayout;
  }

  public get buffer(): GPUBuffer {
    return this._buffer;
  }
}

export { TriangleMesh };
