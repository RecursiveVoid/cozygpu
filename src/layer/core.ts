/**
 * SpriteLayer core system (M5, ARCHITECTURE §28.3), range
 * `OpcodeRange.SPRITE_LAYER` (0x08), chunk `layer-core`, lazy in both modes.
 * DOM-free: it runs in the worker in worker mode.
 *
 * Per layer: one GPU buffer per stream (WebGPU STORAGE, pulled by
 * instance index; WebGL2 VERTEX, read as instanced attributes), the frame
 * table (WebGPU storage; WebGL2 an rgba32uint data texture, two texels per
 * frame), the slot bind group (≤ 8 textures + their samplers) and, with
 * culling, the visible-index list, the per-workgroup counts and the
 * indirect arguments. Draw parameters (affine, alpha, pick id) go to a
 * 256-byte slot of a shared uniform ring bound with a dynamic offset.
 *
 * Pipelines are built async per (stream mask, blend) plus a pick variant
 * per mask; a draw whose pipeline is not ready is skipped. The core keeps
 * no CPU copy of any stream: after a device loss `restore` drops every
 * layer and the front re-creates and re-uploads (new generation).
 */
import { BufferUsage, ShaderStage, TextureUsage } from '../backend/types';
import type {
  BindGroupLayoutEntry,
  BlendMode,
  CommandList,
  RenderPass,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiComputePipeline,
  RhiRenderPipeline,
  RhiResource,
  RhiSampler,
  RhiShaderModule,
  RhiTexture,
  VertexBufferLayout,
  VertexFormat,
} from '../backend/types';
import { OpcodeRange } from '../commands/opcodes';
import { LayerDrawFlag, LayerFlag, LayerOp } from '../commands/layerOpcodes';
import type { CommandReader } from '../commands/types';
import type {
  CoreContext,
  CoreFrameState,
  CoreSystem,
  CoreTexture,
} from '../types/core';
import { PICK_TARGET_FORMAT } from '../types/layouts';
import {
  CULL_WORKGROUP,
  F_ANCHOR,
  F_HEIGHT,
  F_WIDTH,
  FRAME_BYTES,
  INDIRECT_BYTES,
  MAX_TEXTURES,
  STREAM_BYTES,
  VISIBLE_BYTES,
} from './format';

/** WebGL2 attribute format per LayerStream (location = stream index). */
const FORMATS: VertexFormat[] = ['float32x2', 'uint16x4', 'unorm8x4', 'uint32'];
const DEFINES = ['', 'XFORM', 'COLOR', 'USER'];
/** Index = BlendModeId; the pick variant follows. */
const BLENDS: BlendMode[] = ['normal', 'add', 'multiply', 'screen', 'none'];
const PICK = 5;
const VARIANTS = 6;
/** Stream masks with POSITION set: (mask >> 1) in 0..7. */
const MASKS = 8;
/** Pipeline cache: render (mask, variant), then cull (mask, entry). */
const CULL_BASE = MASKS * VARIANTS;
const CULL_ENTRIES = ['cs_count', 'cs_scan', 'cs_scatter'];
/** Uniform ring: slot stride (dynamic offset alignment) and bytes used. */
const SLOT = 256;
const SLOT_BYTES = 48;
/** Frames per data-texture row (WebGL2); two rgba32uint texels each. */
const FRAMES_PER_ROW = 1024;
const MAX_GROUPS_X = 65535;
const DUMMY_BYTES = 16;
/** Layer.buf: streams 0–3, then the cull outputs and the frame table. */
const VISIBLE = 4;
const COUNTS = 5;
const ARGS = 6;
const FRAMES = 7;

/** Shader sources for the backend's language, loaded once per process. */
let wgslSources: Promise<readonly string[]> | null = null;
let glslSources: Promise<readonly string[]> | null = null;

type BufferEntry = { binding: number; resource: { buffer: RhiBuffer } };

