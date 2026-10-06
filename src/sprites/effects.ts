/**
 * Cheap in-batch sprite effects (ARCHITECTURE §22.7), core side. Lazily
 * imported by the sprite core the first time a packet defines one, so a
 * program that never uses a `Group` with a cheap filter chain carries neither
 * this module nor the effect shaders. DOM-free.
 *
 * An effect is one SPRITE_EFFECT_BYTES block (a 4×5 color matrix plus the
 * outline/glow fields text uses). Blocks live in one uniform buffer at a
 * 256-byte stride and are selected with a dynamic offset, so binding an
 * effect costs no allocation and no pipeline change beyond the effect variant
 * of the sprite pipeline.
 */
import { BufferUsage, ShaderStage } from '../backend/types';
import effectFragGLSL from '../shaders/sprite/sprite.effect.frag.glsl';
import effectWGSL from '../shaders/sprite/sprite.effect.wgsl';
import type {
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiRenderPipeline,
  RhiShaderModule,
} from '../backend/types';
import type { CoreContext } from '../types/core';
import { SPRITE_EFFECT_BYTES } from '../types/layouts';
import { SPRITE_BLEND_MODES, SPRITE_VERTEX_LAYOUT } from './pipeline';

/** WebGPU's minimum dynamic uniform alignment. */
const STRIDE = 256;
const INITIAL_SLOTS = 8;

export interface SpriteEffects {
  /** Stores (or replaces) an effect block; `at` indexes into `bytes`. */
  define(id: number, bytes: Uint8Array, at: number): void;
  destroy(id: number): void;
  /** Dynamic offset of `id`'s block, or -1 when it is unknown. */
  offset(id: number): number;
  /** The uniform bind group (group 2). */
  readonly group: RhiBindGroup;
  /** Sprite pipeline variant that applies the effect, per BlendModeId. */
  pipeline(blendId: number): RhiRenderPipeline | null;
  dispose(): void;
}

class SpriteEffectsImpl implements SpriteEffects {
  group!: RhiBindGroup;
  private buffer: RhiBuffer | null = null;
  private layout: RhiBindGroupLayout | null = null;
  private slots = INITIAL_SLOTS;
  /** Slot index per effect id (-1 = none). */
  private readonly slotOf: number[] = [];
  private next = 0;
  /** Retained blocks, so a grow or a device restore can re-upload them. */
  private data = new Uint8Array(INITIAL_SLOTS * STRIDE);
  private readonly pipelines: (RhiRenderPipeline | null)[] = [];
  private epoch = 0;

  constructor(private readonly ctx: CoreContext) {}

  async build(shader: RhiShaderModule): Promise<void> {
    const epoch = ++this.epoch;
    const backend = this.ctx.backend;
    this.layout = backend.createBindGroupLayout({
      label: 'cozygpu.sprite.effect',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.FRAGMENT,
          type: {
            kind: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: STRIDE,
          },
        },
      ],
    });
    this.alloc(this.slots);
    const jobs: Promise<void>[] = [];
    for (let id = 0; id < SPRITE_BLEND_MODES.length; id++) {
      this.pipelines[id] = null;
      jobs.push(
        backend
          .createRenderPipeline({
            label: `cozygpu.sprite.effect.${SPRITE_BLEND_MODES[id]}`,
            shader,
            vertexEntry: 'vs_main',
            fragmentEntry: 'fs_effect',
            bindGroupLayouts: [
              this.ctx.viewLayout,
              this.ctx.textureLayout,
              this.layout,
            ],
            vertexBuffers: [SPRITE_VERTEX_LAYOUT],
            topology: 'triangle-strip',
            blend: SPRITE_BLEND_MODES[id],
            sampleCount: this.ctx.sampleCount,
          })
          .then(pipeline => {
            if (epoch === this.epoch) this.pipelines[id] = pipeline;
            else pipeline.destroy();
          }),
      );
    }
    await Promise.all(jobs);
  }

  private alloc(slots: number): void {
    const backend = this.ctx.backend;
    this.buffer?.destroy();
    this.slots = slots;
    if (this.data.byteLength < slots * STRIDE) {
      const grown = new Uint8Array(slots * STRIDE);
      grown.set(this.data);
      this.data = grown;
    }
    this.buffer = backend.createBuffer({
      label: 'cozygpu.sprite.effects',
      size: slots * STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.group = backend.createBindGroup({
      label: 'cozygpu.sprite.effects',
      layout: this.layout as RhiBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.buffer, offset: 0, size: STRIDE },
        },
      ],
    });
    backend.writeBuffer(this.buffer, 0, this.data, 0, slots * STRIDE);
  }

  define(id: number, bytes: Uint8Array, at: number): void {
    let slot = this.slotOf[id];
    if (slot === undefined || slot < 0) {
      slot = this.next++;
      this.slotOf[id] = slot;
      if (slot >= this.slots) this.alloc(Math.max(this.slots * 2, slot + 1));
    }
    const base = slot * STRIDE;
    this.data.set(bytes.subarray(at, at + SPRITE_EFFECT_BYTES), base);
    const buffer = this.buffer;
    if (buffer) {
      this.ctx.backend.writeBuffer(
        buffer,
        base,
        this.data,
        base,
        SPRITE_EFFECT_BYTES,
      );
    }
  }

  destroy(id: number): void {
    // Slots are not recycled: an effect is per group and there are few.
    this.slotOf[id] = -1;
  }

  offset(id: number): number {
    const slot = this.slotOf[id];
    return slot === undefined || slot < 0 ? -1 : slot * STRIDE;
  }

  pipeline(blendId: number): RhiRenderPipeline | null {
    return this.pipelines[blendId] ?? null;
  }

  dispose(): void {
    this.epoch++;
    for (let i = 0; i < this.pipelines.length; i++)
      this.pipelines[i]?.destroy();
    this.pipelines.length = 0;
    this.buffer?.destroy();
    this.buffer = null;
    this.layout = null;
    this.slotOf.length = 0;
    this.next = 0;
  }
}

/**
 * Builds the effect uniform + the effect variant of the sprite pipelines.
 * `shader` must expose `fs_effect`: on WebGPU that is the base sprite module
 * with sprite.effect.wgsl appended, on WebGL2 a module pairing
 * sprite.vert.glsl with sprite.effect.frag.glsl.
 */
export async function createSpriteEffects(
  ctx: CoreContext,
  shader: RhiShaderModule,
): Promise<SpriteEffects> {
  const effects = new SpriteEffectsImpl(ctx);
  await effects.build(shader);
  return effects;
}

/**
 * The effect fragment shaders. They travel in this chunk, so the base sprite
 * module on the minimal path never carries them (ARCHITECTURE §22.7).
 * WGSL is appended to the base sprite module (it reuses `VertexOut`,
 * `spriteTexture` and `ALPHA_ONLY`); GLSL is a standalone fragment paired
 * with sprite.vert.glsl.
 */
export const EFFECT_WGSL = effectWGSL as string;
export const EFFECT_GLSL = effectFragGLSL as string;
