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
// Static: this chunk is itself lazy, and a dynamic import of a module the
// filter chunk also imports statically would cost an extra facade chunk.
import {
  acquireTargetPool,
  currentPassDesc,
  releaseTargetPool,
  resetTargetPool,
  setCurrentPassDesc,
  type TargetPool,
} from '../filters/targets';
import { MASK_MAX_DEPTH } from '../types/layouts';
import type { CoreContext, CoreFrameState } from '../types/core';
import { SPRITE_VERTEX_LAYOUT } from '../sprites/pipeline';

const QUAD_VERTICES = 4;
const TRIANGLE_VERTICES = 3;

export interface AlphaMasks {
  /**
   * Records the coverage pass and returns the pass the group is captured
   * into, or null when nothing can be captured (the core then clips to the
   * mask's bounds instead). Soft masks nest: each open capture keeps its own
   * targets, and the pass it interrupted is reopened when it ends.
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
  /**
   * M4 (ARCHITECTURE §26.8). A mask whose geometry another system draws (a
   * Graphics, `MaskFlag.EXTERNAL`): takes the targets like `begin` and
   * returns the coverage pass the geometry draws into (multisampled when the
   * main pass is, since the geometry uses the main-pass pipelines), or null
   * when nothing can be captured.
   */
  beginExternal(invert: boolean, frame: CoreFrameState): RenderPassDesc | null;
  /**
   * M4. MASK_GEOMETRY_END: the coverage pass was ended by the core; returns
   * the capture pass of the innermost soft mask.
   */
  endExternal(): RenderPassDesc | null;
  /**
   * The innermost capture pass was ended by the core: the pass it
   * interrupted (the enclosing capture, or the main pass) becomes current
   * again, for the composite.
   */
  endCapture(): void;
  /** Composites the innermost capture over the open pass and frees it. */
  composite(pass: RenderPass, frame: CoreFrameState): void;
  /**
   * The capture (alpha or filter) draws currently go to, set to load so it
   * can be reopened, or null for the main pass.
   */
  current(): RenderPassDesc | null;
  /** True while draws go to an offscreen capture rather than the main pass. */
  readonly capturing: boolean;
  endFrame(): void;
  /** Device restore: forgets the lost device's targets, then destroys. */
  lost(): void;
  destroy(): void;
}

/** One open soft mask: its targets and the pass it interrupted. */
interface Level {
  capture: RhiTexture | null;
  /** Multisampled capture attachment that resolves into `capture` (MSAA). */
  msaa: RhiTexture | null;
  coverage: RhiTexture | null;
  /** M4: multisampled coverage attachment of an external mask (MSAA). */
  coverageMsaa: RhiTexture | null;
  invert: boolean;
  prev: RenderPassDesc | null;
  readonly pass: RenderPassDesc;
  group: RhiBindGroup | null;
  groupCapture: RhiTexture | null;
  groupCoverage: RhiTexture | null;
}

function makeLevel(): Level {
  return {
    capture: null,
    msaa: null,
    coverage: null,
    coverageMsaa: null,
    invert: false,
    prev: null,
    pass: {
      label: 'cozygpu mask capture',
      color: {
        target: 'canvas',
        load: 'clear',
        clearColor: new Float32Array([0, 0, 0, 0]),
      },
    },
    group: null,
    groupCapture: null,
    groupCoverage: null,
  };
}

class AlphaMasksImpl implements AlphaMasks {
  /** Open captures, innermost last; never reallocated. */
  private readonly levels: Level[] = [];
  private depth = 0;

  private readonly coveragePass: RenderPassDesc = {
    label: 'cozygpu mask coverage',
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
  ) {
    for (let i = 0; i < MASK_MAX_DEPTH; i++) this.levels.push(makeLevel());
  }

  get capturing(): boolean {
    return currentPassDesc(this.ctx.backend) !== null;
  }

  current(): RenderPassDesc | null {
    const desc = currentPassDesc(this.ctx.backend);
    if (desc) desc.color.load = 'load';
    return desc;
  }

  begin(
    list: CommandList,
    quads: RhiBuffer | null,
    first: number,
    count: number,
    texture: RhiBindGroup,
    invert: boolean,
    frame: CoreFrameState,
  ): RenderPassDesc | null {
    if (!quads || count === 0) return null;
    const level = this.open(invert, frame, false);
    if (!level) return null;
    // 1. Coverage: the mask's own alpha, on its own pass.
    const coverage = this.coveragePass.color;
    coverage.target = level.coverage!;
    coverage.resolveTarget = undefined;
    const pass = list.beginRenderPass(this.coveragePass);
    pass.setPipeline(this.coveragePipeline);
    pass.setBindGroup(0, this.ctx.viewBindGroup);
    pass.setBindGroup(1, texture);
    pass.setVertexBuffer(0, quads);
    pass.draw(QUAD_VERTICES, count, 0, first);
    pass.end();
    return this.capture(level);
  }

