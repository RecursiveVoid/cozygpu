/**
 * Core half of filters (ARCHITECTURE §22.2): the FILTER
 * opcode range (0x05). DOM-free — it runs in the worker too.
 *
 * FILTER_BEGIN breaks the pass and opens a pooled target; the group's own
 * draw commands land there unchanged; FILTER_END records the chain's
 * full-screen passes on the frame's CommandList (ping-ponging between two
 * pooled targets), reopens the pass it broke and composites the result with
 * one quad.
 *
 * The target is the canvas at `filterOptions.resolution`, scissored to the
 * filter area: the group's own draws go through the sprite pipeline with the
 * frame's View uniform bound at group 0, which cannot be rebound per pass, so
 * an area-sized target would move every sprite. Only the area's texels are
 * ever shaded; see the note in ARCHITECTURE §22.4.
 */
import { BufferUsage, ShaderStage, TextureUsage } from '../backend/types';
import type {
  BlendMode,
  CommandList,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiRenderPipeline,
  RhiSampler,
  RhiTexture,
} from '../backend/types';
import {
  FILTER_MAP_MASK,
  FILTER_MAP_SHIFT,
  FilterFlag,
  FilterOp,
} from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import compositeFragGLSL from '../shaders/filter/composite.frag.glsl';
import compositeVertGLSL from '../shaders/filter/composite.vert.glsl';
import compositeWGSL from '../shaders/filter/composite.wgsl';
import filterVertGLSL from '../shaders/filter/filter.vert.glsl';
import filterWGSL from '../shaders/filter/filter.wgsl';
import { OpcodeRange } from '../commands/opcodes';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';
import {
  FILTER_MAX_PASSES,
  FILTER_MAX_UNIFORM_BYTES,
  FILTER_UNIFORM_OFFSET,
  MASK_MAX_DEPTH,
} from '../types/layouts';

import {
  acquireTargetPool,
  currentPassDesc,
  releaseTargetPool,
  resetTargetPool,
  setCurrentPassDesc,
} from './targets';
import type { TargetPool } from './targets';

/** One uniform slot per recorded pass; WebGPU's minimum dynamic alignment. */
const UNIFORM_STRIDE = 256;
const INITIAL_SLOTS = 32;
/** Blend modes the composite draw can use, indexed by BlendModeId. */
const BLEND_MODES: BlendMode[] = [
  'normal',
  'add',
  'multiply',
  'screen',
  'none',
];

const TRANSPARENT = new Float32Array(4);

interface Program {
  passes: number;
  uniformBytes: number;
  flags: number;
  source: string;
  /** Retained uniform bytes (prelude words stay zero; params from offset 48). */
  data: Uint8Array;
  /** Cached views into `data`: the params tail, and the whole block as u32. */
  params: Uint8Array;
  words: Uint32Array;
  /** Word index of the `map` param + 1, or 0 (see opcodes.ts FILTER_MAP_*). */
  mapWord: number;
  pipeline: RhiRenderPipeline | null;
}

/** One open capture; preallocated, reused, never built per frame. */
interface Capture {
  groupId: number;
  target: RhiTexture | null;
  /**
   * Multisampled attachment that resolves into `target`, under MSAA only: the
   * group's own sprites are drawn by pipelines built for the main pass' sample
   * count, while everything downstream samples the resolved texture.
   */
  msaa: RhiTexture | null;
  /** Reused pass description for this depth. */
  desc: RenderPassDesc;
  prev: RenderPassDesc | null;
  /** Logical render size inside the (possibly larger) target, physical px. */
  vw: number;
  vh: number;
  /** Filter area, target px. */
  ax: number;
  ay: number;
  aw: number;
  ah: number;
  /** Filter area, css px. */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  keep: boolean;
}

function makeCapture(): Capture {
  return {
    groupId: 0,
    target: null,
    msaa: null,
    desc: {
      label: 'cozygpu.filter.capture',
      color: { target: 'canvas', load: 'clear', clearColor: TRANSPARENT },
    },
    prev: null,
    vw: 0,
    vh: 0,
    ax: 0,
    ay: 0,
    aw: 0,
    ah: 0,
    cx: 0,
    cy: 0,
    cw: 0,
    ch: 0,
    keep: false,
  };
}

class FilterCoreSystem implements CoreSystem {
  readonly name = 'filter';
  readonly range = OpcodeRange.FILTER;

