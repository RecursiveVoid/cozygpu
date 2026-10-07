/**
 * Owner: "webgl2". Reused per-frame recording wrappers (ARCHITECTURE §13.1).
 *
 * WebGL executes immediately: a "pass" binds state as calls arrive and
 * `submit()` only closes open passes. One command list, one render pass and
 * one feedback pass exist per backend; bind groups, dynamic offsets and vertex
 * buffers are latched into preallocated arrays and applied at draw time, so
 * the call order of the RHI (bind groups before or after setPipeline) does
 * not matter and nothing is allocated per frame.
 */
import { CozyGPUError } from '../../types/errors';
import type {
  Capabilities,
  ColorTarget,
  CommandList,
  ComputePass,
  FeedbackPass,
  IndexFormat,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiFeedbackPipeline,
  RhiRenderPipeline,
} from '../types';
import { FormatKind } from './formats';
import * as G from './glconst';
import type {
  GLBindGroup,
  GLBuffer,
  GLRenderPipeline,
  GLTexture,
} from './resources';
import { GL_STENCIL_INSIDE, type GLState } from './state';

const MAX_GROUPS = 4;
const MAX_DYNAMIC_OFFSETS = 8;
const MAX_VERTEX_SLOTS = 8;
/**
 * gl.flush() after this many draw calls. ANGLE over Metal records every draw
 * of a frame into one command buffer until the frame ends; about 200k
 * unbatched draws exhausted its host memory (GL_OUT_OF_MEMORY) and lost the
 * context. Flushing in chunks bounds that buffer and costs nothing for
 * normal frames (a few hundred draws).
 */
export const FLUSH_EVERY_DRAWS = 4096;

/** What the recording wrappers need from the backend. */
export interface GLCommandHost {
  readonly gl: WebGL2RenderingContext;
  readonly state: GLState;
  readonly caps: Capabilities;
  /** WEBGL_draw_instanced_base_vertex_base_instance, when available. */
  readonly baseInstance: {
    drawArraysInstancedBaseInstance(
      mode: number,
      first: number,
      count: number,
      instanceCount: number,
      baseInstance: number,
    ): void;
    drawElementsInstancedBaseVertexBaseInstance(
      mode: number,
      count: number,
      type: number,
      offset: number,
      instanceCount: number,
      baseVertex: number,
      baseInstance: number,
    ): void;
  } | null;
  /** Reused transform feedback object. */
  readonly transformFeedback: WebGLTransformFeedback | null;
  /**
   * Bumped after every transform feedback draw. bindTargetFramebuffer
   * re-attaches color 0 of a framebuffer last attached before the current
   * serial (ANGLE/Metal framebuffer-cache workaround, see there).
   */
  feedbackSerial: number;
  /** Framebuffer with `texture` as color 0 and `depth` attached; binds it. */
  bindTargetFramebuffer(texture: GLTexture, depth: GLTexture | null): void;
}

function unsupported(what: string): CozyGPUError {
  return new CozyGPUError('UNSUPPORTED', `${what} is not available on WebGL2`);
}

/** Bind groups + vertex buffers latched until the next draw / run. */
class GLPassBase {
  pipeline: GLRenderPipeline | null = null;
  protected readonly groups: (GLBindGroup | null)[] = [null, null, null, null];
  protected readonly dynamicOffsets: Uint32Array[] = [];
  protected dirtyGroups = 0;
  protected readonly slotBuffers: (GLBuffer | null)[] = [];
  protected readonly slotOffsets = new Float64Array(MAX_VERTEX_SLOTS);
  open = false;

  constructor(protected readonly host: GLCommandHost) {
    for (let i = 0; i < MAX_GROUPS; i++) {
      this.dynamicOffsets.push(new Uint32Array(MAX_DYNAMIC_OFFSETS));
    }
    for (let i = 0; i < MAX_VERTEX_SLOTS; i++) this.slotBuffers.push(null);
  }

  /** Forgets everything latched (new pass). */
  protected begin(): void {
    this.open = true;
    this.pipeline = null;
    this.dirtyGroups = 0;
    for (let i = 0; i < MAX_GROUPS; i++) this.groups[i] = null;
    for (let i = 0; i < MAX_VERTEX_SLOTS; i++) this.slotBuffers[i] = null;
  }

