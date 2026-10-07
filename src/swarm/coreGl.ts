/**
 * WebGL2 swarm core (ARCHITECTURE §14.2). DOM-free.
 * Selected by `createSwarmCoreSystem` when the backend has transform feedback
 * but no compute.
 *
 * Per swarm: two hot vertex buffers (ping-pong `src`/`dst`, capacity × 40),
 * one cold vertex buffer (capacity × 16), std140 uniform buffers for frames
 * (4096 B), draw (32 B), params, an arena of dynamic-offset entries (stride
 * 256) for SpawnParams / SwarmSim, and a pick uniform when pickable.
 *
 * WebGL executes immediately, so ops run in stream order inside `compute`:
 *  - SPAWN: two feedback runs over gl_VertexID ∈ [first, first + count):
 *    hot records into `src`, cold records into `cold`.
 *  - KILL_RANGE / KILL_LIST: zero the records (`life` word for lists) in BOTH
 *    hot buffers, so a later step never resurrects a stale copy.
 *  - WRITE_HOT: into both hot buffers; WRITE_COLD: into cold.
 *  - STEP: feedback `src` + `cold` → `dst` over [0, activeCount), then swap;
 *    substeps alternate.
 * DRAW is an instanced draw of `src` + `cold`. Readbacks read `src`;
 * aliveCount() counts `life > 0` on this thread.
 *
 * Ceiling: SWARM_GL_MAX_CAPACITY objects (front and core refuse more); the
 * per-frame cost is a feedback run over every active slot.
 */
import { BufferUsage, ShaderStage } from '../backend/types';
import type {
  Backend,
  BindGroupLayoutEntry,
  CommandList,
  FeedbackPass,
  RenderPass,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiFeedbackPipeline,
  RhiRenderPipeline,
  RhiShaderModule,
  VertexBufferLayout,
} from '../backend/types';
import { Op, OpcodeRange, ReadbackSource } from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import type { CoreContext, CoreFrameState } from '../types/core';
import { CozyGPUError } from '../types/errors';
import type { CozyGPUErrorCode } from '../types/errors';
import {
  PICK_TARGET_FORMAT,
  SWARM_COLD_BYTES,
  SWARM_CURVE_BYTES,
  SWARM_DRAW_BYTES,
  SWARM_HOT_BYTES,
  SWARM_SIM_BYTES,
  SWARM_SPAWN_BYTES,
} from '../types/layouts';
import {
  BLEND_MODES,
  SWARM_GL_FRAMES_BYTES,
  SWARM_GL_MAX_FRAMES,
  SWARM_GL_ZERO_CHUNK,
  SWARM_PICK_UNIFORM_BYTES,
  SWARM_QUAD_VERTICES,
  SWARM_UNIFORM_STRIDE,
  SwarmReadbackKind,
} from './constants';
import type { SwarmCoreSystem } from './core';
import {
  glslStage,
  OP_KILL_LIST,
  OP_KILL_RANGE,
  OP_SPAWN,
  OP_STEP,
  OP_WRITE_COLD,
  OP_WRITE_HOT,
  OpQueue,
  SPAWN_WORDS,
} from './opQueue';
import { SWARM_GL_MAX_CAPACITY } from './types';

const STRIDE_WORDS = SWARM_UNIFORM_STRIDE / 4;
/** Byte offset of `life` inside a hot record. */
const HOT_LIFE_OFFSET = 36;

const hotAttributes = (
  stepMode: 'vertex' | 'instance',
): VertexBufferLayout => ({
  stride: SWARM_HOT_BYTES,
  stepMode,
  attributes: [
    { location: 0, format: 'float32x4', offset: 0 },
    { location: 1, format: 'float32x4', offset: 16 },
    { location: 2, format: 'float32x2', offset: 32 },
  ],
});
const coldAttributes = (
  stepMode: 'vertex' | 'instance',
): VertexBufferLayout => ({
  stride: SWARM_COLD_BYTES,
  stepMode,
  attributes: [
    { location: 3, format: 'uint32', offset: 0 },
    { location: 4, format: 'uint32', offset: 4 },
    { location: 5, format: 'uint32', offset: 8 },
    { location: 6, format: 'uint32', offset: 12 },
  ],
});
const HOT_VARYINGS = ['h0', 'h1', 'h2'];
const COLD_VARYINGS = ['c0'];

interface GlProgram {
  readonly computeSrc: string;
  readonly renderSrc: string;
  readonly renderFlags: number;
  readonly blendModeId: number;
  readonly texId: number;
  readonly paramsBytes: number;
  paramsBuffer: RhiBuffer;
  step: RhiFeedbackPipeline | null;
  spawnHot: RhiFeedbackPipeline | null;
  spawnCold: RhiFeedbackPipeline | null;
  render: RhiRenderPipeline | null;
  pick: RhiRenderPipeline | null;
  pickBuilding: boolean;
  ready: boolean;
  groupsVersion: number;
  stepGroup: RhiBindGroup | null;
  spawnGroup: RhiBindGroup | null;
  renderGroup: RhiBindGroup | null;
  pickGroup: RhiBindGroup | null;
}

