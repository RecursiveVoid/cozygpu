/**
 * Core half of masking (ARCHITECTURE §21.3): the MASK
 * opcode range (0x04). DOM-free — it runs in the worker too.
 *
 * It owns the mask instance buffers (sprite instance layout), the stencil
 * attachment it asks the core to add through `passBreak`, the stencil-write
 * and stencil-test pipelines, and the scissor stack. Alpha masks borrow the
 * render-target pool from the filters module (src/filters/targets.ts), so the
 * two features never keep two pools; that half lives in ./alpha.ts and is
 * imported the first time a soft mask is pushed.
 *
 * Three implementations, one stack:
 *   scissor  MASK_PUSH_SCISSOR intersects the rect in force; MASK_POP puts
 *            the previous one back. No draw, no target, any nesting depth.
 *   stencil  the mask quads are drawn with `passOp: 'increment-clamp'` and no
 *            color writes; what follows draws where the buffer equals the
 *            nesting level. MASK_POP decrements the same quads back.
 *   alpha    the subtree is captured into a pooled target, the mask's
 *            coverage into another, and MASK_POP composites them.
 *
 * Anything that cannot be done (no stencil attachment because the main pass
 * is multisampled, pipelines still compiling, no target pool yet) falls back
 * to a scissor of the mask's bounds: a mask never draws its subtree
 * unclipped.
 */
import { BufferUsage, TextureUsage } from '../backend/types';
import type {
  CommandList,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiRenderPipeline,
  RhiShaderModule,
  RhiTexture,
} from '../backend/types';
import { MaskFlag, MaskOp, OpcodeRange } from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';
import {
  MASK_MAX_DEPTH,
  MASK_STENCIL_FORMAT,
  SPRITE_INSTANCE_BYTES,
} from '../types/layouts';
import { SPRITE_VERTEX_LAYOUT } from '../sprites/pipeline';
import type { AlphaMasks } from './alpha';

const QUAD_VERTICES = 4;
/**
 * Soft-mask builds attempted before giving up. The first push usually loses
 * a race (the chunk or the target pool is not there yet) and the next one
 * wins, so one try is too few; an unbounded retry would re-import on every
 * frame of a page whose chunk simply cannot be fetched.
 */
const MAX_ALPHA_ATTEMPTS = 3;
/** Stack entry kinds. */
const NONE = 0;
const SCISSOR = 1;
const STENCIL = 2;
const ALPHA = 3;

export class MaskCoreSystem implements CoreSystem {
  readonly name = 'mask';
  readonly range = OpcodeRange.MASK;

  private ctx: CoreContext | null = null;
  private shader: RhiShaderModule | null = null;
  private increment: RhiRenderPipeline | null = null;
  private decrement: RhiRenderPipeline | null = null;
  /** Bumped on restore/destroy so late pipeline promises are dropped. */
  private epoch = 0;

  /** Mask instance buffers and the stage-space bounds of their quads. */
  private readonly buffers: (RhiBuffer | null)[] = [];
  private readonly bounds: (Float32Array | null)[] = [];

  /** Canvas-sized quad used to invert a stencil mask (§21.3). */
  private full: RhiBuffer | null = null;
  private fullWidth = 0;
  private fullHeight = 0;
  private readonly fullQuad = new Float32Array(SPRITE_INSTANCE_BYTES / 4);

  private stencilTexture: RhiTexture | null = null;
  private stencilWidth = 0;
  private stencilHeight = 0;
  /** Frame id whose stencil attachment is already in place. */
  private stencilFrame = -1;
  /**
   * True when the main pass already has a stencil buffer without an
   * attachment of ours: WebGL2 draws into the default framebuffer, which is
   * created with a stencil buffer and cleared to 0 after every composite
   * (`preserveDrawingBuffer: false`). No pass break is needed there.
   */
  private implicitStencil = false;
  /** A frame left the stack unbalanced, so the buffer may not be 0 anymore. */
  private stencilDirty = false;
  /**
   * The frame that left it unbalanced. The next frame's main pass begins with
   * a canvas clear, which clears the implicit stencil buffer with the color,
   * so the counts are 0 again and the flag lifts (one frame of scissor
   * fallback, not the renderer's lifetime).
   */
  private stencilDirtyFrame = -1;
  private level = 0;