  setPipeline(pipeline: RhiRenderPipeline | RhiFeedbackPipeline): void {
    this.pipeline = pipeline as GLRenderPipeline;
    // UBO binding points / texture units are per program.
    this.dirtyGroups = 0xf;
  }

  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void {
    this.groups[index] = group as GLBindGroup;
    if (dynamicOffsets) {
      // Copied like WebGPU does: callers reuse and mutate their arrays.
      const dst = this.dynamicOffsets[index];
      const n = Math.min(dynamicOffsets.length, MAX_DYNAMIC_OFFSETS);
      for (let i = 0; i < n; i++) dst[i] = dynamicOffsets[i];
    }
    this.dirtyGroups |= 1 << index;
  }

  setVertexBuffer(slot: number, buffer: RhiBuffer, offset = 0): void {
    this.slotBuffers[slot] = buffer as GLBuffer;
    this.slotOffsets[slot] = offset;
  }

  /**
   * Applies program, vertex array, bind groups and attribute pointers.
   * `firstInstance` > 0 without the base-instance extension re-points
   * instance-step attributes by firstInstance × stride. False when there is
   * nothing to draw with.
   */
  protected prepare(firstInstance: number): boolean {
    const pipeline = this.pipeline;
    if (!pipeline) return false;
    const host = this.host;
    const gl = host.gl;
    const state = host.state;
    const program = pipeline.program;
    state.useProgram(program.program);
    const va = pipeline.vertexArray;
    state.bindVertexArray(va.vao);

    if (this.dirtyGroups !== 0) {
      const groups = program.groups;
      for (let g = 0; g < groups.length; g++) {
        if ((this.dirtyGroups & (1 << g)) === 0) continue;
        const group = this.groups[g];
        if (!group) continue;
        const bindings = groups[g];
        const offsets = this.dynamicOffsets[g];
        for (let i = 0; i < bindings.length; i++) {
          const b = bindings[i];
          const binding = b.binding;
          if (b.kind === 0) {
            const buffer = group.buffers[binding];
            if (!buffer) continue;
            const dynamic = group.layout.dynamicIndex[binding];
            const offset =
              group.offsets[binding] + (dynamic >= 0 ? offsets[dynamic] : 0);
            const size = group.sizes[binding];
            state.bindUniformBuffer(
              b.unit,
              buffer.raw,
              offset,
              size >= 0
                ? Math.min(size, buffer.size - offset)
                : buffer.size - offset,
            );
          } else if (b.kind === 1) {
            const texture = group.textures[binding];
            if (texture) state.bindTexture(b.unit, texture.raw);
          } else {
            const sampler = group.samplers[binding];
            if (sampler) state.bindSampler(b.unit, sampler.raw);
          }
        }
      }
      this.dirtyGroups = 0;
    }

    const layouts = va.layouts;
    const emulate = firstInstance !== 0 && host.baseInstance === null;
    for (let s = 0; s < layouts.length; s++) {
      const buffer = this.slotBuffers[s];
      if (!buffer) continue;
      const layout = layouts[s];
      const offset =
        this.slotOffsets[s] +
        (emulate && layout.stepMode === 'instance'
          ? firstInstance * layout.stride
          : 0);
      if (va.slotBuffers[s] === buffer && va.slotOffsets[s] === offset)
        continue;
      va.slotBuffers[s] = buffer;
      va.slotOffsets[s] = offset;
      gl.bindBuffer(G.ARRAY_BUFFER, buffer.raw);
      const attributes = layout.attributes;
      const formats = va.formats[s];
      for (let a = 0; a < attributes.length; a++) {
        const attr = attributes[a];
        const format = formats[a];
        if (format.integer) {
          gl.vertexAttribIPointer(
            attr.location,
            format.size,
            format.type,
            layout.stride,
            offset + attr.offset,
          );
        } else {
          gl.vertexAttribPointer(
            attr.location,
            format.size,
            format.type,
            format.normalized,
            layout.stride,
            offset + attr.offset,
          );
        }
      }
    }
    return true;
  }
}

