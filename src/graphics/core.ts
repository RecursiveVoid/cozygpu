/**
 * Graphics core system (ARCHITECTURE §26.5, §27.4), range
 * OpcodeRange.GRAPHICS, chunk `graphics-core`. DOM-free: it runs in the
 * worker in worker mode.
 *
 * Owns the shape-record and node-record buffers, the record pools of the
 * unified batch (item streams, unified mesh vertices, baked sprites), the
 * mesh table (vertex + index buffers per meshId), the transform table and
 * texture slot tables, and three pipeline families (SDF shapes, instanced
 * meshes, unified), each one per blend mode plus the stencil-write and pick
 * variants, WGSL and GLSL alike. Keeps no CPU copies on WebGPU: after a
 * device loss `restore` rebuilds pipelines and the front re-sends
 * everything. On WebGL2 the unified sources are mirrored in data textures
 * (dataTexture.ts).
 *
 *  - Pipelines are created async: the 'normal' and pick variants at `init`
 *    / `restore` (unified, plus shapes on WebGPU without vertex storage and
 *    meshes), every other variant on its first draw. A draw whose pipeline
 *    is not ready is skipped (and reported to the retain core).
 *  - Unified: drawIndexed(count, 1, first) of an item stream bound as a u32
 *    index buffer; records are pulled by the vertex shader (§27.4).
 *  - Shapes (M4 split path): draw(4, count, 0, first) over the shape buffer.
 *  - Meshes: drawIndexed(indexCount, nodeCount, firstIndex, 0, firstNode)
 *    with the mesh as buffer 0 and the node records as buffer 1. A textured
 *    draw binds its uv matrix from a 256-byte slot of a uniform buffer with a
 *    dynamic offset; slots are content-addressed and keep their contents, so
 *    recorded segments stay valid (slot 0 serves untextured draws).
 *  - Retained rendering (§27.3): every GPU object a recorded draw may
 *    reference that is replaced calls `ctx.retain.invalidate()`, every
 *    skipped draw `ctx.retain.skipped()`; each draw binds everything it uses.
 *  - Picking: `drawPick` replays every draw kind with the pick variants;
 *    mask geometry is not pickable.
 */
import { BufferUsage, ShaderStage } from '../backend/types';
import type {
  BindGroupDesc,
  BindGroupLayoutEntry,
  RenderPass,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiRenderPipeline,
  RhiResource,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
  VertexBufferLayout,
} from '../backend/types';
import { OpcodeRange } from '../commands/opcodes';
import { GfxDrawFlag, GfxMeshFlag, GfxOp } from '../commands/gfxOpcodes';
import type { CommandReader } from '../commands/types';
import type {
  CoreContext,
  CoreFrameState,
  CoreSystem,
  CoreTexture,
} from '../types/core';
import { NO_ID } from '../types/ids';
import {
  MASK_STENCIL_FORMAT,
  PICK_TARGET_FORMAT,
  SPRITE_INSTANCE_BYTES,
} from '../types/layouts';
import {
  GFX_ITEM_BYTES,
  GFX_MAX_TEXTURE_SLOTS,
  GFX_MAX_TRANSFORMS,
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GFX_TRANSFORM_BYTES,
  GFX_UVERTEX_BYTES,
} from '../types/gfxLayouts';
import { DataTexture } from './dataTexture';
import {
  GFX_BLEND_MODES,
  GFX_KIND_MESH,
  GFX_KIND_SHAPES,
  GFX_KIND_UNIFIED,
  GFX_MASK_STENCIL,
  GFX_MESH_LAYOUTS,
  GFX_SHAPE_LAYOUT,
  GFX_VARIANT_MASK,
  GFX_VARIANT_PICK,
  GFX_VARIANTS,
  gfxVariant,
} from './pipelines';

const QUAD_VERTICES = 4;
const KINDS = 3;
const PIPELINE_SLOTS = KINDS * GFX_VARIANTS;
/** Dynamic uniform offset alignment (WebGPU minimum): uv and transform slots. */
const SLOT_STRIDE = 256;
const UV_BYTES = 32;
const UV_INITIAL_SLOTS = 16;
/** Distinct uv matrices kept before the table is reset (and segments re-recorded). */
const UV_MAX_SLOTS = 4096;
const KIND_NAMES = ['shape', 'mesh', 'unified'];
const FRAGMENT_ENTRIES = ['fs_main', 'fs_pick', 'fs_mask'];
const DEFINES = ['', 'PICK', 'MASK'];
const NO_LAYOUTS: VertexBufferLayout[] = [];
/** Record bytes per GfxPoolKind (ITEMS, VERTICES, SPRITES). */
const POOL_STRIDE = [GFX_ITEM_BYTES, GFX_UVERTEX_BYTES, SPRITE_INSTANCE_BYTES];
const POOL_NAMES = ['items', 'vertices', 'sprites'];
const POOL_KINDS = 3;
/** Unified sources: shapes, nodes, vertices, sprites. */
const SOURCES = 4;

