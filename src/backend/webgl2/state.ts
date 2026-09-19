/**
 * Owner: "webgl2". Redundant-call filter for WebGL2 state. WebGL executes
 * immediately, so every pass and upload goes through this cache; `reset()`
 * after a context restore (or whenever GL state is changed behind its back).
 * Steady state allocates nothing.
 */
import { BLEND_KEYS, GL_BLEND } from './formats';
import * as G from './glconst';

/** Sentinel for "unknown binding": never equal to a real object or null. */
const UNKNOWN = {} as never;

export class GLState {
  program: WebGLProgram | null = UNKNOWN;
  vao: WebGLVertexArrayObject | null = UNKNOWN;
  framebuffer: WebGLFramebuffer | null = UNKNOWN;
  private blend = -1;
  private depth = -1;
  private scissor = -1;
  private discard = -1;
  private activeUnit = -1;
  private readonly textures: (WebGLTexture | null)[] = [];
  private readonly samplers: (WebGLSampler | null)[] = [];
  private readonly uboBuffers: (WebGLBuffer | null)[] = [];
  private readonly uboOffsets: number[] = [];
  private readonly uboSizes: number[] = [];
  /** UNPACK_FLIP_Y, UNPACK_PREMULTIPLY_ALPHA (-1 unknown). */
  private flipY = -1;
  private premultiply = -1;

  constructor(private gl: WebGL2RenderingContext) {}

  reset(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.program = UNKNOWN;
    this.vao = UNKNOWN;
    this.framebuffer = UNKNOWN;
    this.blend = this.depth = this.scissor = this.discard = -1;
    this.activeUnit = this.flipY = this.premultiply = -1;
    this.textures.length = 0;
    this.samplers.length = 0;
    this.uboBuffers.length = 0;
    this.uboOffsets.length = 0;
    this.uboSizes.length = 0;
    // Constant for the backend's lifetime: tight rows, no colorspace games.
    gl.pixelStorei(G.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(G.PACK_ALIGNMENT, 1);
    gl.pixelStorei(G.UNPACK_COLORSPACE_CONVERSION_WEBGL, 0);
    gl.depthFunc(G.LEQUAL);
  }

  /** Marks framebuffer / vao / program bindings unknown (after blits, readbacks). */
  invalidateBindings(): void {
    this.framebuffer = UNKNOWN;
    this.vao = UNKNOWN;
    this.program = UNKNOWN;
  }

  useProgram(program: WebGLProgram | null): void {
    if (this.program !== program) {
      this.program = program;
      this.gl.useProgram(program);
    }
  }

  bindVertexArray(vao: WebGLVertexArrayObject | null): void {
    if (this.vao !== vao) {
      this.vao = vao;
      this.gl.bindVertexArray(vao);
    }
  }

  bindFramebuffer(fbo: WebGLFramebuffer | null): void {
    if (this.framebuffer !== fbo) {
      this.framebuffer = fbo;
      this.gl.bindFramebuffer(G.FRAMEBUFFER, fbo);
    }
  }

  /** `key` = index into BLEND_KEYS; 4 ('none') disables blending. */
  setBlend(key: number): void {
    if (this.blend === key) return;
    const gl = this.gl;
    const f = GL_BLEND[BLEND_KEYS[key]];
    if (!f) {
      gl.disable(G.BLEND);
    } else {
      if (this.blend < 0 || this.blend === 4) gl.enable(G.BLEND);
      gl.blendFuncSeparate(f[0], f[1], f[2], f[3]);
    }
    this.blend = key;
  }

  setDepthTest(on: boolean): void {
    this.depth = this.toggle(G.DEPTH_TEST, this.depth, on);
  }

  setScissorTest(on: boolean): void {
    this.scissor = this.toggle(G.SCISSOR_TEST, this.scissor, on);
  }

  setRasterizerDiscard(on: boolean): void {
    this.discard = this.toggle(G.RASTERIZER_DISCARD, this.discard, on);
  }

  private toggle(cap: number, current: number, on: boolean): number {
    const next = on ? 1 : 0;
    if (current !== next) {
      if (on) this.gl.enable(cap);
      else this.gl.disable(cap);
    }
    return next;
  }

  bindTexture(unit: number, texture: WebGLTexture | null): void {
    if (this.textures[unit] === texture) return;
    this.activate(unit);
    this.textures[unit] = texture;
    this.gl.bindTexture(G.TEXTURE_2D, texture);
  }

  /** Binds `texture` on unit 0 for uploads (texStorage, texSubImage…). */
  bindTextureForUpload(texture: WebGLTexture | null): void {
    this.bindTexture(0, texture);
    this.activate(0);
  }

  bindSampler(unit: number, sampler: WebGLSampler | null): void {
    if (this.samplers[unit] !== sampler) {
      this.samplers[unit] = sampler;
      this.gl.bindSampler(unit, sampler);
    }
  }

  bindUniformBuffer(
    unit: number,
    buffer: WebGLBuffer | null,
    offset: number,
    size: number,
  ): void {
    if (
      this.uboBuffers[unit] === buffer &&
      this.uboOffsets[unit] === offset &&
      this.uboSizes[unit] === size
    ) {
      return;
    }
    this.uboBuffers[unit] = buffer;
    this.uboOffsets[unit] = offset;
    this.uboSizes[unit] = size;
    this.gl.bindBufferRange(G.UNIFORM_BUFFER, unit, buffer, offset, size);
  }

  setUnpack(flipY: boolean, premultiply: boolean): void {
    const gl = this.gl;
    const f = flipY ? 1 : 0;
    const p = premultiply ? 1 : 0;
    if (this.flipY !== f) {
      this.flipY = f;
      gl.pixelStorei(G.UNPACK_FLIP_Y_WEBGL, flipY);
    }
    if (this.premultiply !== p) {
      this.premultiply = p;
      gl.pixelStorei(G.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    }
  }

  private activate(unit: number): void {
    if (this.activeUnit !== unit) {
      this.activeUnit = unit;
      this.gl.activeTexture(G.TEXTURE0 + unit);
    }
  }
}