export class GLRenderPass extends GLPassBase implements RenderPass {
  /** Height of the current target (viewport / scissor y flip). */
  private targetHeight = 0;
  private resolveSource: GLTexture | null = null;
  private resolveTarget: ColorTarget | null = null;
  private indexBuffer: GLBuffer | null = null;
  private indexType = G.UNSIGNED_SHORT;
  private indexBytes = 2;
  private indexOffset = 0;
  private readonly clearUint = new Uint32Array(4);
  private readonly clearFloat = new Float32Array(4);
  /** M3 masks: current stencil reference and whether a mask is active. */
  private stencilRef = 0;
  private stencilActive = false;
  /** True while the last applied pipeline disabled color writes. */
  private colorWriteOff = false;
  /** Draws issued since the last gl.flush() (see FLUSH_EVERY_DRAWS). */
  private drawsSinceFlush = 0;

  /** @internal Configures the target and clears. */
  start(desc: RenderPassDesc): void {
    this.begin();
    this.indexBuffer = null;
    const host = this.host;
    const gl = host.gl;
    const state = host.state;
    const color = desc.color;
    const target = color.target;
    let width: number;
    let height: number;
    let kind: number = FormatKind.NORM;
    if (target === 'canvas') {
      state.bindFramebuffer(null);
      width = gl.drawingBufferWidth;
      height = gl.drawingBufferHeight;
    } else {
      const texture = target as GLTexture;
      host.bindTargetFramebuffer(
        texture,
        desc.depth ? (desc.depth.target as GLTexture) : null,
      );
      width = texture.width;
      height = texture.height;
      kind = texture.gl.kind;
    }
    this.targetHeight = height;
    this.resolveSource =
      color.resolveTarget && target !== 'canvas' ? (target as GLTexture) : null;
    this.resolveTarget = this.resolveSource ? color.resolveTarget! : null;
    gl.viewport(0, 0, width, height);
    state.setScissorTest(false);

    if (color.load === 'clear') {
      // A stencil-write pipeline from the previous pass (or frame) may have
      // left the color mask off; glClear honours it, so turn it back on.
      state.setColorMask(true);
      const cc = color.clearColor;
      const a = cc ? cc[3] : 0;
      const r = cc ? cc[0] * a : 0;
      const g = cc ? cc[1] * a : 0;
      const b = cc ? cc[2] * a : 0;
      if (kind === FormatKind.UINT) {
        const v = this.clearUint;
        v[0] = cc ? cc[0] : 0;
        v[1] = cc ? cc[1] : 0;
        v[2] = cc ? cc[2] : 0;
        v[3] = cc ? cc[3] : 0;
        gl.clearBufferuiv(G.COLOR, 0, v);
      } else if (kind === FormatKind.FLOAT) {
        const v = this.clearFloat;
        v[0] = r;
        v[1] = g;
        v[2] = b;
        v[3] = a;
        gl.clearBufferfv(G.COLOR, 0, v);
      } else {
        gl.clearColor(r, g, b, a);
        gl.clear(G.COLOR_BUFFER_BIT);
      }
      if (target === 'canvas' && host.caps.stencil && !desc.depth) {
        // M3 masks (§21.3): the canvas' stencil buffer comes from the context
        // attributes, and clearing the canvas clears it with the color, so a
        // stencil mask always starts counting from 0.
        state.setStencilWriteMask(0xff);
        gl.clearStencil(0);
        gl.clear(G.STENCIL_BUFFER_BIT);
      }
    }
    const depth = desc.depth;
    if (depth && depth.load === 'clear') {
      gl.clearDepth(depth.clearValue ?? 1);
      gl.clear(G.DEPTH_BUFFER_BIT);
    }
    // M3 masks (§21.3). The default framebuffer gets its stencil buffer from
    // the context attributes, so the clear is honoured for the canvas target
    // as well — `depth.target` is only attached to a texture target's FBO.
    this.stencilRef = 0;
    this.stencilActive = false;
    if (depth && depth.stencilLoad === 'clear') {
      state.setStencilWriteMask(0xff);
      gl.clearStencil(depth.stencilClearValue ?? 0);
      gl.clear(G.STENCIL_BUFFER_BIT);
    }
  }