  private ctx: CoreContext | null = null;
  private pool: TargetPool | null = null;
  private sampler: RhiSampler | null = null;
  private uniformLayout: RhiBindGroupLayout | null = null;
  private ring: RhiBuffer | null = null;
  private ringGroup: RhiBindGroup | null = null;
  private slots = INITIAL_SLOTS;
  private cursor = 0;
  private wanted = 0;
  private epoch = 0;

  /** Programs by filterId. */
  private readonly programs: (Program | null)[] = [];
  /** One pipeline per distinct composed source, shared by every instance. */
  private readonly pipelines = new Map<string, RhiRenderPipeline | null>();
  /** Bind groups for pooled targets (texture + sampler), built once each. */
  private readonly srcGroups = new Map<RhiTexture, RhiBindGroup>();
  /** Targets pinned by `keepTarget`, per group. */
  private readonly kept = new Map<number, RhiTexture>();

  private readonly stack: Capture[] = [];
  private depth = 0;
  /** FILTER_BEGINs refused for depth; their FILTER_ENDs pop nothing. */
  private dropped = 0;

  private compositePipelines: (RhiRenderPipeline | null)[] = [];
  private readonly chainDesc: RenderPassDesc = {
    label: 'cozygpu.filter.pass',
    color: { target: 'canvas', load: 'clear', clearColor: TRANSPARENT },
  };

  /** Staging for one uniform slot (prelude + params). */
  private readonly staging = new Float32Array(UNIFORM_STRIDE >> 2);
  private readonly stagingU32 = new Uint32Array(this.staging.buffer);
  private readonly stagingU8 = new Uint8Array(this.staging.buffer);
  private readonly dynamic = new Uint32Array(1);
  private readonly chainIds = new Uint32Array(FILTER_MAX_PASSES);

  /** Handed from passBreak to the draw of the same command. */
  private pendingBegin: Capture | null = null;
  private compositeSrc: RhiTexture | null = null;
  private compositeOffset = 0;
  private compositeBlend = 0;

  constructor() {
    for (let i = 0; i < MASK_MAX_DEPTH; i++) this.stack.push(makeCapture());
  }

