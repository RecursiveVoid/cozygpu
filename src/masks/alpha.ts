/**
 * Soft (alpha) masks: the half of the mask core that needs render targets
 * (ARCHITECTURE §21.3). Imported the first time a `MASK_PUSH_ALPHA` arrives,
 * so a program that only uses rect and shape masks never loads it.
 *
 * Targets come from the filter target pool (src/filters/targets.ts) — one
 * pool per renderer for both features, as §22.4 requires. The protocol is:
 * `acquire` two canvas-sized targets when the group's capture starts,
 * `release` both right after the composite, and let the pool's `endFrame`
 * age whatever a dropped frame left behind.
 *
 * Passes per soft mask:
 *   1. coverage  the mask quads into the alpha channel of target M
 *   2. capture   the group's subtree into target C (the core reopens it)
 *   3. composite C × M (or C × (1 − M) when inverted) over the main pass
 */
import { TextureUsage } from '../backend/types';
import type {
  CommandList,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiRenderPipeline,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
} from '../backend/types';
import { ShaderStage } from '../backend/types';
import type { TargetPool } from '../filters/targets';
import type { CoreContext, CoreFrameState } from '../types/core';
import { SPRITE_VERTEX_LAYOUT } from '../sprites/pipeline';

const QUAD_VERTICES = 4;
const TRIANGLE_VERTICES = 3;

export interface AlphaMasks {
  /**
   * Records the coverage pass and returns the pass the group is captured
   * into, or null when nothing can be captured (the core then clips to the
   * mask's bounds instead).
   */
  begin(
    list: CommandList,
    quads: RhiBuffer | null,
    first: number,
    count: number,
    texture: RhiBindGroup,
    invert: boolean,
    frame: CoreFrameState,
  ): RenderPassDesc | null;
  /** The capture pass was ended by the core; the main pass reopens next. */
  endCapture(): void;
  /** Composites the captured target over the main pass and frees the targets. */
  composite(pass: RenderPass, frame: CoreFrameState): void;
  endFrame(): void;
  destroy(): void;
}

class AlphaMasksImpl implements AlphaMasks {
  private capture: RhiTexture | null = null;
  /** Multisampled capture attachment that resolves into `capture` (MSAA). */
  private captureMsaa: RhiTexture | null = null;
  private coverage: RhiTexture | null = null;
  private invert = false;
  private group: RhiBindGroup | null = null;
  private groupCapture: RhiTexture | null = null;
  private groupCoverage: RhiTexture | null = null;

  private readonly coveragePass: RenderPassDesc = {
    label: 'cozygpu mask coverage',
    color: {
      target: 'canvas',
      load: 'clear',
      clearColor: new Float32Array([0, 0, 0, 0]),
    },
  };
  private readonly capturePass: RenderPassDesc = {
    label: 'cozygpu mask capture',
    color: {
      target: 'canvas',
      load: 'clear',
      clearColor: new Float32Array([0, 0, 0, 0]),
    },
  };

  constructor(
    private readonly ctx: CoreContext,
    private readonly pool: TargetPool,
    /** Drops this system's reference on the shared pool (§22.4). */
    private readonly releasePool: () => void,
    private readonly sampler: RhiSampler,
    private readonly layout: RhiBindGroupLayout,
    private readonly coveragePipeline: RhiRenderPipeline,
    private readonly compositeNormal: RhiRenderPipeline,
    private readonly compositeInvert: RhiRenderPipeline,
  ) {}

  begin(
    list: CommandList,
    quads: RhiBuffer | null,
    first: number,
    count: number,
    texture: RhiBindGroup,
    invert: boolean,
    frame: CoreFrameState,
  ): RenderPassDesc | null {
    if (!quads || count === 0 || this.capture) return null;
    const width = Math.max(1, frame.pixelWidth);
    const height = Math.max(1, frame.pixelHeight);
    const format = this.ctx.backend.caps.canvasFormat;
    const coverage = this.pool.acquire(width, height, format, 1);
    const capture = this.pool.acquire(width, height, format, 1);
    // The subtree is drawn by the sprite pipelines, which are built for the
    // main pass' sample count, so under MSAA the capture attachment has to be
    // multisampled and resolve into the single-sampled texture the composite
    // samples.
    const samples = this.ctx.sampleCount;
    const msaa =
      samples === 1 ? null : this.pool.acquire(width, height, format, samples);
    this.coverage = coverage;
    this.capture = capture;
    this.captureMsaa = msaa;
    this.invert = invert;
    // 1. Coverage: the mask's own alpha, on its own pass.
    this.coveragePass.color.target = coverage;
    const pass = list.beginRenderPass(this.coveragePass);
    pass.setPipeline(this.coveragePipeline);
    pass.setBindGroup(0, this.ctx.viewBindGroup);
    pass.setBindGroup(1, texture);
    pass.setVertexBuffer(0, quads);
    pass.draw(QUAD_VERTICES, count, 0, first);
    pass.end();
    // 2. Capture: the core opens this one and the subtree draws into it.
    this.capturePass.color.target = msaa ?? capture;
    this.capturePass.color.resolveTarget = msaa ? capture : undefined;
    return this.capturePass;
  }

  endCapture(): void {}