class Layer {
  capacity = 0;
  streams = 0;
  blend = 0;
  /** Own GPU buffers (see VISIBLE … FRAMES). */
  readonly buf: (RhiBuffer | null)[] = [];
  framesTexture: RhiTexture | null = null;
  /** External ids: streams 0–3, then the indirect source. */
  readonly ext = new Uint32Array(5);
  /** Stream buffers bound last (own or external), indirect source last. */
  readonly bound: (RhiBuffer | null)[] = [];
  /** Largest distance from a frame's anchor to its corners, px. */
  radius = 0;
  readonly tex = new Uint32Array(MAX_TEXTURES);
  texCount = 0;
  readonly texUsed: (CoreTexture | null)[] = [];
  texGroup: RhiBindGroup | null = null;
  /** WebGPU: the stream storage group; WebGL2: the frame table group. */
  group: RhiBindGroup | null = null;
  cullGroup: RhiBindGroup | null = null;
  /** Frame whose LAYER_CULL was queued (draws use the visible list then). */
  cullFrame = -1;

  /** Destroys buf[from, to). */
  free(from: number, to: number): void {
    for (let i = from; i < to; i++) {
      this.buf[i]?.destroy();
      this.buf[i] = null;
    }
    this.group = this.cullGroup = null;
  }
}

export class SpriteLayerCoreSystem implements CoreSystem {
  readonly name = 'layer';
  readonly range = OpcodeRange.SPRITE_LAYER;

  private ctx: CoreContext | null = null;
  private gl = false;
  /** Bumped on restore/destroy so late promises are dropped. */
  private epoch = 0;
  private sources: readonly string[] | null = null;
  private readonly layers: (Layer | undefined)[] = [];

  private dataLayout: RhiBindGroupLayout | null = null;
  private texLayout: RhiBindGroupLayout | null = null;
  private uniLayout: RhiBindGroupLayout | null = null;
  private cullLayout: RhiBindGroupLayout | null = null;
  private dummy: RhiBuffer | null = null;
  private frameSampler: RhiSampler | null = null;

  private readonly modules: (RhiShaderModule | null)[] = [];
  /** Packed, fixed length: the per-draw lookup never allocates. */
  private readonly pipes: (RhiResource | null)[] = Array.from(
    { length: CULL_BASE + MASKS * 3 },
    () => null,
  );
  private readonly requested = new Uint8Array(CULL_BASE + MASKS * 3);

  // Uniform ring with a CPU mirror (growth re-uploads the frame's slots).
  private uni: RhiBuffer | null = null;
  private uniGroup: RhiBindGroup | null = null;
  private slots = 0;
  private cursor = 0;
  private f32 = new Float32Array(0);
  private u32 = new Uint32Array(0);
  private readonly offset = new Uint32Array(1);
  private readonly retired: RhiBuffer[] = [];

  /** Culls queued this frame: (layer id, slot offset, workgroups) triples. */
  private readonly culls: number[] = [];
  private cullCount = 0;
  /** Views of the registered shared buffers, by sharedId. */
  private readonly sharedViews: (Uint8Array | undefined)[] = [];

  /** Set by resolve(): present-stream mask and the rows every stream holds. */
  private mask = 0;
  private limit = 0;

  async init(ctx: CoreContext): Promise<void> {
    await this.build(ctx);
  }

  async restore(ctx: CoreContext): Promise<void> {
    // Every GPU object belonged to the lost device: dropped, not destroyed.
    this.layers.length = 0;
    this.retired.length = 0;
    this.cullCount = 0;
    this.uni = null;
    await this.build(ctx);
  }