  setIndexBuffer(buffer: RhiBuffer, format: IndexFormat, offset = 0): void {
    this.indexBuffer = buffer as GLBuffer;
    const wide = format === 'uint32';
    this.indexType = wide ? G.UNSIGNED_INT : G.UNSIGNED_SHORT;
    this.indexBytes = wide ? 4 : 2;
    this.indexOffset = offset;
  }

  setViewport(x: number, y: number, w: number, h: number): void {
    this.host.gl.viewport(x, this.targetHeight - y - h, w, h);
  }

  setScissor(x: number, y: number, w: number, h: number): void {
    this.host.state.setScissorTest(true);
    this.host.gl.scissor(x, this.targetHeight - y - h, w, h);
  }

  /**
   * M3 (ARCHITECTURE §21.3). Mask nesting depth for the draws that follow.
   * Applied with the next draw's stencil state (GL has one function call for
   * comparison, reference and read mask).
   */
  setStencilReference(reference: number): void {
    this.stencilRef = reference;
    // A reference set on a fresh pass (a mask reopening the canvas after a
    // capture) clips the draws that follow, as a stencil draw would.
    if (reference > 0) this.stencilActive = true;
  }

  private applyPipelineState(): void {
    const pipeline = this.pipeline!;
    const state = this.host.state;
    state.setBlend(pipeline.blend);
    state.setDepthTest(pipeline.depth);
    const stencil = pipeline.stencil;
    if (stencil) {
      this.stencilActive = true;
      state.setStencilTest(true);
      state.setStencil(stencil, this.stencilRef);
    } else if (this.stencilActive) {
      // Inside a mask: pipelines without their own stencil state (sprites,
      // swarms) are clipped by the buffer but never write to it.
      state.setStencilTest(true);
      state.setStencil(GL_STENCIL_INSIDE, this.stencilRef);
    } else {
      // No mask in this pass (yet): the test must be off, or draws would be
      // tested against whatever the last pass left in the buffer.
      state.setStencilTest(false);
    }
    if (pipeline.colorWriteDisabled || this.colorWriteOff) {
      const off = pipeline.colorWriteDisabled;
      this.colorWriteOff = off;
      state.setColorMask(!off);
    }
  }

  draw(
    vertexCount: number,
    instanceCount = 1,
    firstVertex = 0,
    firstInstance = 0,
  ): void {
    if (
      instanceCount === 0 ||
      vertexCount === 0 ||
      !this.prepare(firstInstance)
    )
      return;
    this.applyPipelineState();
    const host = this.host;
    const mode = this.pipeline!.mode;
    if (firstInstance !== 0 && host.baseInstance) {
      host.baseInstance.drawArraysInstancedBaseInstance(
        mode,
        firstVertex,
        vertexCount,
        instanceCount,
        firstInstance,
      );
    } else {
      host.gl.drawArraysInstanced(
        mode,
        firstVertex,
        vertexCount,
        instanceCount,
      );
    }
    this.countDraw();
  }

  private countDraw(): void {
    if (++this.drawsSinceFlush >= FLUSH_EVERY_DRAWS) {
      this.drawsSinceFlush = 0;
      this.host.gl.flush();
    }
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    const index = this.indexBuffer;
    if (
      !index ||
      instanceCount === 0 ||
      indexCount === 0 ||
      !this.prepare(firstInstance)
    )
      return;
    this.applyPipelineState();
    const host = this.host;
    const gl = host.gl;
    const va = this.pipeline!.vertexArray;
    if (va.indexBuffer !== index) {
      va.indexBuffer = index;
      gl.bindBuffer(G.ELEMENT_ARRAY_BUFFER, index.raw);
    }
    const mode = this.pipeline!.mode;
    const offset = this.indexOffset + firstIndex * this.indexBytes;
    const ext = host.baseInstance;
    if (baseVertex !== 0 || (firstInstance !== 0 && ext)) {
      if (!ext) throw unsupported('drawIndexed with baseVertex');
      ext.drawElementsInstancedBaseVertexBaseInstance(
        mode,
        indexCount,
        this.indexType,
        offset,
        instanceCount,
        baseVertex,
        firstInstance,
      );
    } else {
      gl.drawElementsInstanced(
        mode,
        indexCount,
        this.indexType,
        offset,
        instanceCount,
      );
    }
    this.countDraw();
  }