  /** Mask stack (§21.3); parallel arrays, never reallocated. */
  private readonly kinds = new Uint8Array(MASK_MAX_DEPTH * 2);
  private readonly ids = new Uint32Array(MASK_MAX_DEPTH * 2);
  private readonly levels = new Uint8Array(MASK_MAX_DEPTH * 2);
  private readonly flagsOf = new Uint8Array(MASK_MAX_DEPTH * 2);
  private readonly saved = new Float32Array(MASK_MAX_DEPTH * 2 * 4);
  private readonly quads = new Uint32Array(MASK_MAX_DEPTH * 2 * 4);
  private depth = 0;

  /** Current scissor rect in physical px (the whole canvas when unset). */
  private readonly scissor = new Float32Array(4);
  private scissorOn = false;

  private alpha: AlphaMasks | null = null;
  private alphaLoading = false;
  /** Soft-mask builds tried so far (see MAX_ALPHA_ATTEMPTS). */
  private alphaAttempts = 0;
  private readonly passDesc: RenderPassDesc = {
    label: 'cozygpu mask stencil',
    color: { target: 'canvas', load: 'load' },
    depth: {
      target: undefined as unknown as RhiTexture,
      load: 'clear',
      clearValue: 1,
      stencilLoad: 'clear',
      stencilClearValue: 0,
    },
  };
  /** Messages already posted; one `UNSUPPORTED` per distinct reason. */
  private readonly warned = new Set<string>();

  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    await this.createPipelines(ctx);
  }

  async restore(ctx: CoreContext): Promise<void> {
    this.buffers.length = 0;
    this.bounds.length = 0;
    this.full = null;
    this.fullWidth = this.fullHeight = 0;
    this.stencilTexture = null;
    this.stencilWidth = this.stencilHeight = 0;
    this.stencilDirty = false;
    this.stencilDirtyFrame = -1;
    this.depth = 0;
    this.level = 0;
    this.alpha?.destroy();
    this.alpha = null;
    this.alphaLoading = false;
    this.alphaAttempts = 0;
    this.ctx = ctx;
    await this.createPipelines(ctx);
  }

  private async createPipelines(ctx: CoreContext): Promise<void> {
    const epoch = ++this.epoch;
    this.increment = null;
    this.decrement = null;
    const backend = ctx.backend;
    // One language per backend: the other never loads (smaller programs).
    const sources =
      backend.caps.shaderLanguage === 'wgsl'
        ? { wgsl: (await import('./shadersWGSL')).wgsl }
        : await import('./shadersGLSL').then(m => ({
            glsl: { vertex: m.vertex, fragment: m.fragment },
          }));
    if (epoch !== this.epoch) return;
    const shader = backend.createShaderModule({
      label: 'cozygpu.mask',
      ...sources,
    });
    this.shader = shader;
    if (!backend.caps.stencil) return;
    this.implicitStencil =
      backend.caps.backend === 'webgl2' && ctx.sampleCount === 1;
    const make = (
      label: string,
      passOp: 'increment-clamp' | 'decrement-clamp',
    ): Promise<RhiRenderPipeline> =>
      backend.createRenderPipeline({
        label,
        shader,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
        bindGroupLayouts: [ctx.viewLayout, ctx.textureLayout],
        vertexBuffers: [SPRITE_VERTEX_LAYOUT],
        topology: 'triangle-strip',
        blend: 'none',
        depthFormat: MASK_STENCIL_FORMAT,
        sampleCount: ctx.sampleCount,
        colorWriteDisabled: true,
        stencil: { compare: 'equal', passOp },
      });
    const [increment, decrement] = await Promise.all([
      make('cozygpu.mask.increment', 'increment-clamp'),
      make('cozygpu.mask.decrement', 'decrement-clamp'),
    ]);
    if (epoch !== this.epoch) {
      increment.destroy();
      decrement.destroy();
      return;
    }
    this.increment = increment;
    this.decrement = decrement;
  }

  // ── execute ────────────────────────────────────────────────────────────────

  execute(reader: CommandReader, _frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    switch (reader.opcode) {
      case MaskOp.MASK_BUFFER_ALLOC: {
        const id = reader.u32();
        const capacity = reader.u32();
        this.buffers[id]?.destroy();
        this.buffers[id] = ctx.backend.createBuffer({
          label: `cozygpu.mask.quads#${id}`,
          size: Math.max(1, capacity) * SPRITE_INSTANCE_BYTES,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        });
        this.bounds[id] = new Float32Array(4);
        return;
      }
      case MaskOp.MASK_BUFFER_DESTROY: {
        const id = reader.u32();
        this.buffers[id]?.destroy();
        this.buffers[id] = null;
        this.bounds[id] = null;
        return;
      }
      case MaskOp.MASK_UPLOAD: {
        const id = reader.u32();
        const buffer = this.buffers[id];
        const first = reader.u32();
        const count = reader.u32();
        const bytes = count * SPRITE_INSTANCE_BYTES;
        const at = reader.blob(bytes);
        if (!buffer || (first + count) * SPRITE_INSTANCE_BYTES > buffer.size) {
          return;
        }
        ctx.backend.writeBuffer(
          buffer,
          first * SPRITE_INSTANCE_BYTES,
          reader.u8,
          at,
          bytes,
        );
        this.measure(id, reader.f32View, at >> 2, count);
        return;
      }
      default:
        return;
    }
  }

  /** Stage-space bounds of the uploaded quads (the scissor fallback needs them). */
  private measure(
    id: number,
    f32: Float32Array,
    at: number,
    count: number,
  ): void {
    const box = this.bounds[id];
    if (!box) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const per = SPRITE_INSTANCE_BYTES / 4;
    for (let i = 0; i < count; i++) {
      const o = at + i * per;
      const a = f32[o];
      const b = f32[o + 1];
      const c = f32[o + 2];
      const d = f32[o + 3];
      const tx = f32[o + 4];
      const ty = f32[o + 5];
      for (let k = 0; k < 4; k++) {
        const qx = k & 1 ? 1 : 0;
        const qy = k & 2 ? 1 : 0;
        const x = tx + a * qx + c * qy;
        const y = ty + b * qx + d * qy;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    box[0] = minX;
    box[1] = minY;
    box[2] = maxX - minX;
    box[3] = maxY - minY;
  }

  // ── pass breaks ────────────────────────────────────────────────────────────

  passBreak(
    reader: CommandReader,
    list: CommandList,
    frame: CoreFrameState,
  ): RenderPassDesc | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (reader.opcode === MaskOp.MASK_PUSH_STENCIL) {
      return this.stencilPass(ctx, frame);
    }
    if (reader.opcode === MaskOp.MASK_PUSH_ALPHA) {
      const alpha = this.alpha;
      if (!alpha) {
        this.loadAlpha();
        return null;
      }
      // Payload is read without moving the reader: `draw` reads it next.
      const u32 = reader.u32View;
      const at = reader.payloadOffset >> 2;
      return alpha.begin(
        list,
        this.buffers[u32[at + 1]] ?? null,
        u32[at + 2],
        u32[at + 3],
        ctx.getTexture(u32[at + 4]).bindGroup,
        (u32[at + 5] & MaskFlag.INVERT) !== 0,
        frame,
      );
    }
    if (reader.opcode === MaskOp.MASK_POP) {
      const alpha = this.alpha;
      if (alpha) alpha.endCapture();
      return null;
    }
    return null;
  }

  /** Reopens the main pass with a stencil attachment (once per frame). */
  private stencilPass(
    ctx: CoreContext,
    frame: CoreFrameState,
  ): RenderPassDesc | null {
    if (this.implicitStencil) {
      // The pass already has a stencil buffer: nothing to attach.
      this.stencilFrame = frame.frameId;
      return null;
    }
    const main = ctx.mainPass;
    if (ctx.sampleCount !== 1 && !main) {
      // The main pass renders into a multisampled target this system cannot
      // name; masks fall back to a scissor of their bounds.
      this.warnOnce(ctx, 'stencil masks need a single-sampled main pass');
      return null;
    }
    const width = frame.pixelWidth;
    const height = frame.pixelHeight;
    if (
      !this.stencilTexture ||
      this.stencilWidth !== width ||
      this.stencilHeight !== height
    ) {
      this.stencilTexture?.destroy();
      this.stencilTexture = ctx.backend.createTexture({
        label: 'cozygpu.mask.stencil',
        width: Math.max(1, width),
        height: Math.max(1, height),
        format: MASK_STENCIL_FORMAT,
        usage: TextureUsage.RENDER_TARGET,
        sampleCount: ctx.sampleCount,
      });
      this.stencilWidth = width;
      this.stencilHeight = height;
    }
    if (main) {
      // Reopen the main pass exactly as RenderCore had it (under MSAA that is
      // the multisampled target plus its resolve target), only with a stencil
      // buffer attached.
      const color = this.passDesc.color;
      color.target = main.color.target;
      color.resolveTarget = main.color.resolveTarget;
    }
    const depth = this.passDesc.depth!;
    depth.target = this.stencilTexture;
    // One break per frame: later stencil masks reuse the attachment.
    depth.stencilLoad = this.stencilFrame === frame.frameId ? 'load' : 'clear';
    depth.load = depth.stencilLoad;
    this.stencilFrame = frame.frameId;
    return this.passDesc;
  }

  private loadAlpha(): void {
    if (this.alphaLoading || this.alphaAttempts >= MAX_ALPHA_ATTEMPTS) return;
    this.alphaLoading = true;
    this.alphaAttempts++;
    const ctx = this.ctx;
    if (!ctx) {
      this.alphaLoading = false;
      return;
    }
    import('./alpha')
      .then(m => m.createAlphaMasks(ctx, this.shader))
      .then(
        alpha => {
          this.alphaLoading = false;
          if (this.ctx === ctx) this.alpha = alpha;
          else alpha.destroy();
        },
        (err: unknown) => {
          // Usually the filter target pool (ARCHITECTURE §22.4) is not there
          // yet, or a pipeline lost a race with a device restore: soft masks
          // clip to their bounds, and the next push retries (bounded, so a
          // permanent failure costs MAX_ALPHA_ATTEMPTS tries, not one per
          // frame).
          this.alphaLoading = false;
          this.warnOnce(ctx, `soft masks unavailable: ${describe(err)}`);
        },
      );
  }

  // ── draw ───────────────────────────────────────────────────────────────────

  draw(reader: CommandReader, pass: RenderPass, frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    switch (reader.opcode) {
      case MaskOp.MASK_PUSH_SCISSOR: {
        const id = reader.u32();
        const x = reader.f32();
        const y = reader.f32();
        const width = reader.f32();
        const height = reader.f32();
        reader.u32();
        this.pushScissor(pass, frame, id, x, y, width, height);
        return;
      }
      case MaskOp.MASK_PUSH_STENCIL: {
        const id = reader.u32();
        const bufferId = reader.u32();
        const first = reader.u32();
        const count = reader.u32();
        const texId = reader.u32();
        const flags = reader.u32();
        reader.f32();
        this.pushStencil(
          ctx,
          pass,
          frame,
          id,
          bufferId,
          first,
          count,
          texId,
          flags,
        );
        return;
      }
      case MaskOp.MASK_PUSH_ALPHA: {
        const id = reader.u32();
        const bufferId = reader.u32();
        reader.u32();
        reader.u32();
        reader.u32();
        const flags = reader.u32();
        const x = reader.f32();
        const y = reader.f32();
        const width = reader.f32();
        const height = reader.f32();
        reader.f32();
        if (this.alpha) {
          this.push(ALPHA, id, 0, 0, bufferId, 0, 0);
        } else if ((flags & MaskFlag.INVERT) !== 0) {
          // See pushStencil: an inverted mask cannot fall back to a rect.
          this.pushScissor(pass, frame, id, x, y, 0, 0);
        } else {
          // No target pool yet: clip to the mask's bounds instead.
          this.pushScissor(pass, frame, id, x, y, width, height);
        }
        return;
      }
      case MaskOp.MASK_POP: {
        const id = reader.u32();
        this.pop(ctx, pass, frame, id);
        return;
      }
      default:
        return;
    }
  }

  private push(
    kind: number,
    id: number,
    level: number,
    flags: number,
    bufferId: number,
    first: number,
    count: number,
    texId = 0,
  ): number {
    const at = this.depth;
    if (at >= this.kinds.length) return -1;
    this.depth = at + 1;
    this.kinds[at] = kind;
    this.ids[at] = id;
    this.levels[at] = level;
    this.flagsOf[at] = flags;
    this.quads[at * 4] = bufferId;
    this.quads[at * 4 + 1] = first;
    this.quads[at * 4 + 2] = count;
    this.quads[at * 4 + 3] = texId;
    return at;
  }

  private pushScissor(
    pass: RenderPass,
    frame: CoreFrameState,
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const at = this.push(SCISSOR, id, 0, 0, 0, 0, 0);
    if (at < 0) return;
    const s = this.scissor;
    const o = at * 4;
    this.saved[o] = s[0];
    this.saved[o + 1] = s[1];
    this.saved[o + 2] = s[2];
    this.saved[o + 3] = s[3];
    this.flagsOf[at] = this.scissorOn ? 1 : 0;
    const r = frame.resolution;
    let x0 = Math.round(x * r);
    let y0 = Math.round(y * r);
    let x1 = Math.round((x + width) * r);
    let y1 = Math.round((y + height) * r);
    if (this.scissorOn) {
      // Nesting is an intersection, so it is free (§21.3).
      x0 = Math.max(x0, s[0]);
      y0 = Math.max(y0, s[1]);
      x1 = Math.min(x1, s[0] + s[2]);
      y1 = Math.min(y1, s[1] + s[3]);
    }
    x0 = Math.max(0, Math.min(x0, frame.pixelWidth));
    y0 = Math.max(0, Math.min(y0, frame.pixelHeight));
    x1 = Math.max(x0, Math.min(x1, frame.pixelWidth));
    y1 = Math.max(y0, Math.min(y1, frame.pixelHeight));
    s[0] = x0;
    s[1] = y0;
    s[2] = x1 - x0;
    s[3] = y1 - y0;
    this.scissorOn = true;
    pass.setScissor(s[0], s[1], s[2], s[3]);
  }

  private pushStencil(
    ctx: CoreContext,
    pass: RenderPass,
    frame: CoreFrameState,
    id: number,
    bufferId: number,
    first: number,
    count: number,
    texId: number,
    flags: number,
  ): void {
    const buffer = this.buffers[bufferId];
    const increment = this.increment;
    const decrement = this.decrement;
    if (
      !buffer ||
      !increment ||
      !decrement ||
      count === 0 ||
      !this.stencilReady(frame)
    ) {
      // Pipelines still compiling, or no stencil attachment this frame: clip
      // to the mask's bounds. An inverted mask keeps what is OUTSIDE a shape,
      // which one rectangle cannot express, so it clips everything away
      // rather than show what the mask hides.
      const box = this.bounds[bufferId];
      if (!box) {
        this.push(NONE, id, 0, 0, 0, 0, 0);
      } else if ((flags & MaskFlag.INVERT) !== 0) {
        this.pushScissor(pass, frame, id, box[0], box[1], 0, 0);
      } else {
        this.pushScissor(pass, frame, id, box[0], box[1], box[2], box[3]);
      }
      return;
    }
    const level = this.level;
    const at = this.push(
      STENCIL,
      id,
      level,
      flags,
      bufferId,
      first,
      count,
      texId,
    );
    if (at < 0) return;
    const invert = (flags & MaskFlag.INVERT) !== 0;
    const texture = ctx.getTexture(texId).bindGroup;
    if (invert) {
      // Raise everything, then lower the shape: the visible level is then
      // "outside the shape", and nesting keeps counting normally.
      const full = this.fullBuffer(ctx, frame);
      if (full) {
        this.drawQuads(
          pass,
          increment,
          level,
          full,
          ctx.whiteTexture.bindGroup,
          0,
          1,
        );
      }
      this.drawQuads(pass, decrement, level + 1, buffer, texture, first, count);
    } else {
      this.drawQuads(pass, increment, level, buffer, texture, first, count);
    }
    this.level = level + 1;
    pass.setStencilReference(this.level);
  }

  /** Whether the stencil buffer of the open pass can be counted on. */
  private stencilReady(frame: CoreFrameState): boolean {
    if (this.stencilDirty) {
      if (frame.frameId === this.stencilDirtyFrame) return false;
      // A later frame: its main pass cleared the canvas, and with it the
      // implicit stencil buffer, so the counts start from 0 again.
      this.stencilDirty = false;
      this.stencilDirtyFrame = -1;
    }
    return this.implicitStencil || this.stencilFrame === frame.frameId;
  }

  private pop(
    ctx: CoreContext,
    pass: RenderPass,
    frame: CoreFrameState,
    id: number,
  ): void {
    let at = this.depth - 1;
    while (at >= 0 && this.ids[at] !== id) at--;
    if (at < 0) return;
    this.depth = at;
    const kind = this.kinds[at];
    if (kind === SCISSOR) {
      const o = at * 4;
      const s = this.scissor;
      s[0] = this.saved[o];
      s[1] = this.saved[o + 1];
      s[2] = this.saved[o + 2];
      s[3] = this.saved[o + 3];
      this.scissorOn = this.flagsOf[at] === 1;
      if (this.scissorOn) pass.setScissor(s[0], s[1], s[2], s[3]);
      else pass.setScissor(0, 0, frame.pixelWidth, frame.pixelHeight);
      return;
    }
    if (kind === STENCIL) {
      const level = this.levels[at];
      const buffer = this.buffers[this.quads[at * 4]];
      const increment = this.increment;
      const decrement = this.decrement;
      if (buffer && increment && decrement) {
        const first = this.quads[at * 4 + 1];
        const count = this.quads[at * 4 + 2];
        const texture = ctx.getTexture(this.quads[at * 4 + 3]).bindGroup;
        if ((this.flagsOf[at] & MaskFlag.INVERT) !== 0) {
          const full = this.fullBuffer(ctx, frame);
          this.drawQuads(pass, increment, level, buffer, texture, first, count);
          if (full) {
            this.drawQuads(
              pass,
              decrement,
              level + 1,
              full,
              ctx.whiteTexture.bindGroup,
              0,
              1,
            );
          }
        } else {
          this.drawQuads(
            pass,
            decrement,
            level + 1,
            buffer,
            texture,
            first,
            count,
          );
        }
      }
      this.level = level;
      pass.setStencilReference(level);
      return;
    }
    if (kind === ALPHA) this.alpha?.composite(pass, frame);
  }

  private drawQuads(
    pass: RenderPass,
    pipeline: RhiRenderPipeline,
    reference: number,
    buffer: RhiBuffer,
    texture: RhiBindGroup,
    first: number,
    count: number,
  ): void {
    const ctx = this.ctx!;
    pass.setPipeline(pipeline);
    pass.setStencilReference(reference);
    pass.setBindGroup(0, ctx.viewBindGroup);
    pass.setBindGroup(1, texture);
    pass.setVertexBuffer(0, buffer);
    pass.draw(QUAD_VERTICES, count, 0, first);
  }

  /** One quad covering the canvas in stage px (inverted stencil masks). */
  private fullBuffer(
    ctx: CoreContext,
    frame: CoreFrameState,
  ): RhiBuffer | null {
    if (!this.full) {
      this.full = ctx.backend.createBuffer({
        label: 'cozygpu.mask.full',
        size: SPRITE_INSTANCE_BYTES,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      });
      this.fullWidth = 0;
    }
    if (
      this.fullWidth !== frame.cssWidth ||
      this.fullHeight !== frame.cssHeight
    ) {
      this.fullWidth = frame.cssWidth;
      this.fullHeight = frame.cssHeight;
      const q = this.fullQuad;
      q[0] = frame.cssWidth;
      q[1] = 0;
      q[2] = 0;
      q[3] = frame.cssHeight;
      q[4] = 0;
      q[5] = 0;
      // White, threshold 0: every texel of the white texture masks.
      new Uint32Array(q.buffer)[6] = 0x00ffffff;
      ctx.backend.writeBuffer(this.full, 0, q);
    }
    return this.full;
  }

  endFrame(frame: CoreFrameState): void {
    // An unbalanced frame may have left counts in the implicit buffer; stop
    // trusting it for the rest of THIS frame rather than clip wrongly. The
    // next frame's canvas clear zeroes it again (see stencilReady).
    if (this.level !== 0 && this.implicitStencil) {
      this.stencilDirty = true;
      this.stencilDirtyFrame = frame.frameId;
    }
    this.depth = 0;
    this.level = 0;
    this.scissorOn = false;
    this.alpha?.endFrame();
  }

  destroy(): void {
    this.epoch++;
    for (let i = 0; i < this.buffers.length; i++) this.buffers[i]?.destroy();
    this.buffers.length = 0;
    this.bounds.length = 0;
    this.full?.destroy();
    this.full = null;
    this.stencilTexture?.destroy();
    this.stencilTexture = null;
    this.increment?.destroy();
    this.decrement?.destroy();
    this.increment = null;
    this.decrement = null;
    this.shader?.destroy();
    this.shader = null;
    this.alpha?.destroy();
    this.alpha = null;
    this.ctx = null;
  }

  private warnOnce(ctx: CoreContext, message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    ctx.post({
      type: 'error',
      code: 'UNSUPPORTED',
      message: `mask: ${message}`,
    });
  }
}

function describe(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export function createMaskCoreSystem(): CoreSystem {
  return new MaskCoreSystem();
}
