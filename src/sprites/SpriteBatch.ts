import { mat4 } from 'gl-matrix';

import spriteShader from '../shaders/sprite.wgsl';
import { QuadMesh } from '../meshes/QuadMesh';
import { Sprite } from './Sprite';
import { IRenderable } from '../types/IRenderable';

// Per-instance memory layout (96 bytes = 24 floats):
//   offset  0: mat4 column 0  (16 bytes)
//   offset 16: mat4 column 1  (16 bytes)
//   offset 32: mat4 column 2  (16 bytes)
//   offset 48: mat4 column 3  (16 bytes)
//   offset 64: uvRect vec4    (16 bytes)
//   offset 80: tint vec4      (16 bytes)
const FLOATS_PER_INSTANCE = 24;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4; // 96

class SpriteBatch implements IRenderable {
  private _device: GPUDevice;
  private _format: GPUTextureFormat;
  private _maxSprites: number;

  private _mesh: QuadMesh;
  private _pipeline!: GPURenderPipeline;
  private _bindGroup!: GPUBindGroup;

  private _cameraBuffer: GPUBuffer; // view (64) + projection (64) = 128 bytes
  private _instanceBuffer: GPUBuffer;
  private _instanceData: Float32Array;

  private _spriteCount: number = 0;
  private _texture!: GPUTexture;
  private _sampler: GPUSampler;

  // Scratch mat4 reused every update to avoid GC pressure
  private _modelMatrix: Float32Array = mat4.create() as Float32Array;

  constructor(
    device: GPUDevice,
    maxSprites: number = 10_000,
    format: GPUTextureFormat = 'bgra8unorm',
  ) {
    this._device = device;
    this._maxSprites = maxSprites;
    this._format = format;
    this._mesh = new QuadMesh(device);

    this._cameraBuffer = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._instanceData = new Float32Array(maxSprites * FLOATS_PER_INSTANCE);
    this._instanceBuffer = device.createBuffer({
      size: maxSprites * BYTES_PER_INSTANCE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this._sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Assign the texture for this batch. Must be called before the first render.
   * Rebuilds the pipeline + bind group when called.
   */
  public setTexture(texture: GPUTexture): void {
    this._texture = texture;
    this._buildPipeline();
  }

  /**
   * Update the camera matrices. Call this once per frame before render().
   */
  public updateCamera(view: Float32Array, projection: Float32Array): void {
    this._device.queue.writeBuffer(
      this._cameraBuffer, 0,
      view.buffer as ArrayBuffer, view.byteOffset, view.byteLength,
    );
    this._device.queue.writeBuffer(
      this._cameraBuffer, 64,
      projection.buffer as ArrayBuffer, projection.byteOffset, projection.byteLength,
    );
  }

  /**
   * Convert Sprite objects into GPU instance data and upload.
   * This is the only CPU→GPU upload per frame for sprites.
   */
  public update(sprites: Sprite[]): void {
    this._spriteCount = Math.min(sprites.length, this._maxSprites);

    for (let i = 0; i < this._spriteCount; i++) {
      const s = sprites[i];
      const base = i * FLOATS_PER_INSTANCE;

      // Build model matrix in-place (no allocation)
      mat4.identity(this._modelMatrix);
      mat4.translate(this._modelMatrix, this._modelMatrix, [s.x, s.y, s.z]);
      mat4.rotateZ(this._modelMatrix, this._modelMatrix, s.rotation);
      mat4.scale(this._modelMatrix, this._modelMatrix, [s.scaleX, s.scaleY, 1]);

      // mat4 is 16 column-major floats → directly write to instance buffer
      this._instanceData.set(this._modelMatrix, base);

      // uvRect
      this._instanceData[base + 16] = s.uvRect[0];
      this._instanceData[base + 17] = s.uvRect[1];
      this._instanceData[base + 18] = s.uvRect[2];
      this._instanceData[base + 19] = s.uvRect[3];

      // tint
      this._instanceData[base + 20] = s.tint[0];
      this._instanceData[base + 21] = s.tint[1];
      this._instanceData[base + 22] = s.tint[2];
      this._instanceData[base + 23] = s.tint[3];
    }

    if (this._spriteCount > 0) {
      this._device.queue.writeBuffer(
        this._instanceBuffer,
        0,
        this._instanceData.buffer as ArrayBuffer,
        0,
        this._spriteCount * FLOATS_PER_INSTANCE * 4,
      );
    }
  }

  /**
   * Emit a single instanced draw call for all uploaded sprites.
   * Called by Renderer inside its render pass.
   */
  public render(passEncoder: GPURenderPassEncoder): void {
    if (this._spriteCount === 0 || !this._pipeline) return;

    passEncoder.setPipeline(this._pipeline);
    passEncoder.setBindGroup(0, this._bindGroup);
    passEncoder.setVertexBuffer(0, this._mesh.vertexBuffer);
    passEncoder.setVertexBuffer(1, this._instanceBuffer);
    passEncoder.setIndexBuffer(this._mesh.indexBuffer, 'uint16');
    // 6 indices per quad, _spriteCount instances — one draw call total
    passEncoder.drawIndexed(6, this._spriteCount, 0, 0, 0);
  }

  public destroy(): void {
    this._mesh.destroy();
    this._cameraBuffer.destroy();
    this._instanceBuffer.destroy();
  }

  // ─── Pipeline ──────────────────────────────────────────────────────────────

  private _buildPipeline(): void {
    const module = this._device.createShaderModule({ code: spriteShader });

    const bindGroupLayout = this._device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {},
        },
      ],
    });

    this._bindGroup = this._device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._cameraBuffer } },
        { binding: 1, resource: this._texture.createView() },
        { binding: 2, resource: this._sampler },
      ],
    });

    // Instance buffer vertex layout — one entry per sprite, step mode = instance
    const instanceLayout: GPUVertexBufferLayout = {
      arrayStride: BYTES_PER_INSTANCE,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 2, format: 'float32x4', offset: 0 }, // col0
        { shaderLocation: 3, format: 'float32x4', offset: 16 }, // col1
        { shaderLocation: 4, format: 'float32x4', offset: 32 }, // col2
        { shaderLocation: 5, format: 'float32x4', offset: 48 }, // col3
        { shaderLocation: 6, format: 'float32x4', offset: 64 }, // uvRect
        { shaderLocation: 7, format: 'float32x4', offset: 80 }, // tint
      ],
    };

    this._pipeline = this._device.createRenderPipeline({
      layout: this._device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [this._mesh.vertexLayout, instanceLayout],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this._format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
    });
  }
}

export { SpriteBatch };