  drawIndirect(_buffer: RhiBuffer, _offset: number): void {
    throw unsupported('drawIndirect');
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    const source = this.resolveSource;
    if (!source) return;
    this.resolveSource = null;
    const host = this.host;
    const gl = host.gl;
    const state = host.state;
    const target = this.resolveTarget!;
    let width: number;
    let height: number;
    if (target === 'canvas') {
      state.bindFramebuffer(null);
      width = gl.drawingBufferWidth;
      height = gl.drawingBufferHeight;
    } else {
      const texture = target as GLTexture;
      host.bindTargetFramebuffer(texture, texture.fboDepth);
      width = texture.width;
      height = texture.height;
    }
    // FRAMEBUFFER (above) set the draw binding; read from the MSAA target.
    gl.bindFramebuffer(G.READ_FRAMEBUFFER, source.fbo);
    state.setScissorTest(false);
    gl.blitFramebuffer(
      0,
      0,
      source.width,
      source.height,
      0,
      0,
      width,
      height,
      G.COLOR_BUFFER_BIT,
      G.NEAREST,
    );
    // Read and draw bindings now differ: force the next bind.
    state.invalidateBindings();
  }
}

export class GLFeedbackPass extends GLPassBase implements FeedbackPass {
  /** @internal */
  start(): void {
    this.begin();
    this.host.state.setRasterizerDiscard(true);
  }

  run(
    output: RhiBuffer,
    outputOffset: number,
    first: number,
    count: number,
  ): void {
    if (count === 0 || !this.prepare(0)) return;
    const out = output as GLBuffer;
    const host = this.host;
    const gl = host.gl;
    const bytes = count * this.pipeline!.program.recordBytes;
    if (outputOffset + bytes > out.size) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `feedback of ${count} records (${bytes} B) at ${outputOffset} exceeds buffer "${out.label ?? ''}" (${out.size} B)`,
      );
    }
    // A transform feedback buffer must not stay bound to any other target.
    gl.bindBuffer(G.ARRAY_BUFFER, null);
    gl.bindBuffer(G.COPY_WRITE_BUFFER, null);
    gl.bindBuffer(G.UNIFORM_BUFFER, null);
    gl.bindTransformFeedback(G.TRANSFORM_FEEDBACK, host.transformFeedback);
    gl.bindBufferRange(
      G.TRANSFORM_FEEDBACK_BUFFER,
      0,
      out.raw,
      outputOffset,
      bytes,
    );
    gl.beginTransformFeedback(G.POINTS);
    gl.drawArrays(G.POINTS, first, count);
    gl.endTransformFeedback();
    host.feedbackSerial++;
    gl.bindBufferBase(G.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(G.TRANSFORM_FEEDBACK, null);
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.host.state.setRasterizerDiscard(false);
  }
}

export class GLCommandList implements CommandList {
  private readonly renderPass: GLRenderPass;
  private readonly feedbackPass: GLFeedbackPass;

  constructor(host: GLCommandHost) {
    this.renderPass = new GLRenderPass(host);
    this.feedbackPass = new GLFeedbackPass(host);
  }

  beginRenderPass(desc: RenderPassDesc): RenderPass {
    this.closePasses();
    this.renderPass.start(desc);
    return this.renderPass;
  }

  beginComputePass(_label?: string): ComputePass {
    throw unsupported('compute');
  }

  beginFeedbackPass(_label?: string): FeedbackPass {
    this.closePasses();
    this.feedbackPass.start();
    return this.feedbackPass;
  }

  submit(): void {
    this.closePasses();
  }

  /** @internal Drops an unfinished frame (context lost mid-frame). */
  abandon(): void {
    this.renderPass.open = false;
    this.feedbackPass.open = false;
  }

  private closePasses(): void {
    if (this.renderPass.open) this.renderPass.end();
    if (this.feedbackPass.open) this.feedbackPass.end();
  }
}
