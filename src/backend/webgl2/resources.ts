/**
 * RHI resource wrappers around WebGL2 objects. The RHI
 * interfaces are GL-type free; these classes are cast back inside the WebGL2
 * backend only. Every object dies with its context: after a context loss
 * callers recreate everything (same contract as a WebGPU device loss).
 */
import type {
  BindGroupLayoutEntry,
  BufferUsageFlags,
  FeedbackPipelineDesc,
  RenderPipelineDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiFeedbackPipeline,
  RhiRenderPipeline,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
  ShaderSource,
  TextureFormat,
  VertexBufferLayout,
} from '../types';
import type { GLTextureFormat, GLVertexFormat } from './formats';
import type { GLStencil } from './state';

/** What resources need from the backend to release themselves. */
export interface GLOwner {
  readonly gl: WebGL2RenderingContext;
}

export class GLBuffer implements RhiBuffer {
  destroyed = false;

  constructor(
    private readonly owner: GLOwner,
    readonly raw: WebGLBuffer | null,
    /** Bind target used for writes: ELEMENT_ARRAY_BUFFER or COPY_WRITE_BUFFER. */
    readonly target: number,
    readonly size: number,
    readonly usage: BufferUsageFlags,
    readonly label: string | undefined,
  ) {}

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.owner.gl.deleteBuffer(this.raw);
  }
}

/** M2.5 `importBuffer`: an outside WebGLBuffer; cozygpu never deletes it. */
export class GLImportedBuffer extends GLBuffer {
  destroy(): void {
    this.destroyed = true;
  }
}

export class GLTexture implements RhiTexture {
  /** Lazily created framebuffer with this texture (or renderbuffer) as color 0. */
  fbo: WebGLFramebuffer | null = null;
  /** Depth attachment currently on `fbo`. */
  fboDepth: GLTexture | null = null;
  /** Host feedbackSerial when color 0 was last (re)attached to `fbo`. */
  fboFeedbackSerial = 0;
  destroyed = false;

  constructor(
    private readonly owner: GLOwner,
    /** Texture object (null for multisampled targets). */
    readonly raw: WebGLTexture | null,
    /** Renderbuffer for multisampled targets. */
    readonly renderbuffer: WebGLRenderbuffer | null,
    readonly gl: GLTextureFormat,
    readonly width: number,
    readonly height: number,
    readonly format: TextureFormat,
    readonly mipLevelCount: number,
    readonly sampleCount: number,
    /** RENDER_TARGET usage: rows are stored bottom-up (see readTexture). */
    readonly renderTarget: boolean,
    readonly label: string | undefined,
  ) {}

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.owner.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.fbo = null;
    this.fboDepth = null;
    if (this.raw) gl.deleteTexture(this.raw);
    if (this.renderbuffer) gl.deleteRenderbuffer(this.renderbuffer);
  }
}

export class GLSampler implements RhiSampler {
  constructor(
    private readonly owner: GLOwner,
    readonly raw: WebGLSampler | null,
    readonly label: string | undefined,
  ) {}

  destroy(): void {
    this.owner.gl.deleteSampler(this.raw);
  }
}

/** Keeps the sources; programs are compiled at pipeline creation. */
export class GLShaderModule implements RhiShaderModule {
  constructor(
    readonly source: ShaderSource,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}

export class GLBindGroupLayout implements RhiBindGroupLayout {
  /** Index = binding number: position among the dynamic-offset entries, or -1. */
  readonly dynamicIndex: number[] = [];
  /** Stable structure key (program cache). */
  readonly key: string;

  constructor(
    readonly entries: readonly BindGroupLayoutEntry[],
    readonly label: string | undefined,
  ) {
    const sorted = entries.slice().sort((a, b) => a.binding - b.binding);
    let dynamic = 0;
    let key = '';
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const t = e.type;
      this.dynamicIndex[e.binding] =
        t.kind === 'uniform' && t.hasDynamicOffset ? dynamic++ : -1;
      key += `${e.binding}${t.kind[1]},`;
    }
    this.key = key;
  }

  destroy(): void {}
}

/** Resources indexed by binding number. */
export class GLBindGroup implements RhiBindGroup {
  readonly buffers: (GLBuffer | undefined)[] = [];
  readonly offsets: number[] = [];
  /** -1 = to the end of the buffer. */
  readonly sizes: number[] = [];
  readonly textures: (GLTexture | undefined)[] = [];
  readonly samplers: (GLSampler | undefined)[] = [];

  constructor(
    readonly layout: GLBindGroupLayout,
    readonly label: string | undefined,
  ) {}

  destroy(): void {}
}

/** One uniform block, texture or sampler a linked program reads. */
export interface GLProgramBinding {
  /** 0 uniform, 1 texture, 2 sampler. */
  readonly kind: number;
  readonly binding: number;
  /** UBO binding point or texture unit. */
  readonly unit: number;
}

export interface GLProgram {
  readonly program: WebGLProgram;
  /** Index = bind group index. */
  readonly groups: readonly (readonly GLProgramBinding[])[];
  /** Transform feedback: bytes per output record (0 for render programs). */
  readonly recordBytes: number;
}

/** Vertex array + the buffer/offset each slot currently points at. */
export class GLVertexArray {
  readonly slotBuffers: (GLBuffer | null)[] = [];
  readonly slotOffsets: number[] = [];
  indexBuffer: GLBuffer | null = null;

  constructor(
    readonly vao: WebGLVertexArrayObject | null,
    readonly layouts: readonly VertexBufferLayout[],
    /** Parallel to layouts[i].attributes. */
    readonly formats: readonly (readonly GLVertexFormat[])[],
  ) {
    for (let i = 0; i < layouts.length; i++) {
      this.slotBuffers.push(null);
      this.slotOffsets.push(-1);
    }
  }
}

export class GLRenderPipeline
  implements RhiRenderPipeline, RhiFeedbackPipeline
{
  constructor(
    readonly program: GLProgram,
    readonly vertexArray: GLVertexArray,
    /** GL primitive mode. */
    readonly mode: number,
    /** Index into BLEND_KEYS (4 = none). */
    readonly blend: number,
    readonly depth: boolean,
    readonly label: string | undefined,
    /** M3 masks: stencil state in GL enums, null when the pipeline has none. */
    readonly stencil: GLStencil | null = null,
    /** M3 masks: stencil-only draws (`RenderPipelineDesc.colorWriteDisabled`). */
    readonly colorWriteDisabled = false,
  ) {}

  /** Programs and vertex arrays are shared through the backend cache. */
  destroy(): void {}
}

export type AnyPipelineDesc = RenderPipelineDesc | FeedbackPipelineDesc;
