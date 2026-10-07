/**
 * Graphics core system (ARCHITECTURE §26.5), range OpcodeRange.GRAPHICS,
 * chunk `graphics-core`. DOM-free: it runs in the worker in worker mode.
 *
 * Owns the shape-instance and node-record buffers, the mesh table (vertex +
 * index buffers per meshId), the SDF shape and mesh pipelines (one per blend
 * mode, plus the stencil-write variants for masks and the pick pipelines),
 * WGSL and GLSL alike. Keeps no CPU copies: after a device loss `restore`
 * rebuilds pipelines and the front re-sends every buffer and mesh.
 *
 *  - Pipelines are created async: the 'normal' and pick variants of both
 *    kinds at `init` / `restore`, every other variant on its first draw. A
 *    draw whose pipeline is not ready is skipped.
 *  - Shapes: triangle-strip, draw(4, count, 0, first) over the shape buffer.
 *  - Meshes: drawIndexed(indexCount, nodeCount, firstIndex, 0, firstNode)
 *    with the mesh as buffer 0 and the node records as buffer 1. A textured
 *    draw writes its uv matrix to a 256-byte slot of a uniform buffer bound
 *    with a dynamic offset (slot 0 serves untextured draws, which sample the
 *    white texture).
 *  - Picking: `drawPick` replays both draw kinds with the pick variants;
 *    mask geometry is not pickable.
 */
import { BufferUsage, ShaderStage } from '../backend/types';
import type {
  RenderPass,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiRenderPipeline,
  RhiShaderModule,
} from '../backend/types';
import { OpcodeRange } from '../commands/opcodes';
import { GfxDrawFlag, GfxMeshFlag, GfxOp } from '../commands/gfxOpcodes';
import type { CommandReader } from '../commands/types';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';
import { MASK_STENCIL_FORMAT, PICK_TARGET_FORMAT } from '../types/layouts';
import {
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
} from '../types/gfxLayouts';
import {
  GFX_BLEND_MODES,
  GFX_KIND_MESH,
  GFX_KIND_SHAPES,
  GFX_MASK_STENCIL,
  GFX_MESH_LAYOUTS,
  GFX_SHAPE_LAYOUT,
  GFX_VARIANT_MASK,
  GFX_VARIANT_PICK,
  GFX_VARIANTS,
  gfxVariant,
} from './pipelines';

const QUAD_VERTICES = 4;
/** Two draw kinds (shapes, mesh) × GFX_VARIANTS. */
const PIPELINE_SLOTS = 2 * GFX_VARIANTS;
/** Dynamic uniform offset alignment (WebGPU minimum) and the uv block size. */
const UV_STRIDE = 256;
const UV_BYTES = 32;
const UV_INITIAL_SLOTS = 16;
const KIND_NAMES = ['shape', 'mesh'];
const FRAGMENT_ENTRIES = ['fs_main', 'fs_pick', 'fs_mask'];
const DEFINES = ['', 'PICK', 'MASK'];

/** Shader sources for the backend's language, loaded once per process. */
let wgslSources: Promise<readonly string[]> | null = null;
let glslSources: Promise<readonly string[]> | null = null;

/** `#define NAME` after the `#version` line (fragment variants of GLSL). */
function withDefine(source: string, name: string): string {
  return name ? source.replace('\n', `\n#define ${name}\n`) : source;
}

export class GraphicsCoreSystem implements CoreSystem {
  readonly name = 'graphics';
  readonly range = OpcodeRange.GRAPHICS;

  private ctx: CoreContext | null = null;
  /** Bumped on restore/destroy so late promises are dropped. */
  private epoch = 0;
  private wgsl: readonly string[] | null = null;
  private glsl: readonly string[] | null = null;
  /** kind * 3 + fragment variant (main, pick, mask). */
  private readonly modules: (RhiShaderModule | null)[] = [];
  /**
   * kind * GFX_VARIANTS + variant; null while not built. A packed array of
   * fixed length (never holey, never read out of bounds) keeps the per-draw
   * lookup in replay() free of allocations.
   */
  private readonly pipelines: (RhiRenderPipeline | null)[] = Array.from(
    { length: PIPELINE_SLOTS },
    () => null,
  );
  /** Per pipeline slot: 1 once requested (compiling, built or failed). */
  private readonly requested = new Uint8Array(PIPELINE_SLOTS);

  /** Index = bufferId. */
  private readonly shapes: (RhiBuffer | null)[] = [];
  private readonly nodes: (RhiBuffer | null)[] = [];
  /** Index = meshId. */
  private readonly meshVertices: (RhiBuffer | null)[] = [];
  private readonly meshIndices: (RhiBuffer | null)[] = [];
  private readonly meshIndexCount: number[] = [];
  private readonly meshWide: boolean[] = [];