  composite(pass: RenderPass, _frame: CoreFrameState): void {
    const capture = this.capture;
    const coverage = this.coverage;
    if (!capture || !coverage) return;
    if (this.groupCapture !== capture || this.groupCoverage !== coverage) {
      this.group = this.ctx.backend.createBindGroup({
        label: 'cozygpu.mask.composite',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { texture: capture } },
          { binding: 1, resource: { sampler: this.sampler } },
          { binding: 2, resource: { texture: coverage } },
        ],
      });
      this.groupCapture = capture;
      this.groupCoverage = coverage;
    }
    pass.setPipeline(this.invert ? this.compositeInvert : this.compositeNormal);
    pass.setBindGroup(0, this.ctx.viewBindGroup);
    pass.setBindGroup(1, this.group!);
    pass.draw(TRIANGLE_VERTICES, 1, 0, 0);
    this.pool.release(capture);
    this.pool.release(coverage);
    if (this.captureMsaa) this.pool.release(this.captureMsaa);
    this.capture = null;
    this.captureMsaa = null;
    this.coverage = null;
  }

  endFrame(): void {
    this.capture = null;
    this.captureMsaa = null;
    this.coverage = null;
    this.pool.endFrame();
  }

  destroy(): void {
    this.capture = null;
    this.captureMsaa = null;
    this.coverage = null;
    this.group = null;
    this.groupCapture = null;
    this.groupCoverage = null;
    // The pool is shared with the filter core: drop the reference and let the
    // last holder destroy it.
    this.releasePool();
  }
}

/**
 * Builds the soft-mask machinery. Rejects when the target pool or the
 * composite pipelines are not available; the caller then falls back to a
 * scissor of the mask's bounds.
 */
export async function createAlphaMasks(
  ctx: CoreContext,
  maskShader: RhiShaderModule | null,
): Promise<AlphaMasks> {
  const backend = ctx.backend;
  const wgsl = backend.caps.shaderLanguage === 'wgsl';
  const targets = await import('../filters/targets');
  const sources = wgsl
    ? await import('./shadersWGSL')
    : await import('./shadersGLSL');
  const composite = backend.createShaderModule({
    label: 'cozygpu.mask.composite',
    wgsl: wgsl ? (sources as { composite: string }).composite : undefined,
    glsl: wgsl
      ? undefined
      : {
          vertex: (sources as { compositeVertex: string }).compositeVertex,
          fragment: (sources as { compositeFragment: string })
            .compositeFragment,
        },
  });
  // GLSL has one fragment stage per program, so the inverted variant is its
  // own module there (WGSL just picks another entry point).
  const compositeInvertShader = wgsl
    ? composite
    : backend.createShaderModule({
        label: 'cozygpu.mask.composite.invert',
        glsl: {
          vertex: (sources as { compositeVertex: string }).compositeVertex,
          fragment: (sources as { compositeInvertFragment: string })
            .compositeInvertFragment,
        },
      });
  const coverageShader = wgsl
    ? (maskShader ??
      backend.createShaderModule({
        label: 'cozygpu.mask',
        wgsl: (sources as { wgsl: string }).wgsl,
      }))
    : backend.createShaderModule({
        label: 'cozygpu.mask.alpha',
        glsl: {
          vertex: (sources as { vertex: string }).vertex,
          fragment: (sources as { alphaFragment: string }).alphaFragment,
        },
      });
  const layout = backend.createBindGroupLayout({
    label: 'cozygpu.mask.composite',
    entries: [
      {
        binding: 0,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'texture' },
      },
      {
        binding: 1,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'sampler' },
      },
      {
        binding: 2,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'texture' },
      },
    ],
  });
  const sampler = backend.createSampler({ label: 'cozygpu.mask.composite' });
  const [coveragePipeline, compositeNormal, compositeInvert] =
    await Promise.all([
      backend.createRenderPipeline({
        label: 'cozygpu.mask.coverage',
        shader: coverageShader,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_alpha',
        bindGroupLayouts: [ctx.viewLayout, ctx.textureLayout],
        vertexBuffers: [SPRITE_VERTEX_LAYOUT],
        topology: 'triangle-strip',
        blend: 'normal',
        sampleCount: 1,
      }),
      backend.createRenderPipeline({
        label: 'cozygpu.mask.composite',
        shader: composite,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
        bindGroupLayouts: [ctx.viewLayout, layout],
        vertexBuffers: [],
        topology: 'triangle-list',
        blend: 'normal',
        sampleCount: ctx.sampleCount,
      }),
      backend.createRenderPipeline({
        label: 'cozygpu.mask.composite.invert',
        shader: compositeInvertShader,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_invert',
        bindGroupLayouts: [ctx.viewLayout, layout],
        vertexBuffers: [],
        topology: 'triangle-list',
        blend: 'normal',
        sampleCount: ctx.sampleCount,
      }),
    ]);
  // ONE pool per backend for both features (§22.4): a reference, never a
  // second pool, so a page that filters and soft-masks keeps one set of
  // canvas-sized targets instead of two. Taken last, after everything that
  // can reject, so a failed build never leaks the reference.
  const pool = targets.acquireTargetPool(backend);
  return new AlphaMasksImpl(
    ctx,
    pool,
    () => targets.releaseTargetPool(backend),
    sampler,
    layout,
    coveragePipeline,
    compositeNormal,
    compositeInvert,
  );
}

/** Soft-mask targets are sampled, so they need SAMPLED usage in the pool. */
export const ALPHA_TARGET_USAGE =
  TextureUsage.RENDER_TARGET | TextureUsage.SAMPLED;
