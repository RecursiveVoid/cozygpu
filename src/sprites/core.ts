/**
 * SpriteCoreSystem. Core side (render thread, DOM-free)
 * of opcode range 0x02 (ARCHITECTURE §5.3).
 *
 *  - One VERTEX|COPY_DST buffer per bufferId (capacity × 40 B).
 *  - One render pipeline per blend mode, created async in init()/restore().
 *  - Shared uploads write straight from the registered (Shared)ArrayBuffer
 *    through a Uint8Array view cached per sharedId.
 *  - Draws: triangle-strip, draw(4, count, 0, first). Skipped until the
 *    pipeline for that blend mode resolved.
 *  - Picking (ARCHITECTURE §16.3): `drawPick` replays SPRITE_DRAW with one
 *    pick pipeline (fs_pick, PICK_TARGET_FORMAT, blend none), created on the first
 *    pick and registered with `beginPickPipeline` while it compiles.
 *  - Shader sources carry both WGSL and GLSL; the backend picks by
 *    `caps.shaderLanguage`.
 */
import { BufferUsage } from '../backend/types';
import type {
  RenderPass,
  RhiBuffer,
  RhiRenderPipeline,
  RhiShaderModule,
} from '../backend/types';
import { Op, OpcodeRange } from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import {
  beginPickPipeline,
  endPickPipeline,
} from '../renderer/pickingPipelines';
import type { RhiBindGroup } from '../backend/types';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';
import { PICK_TARGET_FORMAT, SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { SPRITE_BLEND_MODES, SPRITE_VERTEX_LAYOUT } from './pipeline';

const QUAD_VERTICES = 4;

/**
 * Chrome (152, Metal) has a queue.writeBuffer size cliff: writes below 4 MiB
 * go through a slower staging path (~0.5 ms/MB) than writes of 4 MiB or more
 * (~0.03 ms/MB). Shared uploads in [WRITE_PAD_MIN, WRITE_PAD_TO) are widened
 * to WRITE_PAD_TO when the GPU buffer and the source have room: the extra
 * bytes are the store's current contents (or unused capacity past the
 * instance count), so rewriting them is harmless.
 */
const WRITE_PAD_MIN = 1 << 20;
const WRITE_PAD_TO = 1 << 22;

export class SpriteCoreSystem implements CoreSystem {
  readonly name = 'sprites';
  readonly range = OpcodeRange.SPRITE;

  private ctx: CoreContext | null = null;
  private shader: RhiShaderModule | null = null;
  /** Shader sources for this backend's language (loaded once). */
  private readonly sources: {
    wgsl?: string;
    glsl?: { vertex: string; fragment: string; pick: string };
  } = {};
  /** Index = BlendModeId; null until created. */
  private readonly pipelines: (RhiRenderPipeline | null)[] = [];
  /** Index = bufferId. */
  private readonly buffers: (RhiBuffer | null)[] = [];
  private readonly sharedSource: (ArrayBuffer | SharedArrayBuffer | null)[] =
    [];
  private readonly sharedViews: (Uint8Array | null)[] = [];
  /** Bumped on restore/destroy so late pipeline promises are dropped. */
  private epoch = 0;
  private pickShader: RhiShaderModule | null = null;
  private pickPipeline: RhiRenderPipeline | null = null;
  /** Pick pipeline creation started for the current epoch. */
  private pickRequested = false;

  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    await this.createPipelines(ctx);
  }

  async restore(ctx: CoreContext): Promise<void> {
    // GPU buffers are gone; the front re-allocates on the generation bump.
    this.buffers.length = 0;
    this.sharedSource.length = 0;
    this.sharedViews.length = 0;
    this.ctx = ctx;
    await this.createPipelines(ctx);
  }

  private async createPipelines(ctx: CoreContext): Promise<void> {
    const epoch = ++this.epoch;
    this.pipelines.length = 0;
    this.pickPipeline = null;
    this.pickShader = null;
    this.pickRequested = false;
    const backend = ctx.backend;
    // One language per backend: the other never loads (smaller programs).
    const sources = this.sources;
    if (backend.caps.shaderLanguage === 'wgsl') {
      if (sources.wgsl === undefined) {
        sources.wgsl = (await import('./shadersWGSL')).wgsl;
      }
    } else if (sources.glsl === undefined) {
      sources.glsl = await import('./shadersGLSL');
    }
    if (epoch !== this.epoch) return;
    const glsl = sources.glsl;
    this.shader = backend.createShaderModule({
      label: 'cozygpu.sprite',
      wgsl: sources.wgsl,
      glsl: glsl && { vertex: glsl.vertex, fragment: glsl.fragment },
    });
    const shader = this.shader;
    const jobs: Promise<void>[] = [];
    for (let id = 0; id < SPRITE_BLEND_MODES.length; id++) {
      this.pipelines[id] = null;
      jobs.push(
        backend
          .createRenderPipeline({
            label: `cozygpu.sprite.${SPRITE_BLEND_MODES[id]}`,
            shader,
            vertexEntry: 'vs_main',
            fragmentEntry: 'fs_main',
            bindGroupLayouts: [ctx.viewLayout, ctx.textureLayout],
            vertexBuffers: [SPRITE_VERTEX_LAYOUT],
            topology: 'triangle-strip',
            blend: SPRITE_BLEND_MODES[id],
            sampleCount: ctx.sampleCount,
          })
          .then(pipeline => {
            if (epoch === this.epoch) this.pipelines[id] = pipeline;
            else pipeline.destroy();
          }),
      );
    }
    await Promise.all(jobs);
  }

  execute(reader: CommandReader, _frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    switch (reader.opcode) {
      case Op.SPRITE_BUFFER_ALLOC: {
        const id = reader.u32();
        const capacity = reader.u32();
        this.buffers[id]?.destroy();
        this.buffers[id] = ctx.backend.createBuffer({
          label: `cozygpu.sprite.instances#${id}`,
          size: Math.max(1, capacity) * SPRITE_INSTANCE_BYTES,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        });
        return;
      }
      case Op.SPRITE_BUFFER_DESTROY: {
        const id = reader.u32();
        this.buffers[id]?.destroy();
        this.buffers[id] = null;
        return;
      }
      case Op.SPRITE_UPLOAD: {
        const buffer = this.buffers[reader.u32()];
        const first = reader.u32();
        const count = reader.u32();
        const bytes = count * SPRITE_INSTANCE_BYTES;
        const at = reader.blob(bytes);
        if (!buffer || !this.fits(buffer, first, count)) return;
        ctx.backend.writeBuffer(
          buffer,
          first * SPRITE_INSTANCE_BYTES,
          reader.u8,
          at,
          bytes,
        );
        return;
      }
      case Op.SPRITE_UPLOAD_SHARED: {
        const buffer = this.buffers[reader.u32()];
        const first = reader.u32();
        const count = reader.u32();
        const sharedId = reader.u32();
        const byteOffset = reader.u32();
        if (!buffer || !this.fits(buffer, first, count)) return;
        const view = this.sharedView(ctx, sharedId);
        let dst = first * SPRITE_INSTANCE_BYTES;
        let start = byteOffset + dst;
        let bytes = count * SPRITE_INSTANCE_BYTES;
        if (!view || start + bytes > view.byteLength) return;
        if (bytes >= WRITE_PAD_MIN && bytes < WRITE_PAD_TO) {
          // Grow the end first, then the start, within both buffers.
          const endRoom = Math.min(
            buffer.size - (dst + bytes),
            view.byteLength - (start + bytes),
          );
          const grow = WRITE_PAD_TO - bytes;
          const tail = Math.min(grow, endRoom);
          const head = Math.min(grow - tail, dst, start - byteOffset);
          if (tail + head === grow) {
            dst -= head;
            start -= head;
            bytes = WRITE_PAD_TO;
          }
        }
        ctx.backend.writeBuffer(buffer, dst, view, start, bytes);
        return;
      }
      default:
        return;
    }
  }

  draw(reader: CommandReader, pass: RenderPass, _frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx || reader.opcode !== Op.SPRITE_DRAW) return;
    const buffer = this.buffers[reader.u32()];
    const first = reader.u32();
    const count = reader.u32();
    const texId = reader.u32();
    const pipeline = this.pipelines[reader.u32()];
    if (!buffer || !pipeline || count === 0) return;
    if (!this.fits(buffer, first, count)) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, ctx.viewBindGroup);
    pass.setBindGroup(1, ctx.getTexture(texId).bindGroup);
    pass.setVertexBuffer(0, buffer);
    pass.draw(QUAD_VERTICES, count, 0, first);
  }

  drawPick(
    reader: CommandReader,
    pass: RenderPass,
    _frame: CoreFrameState,
    view: RhiBindGroup,
  ): void {
    const ctx = this.ctx;
    if (!ctx || reader.opcode !== Op.SPRITE_DRAW) return;
    const pipeline = this.pickPipeline;
    if (!pipeline) {
      if (!this.pickRequested) this.createPickPipeline(ctx);
      return;
    }
    const buffer = this.buffers[reader.u32()];
    const first = reader.u32();
    const count = reader.u32();
    const texId = reader.u32();
    if (!buffer || count === 0 || !this.fits(buffer, first, count)) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, view);
    pass.setBindGroup(1, ctx.getTexture(texId).bindGroup);
    pass.setVertexBuffer(0, buffer);
    pass.draw(QUAD_VERTICES, count, 0, first);
  }

  private createPickPipeline(ctx: CoreContext): void {
    if (!ctx.backend.caps.integerRenderTargets) return;
    this.pickRequested = true;
    const epoch = this.epoch;
    const backend = ctx.backend;
    let shader = this.shader;
    const glsl = this.sources.glsl;
    if (ctx.backend.caps.shaderLanguage !== 'wgsl') {
      if (glsl === undefined) return;
      // GLSL has one fragment per program: a separate module.
      shader = this.pickShader = backend.createShaderModule({
        label: 'cozygpu.sprite.pick',
        glsl: { vertex: glsl.vertex, fragment: glsl.pick },
      });
    }
    if (!shader) return;
    beginPickPipeline(ctx);
    backend
      .createRenderPipeline({
        label: 'cozygpu.sprite.pick',
        shader,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_pick',
        bindGroupLayouts: [ctx.viewLayout, ctx.textureLayout],
        vertexBuffers: [SPRITE_VERTEX_LAYOUT],
        topology: 'triangle-strip',
        colorFormat: PICK_TARGET_FORMAT,
        blend: 'none',
        sampleCount: 1,
      })
      .then(
        pipeline => {
          if (epoch === this.epoch) this.pickPipeline = pipeline;
          else pipeline.destroy();
        },
        (err: unknown) => {
          // No retry (it would fail every frame): picks miss sprites.
          if (typeof console !== 'undefined') {
            console.error('[cozygpu] sprite pick pipeline failed', err);
          }
        },
      )
      .finally(() => endPickPipeline(ctx));
  }

  destroy(): void {
    this.epoch++;
    this.pickPipeline?.destroy();
    this.pickShader?.destroy();
    this.pickPipeline = null;
    this.pickShader = null;
    for (let i = 0; i < this.buffers.length; i++) this.buffers[i]?.destroy();
    for (let i = 0; i < this.pipelines.length; i++) {
      this.pipelines[i]?.destroy();
    }
    this.shader?.destroy();
    this.buffers.length = 0;
    this.pipelines.length = 0;
    this.sharedSource.length = 0;
    this.sharedViews.length = 0;
    this.shader = null;
    this.ctx = null;
  }

  private fits(buffer: RhiBuffer, first: number, count: number): boolean {
    return (first + count) * SPRITE_INSTANCE_BYTES <= buffer.size;
  }

  /** Cached per sharedId; rebuilt only when the registered buffer changes. */
  private sharedView(ctx: CoreContext, sharedId: number): Uint8Array | null {
    const source = ctx.getShared(sharedId);
    if (!source) return null;
    if (this.sharedSource[sharedId] !== source) {
      this.sharedSource[sharedId] = source;
      this.sharedViews[sharedId] = new Uint8Array(source);
    }
    return this.sharedViews[sharedId] ?? null;
  }
}

export function createSpriteCoreSystem(): CoreSystem {
  return new SpriteCoreSystem();
}