  private readonly sharedSource: (ArrayBuffer | SharedArrayBuffer | null)[] =
    [];
  private readonly sharedViews: (Uint8Array | null)[] = [];

  private uvLayout: RhiBindGroupLayout | null = null;
  private uvBuffer: RhiBuffer | null = null;
  private uvGroup: RhiBindGroup | null = null;
  private uvSlots = 0;
  /** Next free uv slot this frame (slot 0 is never written). */
  private uvCursor = 1;
  private readonly uvData = new Float32Array(UV_BYTES / 4);
  private readonly uvOffset = new Uint32Array(1);
  /** Uniform buffers outgrown this frame, destroyed after the submit. */
  private readonly retired: RhiBuffer[] = [];

  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    await this.build(ctx);
  }

  async restore(ctx: CoreContext): Promise<void> {
    // Every GPU object belonged to the lost device: dropped, not destroyed.
    // The front re-allocates and re-uploads on the generation bump.
    this.shapes.length = 0;
    this.nodes.length = 0;
    this.meshVertices.length = 0;
    this.meshIndices.length = 0;
    this.meshIndexCount.length = 0;
    this.meshWide.length = 0;
    this.sharedSource.length = 0;
    this.sharedViews.length = 0;
    this.retired.length = 0;
    this.uvBuffer = null;
    this.uvGroup = null;
    this.ctx = ctx;
    await this.build(ctx);
  }

  private async build(ctx: CoreContext): Promise<void> {
    const epoch = ++this.epoch;
    this.modules.length = 0;
    this.pipelines.fill(null);
    this.requested.fill(0);
    const backend = ctx.backend;
    this.uvLayout = backend.createBindGroupLayout({
      label: 'cozygpu.graphics.uv',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX,
          type: {
            kind: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: UV_BYTES,
          },
        },
      ],
    });
    this.allocUv(ctx, UV_INITIAL_SLOTS);
    // One language per backend: the other never loads.
    if (backend.caps.shaderLanguage === 'wgsl') {
      this.wgsl = await (wgslSources ??= import('./shadersWGSL').then(
        m => m.wgsl,
      ));
    } else {
      this.glsl = await (glslSources ??= import('./shadersGLSL').then(
        m => m.glsl,
      ));
    }
    if (epoch !== this.epoch) return;
    // The two pipelines nearly every program draws with, and the pick
    // variants: built now. A pick issued while a pick variant still compiles
    // waits for it (ctx.pickPipelinePending).
    for (let kind = 0; kind < 2; kind++) {
      this.pipeline(kind, 0);
      this.pipeline(kind, GFX_VARIANT_PICK);
    }
  }

  // ── pipelines ──────────────────────────────────────────────────────────────

  private module(kind: number, fragment: number): RhiShaderModule | null {
    const wgsl = this.wgsl;
    const glsl = this.glsl;
    if (!this.ctx || (!wgsl && !glsl)) return null;
    // WGSL: one module per kind with every entry point; GLSL: one program
    // source per fragment variant.
    const index = kind * 3 + (wgsl ? 0 : fragment);
    return (this.modules[index] ??= this.ctx.backend.createShaderModule({
      label: `cozygpu.graphics.${KIND_NAMES[kind]}`,
      wgsl: wgsl ? wgsl[kind] : undefined,
      glsl: glsl
        ? {
            vertex: glsl[kind * 2],
            fragment: withDefine(glsl[kind * 2 + 1], DEFINES[fragment]),
          }
        : undefined,
    }));
  }

  /**
   * The pipeline, or null while it compiles (the first call starts it). Runs
   * per draw: it creates no closure, so a call allocates nothing.
   */
  private pipeline(kind: number, variant: number): RhiRenderPipeline | null {
    const index = kind * GFX_VARIANTS + variant;
    const existing = this.pipelines[index];
    if (existing === null && this.requested[index] === 0) {
      this.request(kind, variant, index);
    }
    return existing;
  }

  /**
   * Starts building pipeline `index`. Kept out of pipeline(): its promise
   * callbacks capture locals, which makes V8 allocate a context on every
   * call of the function that declares them.
   */
  private request(kind: number, variant: number, index: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const caps = ctx.backend.caps;
    const pick = variant === GFX_VARIANT_PICK;
    const mask = variant === GFX_VARIANT_MASK;
    if ((pick && !caps.integerRenderTargets) || (mask && !caps.stencil)) {
      // Unsupported on this device: these draws stay skipped.
      this.requested[index] = 1;
      return;
    }
    // Mesh mask geometry needs no discard: every triangle counts.
    const fragment = pick ? 1 : mask && kind === GFX_KIND_SHAPES ? 2 : 0;
    const shader = this.module(kind, fragment);
    if (!shader) return;
    this.requested[index] = 1;
    const epoch = this.epoch;
    const mesh = kind === GFX_KIND_MESH;
    // Picks wait for a pick pipeline that is still compiling (§16.3).
    if (pick) ctx.pickPipelinePending?.(1);
    ctx.backend
      .createRenderPipeline({
        label: `cozygpu.graphics.${KIND_NAMES[kind]}.${variant}`,
        shader,
        vertexEntry: 'vs_main',
        fragmentEntry: FRAGMENT_ENTRIES[fragment],
        bindGroupLayouts: mesh
          ? [ctx.viewLayout, ctx.textureLayout, this.uvLayout!]
          : [ctx.viewLayout],
        vertexBuffers: mesh ? GFX_MESH_LAYOUTS : [GFX_SHAPE_LAYOUT],
        topology: mesh ? 'triangle-list' : 'triangle-strip',
        colorFormat: pick ? PICK_TARGET_FORMAT : undefined,
        blend: pick || mask ? 'none' : GFX_BLEND_MODES[variant],
        sampleCount: pick ? 1 : ctx.sampleCount,
        depthFormat: mask ? MASK_STENCIL_FORMAT : undefined,
        stencil: mask ? GFX_MASK_STENCIL : undefined,
        colorWriteDisabled: mask || undefined,
      })
      .then(
        pipeline => {
          if (pick) ctx.pickPipelinePending?.(-1);
          if (epoch === this.epoch) this.pipelines[index] = pipeline;
          else pipeline.destroy();
        },
        (err: unknown) => {
          if (pick) ctx.pickPipelinePending?.(-1);
          // No retry (it would fail every frame): these draws stay skipped.
          if (epoch === this.epoch) {
            ctx.post({
              type: 'error',
              code: 'INTERNAL',
              message: `graphics pipeline: ${(err as Error)?.message ?? String(err)}`,
            });
          }
        },
      );
  }

  // ── uploads ────────────────────────────────────────────────────────────────

  execute(reader: CommandReader, _frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const op = reader.opcode;
    switch (op) {
      case GfxOp.GFX_SHAPE_BUFFER_ALLOC:
      case GfxOp.GFX_NODE_BUFFER_ALLOC: {
        const node = op === GfxOp.GFX_NODE_BUFFER_ALLOC;
        const list = node ? this.nodes : this.shapes;
        const id = reader.u32();
        const capacity = reader.u32();
        list[id]?.destroy();
        list[id] = ctx.backend.createBuffer({
          label: `cozygpu.graphics.${node ? 'nodes' : 'shapes'}#${id}`,
          size:
            Math.max(1, capacity) * (node ? GFX_NODE_BYTES : GFX_SHAPE_BYTES),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        });
        return;
      }
      case GfxOp.GFX_SHAPE_BUFFER_DESTROY:
      case GfxOp.GFX_NODE_BUFFER_DESTROY: {
        const list =
          op === GfxOp.GFX_NODE_BUFFER_DESTROY ? this.nodes : this.shapes;
        const id = reader.u32();
        list[id]?.destroy();
        list[id] = null;
        return;
      }
      case GfxOp.GFX_SHAPE_UPLOAD:
      case GfxOp.GFX_NODE_UPLOAD:
      case GfxOp.GFX_SHAPE_UPLOAD_SHARED:
      case GfxOp.GFX_NODE_UPLOAD_SHARED: {
        const node =
          op === GfxOp.GFX_NODE_UPLOAD || op === GfxOp.GFX_NODE_UPLOAD_SHARED;
        const stride = node ? GFX_NODE_BYTES : GFX_SHAPE_BYTES;
        const buffer = (node ? this.nodes : this.shapes)[reader.u32()];
        const first = reader.u32();
        const count = reader.u32();
        const bytes = count * stride;
        const dst = first * stride;
        let src: Uint8Array | null = reader.u8;
        let at: number;
        if (op === GfxOp.GFX_SHAPE_UPLOAD || op === GfxOp.GFX_NODE_UPLOAD) {
          at = reader.blob(bytes);
        } else {
          src = this.sharedView(ctx, reader.u32());
          // byteOffset locates slot 0 of the store, as for sprites.
          at = reader.u32() + dst;
          if (src && at + bytes > src.byteLength) src = null;
        }
        if (!buffer || !src || dst + bytes > buffer.size) return;
        ctx.backend.writeBuffer(buffer, dst, src, at, bytes);
        return;
      }
      case GfxOp.GFX_MESH_UPLOAD:
      case GfxOp.GFX_MESH_UPLOAD_SHARED: {
        const id = reader.u32();
        const vertexCount = reader.u32();
        const indexCount = reader.u32();
        const wide = (reader.u32() & GfxMeshFlag.U32_INDEX) !== 0;
        const vertexBytes = vertexCount * GFX_MESH_VERTEX_BYTES;
        // writeBuffer sizes are multiples of 4; the padding travels too.
        const indexBytes = (indexCount * (wide ? 4 : 2) + 3) & ~3;
        let src: Uint8Array | null = reader.u8;
        let vertexAt: number;
        let indexAt: number;
        if (op === GfxOp.GFX_MESH_UPLOAD) {
          vertexAt = reader.blob(vertexBytes);
          indexAt = reader.blob(indexBytes);
        } else {
          src = this.sharedView(ctx, reader.u32());
          vertexAt = reader.u32();
          indexAt = reader.u32();
          if (
            src &&
            (vertexAt + vertexBytes > src.byteLength ||
              indexAt + indexBytes > src.byteLength)
          ) {
            src = null;
          }
        }
        if (!src) return;
        const vertices = this.fit(
          ctx,
          this.meshVertices[id],
          vertexBytes,
          BufferUsage.VERTEX,
          `cozygpu.graphics.mesh#${id}`,
        );
        const indices = this.fit(
          ctx,
          this.meshIndices[id],
          indexBytes,
          BufferUsage.INDEX,
          `cozygpu.graphics.indices#${id}`,
        );
        this.meshVertices[id] = vertices;
        this.meshIndices[id] = indices;
        this.meshIndexCount[id] = indexCount;
        this.meshWide[id] = wide;
        if (vertexBytes > 0) {
          ctx.backend.writeBuffer(vertices, 0, src, vertexAt, vertexBytes);
        }
        if (indexBytes > 0) {
          ctx.backend.writeBuffer(indices, 0, src, indexAt, indexBytes);
        }
        return;
      }
      case GfxOp.GFX_MESH_DESTROY: {
        const id = reader.u32();
        this.meshVertices[id]?.destroy();
        this.meshIndices[id]?.destroy();
        this.meshVertices[id] = null;
        this.meshIndices[id] = null;
        this.meshIndexCount[id] = 0;
        return;
      }
      default:
        return;
    }
  }

  /** The buffer when it holds `bytes`, else a new one grown ×1.5 (never shrunk). */
  private fit(
    ctx: CoreContext,
    buffer: RhiBuffer | null | undefined,
    bytes: number,
    usage: number,
    label: string,
  ): RhiBuffer {
    if (buffer && buffer.size >= bytes) return buffer;
    const grown = buffer ? Math.ceil(buffer.size * 1.5) : 0;
    buffer?.destroy();
    return ctx.backend.createBuffer({
      label,
      size: (Math.max(bytes, grown, 4) + 3) & ~3,
      usage: usage | BufferUsage.COPY_DST,
    });
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

  // ── draws ──────────────────────────────────────────────────────────────────

  draw(reader: CommandReader, pass: RenderPass, _frame: CoreFrameState): void {
    this.replay(reader, pass, null);
  }

  drawPick(
    reader: CommandReader,
    pass: RenderPass,
    _frame: CoreFrameState,
    view: RhiBindGroup,
  ): void {
    this.replay(reader, pass, view);
  }

  /** One GFX_DRAW_* command; `pickView` set = the pick pass. */
  private replay(
    reader: CommandReader,
    pass: RenderPass,
    pickView: RhiBindGroup | null,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const view = pickView ?? ctx.viewBindGroup;
    if (reader.opcode === GfxOp.GFX_DRAW_SHAPES) {
      const buffer = this.shapes[reader.u32()];
      const first = reader.u32();
      const count = reader.u32();
      const blendId = reader.u32();
      const flags = reader.u32();
      const variant = gfxVariant(
        blendId,
        (flags & GfxDrawFlag.MASK_WRITE) !== 0,
        pickView !== null,
      );
      if (!buffer || count === 0 || variant < 0) return;
      if ((first + count) * GFX_SHAPE_BYTES > buffer.size) return;
      const pipeline = this.pipeline(GFX_KIND_SHAPES, variant);
      if (!pipeline) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, view);
      pass.setVertexBuffer(0, buffer);
      pass.draw(QUAD_VERTICES, count, 0, first);
      return;
    }
    if (reader.opcode !== GfxOp.GFX_DRAW_MESH) return;
    const meshId = reader.u32();
    const firstIndex = reader.u32();
    const indexCount = reader.u32();
    const nodes = this.nodes[reader.u32()];
    const firstNode = reader.u32();
    const nodeCount = reader.u32();
    const texId = reader.u32();
    const blendId = reader.u32();
    const flags = reader.u32();
    const variant = gfxVariant(
      blendId,
      (flags & GfxDrawFlag.MASK_WRITE) !== 0,
      pickView !== null,
    );
    const vertices = this.meshVertices[meshId];
    const indices = this.meshIndices[meshId];
    if (
      !vertices ||
      !indices ||
      !nodes ||
      variant < 0 ||
      indexCount === 0 ||
      nodeCount === 0 ||
      firstIndex + indexCount > this.meshIndexCount[meshId] ||
      (firstNode + nodeCount) * GFX_NODE_BYTES > nodes.size
    ) {
      return;
    }
    const pipeline = this.pipeline(GFX_KIND_MESH, variant);
    const group = this.uvGroup;
    if (!pipeline || !group) return;
    const textured = (flags & GfxDrawFlag.TEXTURED) !== 0 && pickView === null;
    this.uvOffset[0] = textured ? this.uvSlot(ctx, reader) : 0;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, view);
    pass.setBindGroup(
      1,
      textured ? ctx.getTexture(texId).bindGroup : ctx.whiteTexture.bindGroup,
    );
    pass.setBindGroup(2, this.uvGroup!, this.uvOffset);
    pass.setVertexBuffer(0, vertices);
    pass.setVertexBuffer(1, nodes);
    pass.setIndexBuffer(indices, this.meshWide[meshId] ? 'uint32' : 'uint16');
    pass.drawIndexed(indexCount, nodeCount, firstIndex, 0, firstNode);
  }

  /**
   * Writes the draw's uv matrix (the reader sits on it) to the next uniform
   * slot and returns its byte offset; a matrix equal to the previous slot's
   * reuses it.
   */
  private uvSlot(ctx: CoreContext, reader: CommandReader): number {
    const data = this.uvData;
    let same = this.uvCursor > 1;
    for (let i = 0; i < 6; i++) {
      // vec4 ad, vec4 t: [a, b, c, d, tx, ty, 0, 0]
      const value = reader.f32();
      if (data[i] !== value) {
        data[i] = value;
        same = false;
      }
    }
    if (same) return (this.uvCursor - 1) * UV_STRIDE;
    if (this.uvCursor >= this.uvSlots) {
      // Earlier draws of this frame still read the old buffer: it is
      // destroyed after the submit.
      if (this.uvBuffer) this.retired.push(this.uvBuffer);
      this.uvBuffer = null;
      this.allocUv(ctx, this.uvSlots * 2);
    }
    const offset = this.uvCursor++ * UV_STRIDE;
    ctx.backend.writeBuffer(this.uvBuffer!, offset, data, 0, UV_BYTES);
    return offset;
  }

  private allocUv(ctx: CoreContext, slots: number): void {
    this.uvBuffer?.destroy();
    this.uvSlots = slots;
    this.uvBuffer = ctx.backend.createBuffer({
      label: 'cozygpu.graphics.uv',
      size: slots * UV_STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.uvGroup = ctx.backend.createBindGroup({
      label: 'cozygpu.graphics.uv',
      layout: this.uvLayout!,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uvBuffer, offset: 0, size: UV_BYTES },
        },
      ],
    });
  }

  endFrame(_frame: CoreFrameState): void {
    this.uvCursor = 1;
    const retired = this.retired;
    for (let i = 0; i < retired.length; i++) retired[i].destroy();
    retired.length = 0;
  }

  destroy(): void {
    this.epoch++;
    const lists = [
      this.shapes,
      this.nodes,
      this.meshVertices,
      this.meshIndices,
      this.retired,
    ];
    for (let l = 0; l < lists.length; l++) {
      const list = lists[l];
      for (let i = 0; i < list.length; i++) list[i]?.destroy();
      list.length = 0;
    }
    for (let i = 0; i < this.pipelines.length; i++) {
      this.pipelines[i]?.destroy();
    }
    for (let i = 0; i < this.modules.length; i++) this.modules[i]?.destroy();
    this.pipelines.fill(null);
    this.requested.fill(0);
    this.modules.length = 0;
    this.uvBuffer?.destroy();
    this.uvBuffer = null;
    this.uvGroup = null;
    this.sharedSource.length = 0;
    this.sharedViews.length = 0;
    this.ctx = null;
  }
}

export function createGraphicsCoreSystem(): CoreSystem {
  return new GraphicsCoreSystem();
}