/** Shader sources for the backend's language, loaded once per process. */
let wgslSources: Promise<readonly string[]> | null = null;
let glslSources: Promise<readonly string[]> | null = null;

/** `#define NAME` after the `#version` line (fragment variants of GLSL). */
function withDefine(source: string, name: string): string {
  return name ? source.replace('\n', `\n#define ${name}\n`) : source;
}

/** FNV-1a over the six matrix words at `at`. */
function uvHash(bits: Uint32Array, at: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < 6; i++) h = Math.imul(h ^ bits[at + i], 0x01000193);
  return h;
}

/** A texture slot table (GFX_SET_TEXTURE_SLOTS) and its bind group. */
class SlotTable {
  readonly texIds = new Uint32Array(GFX_MAX_TEXTURE_SLOTS).fill(NO_ID);
  readonly bound: (CoreTexture | null)[] = [];
  group: RhiBindGroup | null = null;

  constructor() {
    for (let i = 0; i < GFX_MAX_TEXTURE_SLOTS; i++) this.bound.push(null);
  }
}

export class GraphicsCoreSystem implements CoreSystem {
  readonly name = 'graphics';
  readonly range = OpcodeRange.GRAPHICS;

  private ctx: CoreContext | null = null;
  /** Bumped on restore/destroy so late promises are dropped. */
  private epoch = 0;
  /** WebGL2: unified sources are data textures. */
  private gl = false;
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

  /** Index = bufferId. Shape buffers are WebGPU-only (data textures on WebGL2). */
  private readonly shapes: (RhiBuffer | null)[] = [];
  private readonly nodes: (RhiBuffer | null)[] = [];
  private readonly shapeTex: (DataTexture | null)[] = [];
  private readonly nodeTex: (DataTexture | null)[] = [];
  /** [GfxPoolKind][poolId]. Items are index buffers on both backends. */
  private readonly pools: (RhiBuffer | null)[][] = [[], [], []];
  private readonly poolTex: (DataTexture | null)[][] = [[], [], []];
  /** Index = meshId. */
  private readonly meshVertices: (RhiBuffer | null)[] = [];
  private readonly meshIndices: (RhiBuffer | null)[] = [];
  private readonly meshIndexCount: number[] = [];
  private readonly meshWide: boolean[] = [];

  private readonly sharedSource: (ArrayBuffer | SharedArrayBuffer | null)[] =
    [];
  private readonly sharedViews: (Uint8Array | null)[] = [];

  // ── uv slots (textured meshes)
  private uvLayout: RhiBindGroupLayout | null = null;
  private uvBuffer: RhiBuffer | null = null;
  private uvGroup: RhiBindGroup | null = null;
  private uvSlots = 0;
  /** Slots in use (slot 0 is never written). */
  private uvCount = 1;
  /** Open-addressing table: hash → slot + 1. */
  private uvHash = new Int32Array(64);
  private uvData = new Float32Array(UV_INITIAL_SLOTS * 8);
  private readonly uvScratch = new Float32Array(UV_BYTES / 4);
  private readonly uvBits = new Uint32Array(this.uvScratch.buffer);
  private readonly uvOffset = new Uint32Array(1);