  beginExternal(invert: boolean, frame: CoreFrameState): RenderPassDesc | null {
    const level = this.open(invert, frame, true);
    if (!level) return null;
    const coverage = this.coveragePass.color;
    coverage.target = level.coverageMsaa ?? level.coverage!;
    coverage.resolveTarget = level.coverageMsaa ? level.coverage! : undefined;
    return this.coveragePass;
  }

  endExternal(): RenderPassDesc | null {
    return this.depth > 0 ? this.capture(this.levels[this.depth - 1]) : null;
  }

  /** Takes the targets of the next soft mask level. */
  private open(
    invert: boolean,
    frame: CoreFrameState,
    external: boolean,
  ): Level | null {
    if (this.depth >= this.levels.length) return null;
    const backend = this.ctx.backend;
    // Exactly the frame's size, so the capture is drawn with the main pass'
    // viewport and scissor rects need no mapping (§21.3).
    const width = Math.max(1, frame.pixelWidth);
    const height = Math.max(1, frame.pixelHeight);
    const format = backend.caps.canvasFormat;
    const coverage = this.pool.acquire(width, height, format, 1, true);
    const capture = this.pool.acquire(width, height, format, 1, true);
    // The subtree is drawn by the sprite pipelines, which are built for the
    // main pass' sample count, so under MSAA the capture attachment has to be
    // multisampled and resolve into the single-sampled texture the composite
    // samples. External mask geometry is drawn the same way.
    const samples = this.ctx.sampleCount;
    const msaa =
      samples === 1
        ? null
        : this.pool.acquire(width, height, format, samples, true);
    const level = this.levels[this.depth++];
    level.coverage = coverage;
    level.capture = capture;
    level.msaa = msaa;
    level.coverageMsaa =
      external && msaa
        ? this.pool.acquire(width, height, format, samples, true)
        : null;
    level.invert = invert;
    level.prev = currentPassDesc(backend);
    return level;
  }

  /**
   * 2. Capture: the core opens this one and the subtree draws into it. An
   * inner effect reopens it (with load) after its own capture.
   */
  private capture(level: Level): RenderPassDesc {
    const msaa = level.msaa;
    const color = level.pass.color;
    color.target = msaa ?? level.capture!;
    color.resolveTarget = msaa ? level.capture! : undefined;
    color.keepMultisampled = msaa !== null;
    color.load = 'clear';
    setCurrentPassDesc(this.ctx.backend, level.pass);
    return level.pass;
  }

  endCapture(): void {
    if (this.depth > 0) {
      setCurrentPassDesc(this.ctx.backend, this.levels[this.depth - 1].prev);
    }
  }

  composite(pass: RenderPass, _frame: CoreFrameState): void {
    if (this.depth === 0) return;
    const level = this.levels[--this.depth];
    const capture = level.capture;
    const coverage = level.coverage;
    if (!capture || !coverage) return;
    if (level.groupCapture !== capture || level.groupCoverage !== coverage) {
      level.group = this.ctx.backend.createBindGroup({
        label: 'cozygpu.mask.composite',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { texture: capture } },
          { binding: 1, resource: { sampler: this.sampler } },
          { binding: 2, resource: { texture: coverage } },
        ],
      });
      level.groupCapture = capture;
      level.groupCoverage = coverage;
    }
    pass.setPipeline(
      level.invert ? this.compositeInvert : this.compositeNormal,
    );
    pass.setBindGroup(0, this.ctx.viewBindGroup);
    pass.setBindGroup(1, level.group!);
    pass.draw(TRIANGLE_VERTICES, 1, 0, 0);
    this.pool.release(capture);
    this.pool.release(coverage);
    if (level.msaa) this.pool.release(level.msaa);
    if (level.coverageMsaa) this.pool.release(level.coverageMsaa);
    this.clear(level);
  }

  private clear(level: Level): void {
    level.capture = null;
    level.msaa = null;
    level.coverage = null;
    level.coverageMsaa = null;
    level.prev = null;
  }

  endFrame(): void {
    for (let i = 0; i < this.levels.length; i++) this.clear(this.levels[i]);
    this.depth = 0;
    setCurrentPassDesc(this.ctx.backend, null);
    this.pool.endFrame();
  }

  lost(): void {
    resetTargetPool(this.ctx.backend);
    this.destroy();
  }

  destroy(): void {
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      this.clear(level);
      level.group = null;
      level.groupCapture = null;
      level.groupCoverage = null;
    }
    this.depth = 0;
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
  const pool = acquireTargetPool(backend);
  return new AlphaMasksImpl(
    ctx,
    pool,
    () => releaseTargetPool(backend),
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