  private async build(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    const epoch = ++this.epoch;
    const backend = ctx.backend;
    const gl = (this.gl = backend.caps.shaderLanguage !== 'wgsl');
    this.modules.length = 0;
    this.pipes.fill(null);
    this.requested.fill(0);
    const V = ShaderStage.VERTEX;
    const C = ShaderStage.COMPUTE;
    const F = ShaderStage.FRAGMENT;
    const data: BindGroupLayoutEntry[] = [];
    const cull: BindGroupLayoutEntry[] = [];
    const tex: BindGroupLayoutEntry[] = [];
    if (gl) {
      data.push(
        {
          binding: 0,
          visibility: V,
          type: { kind: 'texture', sampleType: 'uint' },
        },
        {
          binding: 1,
          visibility: V,
          type: { kind: 'sampler', filtering: false },
        },
      );
      this.frameSampler = backend.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest',
        mipmapFilter: 'nearest',
      });
    } else {
      for (let b = 0; b < 6; b++) {
        data.push({
          binding: b,
          visibility: V,
          type: { kind: 'storage', readOnly: true },
        });
        cull.push({
          binding: b,
          visibility: C,
          type: { kind: 'storage', readOnly: b < 3 },
        });
      }
      this.dummy = backend.createBuffer({
        size: DUMMY_BYTES,
        usage: BufferUsage.STORAGE,
      });
      this.cullLayout = backend.createBindGroupLayout({ entries: cull });
    }
    for (let i = 0; i < MAX_TEXTURES; i++) {
      tex.push(
        { binding: 2 * i, visibility: F, type: { kind: 'texture' } },
        { binding: 2 * i + 1, visibility: F, type: { kind: 'sampler' } },
      );
    }
    this.dataLayout = backend.createBindGroupLayout({ entries: data });
    this.texLayout = backend.createBindGroupLayout({ entries: tex });
    this.uniLayout = backend.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: V | F | (gl ? 0 : C),
          type: {
            kind: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: SLOT_BYTES,
          },
        },
      ],
    });
    this.slots = this.cursor = 0;
    this.grow(64);
    const sources = await (gl
      ? (glslSources ??= import('./shadersGLSL').then(m => m.glsl))
      : (wgslSources ??= import('./shadersWGSL').then(m => m.wgsl)));
    if (epoch === this.epoch) this.sources = sources;
  }

  // ── pipelines ──────────────────────────────────────────────────────────────

  private module(
    m: number,
    pick: number,
    cull: number,
  ): RhiShaderModule | null {
    const src = this.sources;
    const ctx = this.ctx;
    if (!src || !ctx) return null;
    // WGSL: one render and one cull module per mask; GLSL: per (mask, pick).
    const index = cull ? MASKS * 2 + m : m * 2 + (this.gl ? pick : 0);
    if (this.modules[index]) return this.modules[index]!;
    let defs = pick ? '#define PICK\n' : '';
    for (let k = 1; k < 4; k++) {
      if ((m << 1) & (1 << k)) defs += `#define ${DEFINES[k]}\n`;
    }
    const add = (s: string) => s.replace('\n', `\n${defs}`);
    return (this.modules[index] = ctx.backend.createShaderModule({
      wgsl: this.gl
        ? undefined
        : `const STREAMS=${(m << 1) | 1}u;\n${src[cull]}`,
      glsl: this.gl
        ? { vertex: add(src[0]), fragment: add(src[1]) }
        : undefined,
    }));
  }

  /**
   * Pipeline `index` (render: mask × VARIANTS + variant; cull: CULL_BASE +
   * mask × 3 + entry), or null while it compiles; the first call starts it.
   */
  private pipe<T extends RhiResource>(index: number): T | null {
    if (this.requested[index] === 0) this.request(index);
    return this.pipes[index] as T | null;
  }

  /** Kept apart from pipe(): its closures would allocate on every call. */
  private request(index: number): void {
    const ctx = this.ctx;
    const cull = index >= CULL_BASE ? 1 : 0;
    const m = cull ? ((index - CULL_BASE) / 3) | 0 : (index / VARIANTS) | 0;
    const variant = index - m * VARIANTS;
    const pick = !cull && variant === PICK ? 1 : 0;
    const shader = this.module(m, pick, cull);
    if (!ctx || !shader) return;
    this.requested[index] = 1;
    const backend = ctx.backend;
    if (pick && !backend.caps.integerRenderTargets) return;
    const epoch = this.epoch;
    let promise: Promise<RhiResource>;
    if (cull) {
      promise = backend.createComputePipeline({
        shader,
        entry: CULL_ENTRIES[index - CULL_BASE - m * 3],
        bindGroupLayouts: [ctx.viewLayout, this.cullLayout!, this.uniLayout!],
      });
    } else {
      // The pick variant is built with the mask's first pipeline, so a pick
      // never reads back a pass that skipped this layer (§16.3).
      if (!pick) this.pipe(m * VARIANTS + PICK);
      else ctx.pickPipelinePending?.(1);
      const layouts: VertexBufferLayout[] = [];
      for (let k = 0; this.gl && k < 4; k++) {
        if (((m << 1) | 1) & (1 << k)) {
          layouts.push({
            stride: STREAM_BYTES[k],
            stepMode: 'instance',
            attributes: [{ location: k, format: FORMATS[k], offset: 0 }],
          });
        }
      }
      promise = backend.createRenderPipeline({
        shader,
        fragmentEntry: pick ? 'fs_pick' : 'fs_main',
        bindGroupLayouts: [
          ctx.viewLayout,
          this.dataLayout!,
          this.texLayout!,
          this.uniLayout!,
        ],
        vertexBuffers: layouts,
        topology: 'triangle-strip',
        colorFormat: pick ? PICK_TARGET_FORMAT : undefined,
        blend: pick ? 'none' : BLENDS[variant],
        sampleCount: pick ? 1 : ctx.sampleCount,
      });
    }
    promise.then(
      p => {
        if (pick) ctx.pickPipelinePending?.(-1);
        if (epoch === this.epoch) this.pipes[index] = p;
        else p.destroy();
      },
      (err: unknown) => {
        if (pick) ctx.pickPipelinePending?.(-1);
        // No retry (it would fail every frame): these draws stay skipped.
        if (epoch === this.epoch) {
          ctx.post({
            type: 'error',
            code: 'INTERNAL',
            message: `layer pipeline: ${(err as Error)?.message ?? String(err)}`,
          });
        }
      },
    );
  }

  // ── uniform ring ───────────────────────────────────────────────────────────

  private grow(slots: number): void {
    const backend = this.ctx!.backend;
    const f32 = new Float32Array((slots * SLOT) >> 2);
    f32.set(this.f32);
    this.f32 = f32;
    this.u32 = new Uint32Array(f32.buffer);
    // Draws already recorded this frame keep reading the old buffer: it is
    // destroyed after the submit.
    if (this.uni) this.retired.push(this.uni);
    const uni = (this.uni = backend.createBuffer({
      label: 'cozygpu.layer.draw',
      size: slots * SLOT,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    }));
    this.slots = slots;
    this.uniGroup = backend.createBindGroup({
      layout: this.uniLayout!,
      entries: [
        { binding: 0, resource: { buffer: uni, offset: 0, size: SLOT_BYTES } },
      ],
    });
    // Slots written earlier this frame (cull parameters) move along.
    if (this.cursor > 0)
      backend.writeBuffer(uni, 0, f32, 0, this.cursor * SLOT);
  }

  /** Next slot's word index in the mirror. */
  private slot(): number {
    if (this.cursor >= this.slots) this.grow(this.slots * 2);
    return (this.cursor++ * SLOT) >> 2;
  }

  /** Uploads the slot at word `w` and sets `offset` for its bind. */
  private commit(w: number): void {
    const at = w << 2;
    this.offset[0] = at;
    this.ctx!.backend.writeBuffer(this.uni!, at, this.f32, at, SLOT_BYTES);
  }

  // ── commands ───────────────────────────────────────────────────────────────

  execute(reader: CommandReader, frame: CoreFrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const backend = ctx.backend;
    const op = reader.opcode;
    const id = reader.u32();
    let L = this.layers[id];
    const buffer = (i: number, size: number, usage: number) =>
      (L!.buf[i] = backend.createBuffer({
        label: `cozygpu.layer#${id}.${i}`,
        size: Math.max(size, DUMMY_BYTES),
        usage,
      }));
    if (op === LayerOp.LAYER_CREATE) {
      const capacity = reader.u32();
      const streams = reader.u32() | 1;
      const flags = reader.u32();
      if (!L) L = this.layers[id] = new Layer();
      L.blend = reader.u32();
      if (capacity !== L.capacity || streams !== L.streams) {
        // Same capacity and streams: the streams (and their contents) stay.
        L.free(0, ARGS + 1);
        L.capacity = capacity;
        L.streams = streams;
        for (let k = 0; k < 4; k++) {
          if (streams & (1 << k)) {
            buffer(
              k,
              capacity * STREAM_BYTES[k],
              (this.gl ? BufferUsage.VERTEX : BufferUsage.STORAGE) |
                BufferUsage.COPY_DST,
            );
          }
        }
      }
      const caps = backend.caps;
      if (
        !((flags & LayerFlag.CULL) !== 0 && caps.compute && caps.indirectDraw)
      ) {
        L.free(VISIBLE, ARGS + 1);
      } else if (!L.buf[VISIBLE]) {
        const S = BufferUsage.STORAGE;
        buffer(VISIBLE, capacity * VISIBLE_BYTES, S);
        buffer(COUNTS, (Math.ceil(capacity / CULL_WORKGROUP) + 1) * 4, S);
        buffer(ARGS, INDIRECT_BYTES, S | BufferUsage.INDIRECT);
        L.group = L.cullGroup = null;
      }
      return;
    }
    if (!L) return;
    switch (op) {
      case LayerOp.LAYER_DESTROY:
        this.sweepViews();
        L.free(0, FRAMES + 1);
        L.framesTexture?.destroy();
        this.layers[id] = undefined;
        return;
      case LayerOp.LAYER_UPLOAD:
      case LayerOp.LAYER_UPLOAD_SHARED: {
        const k = reader.u32() & 3;
        const first = reader.u32();
        const count = reader.u32();
        const stride = STREAM_BYTES[k];
        const bytes = count * stride;
        const dst = first * stride;
        const target = L.buf[k];
        let src: Uint8Array | null = reader.u8;
        let at: number;
        if (op === LayerOp.LAYER_UPLOAD) {
          at = reader.blob(bytes);
        } else {
          src = this.shared(reader.u32());
          // byteOffset locates row 0 of the store or column.
          at = reader.u32() + dst;
          if (src && at + bytes > src.byteLength) src = null;
        }
        if (target && src && bytes > 0 && dst + bytes <= target.size) {
          backend.writeBuffer(target, dst, src, at, bytes);
        }
        return;
      }
      case LayerOp.LAYER_SET_FRAMES: {
        const count = reader.u32();
        const bytes = count * FRAME_BYTES;
        const at = reader.blob(bytes);
        if (count === 0) return;
        const f = reader.f32View;
        let radius = 0;
        for (let i = 0, w = at >> 2; i < count; i++, w += FRAME_BYTES >> 2) {
          const anchor = reader.u32View[w + (F_ANCHOR >> 2)];
          const ax = (anchor & 0xffff) / 0xffff;
          const ay = (anchor >>> 16) / 0xffff;
          radius = Math.max(
            radius,
            Math.hypot(
              Math.max(ax, 1 - ax) * f[w + (F_WIDTH >> 2)],
              Math.max(ay, 1 - ay) * f[w + (F_HEIGHT >> 2)],
            ),
          );
        }
        L.radius = radius;
        if (this.gl) {
          const cols = Math.min(count, FRAMES_PER_ROW);
          const rows = Math.ceil(count / cols);
          let t = L.framesTexture;
          if (!t || t.width !== cols * 2 || t.height !== rows) {
            t?.destroy();
            t = L.framesTexture = backend.createTexture({
              width: cols * 2,
              height: rows,
              format: 'rgba32uint',
              usage: TextureUsage.SAMPLED | TextureUsage.COPY_DST,
            });
            L.group = null;
          }
          for (let r = 0; r < rows; r++) {
            const n = Math.min(cols, count - r * cols);
            const from = at + r * cols * FRAME_BYTES;
            backend.writeTexture(
              t,
              reader.u8.subarray(from, from + n * FRAME_BYTES),
              0,
              r,
              n * 2,
              1,
            );
          }
        } else {
          if ((L.buf[FRAMES]?.size ?? 0) < bytes) {
            L.free(FRAMES, FRAMES + 1);
            buffer(FRAMES, bytes, BufferUsage.STORAGE | BufferUsage.COPY_DST);
          }
          backend.writeBuffer(L.buf[FRAMES]!, 0, reader.u8, at, bytes);
        }
        return;
      }
      case LayerOp.LAYER_SET_TEXTURES: {
        const n = Math.min(reader.u32(), MAX_TEXTURES);
        for (let i = 0; i < n; i++) L.tex[i] = reader.u32();
        L.texCount = n;
        L.texGroup = null;
        return;
      }
      case LayerOp.LAYER_SET_SOURCE:
        for (let k = 0; k < 5; k++) L.ext[k] = reader.u32();
        return;
      case LayerOp.LAYER_CULL: {
        let count = reader.u32();
        if (!L.buf[VISIBLE] || !this.resolve(L)) return;
        count = Math.min(count, this.limit);
        const base = CULL_BASE + (this.mask >> 1) * 3;
        // All three entries requested every time until each is built.
        let ready = count > 0;
        for (let e = 0; e < 3; e++) if (!this.pipe(base + e)) ready = false;
        if (!ready) return;
        const w = this.slot();
        const f = this.f32;
        for (let i = 0; i < 7; i++) f[w + i] = reader.f32();
        const groups = Math.ceil(count / CULL_WORKGROUP);
        this.u32[w + 7] = count;
        f[w + 8] = L.radius;
        this.u32[w + 9] = Math.min(groups, MAX_GROUPS_X);
        this.commit(w);
        if (!L.cullGroup) {
          const entries = this.bind(L);
          for (let b = VISIBLE; b <= ARGS; b++) {
            entries.push({ binding: b - 1, resource: { buffer: L.buf[b]! } });
          }
          entries.splice(3, 1);
          L.cullGroup = backend.createBindGroup({
            layout: this.cullLayout!,
            entries,
          });
        }
        const n = 3 * this.cullCount++;
        this.culls[n] = id;
        this.culls[n + 1] = w << 2;
        this.culls[n + 2] = groups;
        L.cullFrame = frame.frameId;
        return;
      }
      default:
        return;
    }
  }

  /**
   * Resolves the layer's stream buffers (own or external) into `bound`,
   * dropping the bind groups when one changed. Sets `mask` (streams
   * present) and `limit` (rows every stream holds). False when a stream's
   * external buffer is gone (released, device loss) or POSITION is missing.
   */
  private resolve(L: Layer): boolean {
    let mask = 0;
    let limit = 0x7fffffff;
    for (let k = 0; k < 5; k++) {
      let b = k < 4 ? (L.buf[k] ?? null) : null;
      const id = L.ext[k];
      if (id !== 0) {
        b = this.ctx!.getExternalBuffer?.(id) ?? null;
        if (!b) return false;
      }
      if (b !== L.bound[k]) {
        L.bound[k] = b;
        L.group = L.cullGroup = null;
      }
      if (b && k < 4) {
        mask |= 1 << k;
        limit = Math.min(limit, Math.floor(b.size / STREAM_BYTES[k]));
      }
    }
    this.mask = mask;
    this.limit = limit;
    return (mask & 1) !== 0;
  }

  /** Storage entries 0–3 of the WebGPU groups (absent streams: a dummy). */
  private bind(L: Layer): BufferEntry[] {
    const out: BufferEntry[] = [];
    for (let k = 0; k < 4; k++) {
      out.push({ binding: k, resource: { buffer: L.bound[k] ?? this.dummy! } });
    }
    return out;
  }

  /** The slot bind group, rebuilt when a texture id or core texture changed. */
  private textures(L: Layer): RhiBindGroup {
    const ctx = this.ctx!;
    let stale = L.texGroup === null;
    for (let i = 0; i < MAX_TEXTURES; i++) {
      const t = i < L.texCount ? ctx.getTexture(L.tex[i]) : ctx.whiteTexture;
      if (L.texUsed[i] !== t) {
        L.texUsed[i] = t;
        stale = true;
      }
    }
    if (stale) {
      const entries = [];
      for (let i = 0; i < MAX_TEXTURES; i++) {
        const t = L.texUsed[i]!;
        entries.push(
          { binding: 2 * i, resource: { texture: t.texture } },
          { binding: 2 * i + 1, resource: { sampler: t.sampler } },
        );
      }
      L.texGroup = ctx.backend.createBindGroup({
        layout: this.texLayout!,
        entries,
      });
    }
    return L.texGroup!;
  }

  compute(list: CommandList, _frame: CoreFrameState): void {
    const n = this.cullCount;
    if (n === 0) return;
    this.cullCount = 0;
    const pass = list.beginComputePass();
    for (let i = 0; i < 3 * n; i += 3) {
      const L = this.layers[this.culls[i]]!;
      const base = CULL_BASE + ((this.resolve(L) ? this.mask : 1) >> 1) * 3;
      const groups = this.culls[i + 2];
      const x = Math.min(groups, MAX_GROUPS_X);
      const y = Math.ceil(groups / x);
      this.offset[0] = this.culls[i + 1];
      pass.setBindGroup(0, this.ctx!.viewBindGroup);
      pass.setBindGroup(1, L.cullGroup!);
      pass.setBindGroup(2, this.uniGroup!, this.offset);
      for (let e = 0; e < 3; e++) {
        pass.setPipeline(this.pipes[base + e] as RhiComputePipeline);
        if (e === 1) pass.dispatch(1);
        else pass.dispatch(x, y);
      }
    }
    pass.end();
  }

  draw(reader: CommandReader, pass: RenderPass, frame: CoreFrameState): void {
    this.replay(reader, pass, frame, null);
  }

  drawPick(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    view: RhiBindGroup,
  ): void {
    this.replay(reader, pass, frame, view);
  }

  /** One LAYER_DRAW; `pickView` set = the pick pass. */
  private replay(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    pickView: RhiBindGroup | null,
  ): void {
    const ctx = this.ctx;
    const L = this.layers[reader.u32()];
    if (!ctx || !L || !this.resolve(L)) return;
    // a, b, c, d, tx, ty, alpha go straight to the draw's uniform slot.
    const s = this.slot();
    for (let i = 0; i < 7; i++) this.f32[s + i] = reader.f32();
    let count = Math.min(reader.u32(), this.limit);
    const pickId = reader.u32();
    const flags = reader.u32();
    const indirect = flags & LayerDrawFlag.INDIRECT ? L.bound[4] : null;
    if (
      (flags & LayerDrawFlag.INDIRECT && !indirect) ||
      (pickView && !pickId)
    ) {
      count = 0;
    }
    const pipeline = this.pipe<RhiRenderPipeline>(
      (this.mask >> 1) * VARIANTS +
        (pickView ? PICK : L.blend < PICK ? L.blend : 0),
    );
    const gl = this.gl;
    const frames = gl ? L.framesTexture : L.buf[FRAMES];
    if (!pipeline || !frames || count === 0) return;
    let group = L.group;
    if (!group) {
      let entries: { binding: number; resource: object }[];
      if (gl) {
        entries = [
          { binding: 0, resource: { texture: frames } },
          { binding: 1, resource: { sampler: this.frameSampler! } },
        ];
      } else {
        entries = this.bind(L);
        entries.push(
          { binding: 4, resource: { buffer: frames } },
          { binding: 5, resource: { buffer: L.buf[VISIBLE] ?? this.dummy! } },
        );
      }
      group = L.group = ctx.backend.createBindGroup({
        layout: this.dataLayout!,
        entries: entries as BufferEntry[],
      });
    }
    const culled =
      flags & LayerDrawFlag.CULLED &&
      L.cullFrame === frame.frameId &&
      L.buf[ARGS];
    this.u32[s + 7] = pickId;
    this.u32[s + 8] = culled ? 1 : 0;
    this.commit(s);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, pickView ?? ctx.viewBindGroup);
    pass.setBindGroup(1, group);
    pass.setBindGroup(2, this.textures(L));
    pass.setBindGroup(3, this.uniGroup!, this.offset);
    for (let k = 0, slot = 0; gl && k < 4; k++) {
      const b = L.bound[k];
      if (b) pass.setVertexBuffer(slot++, b);
    }
    if (culled) pass.drawIndirect(L.buf[ARGS]!, 0);
    else if (indirect) pass.drawIndirect(indirect, 0);
    else pass.draw(4, count, 0, 0);
  }

  /** Cached per sharedId; rebuilt only when the registered buffer changes. */
  private shared(sharedId: number): Uint8Array | null {
    const source = this.ctx!.getShared(sharedId);
    if (!source) return null;
    const view = this.sharedViews[sharedId];
    if (view?.buffer === source) return view;
    // A new registration: the views of released ones go (they would keep
    // the buffers alive).
    this.sweepViews();
    return (this.sharedViews[sharedId] = new Uint8Array(source));
  }

  private sweepViews(): void {
    const views = this.sharedViews;
    for (let i = 0; i < views.length; i++) {
      if (views[i] && this.ctx!.getShared(i) !== views[i]!.buffer) {
        views[i] = undefined;
      }
    }
  }

  endFrame(_frame: CoreFrameState): void {
    this.cursor = this.cullCount = 0;
    const retired = this.retired;
    for (let i = 0; i < retired.length; i++) retired[i].destroy();
    retired.length = 0;
  }

  destroy(): void {
    this.epoch++;
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) {
      layers[i]?.free(0, FRAMES + 1);
      layers[i]?.framesTexture?.destroy();
    }
    layers.length = 0;
    const all = [...this.pipes, ...this.modules, this.uni, this.dummy];
    for (let i = 0; i < all.length; i++) all[i]?.destroy();
    this.endFrame(null!);
    this.uni = null;
    this.ctx = null;
  }
}

export function createSpriteLayerCoreSystem(): CoreSystem {
  return new SpriteLayerCoreSystem();
}
