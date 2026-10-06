/**
 * Owner: "webgl2". Redundant-call filter for WebGL2 state. WebGL executes
 * immediately, so every pass and upload goes through this cache; `reset()`
 * after a context restore (or whenever GL state is changed behind its back).
 * Steady state allocates nothing.
 */
import type { CompareFunction, StencilOperation, StencilState } from '../types';
import { BLEND_KEYS, GL_BLEND } from './formats';
import * as G from './glconst';

/**
 * M3 (ARCHITECTURE §21.3). A pipeline's stencil state translated to GL enums
 * once, at pipeline creation: the draw path only compares numbers.
 */
export interface GLStencil {
  func: number;
  readMask: number;
  writeMask: number;
  fail: number;
  zfail: number;
  pass: number;
}

/** GL compare functions are contiguous from NEVER, in RHI order. */
const COMPARE: readonly CompareFunction[] = [
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
];

const STENCIL_OPS: readonly StencilOperation[] = [
  'keep',
  'zero',
  'replace',
  'invert',
  'increment-clamp',
  'decrement-clamp',
  'increment-wrap',
  'decrement-wrap',
];
const STENCIL_OP_VALUES = [
  G.KEEP,
  G.ZERO,
  G.REPLACE,
  G.INVERT,
  G.INCR,
  G.DECR,
  G.INCR_WRAP,
  G.DECR_WRAP,
];

function glOp(op: StencilOperation | undefined): number {
  return STENCIL_OP_VALUES[op === undefined ? 0 : STENCIL_OPS.indexOf(op)];
}

export function toGLStencil(state: StencilState): GLStencil {
  return {
    func: G.NEVER + COMPARE.indexOf(state.compare ?? 'always'),
    readMask: state.readMask ?? 0xff,
    writeMask: state.writeMask ?? 0xff,
    fail: glOp(state.failOp),
    zfail: glOp(state.depthFailOp),
    pass: glOp(state.passOp),
  };
}

/**
 * What a draw inside a stencil mask uses: pass where the buffer equals the
 * current nesting depth, never write. Pipelines that declare no stencil state
 * inherit it once a mask is active in the pass (§21.3), which is how ordinary
 * sprite draws get clipped without their own stencil pipelines.
 */
export const GL_STENCIL_INSIDE: GLStencil = {
  func: G.EQUAL,
  readMask: 0xff,
  writeMask: 0,
  fail: G.KEEP,
  zfail: G.KEEP,
  pass: G.KEEP,
};

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
  /** M3 stencil (masks): test toggle, func + ref + masks, ops, color mask. */
  private stencil = -1;
  private stencilFunc = -1;
  private stencilRef = -1;
  private stencilRead = -1;
  private stencilWrite = -1;
  private stencilFail = -1;
  private stencilZFail = -1;
  private stencilPass = -1;
  private colorMask = -1;
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
    this.stencil = this.stencilFunc = this.stencilRef = this.stencilRead = -1;
    this.stencilWrite = this.stencilFail = -1;
    this.stencilZFail = this.stencilPass = this.colorMask = -1;
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

  // ── M3 stencil (ARCHITECTURE §21.3) ────────────────────────────────────────

  setStencilTest(on: boolean): void {
    this.stencil = this.toggle(G.STENCIL_TEST, this.stencil, on);
  }

  /** Test, ops and write mask of the pipeline about to draw, at `ref`. */
  setStencil(s: GLStencil, ref: number): void {
    const gl = this.gl;
    if (
      this.stencilFunc !== s.func ||
      this.stencilRef !== ref ||
      this.stencilRead !== s.readMask
    ) {
      this.stencilFunc = s.func;
      this.stencilRef = ref;
      this.stencilRead = s.readMask;
      gl.stencilFunc(s.func, ref, s.readMask);
    }
    if (
      this.stencilFail !== s.fail ||
      this.stencilZFail !== s.zfail ||
      this.stencilPass !== s.pass
    ) {
      this.stencilFail = s.fail;
      this.stencilZFail = s.zfail;
      this.stencilPass = s.pass;
      gl.stencilOp(s.fail, s.zfail, s.pass);
    }
    if (this.stencilWrite !== s.writeMask) {
      this.stencilWrite = s.writeMask;
      gl.stencilMask(s.writeMask);
    }
  }

  /** Lets `gl.clear(STENCIL_BUFFER_BIT)` reach every bit. */
  setStencilWriteMask(mask: number): void {
    if (this.stencilWrite !== mask) {
      this.stencilWrite = mask;
      this.gl.stencilMask(mask);
    }
  }

  setColorMask(on: boolean): void {
    const next = on ? 1 : 0;
    if (this.colorMask !== next) {
      this.colorMask = next;
      this.gl.colorMask(on, on, on, on);
    }
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