interface GlSwarm {
  readonly id: number;
  readonly capacity: number;
  readonly hot: [RhiBuffer, RhiBuffer];
  /** Index of the current hot buffer in `hot`. */
  src: number;
  readonly cold: RhiBuffer;
  readonly frames: RhiBuffer;
  readonly draw: RhiBuffer;
  /** Over-life curves (SWARM_SET_CURVES, 64 B); zeroed until one arrives. */
  readonly curves: RhiBuffer;
  arena: RhiBuffer;
  arenaEntries: number;
  pickBuffer: RhiBuffer | null;
  pickId: number;
  /**
   * M2.5: an external source was set. WebGL2 has none (the front refuses
   * `setSource` there): the swarm draws nothing until it is cleared.
   */
  external: boolean;
  resourceVersion: number;
  active: GlProgram | null;
  pending: GlProgram | null;
  readonly ops: OpQueue;
  drawCount: number;
  destroyed: boolean;
}

export function createGlSwarmCore(): SwarmCoreSystem {
  let ctx: CoreContext | null = null;
  let backend: Backend | null = null;
  let epoch = 0;

  const swarms = new Map<number, GlSwarm>();
  const list: GlSwarm[] = [];
  const refused = new Map<number, CozyGPUErrorCode>();

  let emptyLayout: RhiBindGroupLayout | null = null;
  let emptyGroup: RhiBindGroup | null = null;
  let stepLayout: RhiBindGroupLayout | null = null;
  let spawnLayout: RhiBindGroupLayout | null = null;
  let renderLayout: RhiBindGroupLayout | null = null;
  let pickLayout: RhiBindGroupLayout | null = null;

  let arenaU8 = new Uint8Array(SWARM_UNIFORM_STRIDE * 8);
  let arenaU32 = new Uint32Array(arenaU8.buffer);
  let arenaF32 = new Float32Array(arenaU8.buffer);
  const dynOffset = new Uint32Array(1);
  const drawU8 = new Uint8Array(SWARM_DRAW_BYTES);
  const drawF32 = new Float32Array(drawU8.buffer);
  const drawU32 = new Uint32Array(drawU8.buffer);
  const smallU8 = new Uint8Array(16);
  const smallU32 = new Uint32Array(smallU8.buffer);
  const zeros = new Uint8Array(SWARM_GL_ZERO_CHUNK * SWARM_HOT_BYTES);

  const uniform = (
    binding: number,
    size: number,
    hasDynamicOffset = false,
  ): BindGroupLayoutEntry => ({
    binding,
    visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
    type: { kind: 'uniform', hasDynamicOffset, minBindingSize: size },
  });

  function createLayouts(b: Backend): void {
    emptyLayout = b.createBindGroupLayout({
      label: 'swarm.empty',
      entries: [],
    });
    emptyGroup = b.createBindGroup({
      label: 'swarm.empty',
      layout: emptyLayout,
      entries: [],
    });
    stepLayout = b.createBindGroupLayout({
      label: 'swarm.gl.step',
      entries: [uniform(2, SWARM_SIM_BYTES, true), uniform(3, 0)],
    });
    spawnLayout = b.createBindGroupLayout({
      label: 'swarm.gl.spawn',
      entries: [uniform(5, SWARM_SPAWN_BYTES, true)],
    });
    renderLayout = b.createBindGroupLayout({
      label: 'swarm.gl.render',
      entries: [
        uniform(2, SWARM_GL_FRAMES_BYTES),
        uniform(3, SWARM_DRAW_BYTES),
        uniform(6, SWARM_CURVE_BYTES),
      ],
    });
    pickLayout = b.createBindGroupLayout({
      label: 'swarm.gl.pick',
      entries: [
        uniform(2, SWARM_GL_FRAMES_BYTES),
        uniform(3, SWARM_DRAW_BYTES),
        uniform(5, SWARM_PICK_UNIFORM_BYTES),
        uniform(6, SWARM_CURVE_BYTES),
      ],
    });
  }

  function postError(code: string, message: string): void {
    ctx?.post({ type: 'error', code, message });
  }

  function unreadable(id: number): CozyGPUError {
    const code = refused.get(id);
    return code
      ? new CozyGPUError(
          code,
          `swarm ${id} was refused or disabled by the core (${code})`,
        )
      : new CozyGPUError('INVALID_ARGUMENT', `swarm ${id} does not exist`);
  }

  // ─── buffers & groups ─────────────────────────────────────────────────────

  function ensureArena(s: GlSwarm, entries: number): void {
    const bytes = entries * SWARM_UNIFORM_STRIDE;
    if (bytes > arenaU8.byteLength) {
      let size = arenaU8.byteLength * 2;
      while (size < bytes) size *= 2;
      arenaU8 = new Uint8Array(size);
      arenaU32 = new Uint32Array(arenaU8.buffer);
      arenaF32 = new Float32Array(arenaU8.buffer);
    }
    if (entries <= s.arenaEntries) return;
    let n = s.arenaEntries * 2;
    while (n < entries) n *= 2;
    s.arena.destroy();
    s.arena = backend!.createBuffer({
      label: `swarm${s.id}.arena`,
      size: n * SWARM_UNIFORM_STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    s.arenaEntries = n;
    s.resourceVersion++;
  }

  function ensureGroups(s: GlSwarm, p: GlProgram): void {
    if (p.groupsVersion === s.resourceVersion) return;
    const b = backend!;
    p.groupsVersion = s.resourceVersion;
    p.stepGroup = b.createBindGroup({
      label: `swarm${s.id}.gl.step`,
      layout: stepLayout!,
      entries: [
        {
          binding: 2,
          resource: { buffer: s.arena, offset: 0, size: SWARM_SIM_BYTES },
        },
        { binding: 3, resource: { buffer: p.paramsBuffer } },
      ],
    });
    p.spawnGroup = b.createBindGroup({
      label: `swarm${s.id}.gl.spawn`,
      layout: spawnLayout!,
      entries: [
        {
          binding: 5,
          resource: { buffer: s.arena, offset: 0, size: SWARM_SPAWN_BYTES },
        },
      ],
    });
    p.renderGroup = b.createBindGroup({
      label: `swarm${s.id}.gl.render`,
      layout: renderLayout!,
      entries: [
        { binding: 2, resource: { buffer: s.frames } },
        { binding: 3, resource: { buffer: s.draw } },
        { binding: 6, resource: { buffer: s.curves } },
      ],
    });
    p.pickGroup = s.pickBuffer
      ? b.createBindGroup({
          label: `swarm${s.id}.gl.pick`,
          layout: pickLayout!,
          entries: [
            { binding: 2, resource: { buffer: s.frames } },
            { binding: 3, resource: { buffer: s.draw } },
            { binding: 5, resource: { buffer: s.pickBuffer } },
            { binding: 6, resource: { buffer: s.curves } },
          ],
        })
      : null;
  }

  // ─── programs ─────────────────────────────────────────────────────────────

  function stage(src: string, name: string): string {
    const text = glslStage(src, name);
    if (!text) {
      throw new CozyGPUError(
        'SHADER_COMPILE',
        `swarm GLSL program is missing the "${name}" stage (was it composed ` +
          "with language 'glsl300es'?)",
      );
    }
    return text;
  }

  function startProgram(
    s: GlSwarm,
    reader: CommandReader,
    texId: number,
    blendModeId: number,
    renderFlags: number,
    paramsBytes: number,
  ): void {
    const computeBytes = reader.u32();
    const renderBytes = reader.u32();
    // reader.utf8 copies out of a SharedArrayBuffer ring slot first;
    // TextDecoder refuses shared views (§17). Rare command, so the copy is free.
    const computeSrc = reader.utf8(computeBytes);
    const renderSrc = reader.utf8(renderBytes);
    const b = backend!;
    const base = s.pending ?? s.active;
    const share =
      base !== null &&
      base.computeSrc === computeSrc &&
      base.paramsBytes === paramsBytes;
    const program: GlProgram = {
      computeSrc,
      renderSrc,
      renderFlags,
      blendModeId,
      texId,
      paramsBytes,
      paramsBuffer: share
        ? base.paramsBuffer
        : b.createBuffer({
            label: `swarm${s.id}.params`,
            size: Math.max(16, (paramsBytes + 15) & ~15),
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
          }),
      step: share ? base.step : null,
      spawnHot: share ? base.spawnHot : null,
      spawnCold: share ? base.spawnCold : null,
      render: null,
      pick: null,
      pickBuilding: false,
      ready: false,
      groupsVersion: -1,
      stepGroup: null,
      spawnGroup: null,
      renderGroup: null,
      pickGroup: null,
    };
    const superseded = s.pending;
    if (
      superseded &&
      superseded.paramsBuffer !== program.paramsBuffer &&
      superseded.paramsBuffer !== s.active?.paramsBuffer
    ) {
      superseded.paramsBuffer.destroy();
    }
    s.pending = program;
    const started = epoch;
    buildProgram(s, program, share && base.step !== null).then(
      () => {
        if (started !== epoch || s.destroyed || s.pending !== program) return;
        const old = s.active;
        s.active = program;
        s.pending = null;
        program.ready = true;
        if (old && old.paramsBuffer !== program.paramsBuffer) {
          old.paramsBuffer.destroy();
        }
      },
      (error: unknown) => {
        if (started !== epoch) return;
        postError(
          'SHADER_COMPILE',
          `swarm ${s.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (s.pending === program) {
          s.pending = null;
          if (program.paramsBuffer !== s.active?.paramsBuffer) {
            program.paramsBuffer.destroy();
          }
        }
      },
    );
  }

  async function buildProgram(
    s: GlSwarm,
    p: GlProgram,
    reuseFeedback: boolean,
  ): Promise<void> {
    const b = backend!;
    const c = ctx!;
    const vertex = stage(p.renderSrc, 'vertex');
    const renderModule: RhiShaderModule = b.createShaderModule({
      label: `swarm${s.id}.gl.render`,
      glsl: { vertex, fragment: stage(p.renderSrc, 'fragment') },
    });
    const renderPromise = b.createRenderPipeline({
      label: `swarm${s.id}.gl.render`,
      shader: renderModule,
      bindGroupLayouts: [c.viewLayout, c.textureLayout, renderLayout!],
      vertexBuffers: [hotAttributes('instance'), coldAttributes('instance')],
      topology: 'triangle-strip',
      blend: BLEND_MODES[p.blendModeId] ?? 'normal',
      sampleCount: c.sampleCount,
    });
    if (s.pickId !== 0) buildPick(s, p);
    if (!reuseFeedback) {
      const feedback = (
        name: string,
        layout: RhiBindGroupLayout,
        inputs: VertexBufferLayout[],
        varyings: string[],
      ): Promise<RhiFeedbackPipeline> =>
        b.createFeedbackPipeline({
          label: `swarm${s.id}.gl.${name}`,
          shader: b.createShaderModule({
            label: `swarm${s.id}.gl.${name}`,
            glsl: { vertex: stage(p.computeSrc, name) },
          }),
          bindGroupLayouts: [c.viewLayout, emptyLayout!, layout],
          vertexBuffers: inputs,
          varyings,
        });
      const [step, spawnHot, spawnCold] = await Promise.all([
        feedback(
          'step',
          stepLayout!,
          [hotAttributes('vertex'), coldAttributes('vertex')],
          HOT_VARYINGS,
        ),
        feedback('spawn', spawnLayout!, [], HOT_VARYINGS),
        feedback('spawnCold', spawnLayout!, [], COLD_VARYINGS),
      ]);
      p.step = step;
      p.spawnHot = spawnHot;
      p.spawnCold = spawnCold;
    }
    p.render = await renderPromise;
  }

  function buildPick(s: GlSwarm, p: GlProgram): void {
    if (p.pick || p.pickBuilding) return;
    p.pickBuilding = true;
    const b = backend!;
    const c = ctx!;
    const started = epoch;
    let pending: Promise<RhiRenderPipeline>;
    try {
      pending = b.createRenderPipeline({
        label: `swarm${s.id}.gl.pick`,
        shader: b.createShaderModule({
          label: `swarm${s.id}.gl.pick`,
          glsl: {
            vertex: stage(p.renderSrc, 'vertex'),
            fragment: stage(p.renderSrc, 'pickFragment'),
          },
        }),
        bindGroupLayouts: [c.viewLayout, c.textureLayout, pickLayout!],
        vertexBuffers: [hotAttributes('instance'), coldAttributes('instance')],
        topology: 'triangle-strip',
        colorFormat: PICK_TARGET_FORMAT,
        blend: 'none',
        sampleCount: 1,
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      pipeline => {
        if (started === epoch && !s.destroyed) p.pick = pipeline;
      },
      (error: unknown) => {
        if (started !== epoch) return;
        postError(
          'SHADER_COMPILE',
          `swarm ${s.id} pick: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  function destroySwarm(s: GlSwarm): void {
    s.destroyed = true;
    s.hot[0].destroy();
    s.hot[1].destroy();
    s.cold.destroy();
    s.frames.destroy();
    s.draw.destroy();
    s.curves.destroy();
    s.arena.destroy();
    s.pickBuffer?.destroy();
    const params = s.active?.paramsBuffer;
    params?.destroy();
    if (s.pending && s.pending.paramsBuffer !== params) {
      s.pending.paramsBuffer.destroy();
    }
    swarms.delete(s.id);
    const index = list.indexOf(s);
    if (index >= 0) list.splice(index, 1);
  }

  function createSwarm(reader: CommandReader): void {
    const b = backend!;
    const id = reader.u32();
    const capacity = reader.u32();
    const texId = reader.u32();
    const blendModeId = reader.u32();
    const renderFlags = reader.u32();
    const paramsBytes = reader.u32();

    const existing = swarms.get(id);
    if (existing) destroySwarm(existing);
    refused.delete(id);

    const hotBytes = capacity * SWARM_HOT_BYTES;
    if (
      capacity <= 0 ||
      capacity > SWARM_GL_MAX_CAPACITY ||
      hotBytes > b.caps.maxBufferSize
    ) {
      refused.set(id, 'OUT_OF_CAPACITY');
      postError(
        'OUT_OF_CAPACITY',
        `Swarm ${id}: capacity ${capacity} exceeds the WebGL2 limit ` +
          `(${SWARM_GL_MAX_CAPACITY} objects, ${b.caps.maxBufferSize} B per buffer)`,
      );
      return;
    }
    const hotUsage =
      BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.COPY_SRC;
    const s: GlSwarm = {
      id,
      capacity,
      hot: [
        b.createBuffer({
          label: `swarm${id}.hotA`,
          size: hotBytes,
          usage: hotUsage,
        }),
        b.createBuffer({
          label: `swarm${id}.hotB`,
          size: hotBytes,
          usage: hotUsage,
        }),
      ],
      src: 0,
      cold: b.createBuffer({
        label: `swarm${id}.cold`,
        size: capacity * SWARM_COLD_BYTES,
        usage: hotUsage,
      }),
      frames: b.createBuffer({
        label: `swarm${id}.frames`,
        size: SWARM_GL_FRAMES_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
      draw: b.createBuffer({
        label: `swarm${id}.draw`,
        size: SWARM_DRAW_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
      curves: b.createBuffer({
        label: `swarm${id}.curves`,
        size: SWARM_CURVE_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
      arena: b.createBuffer({
        label: `swarm${id}.arena`,
        size: 4 * SWARM_UNIFORM_STRIDE,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
      arenaEntries: 4,
      pickBuffer: null,
      pickId: 0,
      external: false,
      resourceVersion: 0,
      active: null,
      pending: null,
      ops: new OpQueue(),
      drawCount: 0,
      destroyed: false,
    };
    // Default frame table: one frame covering the whole texture.
    smallU32[0] = 1;
    smallU32[1] = 0;
    smallU32[2] = 0;
    smallU32[3] = 0;
    b.writeBuffer(s.frames, 0, smallU8, 0, 16);
    const f32 = new Float32Array(smallU8.buffer);
    f32[0] = 0;
    f32[1] = 0;
    f32[2] = 1;
    f32[3] = 1;
    b.writeBuffer(s.frames, 16, smallU8, 0, 16);
    swarms.set(id, s);
    list.push(s);
    startProgram(s, reader, texId, blendModeId, renderFlags, paramsBytes);
  }

  function setFrames(s: GlSwarm, reader: CommandReader): void {
    const count = reader.u32();
    if (count === 0) return;
    const at = reader.blob(count * 16);
    const n = Math.min(count, SWARM_GL_MAX_FRAMES);
    smallU32[0] = n;
    smallU32[1] = 0;
    smallU32[2] = 0;
    smallU32[3] = 0;
    backend!.writeBuffer(s.frames, 0, smallU8, 0, 16);
    backend!.writeBuffer(s.frames, 16, reader.u8, at, n * 16);
  }

  function setPick(s: GlSwarm, pickId: number): void {
    s.pickId = pickId;
    if (pickId === 0) return;
    if (!s.pickBuffer) {
      s.pickBuffer = backend!.createBuffer({
        label: `swarm${s.id}.pick`,
        size: SWARM_PICK_UNIFORM_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      s.resourceVersion++;
    }
    smallU32[0] = pickId;
    smallU32[1] = 0;
    smallU32[2] = 0;
    smallU32[3] = 0;
    backend!.writeBuffer(s.pickBuffer, 0, smallU8, 0, SWARM_PICK_UNIFORM_BYTES);
    if (s.active) buildPick(s, s.active);
    if (s.pending) buildPick(s, s.pending);
  }

  // ─── compute (feedback) ───────────────────────────────────────────────────

  let pass: FeedbackPass | null = null;
  let passList: CommandList | null = null;

  function beginPass(): FeedbackPass {
    if (!pass) pass = passList!.beginFeedbackPass('swarm');
    return pass;
  }

  /** Buffer writes happen outside feedback passes. */
  function endPass(): void {
    if (pass) {
      pass.end();
      pass = null;
    }
  }

  function bindGroups(
    p: FeedbackPass,
    pipeline: RhiFeedbackPipeline,
    group: RhiBindGroup,
    entry: number,
  ): void {
    p.setPipeline(pipeline);
    p.setBindGroup(0, ctx!.viewBindGroup);
    p.setBindGroup(1, emptyGroup!);
    dynOffset[0] = entry * SWARM_UNIFORM_STRIDE;
    p.setBindGroup(2, group, dynOffset);
  }

  /** Zeroes hot records [first, first + count) in both hot buffers. */
  function killRange(s: GlSwarm, first: number, count: number): void {
    const b = backend!;
    let at = first;
    const end = Math.min(first + count, s.capacity);
    while (at < end) {
      const n = Math.min(end - at, SWARM_GL_ZERO_CHUNK);
      b.writeBuffer(
        s.hot[0],
        at * SWARM_HOT_BYTES,
        zeros,
        0,
        n * SWARM_HOT_BYTES,
      );
      b.writeBuffer(
        s.hot[1],
        at * SWARM_HOT_BYTES,
        zeros,
        0,
        n * SWARM_HOT_BYTES,
      );
      at += n;
    }
  }

  function computeSwarm(s: GlSwarm, frame: CoreFrameState): void {
    const prog = s.active;
    const ops = s.ops;
    if (ops.length === 0) return;
    if (!prog || !prog.ready) {
      if (!prog && !s.pending) ops.length = 0;
      else ops.retainFrom(0);
      return;
    }
    const u32 = ops.u32;

    // 1. arena entries (SpawnParams / SwarmSim), uploaded before any run
    let entries = 0;
    for (let k = 0; k < ops.length; k += ops.sizeAt(k)) {
      if (u32[k] === OP_SPAWN) entries++;
      else if (u32[k] === OP_STEP) entries += Math.max(1, u32[k + 2]);
    }
    if (entries > 0) ensureArena(s, entries);
    ensureGroups(s, prog);
    let e = 0;
    for (let k = 0; k < ops.length; k += ops.sizeAt(k)) {
      const op = u32[k];
      if (op === OP_SPAWN) {
        const base = e * STRIDE_WORDS;
        for (let j = 0; j < SPAWN_WORDS; j++)
          arenaU32[base + j] = u32[k + 1 + j];
        e++;
      } else if (op === OP_STEP) {
        const substeps = Math.max(1, u32[k + 2]);
        const n = Math.min(u32[k + 3], s.capacity);
        const dt = ops.f32[k + 1] / substeps;
        for (let sub = 0; sub < substeps; sub++) {
          const w = (e + sub) * STRIDE_WORDS;
          arenaF32[w] = dt;
          arenaF32[w + 1] = frame.time;
          arenaU32[w + 2] = n;
          arenaU32[w + 3] = sub;
        }
        e += substeps;
      }
    }
    const b = backend!;
    if (e > 0) b.writeBuffer(s.arena, 0, arenaU8, 0, e * SWARM_UNIFORM_STRIDE);

    // 2. execute in stream order
    e = 0;
    for (let k = 0; k < ops.length; k += ops.sizeAt(k)) {
      const op = u32[k];
      if (op === OP_SPAWN) {
        const first = u32[k + 1];
        const n = Math.min(u32[k + 2], s.capacity - first);
        if (n > 0) {
          const p = beginPass();
          bindGroups(p, prog.spawnHot!, prog.spawnGroup!, e);
          p.run(s.hot[s.src], first * SWARM_HOT_BYTES, first, n);
          bindGroups(p, prog.spawnCold!, prog.spawnGroup!, e);
          p.run(s.cold, first * SWARM_COLD_BYTES, first, n);
        }
        e++;
      } else if (op === OP_STEP) {
        const substeps = Math.max(1, u32[k + 2]);
        const n = Math.min(u32[k + 3], s.capacity);
        s.drawCount = n;
        for (let sub = 0; sub < substeps; sub++) {
          if (n > 0) {
            const p = beginPass();
            bindGroups(p, prog.step!, prog.stepGroup!, e + sub);
            p.setVertexBuffer(0, s.hot[s.src], 0);
            p.setVertexBuffer(1, s.cold, 0);
            p.run(s.hot[1 - s.src], 0, 0, n);
            s.src = 1 - s.src;
          }
        }
        e += substeps;
      } else if (op === OP_KILL_RANGE) {
        endPass();
        killRange(s, u32[k + 1], u32[k + 2]);
      } else if (op === OP_KILL_LIST) {
        endPass();
        const n = u32[k + 1];
        for (let j = 0; j < n; j++) {
          const i = u32[k + 2 + j];
          if (i >= s.capacity) continue;
          const at = i * SWARM_HOT_BYTES + HOT_LIFE_OFFSET;
          b.writeBuffer(s.hot[0], at, zeros, 0, 4);
          b.writeBuffer(s.hot[1], at, zeros, 0, 4);
        }
      } else if (op === OP_WRITE_HOT) {
        endPass();
        const bytes = u32[k + 2] * SWARM_HOT_BYTES;
        const at = u32[k + 1] * SWARM_HOT_BYTES;
        b.writeBuffer(s.hot[0], at, ops.u8, (k + 3) * 4, bytes);
        b.writeBuffer(s.hot[1], at, ops.u8, (k + 3) * 4, bytes);
      } else if (op === OP_WRITE_COLD) {
        endPass();
        const bytes = u32[k + 2] * SWARM_COLD_BYTES;
        b.writeBuffer(
          s.cold,
          u32[k + 1] * SWARM_COLD_BYTES,
          ops.u8,
          (k + 3) * 4,
          bytes,
        );
      }
    }
    ops.length = 0;
  }

  function readDraw(reader: CommandReader): GlSwarm | null {
    const s = swarms.get(reader.u32());
    if (!s) return null;
    for (let k = 0; k < 7; k++) drawF32[k] = reader.f32();
    s.drawCount = Math.min(reader.u32(), s.capacity);
    return s;
  }

  function issueDraw(s: GlSwarm, renderPass: RenderPass): void {
    renderPass.setVertexBuffer(0, s.hot[s.src], 0);
    renderPass.setVertexBuffer(1, s.cold, 0);
    renderPass.draw(SWARM_QUAD_VERTICES, s.drawCount, 0, 0);
  }

  // ─── system ───────────────────────────────────────────────────────────────

  const system: SwarmCoreSystem = {
    name: 'swarm',
    range: OpcodeRange.SWARM,

    async init(context: CoreContext): Promise<void> {
      ctx = context;
      backend = context.backend;
      createLayouts(context.backend);
    },

    execute(reader: CommandReader): void {
      if (!backend) return;
      const opcode = reader.opcode;
      if (opcode === Op.SWARM_CREATE) {
        createSwarm(reader);
        return;
      }
      const id = reader.u32();
      const s = swarms.get(id);
      if (!s) {
        if (opcode === Op.SWARM_DESTROY) refused.delete(id);
        return;
      }
      const ops = s.ops;
      switch (opcode) {
        case Op.SWARM_DESTROY:
          destroySwarm(s);
          break;
        case Op.SWARM_SET_PIPELINE: {
          const texId = reader.u32();
          const blendModeId = reader.u32();
          const renderFlags = reader.u32();
          const paramsBytes = reader.u32();
          startProgram(s, reader, texId, blendModeId, renderFlags, paramsBytes);
          break;
        }
        case Op.SWARM_WRITE_HOT:
        case Op.SWARM_WRITE_COLD: {
          const hot = opcode === Op.SWARM_WRITE_HOT;
          const recordBytes = hot ? SWARM_HOT_BYTES : SWARM_COLD_BYTES;
          const first = reader.u32();
          const count = reader.u32();
          const at = reader.blob(count * recordBytes);
          if (first >= s.capacity) break;
          const n = Math.min(count, s.capacity - first);
          if (n <= 0) break;
          const w = ops.reserve(3 + (n * recordBytes) / 4);
          ops.u32[w] = hot ? OP_WRITE_HOT : OP_WRITE_COLD;
          ops.u32[w + 1] = first;
          ops.u32[w + 2] = n;
          ops.u8.set(reader.u8.subarray(at, at + n * recordBytes), (w + 3) * 4);
          break;
        }
        case Op.SWARM_SPAWN: {
          const at = reader.blob(SWARM_SPAWN_BYTES) >> 2;
          const src = reader.u32View;
          const first = src[at];
          if (first >= s.capacity) break;
          const w = ops.reserve(1 + SPAWN_WORDS);
          ops.u32[w] = OP_SPAWN;
          for (let j = 0; j < SPAWN_WORDS; j++)
            ops.u32[w + 1 + j] = src[at + j];
          ops.u32[w + 2] = Math.min(src[at + 1], s.capacity - first);
          break;
        }
        case Op.SWARM_KILL_RANGE: {
          const first = reader.u32();
          const count = reader.u32();
          if (first >= s.capacity) break;
          const w = ops.reserve(3);
          ops.u32[w] = OP_KILL_RANGE;
          ops.u32[w + 1] = first;
          ops.u32[w + 2] = Math.min(count, s.capacity - first);
          break;
        }
        case Op.SWARM_KILL_LIST: {
          const n = reader.u32();
          const at = reader.blob(n * 4) >> 2;
          const w = ops.reserve(2 + n);
          ops.u32[w] = OP_KILL_LIST;
          ops.u32[w + 1] = n;
          const src = reader.u32View;
          for (let j = 0; j < n; j++) ops.u32[w + 2 + j] = src[at + j];
          break;
        }
        case Op.SWARM_SET_PARAMS: {
          const byteOffset = reader.u32();
          const byteLength = reader.u32();
          const at = reader.blob(byteLength);
          const p = s.pending ?? s.active;
          if (!p) break;
          const size = p.paramsBuffer.size;
          if (byteOffset >= size) break;
          backend.writeBuffer(
            p.paramsBuffer,
            byteOffset,
            reader.u8,
            at,
            Math.min(byteLength, size - byteOffset) & ~3,
          );
          break;
        }
        case Op.SWARM_STEP: {
          const dt = reader.f32();
          const substeps = reader.u32();
          const count = reader.u32();
          const w = ops.reserve(4);
          ops.u32[w] = OP_STEP;
          ops.f32[w + 1] = dt;
          ops.u32[w + 2] = Math.min(Math.max(1, substeps), 64);
          ops.u32[w + 3] = count;
          break;
        }
        case Op.SWARM_SET_FRAMES:
          setFrames(s, reader);
          break;
        case Op.SWARM_SET_CURVES:
          backend.writeBuffer(
            s.curves,
            0,
            reader.u8,
            reader.blob(SWARM_CURVE_BYTES),
            SWARM_CURVE_BYTES,
          );
          break;
        case Op.SWARM_SET_PICK:
          setPick(s, reader.u32());
          break;
        case Op.SWARM_SET_SOURCE:
          // The front refuses setSource on WebGL2 (UNSUPPORTED).
          s.external = reader.u32() !== 0;
          break;
        default:
          break;
      }
    },

    compute(commandList: CommandList, frame: CoreFrameState): void {
      if (!backend || list.length === 0) return;
      passList = commandList;
      for (let i = 0; i < list.length; i++) computeSwarm(list[i], frame);
      endPass();
      passList = null;
    },

    draw(reader: CommandReader, renderPass: RenderPass): void {
      if (!backend || reader.opcode !== Op.SWARM_DRAW) return;
      const s = readDraw(reader);
      if (!s) return;
      const prog = s.active;
      if (!prog || !prog.ready || !prog.render || s.drawCount === 0) return;
      if (s.external) return;
      drawU32[7] = prog.renderFlags;
      backend.writeBuffer(s.draw, 0, drawU8, 0, SWARM_DRAW_BYTES);
      ensureGroups(s, prog);
      const c = ctx!;
      renderPass.setPipeline(prog.render);
      renderPass.setBindGroup(0, c.viewBindGroup);
      renderPass.setBindGroup(1, c.getTexture(prog.texId).bindGroup);
      renderPass.setBindGroup(2, prog.renderGroup!);
      issueDraw(s, renderPass);
    },

    drawPick(
      reader: CommandReader,
      renderPass: RenderPass,
      _frame: CoreFrameState,
      view: RhiBindGroup,
    ): void {
      if (!backend || reader.opcode !== Op.SWARM_DRAW) return;
      const s = readDraw(reader);
      if (!s || s.pickId === 0 || s.drawCount === 0 || s.external) return;
      const prog = s.active;
      if (!prog || !prog.ready) return;
      if (!prog.pick) {
        buildPick(s, prog);
        return;
      }
      drawU32[7] = prog.renderFlags;
      backend.writeBuffer(s.draw, 0, drawU8, 0, SWARM_DRAW_BYTES);
      ensureGroups(s, prog);
      if (!prog.pickGroup) return;
      renderPass.setPipeline(prog.pick);
      renderPass.setBindGroup(0, view);
      renderPass.setBindGroup(1, ctx!.getTexture(prog.texId).bindGroup);
      renderPass.setBindGroup(2, prog.pickGroup);
      issueDraw(s, renderPass);
    },

    async restore(context: CoreContext): Promise<void> {
      epoch++;
      swarms.clear();
      list.length = 0;
      refused.clear();
      ctx = context;
      backend = context.backend;
      createLayouts(context.backend);
    },

    destroy(): void {
      epoch++;
      for (let i = list.length - 1; i >= 0; i--) destroySwarm(list[i]);
      refused.clear();
      ctx = null;
      backend = null;
    },

    readback(
      srcKind: number,
      srcId: number,
      first: number,
      count: number,
    ): Promise<ArrayBuffer> | undefined {
      if (
        srcKind !== SwarmReadbackKind.HOT &&
        srcKind !== SwarmReadbackKind.COLD &&
        srcKind !== ReadbackSource.SWARM_ALIVE
      ) {
        return undefined;
      }
      if (!backend) {
        return Promise.reject(
          new CozyGPUError('DESTROYED', 'swarm core was destroyed'),
        );
      }
      const s = swarms.get(srcId);
      if (!s) return Promise.reject(unreadable(srcId));
      if (srcKind === ReadbackSource.SWARM_ALIVE) {
        const n = Math.min(count, s.capacity);
        if (n <= 0) return Promise.resolve(new Uint32Array(1).buffer);
        return backend
          .readBuffer(s.hot[s.src], 0, n * SWARM_HOT_BYTES)
          .then(data => {
            const f32 = new Float32Array(data);
            let alive = 0;
            for (let i = 9; i < f32.length; i += 10) if (f32[i] > 0) alive++;
            const out = new Uint32Array(1);
            out[0] = alive;
            return out.buffer;
          });
      }
      const recordBytes =
        srcKind === SwarmReadbackKind.HOT ? SWARM_HOT_BYTES : SWARM_COLD_BYTES;
      const start = Math.min(first, s.capacity);
      const n = Math.min(count, s.capacity - start);
      return backend.readBuffer(
        srcKind === SwarmReadbackKind.HOT ? s.hot[s.src] : s.cold,
        start * recordBytes,
        n * recordBytes,
      );
    },

    readbackBuffer(srcKind: number, swarmId: number): RhiBuffer | undefined {
      const s = swarms.get(swarmId);
      if (!s) return undefined;
      if (srcKind === SwarmReadbackKind.HOT) return s.hot[s.src];
      if (srcKind === SwarmReadbackKind.COLD) return s.cold;
      return undefined;
    },
  };
  return system;
}