  /**
   * A pooled target was destroyed: drop its bind group, which would otherwise
   * stay in `srcGroups` — and on the GPU — for a texture that no longer
   * exists. Bound once, so registering it allocates nothing per frame.
   */
  private readonly forgetSource = (texture: RhiTexture): void => {
    const group = this.srcGroups.get(texture);
    if (!group) return;
    this.srcGroups.delete(texture);
    group.destroy();
  };

  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    const pool = acquireTargetPool(ctx.backend);
    this.pool = pool;
    pool.onDestroyed(this.forgetSource);
    await this.build(ctx);
  }

  async restore(ctx: CoreContext): Promise<void> {
    // GPU objects are gone; the front re-sends FILTER_DEFINE on the bump.
    this.programs.length = 0;
    this.pipelines.clear();
    this.srcGroups.clear();
    this.kept.clear();
    // The uniform ring belonged to the lost device: build() must not delete
    // it on the restored one.
    this.ring = null;
    const previous = this.ctx;
    this.ctx = ctx;
    // One reference per system, however many restores run: taking another
    // without dropping the old one would pin the shared pool forever. The new
    // one is taken first, so a pool another system still holds is kept.
    this.pool?.offDestroyed(this.forgetSource);
    // The backend (and so the shared pool record) survives a restore, but
    // the pooled textures belong to the lost device: drop them first.
    if (previous) resetTargetPool(previous.backend);
    resetTargetPool(ctx.backend);
    const pool = acquireTargetPool(ctx.backend);
    if (previous) releaseTargetPool(previous.backend);
    this.pool = pool;
    pool.onDestroyed(this.forgetSource);
    await this.build(ctx);
  }

  private async build(ctx: CoreContext): Promise<void> {
    const epoch = ++this.epoch;
    const backend = ctx.backend;
    this.sampler = backend.createSampler({
      label: 'cozygpu.filter.sampler',
      minFilter: 'linear',
      magFilter: 'linear',
      addressU: 'clamp-to-edge',
      addressV: 'clamp-to-edge',
    });
    this.uniformLayout = backend.createBindGroupLayout({
      label: 'cozygpu.filter.uniforms',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: {
            kind: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: UNIFORM_STRIDE,
          },
        },
      ],
    });
    this.allocRing(ctx, this.slots);
    const wgsl = backend.caps.shaderLanguage === 'wgsl';
    const shader = backend.createShaderModule({
      label: 'cozygpu.filter.composite',
      wgsl: wgsl ? (compositeWGSL as string) : undefined,
      glsl: wgsl
        ? undefined
        : {
            vertex: compositeVertGLSL as string,
            fragment: compositeFragGLSL as string,
          },
    });
    const jobs: Promise<void>[] = [];
    this.compositePipelines = [];
    for (let id = 0; id < BLEND_MODES.length; id++) {
      this.compositePipelines[id] = null;
      jobs.push(
        backend
          .createRenderPipeline({
            label: `cozygpu.filter.composite.${BLEND_MODES[id]}`,
            shader,
            bindGroupLayouts: [
              ctx.viewLayout,
              ctx.textureLayout,
              this.uniformLayout,
            ],
            vertexBuffers: [],
            topology: 'triangle-strip',
            blend: BLEND_MODES[id],
            sampleCount: ctx.sampleCount,
          })
          .then(pipeline => {
            if (epoch === this.epoch) this.compositePipelines[id] = pipeline;
            else pipeline.destroy();
          }),
      );
    }
    await Promise.all(jobs);
  }

  private allocRing(ctx: CoreContext, slots: number): void {
    this.ring?.destroy();
    this.slots = slots;
    this.ring = ctx.backend.createBuffer({
      label: 'cozygpu.filter.passUniforms',
      size: slots * UNIFORM_STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.ringGroup = ctx.backend.createBindGroup({
      label: 'cozygpu.filter.passUniforms',
      layout: this.uniformLayout as RhiBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.ring, offset: 0, size: UNIFORM_STRIDE },
        },
      ],
    });
  }

  execute(reader: CommandReader, _frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    switch (reader.opcode) {
      case FilterOp.FILTER_DEFINE: {
        const id = reader.u32();
        const passes = Math.max(1, Math.min(FILTER_MAX_PASSES, reader.u32()));
        const uniformBytes = Math.min(FILTER_MAX_UNIFORM_BYTES, reader.u32());
        const flags = reader.u32();
        const srcBytes = reader.u32();
        const source = reader.utf8(srcBytes);
        const data = new Uint8Array(FILTER_MAX_UNIFORM_BYTES);
        const program: Program = {
          passes,
          uniformBytes,
          flags,
          source,
          data,
          params: data.subarray(FILTER_UNIFORM_OFFSET, uniformBytes),
          words: new Uint32Array(data.buffer),
          mapWord: (flags >>> FILTER_MAP_SHIFT) & FILTER_MAP_MASK,
          pipeline: null,
        };
        this.programs[id] = program;
        this.ensurePipeline(ctx, program);
        return;
      }
      case FilterOp.FILTER_DESTROY: {
        this.programs[reader.u32()] = null;
        return;
      }
      case FilterOp.FILTER_SET_UNIFORMS: {
        const program = this.programs[reader.u32()];
        const offset = reader.u32();
        const length = reader.u32();
        const at = reader.blob(length);
        if (!program || offset + length > FILTER_MAX_UNIFORM_BYTES) return;
        program.data.set(reader.u8.subarray(at, at + length), offset);
        return;
      }
      default:
        return;
    }
  }

  /** One pipeline per composed source; instances of the same filter share it. */
  private ensurePipeline(ctx: CoreContext, program: Program): void {
    const cached = this.pipelines.get(program.source);
    if (cached !== undefined) {
      program.pipeline = cached;
      if (cached !== null) return;
      // A compile is already in flight for this source.
      return;
    }
    this.pipelines.set(program.source, null);
    const epoch = this.epoch;
    const backend = ctx.backend;
    const wgsl = backend.caps.shaderLanguage === 'wgsl';
    let shader;
    try {
      shader = backend.createShaderModule({
        label: 'cozygpu.filter.program',
        wgsl: wgsl ? `${filterWGSL as string}\n${program.source}` : undefined,
        glsl: wgsl
          ? undefined
          : { vertex: filterVertGLSL as string, fragment: program.source },
      });
    } catch (err) {
      this.report(ctx, err);
      return;
    }
    backend
      .createRenderPipeline({
        label: 'cozygpu.filter.program',
        shader,
        bindGroupLayouts: [
          ctx.viewLayout,
          ctx.textureLayout,
          this.uniformLayout as RhiBindGroupLayout,
          ctx.textureLayout,
        ],
        vertexBuffers: [],
        topology: 'triangle-list',
        blend: 'none',
        sampleCount: 1,
      })
      .then(
        pipeline => {
          if (epoch !== this.epoch) {
            pipeline.destroy();
            return;
          }
          this.pipelines.set(program.source, pipeline);
          for (let i = 0; i < this.programs.length; i++) {
            const p = this.programs[i];
            if (p && p.source === program.source) p.pipeline = pipeline;
          }
        },
        (err: unknown) => {
          this.pipelines.delete(program.source);
          this.report(ctx, err);
        },
      );
  }

  private report(ctx: CoreContext, err: unknown): void {
    ctx.post({
      type: 'error',
      code: 'SHADER_COMPILE',
      message: `filter: ${(err as Error)?.message ?? String(err)}`,
    });
  }

  passBreak(
    reader: CommandReader,
    list: CommandList,
    frame: CoreFrameState,
  ): RenderPassDesc | null {
    const ctx = this.ctx;
    const pool = this.pool;
    if (!ctx || !pool) return null;
    if (reader.opcode === FilterOp.FILTER_BEGIN) {
      return this.begin(reader, frame, ctx, pool);
    }
    if (reader.opcode === FilterOp.FILTER_END) {
      return this.end(reader, list, frame, ctx, pool);
    }
    return null;
  }

  private begin(
    reader: CommandReader,
    frame: CoreFrameState,
    ctx: CoreContext,
    pool: TargetPool,
  ): RenderPassDesc | null {
    const groupId = reader.u32();
    const x = reader.f32();
    const y = reader.f32();
    const w = reader.f32();
    const h = reader.f32();
    const resolution = reader.f32();
    const flags = reader.u32();
    this.pendingBegin = null;
    if (this.depth >= this.stack.length) {
      // Nested past MASK_MAX_DEPTH: this group is not captured, so its
      // FILTER_END must not pop the capture of an enclosing group. Dropped
      // begins nest inside each other (the depth cannot fall while they are
      // open), so one LIFO counter matches each end to its own begin.
      this.dropped++;
      return null;
    }
    const res = resolution > 0 ? Math.min(2, resolution) : 1;
    const vw = Math.max(1, Math.round(frame.pixelWidth * res));
    const vh = Math.max(1, Math.round(frame.pixelHeight * res));
    const keep = (flags & FilterFlag.KEEP_TARGET) !== 0;
    let target: RhiTexture | null = null;
    if (keep) {
      const pinned = this.kept.get(groupId);
      if (pinned && pinned.width >= vw && pinned.height >= vh) {
        target = pinned;
      } else {
        pinned?.destroy();
        target = ctx.backend.createTexture({
          label: `cozygpu.filter.kept#${groupId}`,
          width: vw,
          height: vh,
          format: ctx.backend.caps.canvasFormat,
          usage: TextureUsage.RENDER_TARGET | TextureUsage.SAMPLED,
        });
        this.kept.set(groupId, target);
      }
    } else {
      target = pool.acquire(vw, vh);
    }
    const sx =
      frame.cssWidth > 0 ? (frame.pixelWidth / frame.cssWidth) * res : res;
    const sy =
      frame.cssHeight > 0 ? (frame.pixelHeight / frame.cssHeight) * res : res;
    const samples = ctx.sampleCount;
    const msaa =
      samples === 1
        ? null
        : pool.acquire(vw, vh, ctx.backend.caps.canvasFormat, samples);
    const c = this.stack[this.depth++];
    c.groupId = groupId;
    c.target = target;
    c.msaa = msaa;
    c.vw = vw;
    c.vh = vh;
    c.keep = keep;
    c.cx = x;
    c.cy = y;
    c.cw = w;
    c.ch = h;
    c.ax = clamp(Math.floor(x * sx), 0, vw);
    c.ay = clamp(Math.floor(y * sy), 0, vh);
    c.aw = clamp(Math.ceil(w * sx), 0, vw - c.ax);
    c.ah = clamp(Math.ceil(h * sy), 0, vh - c.ay);
    c.prev = currentPassDesc(ctx.backend);
    c.desc.color.target = msaa ?? target;
    c.desc.color.resolveTarget = msaa ? target : undefined;
    // A multisampled attachment cannot be loaded from the resolved texture,
    // so KEEP_TARGET keeps the resolved content but starts the pass cleared.
    c.desc.color.load = keep && !msaa ? 'load' : 'clear';
    setCurrentPassDesc(ctx.backend, c.desc);
    this.pendingBegin = c;
    return c.desc;
  }

  private end(
    reader: CommandReader,
    list: CommandList,
    frame: CoreFrameState,
    ctx: CoreContext,
    pool: TargetPool,
  ): RenderPassDesc | null {
    reader.u32(); // groupId
    this.compositeBlend = reader.u32();
    const alpha = reader.f32();
    const count = Math.min(FILTER_MAX_PASSES, reader.u32());
    const at = reader.blob(count * 4);
    for (let i = 0; i < count; i++)
      this.chainIds[i] = reader.u32View[(at >> 2) + i];
    this.compositeSrc = null;
    if (this.dropped > 0) {
      this.dropped--;
      return null;
    }
    if (this.depth === 0) return null;
    const c = this.stack[--this.depth];
    const capture = c.target as RhiTexture;
    if (c.msaa) {
      pool.release(c.msaa);
      c.msaa = null;
    }
    let src = capture;
    for (let i = 0; i < count; i++) {
      const program = this.programs[this.chainIds[i]];
      if (!program || !program.pipeline) continue;
      for (let p = 0; p < program.passes; p++) {
        const dst = pool.acquire(c.vw, c.vh);
        const offset = this.writePassUniform(ctx, program, c, frame, p, dst);
        if (offset < 0) break;
        this.chainDesc.color.target = dst;
        this.chainDesc.color.load = 'clear';
        const rp = list.beginRenderPass(this.chainDesc);
        rp.setScissor(c.ax, c.ay, c.aw, c.ah);
        rp.setPipeline(program.pipeline);
        rp.setBindGroup(0, ctx.viewBindGroup);
        rp.setBindGroup(1, this.sourceGroup(ctx, src));
        this.dynamic[0] = offset;
        rp.setBindGroup(2, this.ringGroup as RhiBindGroup, this.dynamic);
        rp.setBindGroup(3, this.auxGroup(ctx, program, capture));
        rp.draw(3);
        rp.end();
        if (src !== capture) pool.release(src);
        src = dst;
      }
    }
    this.compositeSrc = src;
    this.compositeOffset = this.writeCompositeUniform(ctx, c, src, alpha);
    // Reopen the pass this capture interrupted, without clearing it.
    const prev = c.prev;
    if (prev) prev.color.load = 'load';
    setCurrentPassDesc(ctx.backend, prev);
    return prev;
  }

  /** Writes one pass' uniform slot; returns its dynamic offset, or -1. */
  private writePassUniform(
    ctx: CoreContext,
    program: Program,
    c: Capture,
    frame: CoreFrameState,
    passIndex: number,
    target: RhiTexture,
  ): number {
    const offset = this.slot();
    if (offset < 0) return -1;
    const f = this.staging;
    const u = this.stagingU32;
    f[0] = 1 / target.width;
    f[1] = 1 / target.height;
    f[2] = target.width;
    f[3] = target.height;
    f[4] = c.cx;
    f[5] = c.cy;
    f[6] = c.cw;
    f[7] = c.ch;
    f[8] = frame.time;
    u[9] = passIndex;
    // css px -> target px, so a strength or width in stage px means the same
    // thing at any DPR and at any filterOptions.resolution.
    f[10] = c.cw > 0 ? c.aw / c.cw : 1;
    f[11] = c.ch > 0 ? c.ah / c.ch : 1;
    // Cached view: a subarray per pass would allocate every frame.
    if (program.params.length > 0) {
      this.stagingU8.set(program.params, FILTER_UNIFORM_OFFSET);
    }
    ctx.backend.writeBuffer(
      this.ring as RhiBuffer,
      offset,
      this.stagingU8,
      0,
      UNIFORM_STRIDE,
    );
    return offset;
  }

  private writeCompositeUniform(
    ctx: CoreContext,
    c: Capture,
    src: RhiTexture,
    alpha: number,
  ): number {
    const offset = this.slot();
    if (offset < 0) return -1;
    const f = this.staging;
    f[0] = c.cx;
    f[1] = c.cy;
    f[2] = c.cw;
    f[3] = c.ch;
    f[4] = c.ax / src.width;
    f[5] = c.ay / src.height;
    f[6] = (c.ax + c.aw) / src.width;
    f[7] = (c.ay + c.ah) / src.height;
    f[8] = alpha;
    f[9] = 0;
    f[10] = 0;
    f[11] = 0;
    ctx.backend.writeBuffer(
      this.ring as RhiBuffer,
      offset,
      this.stagingU8,
      0,
      UNIFORM_STRIDE,
    );
    return offset;
  }

  private slot(): number {
    if (this.cursor >= this.slots) {
      this.wanted = this.slots * 2;
      return -1;
    }
    const offset = this.cursor * UNIFORM_STRIDE;
    this.cursor++;
    if (this.cursor > this.wanted) this.wanted = this.cursor;
    return offset;
  }

  private sourceGroup(ctx: CoreContext, texture: RhiTexture): RhiBindGroup {
    let group = this.srcGroups.get(texture);
    if (!group) {
      group = ctx.backend.createBindGroup({
        label: 'cozygpu.filter.source',
        layout: ctx.textureLayout,
        entries: [
          { binding: 0, resource: { texture } },
          { binding: 1, resource: { sampler: this.sampler as RhiSampler } },
        ],
      });
      this.srcGroups.set(texture, group);
    }
    return group;
  }

  /** Group 3: the displacement map when the program has one, else the capture. */
  private auxGroup(
    ctx: CoreContext,
    program: Program,
    capture: RhiTexture,
  ): RhiBindGroup {
    if (program.mapWord > 0) {
      const texId = program.words[program.mapWord - 1];
      if (texId !== 0) return ctx.getTexture(texId).bindGroup;
    }
    return this.sourceGroup(ctx, capture);
  }

  draw(reader: CommandReader, pass: RenderPass, _frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (reader.opcode === FilterOp.FILTER_BEGIN) {
      const c = this.pendingBegin;
      this.pendingBegin = null;
      if (!c) return;
      // The target may be bigger than the logical canvas (pool granularity).
      pass.setViewport(0, 0, c.vw, c.vh);
      pass.setScissor(c.ax, c.ay, c.aw, c.ah);
      return;
    }
    if (reader.opcode !== FilterOp.FILTER_END) return;
    const src = this.compositeSrc;
    this.compositeSrc = null;
    const pipeline = this.compositePipelines[this.compositeBlend];
    // Back inside the enclosing capture: restore its viewport and scissor.
    if (this.depth > 0) {
      const outer = this.stack[this.depth - 1];
      pass.setViewport(0, 0, outer.vw, outer.vh);
      pass.setScissor(outer.ax, outer.ay, outer.aw, outer.ah);
    }
    if (!src || !pipeline || this.compositeOffset < 0) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, ctx.viewBindGroup);
    pass.setBindGroup(1, this.sourceGroup(ctx, src));
    this.dynamic[0] = this.compositeOffset;
    pass.setBindGroup(2, this.ringGroup as RhiBindGroup, this.dynamic);
    pass.draw(4);
  }

  endFrame(_frame: CoreFrameState): void {
    this.depth = 0;
    this.dropped = 0;
    this.cursor = 0;
    this.pendingBegin = null;
    this.compositeSrc = null;
    const ctx = this.ctx;
    if (ctx && this.wanted > this.slots) {
      const slots = Math.min(1024, this.wanted);
      this.allocRing(ctx, slots);
    }
    this.wanted = 0;
    this.pool?.endFrame();
    if (ctx) setCurrentPassDesc(ctx.backend, null);
  }

  destroy(): void {
    this.epoch++;
    const ctx = this.ctx;
    for (const pipeline of this.pipelines.values()) pipeline?.destroy();
    this.pipelines.clear();
    for (let i = 0; i < this.compositePipelines.length; i++) {
      this.compositePipelines[i]?.destroy();
    }
    this.compositePipelines.length = 0;
    for (const texture of this.kept.values()) texture.destroy();
    this.kept.clear();
    for (const group of this.srcGroups.values()) group.destroy();
    this.srcGroups.clear();
    this.programs.length = 0;
    this.ring?.destroy();
    this.ring = null;
    this.ringGroup = null;
    this.sampler = null;
    this.uniformLayout = null;
    this.pool?.offDestroyed(this.forgetSource);
    this.pool = null;
    this.ctx = null;
    if (ctx) releaseTargetPool(ctx.backend);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createFilterCoreSystem(): CoreSystem {
  return new FilterCoreSystem();
}