  // ── unified batch
  private srcLayout: RhiBindGroupLayout | null = null;
  private slotLayout: RhiBindGroupLayout | null = null;
  private xfLayout: RhiBindGroupLayout | null = null;
  private srcGroup: RhiBindGroup | null = null;
  private readonly srcKey: (RhiResource | null)[] = [null, null, null, null];
  private readonly srcNow: (RhiResource | null)[] = [null, null, null, null];
  /** Stands in for a missing source (WebGPU buffer, WebGL2 texture). */
  private dummy: RhiResource | null = null;
  private nearest: RhiSampler | null = null;
  private readonly slotTables: (SlotTable | null)[] = [];
  private defaultSlots: SlotTable | null = null;
  private xfBuffer: RhiBuffer | null = null;
  private xfGroup: RhiBindGroup | null = null;
  private readonly xfData = new Float32Array(GFX_TRANSFORM_BYTES / 4);
  private readonly xfOffset = new Uint32Array(1);

  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    await this.build(ctx);
  }

  async restore(ctx: CoreContext): Promise<void> {
    // Every GPU object belonged to the lost device: dropped, not destroyed.
    // The front re-allocates and re-uploads on the generation bump.
    this.shapes.length = 0;
    this.nodes.length = 0;
    this.shapeTex.length = 0;
    this.nodeTex.length = 0;
    for (let k = 0; k < POOL_KINDS; k++) {
      this.pools[k].length = 0;
      this.poolTex[k].length = 0;
    }
    this.meshVertices.length = 0;
    this.meshIndices.length = 0;
    this.meshIndexCount.length = 0;
    this.meshWide.length = 0;
    this.sharedSource.length = 0;
    this.sharedViews.length = 0;
    this.slotTables.length = 0;
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
    const gl = (this.gl = backend.caps.shaderLanguage !== 'wgsl');
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
    this.uvCount = 1;
    this.uvHash.fill(0);
    this.allocUv(ctx, UV_INITIAL_SLOTS);
    this.buildUnified(ctx, gl);
    // One language per backend: the other never loads.
    if (!gl) {
      this.wgsl = await (wgslSources ??= import('./shadersWGSL').then(
        m => m.wgsl,
      ));
    } else {
      this.glsl = await (glslSources ??= import('./shadersGLSL').then(
        m => m.glsl,
      ));
    }
    if (epoch !== this.epoch) return;
    // The pipelines nearly every program draws with, and the pick variants:
    // built now. A pick issued while a pick variant still compiles waits for
    // it (ctx.pickPipelinePending).
    const first = gl || backend.caps.vertexStorage ? 1 : 0;
    for (let kind = first; kind < KINDS; kind++) {
      this.pipeline(kind, 0);
      this.pipeline(kind, GFX_VARIANT_PICK);
    }
  }

  /** Layouts, the dummy source, the transform table and the default slots. */
  private buildUnified(ctx: CoreContext, gl: boolean): void {
    const backend = ctx.backend;
    const src: BindGroupLayoutEntry[] = [];
    for (let i = 0; i < SOURCES; i++) {
      if (gl) {
        src.push(
          {
            binding: 2 * i,
            visibility: ShaderStage.VERTEX,
            type: { kind: 'texture', sampleType: 'uint' },
          },
          {
            binding: 2 * i + 1,
            visibility: ShaderStage.VERTEX,
            type: { kind: 'sampler', filtering: false },
          },
        );
      } else {
        src.push({
          binding: i,
          visibility: ShaderStage.VERTEX,
          type: { kind: 'storage', readOnly: true },
        });
      }
    }
    this.srcLayout = backend.createBindGroupLayout({
      label: 'cozygpu.graphics.sources',
      entries: src,
    });
    const slots: BindGroupLayoutEntry[] = [];
    for (let i = 0; i < GFX_MAX_TEXTURE_SLOTS; i++) {
      slots.push({
        binding: gl ? 2 * i : i,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'texture' },
      });
      if (gl) {
        slots.push({
          binding: 2 * i + 1,
          visibility: ShaderStage.FRAGMENT,
          type: { kind: 'sampler' },
        });
      }
    }
    if (!gl) {
      slots.push({
        binding: GFX_MAX_TEXTURE_SLOTS,
        visibility: ShaderStage.FRAGMENT,
        type: { kind: 'sampler' },
      });
    }
    this.slotLayout = backend.createBindGroupLayout({
      label: 'cozygpu.graphics.slots',
      entries: slots,
    });
    this.xfLayout = backend.createBindGroupLayout({
      label: 'cozygpu.graphics.transforms',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX,
          type: {
            kind: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: GFX_TRANSFORM_BYTES,
          },
        },
      ],
    });
    this.nearest = gl
      ? backend.createSampler({
          label: 'cozygpu.graphics.nearest',
          minFilter: 'nearest',
          magFilter: 'nearest',
        })
      : null;
    this.dummy = gl
      ? new DataTexture(backend, 16, 'cozygpu.graphics.none').texture
      : backend.createBuffer({
          label: 'cozygpu.graphics.none',
          size: GFX_SHAPE_BYTES,
          usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
    this.srcGroup = null;
    this.srcKey.fill(null);
    this.xfBuffer = backend.createBuffer({
      label: 'cozygpu.graphics.transforms',
      size: GFX_MAX_TRANSFORMS * SLOT_STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const identity = this.xfData;
    identity.fill(0);
    identity[0] = identity[3] = identity[6] = 1;
    backend.writeBuffer(this.xfBuffer, 0, identity, 0, GFX_TRANSFORM_BYTES);
    this.xfGroup = backend.createBindGroup({
      label: 'cozygpu.graphics.transforms',
      layout: this.xfLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.xfBuffer,
            offset: 0,
            size: GFX_TRANSFORM_BYTES,
          },
        },
      ],
    });
    this.defaultSlots = new SlotTable();
  }

  // ── pipelines ──────────────────────────────────────────────────────────────

  private module(kind: number, fragment: number): RhiShaderModule | null {
    const wgsl = this.wgsl;
    const glsl = this.glsl;
    if (!this.ctx || (!wgsl && !glsl)) return null;
    // WGSL: one module per kind with every entry point; GLSL: one program
    // source per fragment variant, (vertex, fragment) pairs for the mesh and
    // unified kinds (WebGL2 always draws shapes through the unified batch).
    const index = kind * 3 + (wgsl ? 0 : fragment);
    const pair = kind === GFX_KIND_MESH ? 0 : 2;
    return (this.modules[index] ??= this.ctx.backend.createShaderModule({
      label: `cozygpu.graphics.${KIND_NAMES[kind]}`,
      wgsl: wgsl ? wgsl[kind] : undefined,
      glsl: glsl
        ? {
            vertex: glsl[pair],
            fragment: withDefine(glsl[pair + 1], DEFINES[fragment]),
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
    if (
      (pick && !caps.integerRenderTargets) ||
      (mask && !caps.stencil) ||
      (kind === GFX_KIND_SHAPES && this.gl)
    ) {
      // Unsupported on this device: these draws stay skipped.
      this.requested[index] = 1;
      return;
    }
    // Mesh mask geometry needs no discard: every triangle counts.
    const fragment = pick ? 1 : mask && kind !== GFX_KIND_MESH ? 2 : 0;
    const shader = this.module(kind, fragment);
    if (!shader) return;
    this.requested[index] = 1;
    const epoch = this.epoch;
    const mesh = kind === GFX_KIND_MESH;
    const unified = kind === GFX_KIND_UNIFIED;
    // Picks wait for a pick pipeline that is still compiling (§16.3).
    if (pick) ctx.pickPipelinePending?.(1);
    ctx.backend
      .createRenderPipeline({
        label: `cozygpu.graphics.${KIND_NAMES[kind]}.${variant}`,
        shader,
        vertexEntry: 'vs_main',
        fragmentEntry: FRAGMENT_ENTRIES[fragment],
        bindGroupLayouts: unified
          ? [ctx.viewLayout, this.srcLayout!, this.slotLayout!, this.xfLayout!]
          : mesh
            ? [ctx.viewLayout, ctx.textureLayout, this.uvLayout!]
            : [ctx.viewLayout],
        vertexBuffers: unified
          ? NO_LAYOUTS
          : mesh
            ? GFX_MESH_LAYOUTS
            : [GFX_SHAPE_LAYOUT],
        topology: kind === GFX_KIND_SHAPES ? 'triangle-strip' : 'triangle-list',
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
    const gl = this.gl;
    switch (op) {
      case GfxOp.GFX_SHAPE_BUFFER_ALLOC:
      case GfxOp.GFX_NODE_BUFFER_ALLOC: {
        const node = op === GfxOp.GFX_NODE_BUFFER_ALLOC;
        const id = reader.u32();
        const capacity = Math.max(1, reader.u32());
        const stride = node ? GFX_NODE_BYTES : GFX_SHAPE_BYTES;
        const list = node ? this.nodes : this.shapes;
        list[id]?.destroy();
        list[id] = null;
        if (node || !gl) {
          list[id] = ctx.backend.createBuffer({
            label: `cozygpu.graphics.${node ? 'nodes' : 'shapes'}#${id}`,
            size: capacity * stride,
            usage:
              BufferUsage.VERTEX |
              BufferUsage.COPY_DST |
              (gl ? 0 : BufferUsage.STORAGE),
          });
        }
        if (gl) {
          const tex = node ? this.nodeTex : this.shapeTex;
          tex[id]?.destroy();
          tex[id] = new DataTexture(
            ctx.backend,
            capacity * stride,
            `cozygpu.graphics.${node ? 'nodes' : 'shapes'}#${id}`,
          );
        }
        this.replaced();
        return;
      }
      case GfxOp.GFX_SHAPE_BUFFER_DESTROY:
      case GfxOp.GFX_NODE_BUFFER_DESTROY: {
        const node = op === GfxOp.GFX_NODE_BUFFER_DESTROY;
        const id = reader.u32();
        const list = node ? this.nodes : this.shapes;
        list[id]?.destroy();
        list[id] = null;
        const tex = node ? this.nodeTex : this.shapeTex;
        tex[id]?.destroy();
        tex[id] = null;
        this.replaced();
        return;
      }
      case GfxOp.GFX_SHAPE_UPLOAD:
      case GfxOp.GFX_NODE_UPLOAD:
      case GfxOp.GFX_SHAPE_UPLOAD_SHARED:
      case GfxOp.GFX_NODE_UPLOAD_SHARED: {
        const node =
          op === GfxOp.GFX_NODE_UPLOAD || op === GfxOp.GFX_NODE_UPLOAD_SHARED;
        const stride = node ? GFX_NODE_BYTES : GFX_SHAPE_BYTES;
        const id = reader.u32();
        const shared =
          op === GfxOp.GFX_SHAPE_UPLOAD_SHARED ||
          op === GfxOp.GFX_NODE_UPLOAD_SHARED;
        this.upload(
          ctx,
          reader,
          shared,
          stride,
          (node ? this.nodes : this.shapes)[id] ?? null,
          (node ? this.nodeTex : this.shapeTex)[id] ?? null,
        );
        return;
      }
      case GfxOp.GFX_POOL_ALLOC: {
        const kind = reader.u32();
        const id = reader.u32();
        const capacity = Math.max(1, reader.u32());
        if (kind >= POOL_KINDS) return;
        const stride = POOL_STRIDE[kind];
        const label = `cozygpu.graphics.${POOL_NAMES[kind]}#${id}`;
        const list = this.pools[kind];
        list[id]?.destroy();
        list[id] = null;
        const tex = this.poolTex[kind];
        tex[id]?.destroy();
        tex[id] = null;
        if (kind === 0 || !gl) {
          list[id] = ctx.backend.createBuffer({
            label,
            size: (capacity * stride + 3) & ~3,
            usage:
              (kind === 0 ? BufferUsage.INDEX : BufferUsage.STORAGE) |
              BufferUsage.COPY_DST,
          });
        } else {
          tex[id] = new DataTexture(ctx.backend, capacity * stride, label);
        }
        this.replaced();
        return;
      }
      case GfxOp.GFX_POOL_DESTROY: {
        const kind = reader.u32();
        const id = reader.u32();
        if (kind >= POOL_KINDS) return;
        this.pools[kind][id]?.destroy();
        this.pools[kind][id] = null;
        this.poolTex[kind][id]?.destroy();
        this.poolTex[kind][id] = null;
        this.replaced();
        return;
      }
      case GfxOp.GFX_POOL_UPLOAD:
      case GfxOp.GFX_POOL_UPLOAD_SHARED: {
        const kind = reader.u32();
        const id = reader.u32();
        if (kind >= POOL_KINDS) return;
        this.upload(
          ctx,
          reader,
          op === GfxOp.GFX_POOL_UPLOAD_SHARED,
          POOL_STRIDE[kind],
          this.pools[kind][id] ?? null,
          this.poolTex[kind][id] ?? null,
        );
        return;
      }
      case GfxOp.GFX_SET_TRANSFORM: {
        const id = reader.u32();
        const data = this.xfData;
        for (let i = 0; i < 7; i++) data[i] = reader.f32();
        data[7] = 0;
        if (id === 0 || id >= GFX_MAX_TRANSFORMS || !this.xfBuffer) return;
        ctx.backend.writeBuffer(
          this.xfBuffer,
          id * SLOT_STRIDE,
          data,
          0,
          GFX_TRANSFORM_BYTES,
        );
        return;
      }
      case GfxOp.GFX_SET_TEXTURE_SLOTS: {
        const id = reader.u32();
        const count = Math.min(reader.u32(), GFX_MAX_TEXTURE_SLOTS);
        if (id === 0) return;
        if (count === 0) {
          // Released (the static bake was dropped); the id may come back.
          if (id < this.slotTables.length) this.slotTables[id] = null;
          return;
        }
        const table = (this.slotTables[id] ??= new SlotTable());
        table.texIds.fill(NO_ID);
        for (let i = 0; i < count; i++) table.texIds[i] = reader.u32();
        // Rebuilt on its next draw.
        table.bound.fill(null);
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
        this.replaced();
        return;
      }
      default:
        return;
    }
  }

  /**
   * One record upload: u32 first, u32 count, then the bytes (inline) or
   * u32 sharedId, u32 byteOffset (byteOffset locates record 0, as for
   * sprites). Writes the buffer and, on WebGL2, its data texture.
   */
  private upload(
    ctx: CoreContext,
    reader: CommandReader,
    shared: boolean,
    stride: number,
    buffer: RhiBuffer | null,
    tex: DataTexture | null,
  ): void {
    const first = reader.u32();
    const count = reader.u32();
    const bytes = count * stride;
    const dst = first * stride;
    let src: Uint8Array | null = reader.u8;
    let at: number;
    if (!shared) {
      at = reader.blob(bytes);
    } else {
      src = this.sharedView(ctx, reader.u32());
      at = reader.u32() + dst;
      if (src && at + bytes > src.byteLength) src = null;
    }
    if (!src || bytes === 0) return;
    if (buffer && dst + bytes <= buffer.size) {
      // writeBuffer sizes are multiples of 4 (items and records are).
      ctx.backend.writeBuffer(buffer, dst, src, at, bytes);
    }
    if (tex) tex.write(ctx.backend, dst, src, at, bytes);
  }

  /** A GPU object recorded draws may reference was replaced (§27.3). */
  private replaced(): void {
    this.ctx?.retain?.invalidate();
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
    if (buffer) this.replaced();
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

  /** A draw this core was asked for and cannot make (§27.3). */
  private skip(pick: boolean): void {
    if (!pick) this.ctx?.retain?.skipped();
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
    const pick = pickView !== null;
    const opcode = reader.opcode;
    if (opcode === GfxOp.GFX_DRAW_UNIFIED) {
      this.replayUnified(ctx, reader, pass, view, pick);
      return;
    }
    if (opcode === GfxOp.GFX_DRAW_SHAPES) {
      const buffer = this.shapes[reader.u32()];
      const first = reader.u32();
      const count = reader.u32();
      const blendId = reader.u32();
      const flags = reader.u32();
      const variant = gfxVariant(
        blendId,
        (flags & GfxDrawFlag.MASK_WRITE) !== 0,
        pick,
      );
      if (count === 0 || variant < 0) return;
      const pipeline = this.pipeline(GFX_KIND_SHAPES, variant);
      if (
        !buffer ||
        (first + count) * GFX_SHAPE_BYTES > buffer.size ||
        !pipeline
      ) {
        this.skip(pick);
        return;
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, view);
      pass.setVertexBuffer(0, buffer);
      pass.draw(QUAD_VERTICES, count, 0, first);
      return;
    }
    if (opcode !== GfxOp.GFX_DRAW_MESH) return;
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
      pick,
    );
    if (variant < 0 || indexCount === 0 || nodeCount === 0) return;
    const vertices = this.meshVertices[meshId];
    const indices = this.meshIndices[meshId];
    const pipeline = this.pipeline(GFX_KIND_MESH, variant);
    const group = this.uvGroup;
    if (
      !vertices ||
      !indices ||
      !nodes ||
      !pipeline ||
      !group ||
      firstIndex + indexCount > this.meshIndexCount[meshId] ||
      (firstNode + nodeCount) * GFX_NODE_BYTES > nodes.size
    ) {
      this.skip(pick);
      return;
    }
    const textured = (flags & GfxDrawFlag.TEXTURED) !== 0 && !pick;
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

  /** GFX_DRAW_UNIFIED (§27.4). */
  private replayUnified(
    ctx: CoreContext,
    reader: CommandReader,
    pass: RenderPass,
    view: RhiBindGroup,
    pick: boolean,
  ): void {
    const items = this.pools[0][reader.u32()];
    const first = reader.u32();
    const count = reader.u32();
    const shapeId = reader.u32();
    const vertexId = reader.u32();
    const nodeId = reader.u32();
    const spriteId = reader.u32();
    const slotsId = reader.u32();
    const transformId = reader.u32();
    const blendId = reader.u32();
    const flags = reader.u32();
    const variant = gfxVariant(
      blendId,
      (flags & GfxDrawFlag.MASK_WRITE) !== 0,
      pick,
    );
    if (count === 0 || variant < 0) return;
    const pipeline = this.pipeline(GFX_KIND_UNIFIED, variant);
    const sources = this.sources(ctx, shapeId, nodeId, vertexId, spriteId);
    const slots = this.slots(ctx, slotsId);
    if (
      !items ||
      (first + count) * GFX_ITEM_BYTES > items.size ||
      !pipeline ||
      !sources ||
      !slots ||
      transformId >= GFX_MAX_TRANSFORMS
    ) {
      this.skip(pick);
      return;
    }
    this.xfOffset[0] = transformId * SLOT_STRIDE;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, view);
    pass.setBindGroup(1, sources);
    pass.setBindGroup(2, slots);
    pass.setBindGroup(3, this.xfGroup!, this.xfOffset);
    pass.setIndexBuffer(items, 'uint32');
    pass.drawIndexed(count, 1, first, 0, 0);
  }

  /** The source bind group for these ids (rebuilt when a source changed). */
  private sources(
    ctx: CoreContext,
    shapeId: number,
    nodeId: number,
    vertexId: number,
    spriteId: number,
  ): RhiBindGroup | null {
    const now = this.srcNow;
    const dummy = this.dummy;
    if (!dummy || !this.srcLayout) return null;
    if (this.gl) {
      now[0] = this.shapeTex[shapeId]?.texture ?? dummy;
      now[1] = this.nodeTex[nodeId]?.texture ?? dummy;
      now[2] = this.poolTex[1][vertexId]?.texture ?? dummy;
      now[3] = this.poolTex[2][spriteId]?.texture ?? dummy;
    } else {
      now[0] = this.shapes[shapeId] ?? dummy;
      now[1] = this.nodes[nodeId] ?? dummy;
      now[2] = this.pools[1][vertexId] ?? dummy;
      now[3] = this.pools[2][spriteId] ?? dummy;
    }
    const key = this.srcKey;
    if (
      this.srcGroup !== null &&
      key[0] === now[0] &&
      key[1] === now[1] &&
      key[2] === now[2] &&
      key[3] === now[3]
    ) {
      return this.srcGroup;
    }
    if (this.srcGroup !== null) this.replaced();
    key[0] = now[0];
    key[1] = now[1];
    key[2] = now[2];
    key[3] = now[3];
    const entries: BindGroupDesc['entries'] = [];
    for (let i = 0; i < SOURCES; i++) {
      if (this.gl) {
        entries.push(
          { binding: 2 * i, resource: { texture: now[i] as RhiTexture } },
          { binding: 2 * i + 1, resource: { sampler: this.nearest! } },
        );
      } else {
        entries.push({
          binding: i,
          resource: { buffer: now[i] as RhiBuffer },
        });
      }
    }
    this.srcGroup = ctx.backend.createBindGroup({
      label: 'cozygpu.graphics.sources',
      layout: this.srcLayout,
      entries,
    });
    return this.srcGroup;
  }

  /** The bind group of slot table `id` (0: white everywhere). */
  private slots(ctx: CoreContext, id: number): RhiBindGroup | null {
    const table = id === 0 ? this.defaultSlots : this.slotTables[id];
    if (!table || !this.slotLayout) return null;
    let changed = table.group === null;
    for (let i = 0; i < GFX_MAX_TEXTURE_SLOTS; i++) {
      const tex = table.texIds[i];
      const t = tex === NO_ID ? ctx.whiteTexture : ctx.getTexture(tex);
      if (table.bound[i] !== t) {
        table.bound[i] = t;
        changed = true;
      }
    }
    if (!changed) return table.group;
    if (table.group !== null) this.replaced();
    const gl = this.gl;
    const entries: BindGroupDesc['entries'] = [];
    for (let i = 0; i < GFX_MAX_TEXTURE_SLOTS; i++) {
      const t = table.bound[i]!;
      entries.push({
        binding: gl ? 2 * i : i,
        resource: { texture: t.texture },
      });
      if (gl)
        entries.push({ binding: 2 * i + 1, resource: { sampler: t.sampler } });
    }
    if (!gl) {
      entries.push({
        binding: GFX_MAX_TEXTURE_SLOTS,
        resource: { sampler: table.bound[0]!.sampler },
      });
    }
    table.group = ctx.backend.createBindGroup({
      label: 'cozygpu.graphics.slots',
      layout: this.slotLayout,
      entries,
    });
    return table.group;
  }

  /**
   * The uniform slot holding the draw's uv matrix (the reader sits on it),
   * as a byte offset. Slots are content-addressed and never rewritten, so a
   * recorded draw keeps reading its matrix; a new matrix takes a new slot.
   */
  private uvSlot(ctx: CoreContext, reader: CommandReader): number {
    const m = this.uvScratch;
    // vec4 ad, vec4 t: [a, b, c, d, tx, ty, 0, 0]
    for (let i = 0; i < 6; i++) m[i] = reader.f32();
    m[6] = m[7] = 0;
    return this.uvFind(ctx);
  }

  /** Slot of the matrix in `uvScratch` (a new one when it is not there yet). */
  private uvFind(ctx: CoreContext): number {
    const m = this.uvScratch;
    const table = this.uvHash;
    const mask = table.length - 1;
    const data = this.uvData;
    for (
      let probe = uvHash(this.uvBits, 0) & mask;
      ;
      probe = (probe + 1) & mask
    ) {
      const slot = table[probe] - 1;
      if (slot < 0) {
        if (this.uvCount >= UV_MAX_SLOTS) {
          // Too many distinct matrices: start over (recorded draws re-record).
          this.uvCount = 1;
          table.fill(0);
          this.replaced();
          return this.uvFind(ctx);
        }
        const fresh = this.uvCount++;
        if (fresh >= this.uvSlots) this.allocUv(ctx, this.uvSlots * 2);
        this.uvData.set(m, fresh * 8);
        if (this.uvCount * 2 > table.length) this.rehash();
        else table[probe] = fresh + 1;
        ctx.backend.writeBuffer(
          this.uvBuffer!,
          fresh * SLOT_STRIDE,
          m,
          0,
          UV_BYTES,
        );
        return fresh * SLOT_STRIDE;
      }
      const o = slot * 8;
      if (
        data[o] === m[0] &&
        data[o + 1] === m[1] &&
        data[o + 2] === m[2] &&
        data[o + 3] === m[3] &&
        data[o + 4] === m[4] &&
        data[o + 5] === m[5]
      ) {
        return slot * SLOT_STRIDE;
      }
    }
  }

  /** Doubles the uv hash table and re-inserts every slot. */
  private rehash(): void {
    const table = new Int32Array(this.uvHash.length * 2);
    const mask = table.length - 1;
    const bits = new Uint32Array(this.uvData.buffer);
    for (let slot = 1; slot < this.uvCount; slot++) {
      let probe = uvHash(bits, slot * 8) & mask;
      while (table[probe] !== 0) probe = (probe + 1) & mask;
      table[probe] = slot + 1;
    }
    this.uvHash = table;
  }

  /** (Re)creates the uv uniform buffer with `slots` slots, keeping contents. */
  private allocUv(ctx: CoreContext, slots: number): void {
    const old = this.uvBuffer;
    this.uvSlots = slots;
    if (this.uvData.length < slots * 8) {
      const data = new Float32Array(slots * 8);
      data.set(this.uvData);
      this.uvData = data;
    }
    this.uvBuffer = ctx.backend.createBuffer({
      label: 'cozygpu.graphics.uv',
      size: slots * SLOT_STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    // Re-send the slots in use (writes at 256-byte steps).
    for (let s = 1; s < Math.min(this.uvCount, slots); s++) {
      ctx.backend.writeBuffer(
        this.uvBuffer,
        s * SLOT_STRIDE,
        this.uvData,
        s * 8 * 4,
        UV_BYTES,
      );
    }
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
    if (old) {
      old.destroy();
      this.replaced();
    }
  }

  destroy(): void {
    this.epoch++;
    const lists: (RhiBuffer | null)[][] = [
      this.shapes,
      this.nodes,
      this.meshVertices,
      this.meshIndices,
      this.pools[0],
      this.pools[1],
      this.pools[2],
    ];
    for (let l = 0; l < lists.length; l++) {
      const list = lists[l];
      for (let i = 0; i < list.length; i++) list[i]?.destroy();
      list.length = 0;
    }
    const texLists = [
      this.shapeTex,
      this.nodeTex,
      this.poolTex[1],
      this.poolTex[2],
    ];
    for (let l = 0; l < texLists.length; l++) {
      const list = texLists[l];
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
    this.xfBuffer?.destroy();
    this.xfBuffer = null;
    this.xfGroup = null;
    this.dummy?.destroy();
    this.dummy = null;
    this.srcGroup = null;
    this.slotTables.length = 0;
    this.sharedSource.length = 0;
    this.sharedViews.length = 0;
    this.ctx = null;
  }
}

export function createGraphicsCoreSystem(): CoreSystem {
  return new GraphicsCoreSystem();
}
