/**
 * Owner: "swarm". Core-side (render thread) system for opcode range 0x03.
 * DOM-free: runs on the main thread or in the worker.
 *
 * `createSwarmCoreSystem()` picks the implementation from the backend's
 * capabilities at init: compute + vertex storage → the WebGPU core below;
 * transform feedback → the WebGL2 core (./coreGl.ts, ARCHITECTURE §14.2).
 *
 * WebGPU core. Per swarm: hot/cold/frames storage, a draw uniform, a
 * dynamic-offset uniform "arena" (stride 256) holding SpawnParams/kill/SwarmSim
 * entries for this frame, a kill-list storage buffer, a 16-byte counters
 * storage struct (free-list top + alive count), and with culling or
 * allocation 'gpu' a `visible` index buffer + indirect draw args. Allocation
 * 'gpu' adds the free list (capacity × u32, ARCHITECTURE §14.3).
 *
 * Ordering: spawn/kill/step are queued (op queue) and dispatched in the
 * compute phase in stream order. WRITE_HOT/COLD are applied with
 * writeBuffer immediately when nothing is queued; otherwise they are queued
 * too, and a write that follows a dispatch in the same frame is deferred
 * (with everything after it) to the next frame, because all writeBuffer
 * calls land before the frame's command buffer. Steps are dropped when
 * deferred or while pipelines compile (ARCHITECTURE §6.5).
 *
 * Steady-state frames allocate nothing: scratch arrays grow only, bind groups
 * are rebuilt only when a referenced buffer changes.
 *
 * External sources (M2.5, ARCHITECTURE §19.4): SWARM_SET_SOURCE points hot
 * (and optionally cold) at buffers registered through renderer interop
 * (`CoreContext.getExternalBuffer`). The switch is queued like a write, so
 * ops queued before it still target the own buffers. The ids are resolved
 * every frame (two map lookups); a released or lost buffer makes the swarm
 * draw and dispatch nothing until a new source arrives.
 */
import { bufferAllocated } from '../backend/allocation';
import { BufferUsage, ShaderStage } from '../backend/types';
import type {
  Backend,
  BindGroupLayoutEntry,
  CommandList,
  ComputePass,
  RenderPass,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiComputePipeline,
  RhiRenderPipeline,
  RhiShaderModule,
} from '../backend/types';
import {
  Op,
  OpcodeRange,
  ReadbackSource,
  SwarmSourceFlag,
} from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import { CozyGPUError } from '../types/errors';
import type { CozyGPUErrorCode } from '../types/errors';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';
import {
  PICK_TARGET_FORMAT,
  SWARM_COLD_BYTES,
  SWARM_DRAW_BYTES,
  SWARM_HOT_BYTES,
  SWARM_SIM_BYTES,
  SWARM_SPAWN_BYTES,
} from '../types/layouts';
import {
  BLEND_MODES,
  SWARM_COUNTER_ALIVE,
  SWARM_COUNTER_FREE_TOP,
  SWARM_COUNTERS_BYTES,
  SWARM_LARGE_ALLOCATION_BYTES,
  SWARM_MAX_WORKGROUPS,
  SWARM_PICK_UNIFORM_BYTES,
  SWARM_QUAD_VERTICES,
  SWARM_UNIFORM_STRIDE,
  SWARM_WORKGROUP_SIZE,
  SwarmInternalRenderFlag,
  SwarmReadbackKind,
} from './constants';
import { createGlSwarmCore } from './coreGl';
import {
  OP_INIT_FREE,
  OP_KILL_LIST,
  OP_KILL_RANGE,
  OP_SOURCE,
  OP_SPAWN,
  OP_STEP,
  OP_WRITE_COLD,
  OP_WRITE_HOT,
  OpQueue,
  SPAWN_WORDS,
} from './opQueue';

const STRIDE_WORDS = SWARM_UNIFORM_STRIDE / 4;

/** Alive-count request state for 'ring' / 'manual' swarms. */
const COUNT_IDLE = 0;
const COUNT_REQUESTED = 1;
const COUNT_DISPATCHED = 2;

/** Render bind group layout variants: bit 0 = `visible` list, bit 1 = pick uniform. */
const LAYOUT_VISIBLE = 1;
const LAYOUT_PICK = 2;

// ─── GPU state ─────────────────────────────────────────────────────────────

interface Program {
  readonly computeSrc: string;
  readonly renderSrc: string;
  readonly renderFlags: number;
  readonly blendModeId: number;
  readonly texId: number;
  readonly paramsBytes: number;
  readonly cull: boolean;
  /** cull or allocation 'gpu': draws go through `visible` + drawIndirect. */
  readonly compact: boolean;
  paramsBuffer: RhiBuffer;
  /** Params buffer + compute pipelines are shared with the previous program. */
  sharedCompute: boolean;
  step: RhiComputePipeline | null;
  spawn: RhiComputePipeline | null;
  spawnPop: RhiComputePipeline | null;
  kill: RhiComputePipeline | null;
  count: RhiComputePipeline | null;
  freeInit: RhiComputePipeline | null;
  cullPipeline: RhiComputePipeline | null;
  renderModule: RhiShaderModule | null;
  render: RhiRenderPipeline | null;
  pick: RhiRenderPipeline | null;
  pickBuilding: boolean;
  ready: boolean;
  groupsVersion: number;
  stepGroup: RhiBindGroup | null;
  opGroup: RhiBindGroup | null;
  countGroup: RhiBindGroup | null;
  cullGroup: RhiBindGroup | null;
  renderGroup: RhiBindGroup | null;
  pickGroup: RhiBindGroup | null;
}

interface GpuSwarm {
  readonly id: number;
  readonly capacity: number;
  readonly gpuAlloc: boolean;
  /** The swarm's own hot/cold buffers. */
  readonly ownHot: RhiBuffer;
  readonly ownCold: RhiBuffer;
  /** Bound hot/cold: the own buffers or an external source (M2.5). */
  hot: RhiBuffer;
  cold: RhiBuffer;
  readonly draw: RhiBuffer;
  /** capacity × u32 for allocation 'gpu', a 4-byte dummy otherwise. */
  readonly free: RhiBuffer;
  readonly counters: RhiBuffer;
  frames: RhiBuffer;
  arena: RhiBuffer;
  arenaEntries: number;
  killList: RhiBuffer;
  killWords: number;
  visible: RhiBuffer | null;
  args: RhiBuffer | null;
  pickBuffer: RhiBuffer | null;
  pickId: number;
  /** M2.5 external source: hot / cold external ids (0 = own buffer) and flags. */
  srcHot: number;
  srcCold: number;
  srcFlags: number;
  /** Records drawable from the bound buffers (capacity for own buffers). */
  srcLimit: number;
  /** Bumped whenever a buffer referenced by bind groups is replaced. */
  resourceVersion: number;
  active: Program | null;
  pending: Program | null;
  readonly ops: OpQueue;
  /** Last activeCount seen in STEP/DRAW (cull dispatch range). */
  drawCount: number;
  /** allocation 'gpu': compaction must run at least once (initial args). */
  compactDirty: boolean;
  countState: number;
  countRange: number;
  countWaiters: ((result: ArrayBuffer | CozyGPUError) => void)[];
  /**
   * Hot/cold GPU allocation still unconfirmed: the swarm neither dispatches,
   * draws, writes nor reads back until it resolves (an out-of-memory buffer
   * would invalidate every frame's command buffer).
   */
  allocation: Promise<boolean> | null;
  destroyed: boolean;
}

/** The swarm core system, plus the READBACK extension RenderCore looks for. */
export interface SwarmCoreSystem extends CoreSystem {
  /** srcKind 1 = hot, 2 = cold (READBACK). Undefined for unknown ids. */
  readbackBuffer(srcKind: number, swarmId: number): RhiBuffer | undefined;
  /**
   * READBACK of `count` records starting at `first`. Returns undefined when
   * `srcKind` is not a swarm kind (another system may handle it). Reads the
   * state as of the previous submitted frame. srcKind 3 (alive count)
   * resolves 4 bytes (u32); `count` is the front's activeCount.
   */
  readback(
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer> | undefined;
}

/**
 * Selects the WebGPU or WebGL2 swarm core from the backend at init (and again
 * at restore when the backend kind changed).
 */
export function createSwarmCoreSystem(): SwarmCoreSystem {
  let impl: SwarmCoreSystem | null = null;
  let implGl = false;
  const wantsGl = (ctx: CoreContext): boolean => {
    const caps = ctx.backend.caps;
    return !(caps.compute && caps.vertexStorage) && caps.transformFeedback;
  };
  const system: SwarmCoreSystem = {
    name: 'swarm',
    range: OpcodeRange.SWARM,
    init(ctx: CoreContext): Promise<void> {
      impl?.destroy();
      implGl = wantsGl(ctx);
      impl = implGl ? createGlSwarmCore() : createWebGPUSwarmCore();
      return impl.init(ctx);
    },
    execute(reader: CommandReader, frame: CoreFrameState): void {
      impl?.execute(reader, frame);
    },
    compute(list: CommandList, frame: CoreFrameState): void {
      if (impl && impl.compute) impl.compute(list, frame);
    },
    draw(reader: CommandReader, pass: RenderPass, frame: CoreFrameState): void {
      impl?.draw(reader, pass, frame);
    },
    drawPick(
      reader: CommandReader,
      pass: RenderPass,
      frame: CoreFrameState,
      view: RhiBindGroup,
    ): void {
      if (impl && impl.drawPick) impl.drawPick(reader, pass, frame, view);
    },
    endFrame(frame: CoreFrameState): void {
      if (impl && impl.endFrame) impl.endFrame(frame);
    },
    async restore(ctx: CoreContext): Promise<void> {
      if (impl && wantsGl(ctx) === implGl) return impl.restore(ctx);
      return system.init(ctx);
    },
    destroy(): void {
      impl?.destroy();
      impl = null;
    },
    readback(srcKind, srcId, first, count) {
      if (!impl) {
        return srcKind === SwarmReadbackKind.HOT ||
          srcKind === SwarmReadbackKind.COLD ||
          srcKind === ReadbackSource.SWARM_ALIVE
          ? Promise.reject(
              new CozyGPUError('DESTROYED', 'swarm core was destroyed'),
            )
          : undefined;
      }
      return impl.readback(srcKind, srcId, first, count);
    },
    readbackBuffer(srcKind: number, swarmId: number): RhiBuffer | undefined {
      return impl?.readbackBuffer(srcKind, swarmId);
    },
  };
  return system;
}

/** The WebGPU (compute) swarm core. */
export function createWebGPUSwarmCore(): SwarmCoreSystem {
  let ctx: CoreContext | null = null;
  let backend: Backend | null = null;
  /** Bumped on restore/destroy: async pipeline results from before are dropped. */
  let epoch = 0;
  let unsupportedReported = false;

  const swarms = new Map<number, GpuSwarm>();
  const list: GpuSwarm[] = [];
  /**
   * Swarms the core refused or disabled (id → error code), so a readback of
   * one rejects with that code. Cleared by SWARM_CREATE/SWARM_DESTROY.
   */
  const refused = new Map<number, CozyGPUErrorCode>();
  /** The very-large-allocation warning is logged once per core. */
  let largeWarned = false;

  let emptyGroup: RhiBindGroup | null = null;
  let emptyLayout: RhiBindGroupLayout | null = null;
  let stepLayout: RhiBindGroupLayout | null = null;
  let opLayout: RhiBindGroupLayout | null = null;
  let countLayout: RhiBindGroupLayout | null = null;
  let cullLayout: RhiBindGroupLayout | null = null;
  /** Indexed by LAYOUT_VISIBLE | LAYOUT_PICK. */
  const renderLayouts: RhiBindGroupLayout[] = [];

  // per-frame scratch (grown, never allocated per frame)
  let arenaU8 = new Uint8Array(SWARM_UNIFORM_STRIDE * 8);
  let arenaU32 = new Uint32Array(arenaU8.buffer);
  let arenaF32 = new Float32Array(arenaU8.buffer);
  let killU32 = new Uint32Array(64);
  let killU8 = new Uint8Array(killU32.buffer);
  const dynOffset = new Uint32Array(1);
  const drawU8 = new Uint8Array(SWARM_DRAW_BYTES);
  const drawF32 = new Float32Array(drawU8.buffer);
  const drawU32 = new Uint32Array(drawU8.buffer);
  const argsReset = new Uint8Array(
    new Uint32Array([SWARM_QUAD_VERTICES, 0, 0, 0]).buffer,
  );
  const zeroWord = new Uint8Array(4);
  const smallU8 = new Uint8Array(SWARM_COUNTERS_BYTES);
  const smallU32 = new Uint32Array(smallU8.buffer);

  const storage = (
    binding: number,
    readOnly: boolean,
    visibility: number,
  ): BindGroupLayoutEntry => ({
    binding,
    visibility,
    type: { kind: 'storage', readOnly },
  });
  const uniform = (
    binding: number,
    visibility: number,
    size: number,
    hasDynamicOffset = false,
  ): BindGroupLayoutEntry => ({
    binding,
    visibility,
    type: { kind: 'uniform', hasDynamicOffset, minBindingSize: size },
  });

  function createLayouts(b: Backend): void {
    const C = ShaderStage.COMPUTE;
    const V = ShaderStage.VERTEX;
    const F = ShaderStage.FRAGMENT;
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
      label: 'swarm.step',
      entries: [
        storage(0, false, C),
        storage(1, true, C),
        uniform(2, C, SWARM_SIM_BYTES, true),
        uniform(3, C, 0), // params size varies per program
        storage(10, false, C),
        storage(11, false, C),
      ],
    });
    opLayout = b.createBindGroupLayout({
      label: 'swarm.op',
      entries: [
        storage(0, false, C),
        storage(4, false, C),
        uniform(5, C, SWARM_SPAWN_BYTES, true),
        storage(6, true, C),
        storage(10, false, C),
        storage(11, false, C),
      ],
    });
    countLayout = b.createBindGroupLayout({
      label: 'swarm.count',
      entries: [
        storage(0, false, C),
        uniform(2, C, SWARM_SIM_BYTES, true),
        storage(11, false, C),
      ],
    });
    cullLayout = b.createBindGroupLayout({
      label: 'swarm.cull',
      entries: [
        storage(0, false, C),
        uniform(2, C, SWARM_SIM_BYTES, true),
        storage(7, false, C),
        storage(8, false, C),
        uniform(9, C, SWARM_DRAW_BYTES),
        storage(11, false, C),
      ],
    });
    renderLayouts.length = 0;
    for (let variant = 0; variant < 4; variant++) {
      const entries: BindGroupLayoutEntry[] = [
        storage(0, true, V),
        storage(1, true, V),
        storage(2, true, V),
        uniform(3, V, SWARM_DRAW_BYTES),
      ];
      if (variant & LAYOUT_VISIBLE) entries.push(storage(4, true, V));
      if (variant & LAYOUT_PICK) {
        entries.push(uniform(5, F, SWARM_PICK_UNIFORM_BYTES));
      }
      renderLayouts.push(
        b.createBindGroupLayout({
          label: `swarm.render${variant}`,
          entries,
        }),
      );
    }
  }

  function postError(code: string, message: string): void {
    ctx?.post({ type: 'error', code, message });
  }

  // ─── buffers ──────────────────────────────────────────────────────────────

  function ensureArena(s: GpuSwarm, entries: number): void {
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

  function ensureKillList(s: GpuSwarm, words: number): void {
    if (words > killU32.length) {
      let size = killU32.length * 2;
      while (size < words) size *= 2;
      killU32 = new Uint32Array(size);
      killU8 = new Uint8Array(killU32.buffer);
    }
    if (words <= s.killWords) return;
    let n = s.killWords * 2;
    while (n < words) n *= 2;
    s.killList.destroy();
    s.killList = backend!.createBuffer({
      label: `swarm${s.id}.kill`,
      size: n * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    s.killWords = n;
    s.resourceVersion++;
  }

  function ensureCullBuffers(s: GpuSwarm): void {
    if (s.visible) return;
    s.visible = backend!.createBuffer({
      label: `swarm${s.id}.visible`,
      size: s.capacity * 4,
      usage: BufferUsage.STORAGE,
    });
    s.args = backend!.createBuffer({
      label: `swarm${s.id}.args`,
      size: 16,
      usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST,
    });
    backend!.writeBuffer(s.args, 0, argsReset);
    s.resourceVersion++;
    watchAllocation(s);
  }

  function ensureGroups(s: GpuSwarm, p: Program): void {
    if (p.groupsVersion === s.resourceVersion) return;
    const b = backend!;
    p.groupsVersion = s.resourceVersion;
    const hot = s.hot;
    const cold = s.cold;
    p.stepGroup = b.createBindGroup({
      label: `swarm${s.id}.step`,
      layout: stepLayout!,
      entries: [
        { binding: 0, resource: { buffer: hot } },
        { binding: 1, resource: { buffer: cold } },
        {
          binding: 2,
          resource: { buffer: s.arena, offset: 0, size: SWARM_SIM_BYTES },
        },
        { binding: 3, resource: { buffer: p.paramsBuffer } },
        { binding: 10, resource: { buffer: s.free } },
        { binding: 11, resource: { buffer: s.counters } },
      ],
    });
    p.opGroup = b.createBindGroup({
      label: `swarm${s.id}.op`,
      layout: opLayout!,
      entries: [
        { binding: 0, resource: { buffer: hot } },
        { binding: 4, resource: { buffer: cold } },
        {
          binding: 5,
          resource: { buffer: s.arena, offset: 0, size: SWARM_SPAWN_BYTES },
        },
        { binding: 6, resource: { buffer: s.killList } },
        { binding: 10, resource: { buffer: s.free } },
        { binding: 11, resource: { buffer: s.counters } },
      ],
    });
    p.countGroup = b.createBindGroup({
      label: `swarm${s.id}.count`,
      layout: countLayout!,
      entries: [
        { binding: 0, resource: { buffer: hot } },
        {
          binding: 2,
          resource: { buffer: s.arena, offset: 0, size: SWARM_SIM_BYTES },
        },
        { binding: 11, resource: { buffer: s.counters } },
      ],
    });
    if (p.compact && s.visible && s.args) {
      p.cullGroup = b.createBindGroup({
        label: `swarm${s.id}.cull`,
        layout: cullLayout!,
        entries: [
          { binding: 0, resource: { buffer: hot } },
          {
            binding: 2,
            resource: { buffer: s.arena, offset: 0, size: SWARM_SIM_BYTES },
          },
          { binding: 7, resource: { buffer: s.visible } },
          { binding: 8, resource: { buffer: s.args } },
          { binding: 9, resource: { buffer: s.draw } },
          { binding: 11, resource: { buffer: s.counters } },
        ],
      });
    }
    const visible = p.compact && s.visible !== null;
    const renderEntries = [
      { binding: 0, resource: { buffer: hot } },
      { binding: 1, resource: { buffer: cold } },
      { binding: 2, resource: { buffer: s.frames } },
      { binding: 3, resource: { buffer: s.draw } },
    ];
    if (visible) {
      renderEntries.push({ binding: 4, resource: { buffer: s.visible! } });
    }
    const variant = visible ? LAYOUT_VISIBLE : 0;
    p.renderGroup = b.createBindGroup({
      label: `swarm${s.id}.render`,
      layout: renderLayouts[variant],
      entries: renderEntries,
    });
    p.pickGroup = null;
    if (s.pickBuffer) {
      renderEntries.push({ binding: 5, resource: { buffer: s.pickBuffer } });
      p.pickGroup = b.createBindGroup({
        label: `swarm${s.id}.pick`,
        layout: renderLayouts[variant | LAYOUT_PICK],
        entries: renderEntries,
      });
    }
  }

  // ─── programs (async pipelines) ───────────────────────────────────────────

  function latestProgram(s: GpuSwarm): Program | null {
    return s.pending ?? s.active;
  }

  function releaseProgram(p: Program, keepParams: boolean): void {
    if (!keepParams) p.paramsBuffer.destroy();
  }

  function startProgram(
    s: GpuSwarm,
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
    const cull = (renderFlags & SwarmInternalRenderFlag.CULL) !== 0;
    const compact = cull || s.gpuAlloc;
    if (cull && !b.caps.indirectDraw) {
      postError('UNSUPPORTED', 'Swarm culling requires indirect draws');
      return;
    }
    if (compact) ensureCullBuffers(s);

    const base = latestProgram(s);
    const shareCompute =
      base !== null &&
      base.computeSrc === computeSrc &&
      base.paramsBytes === paramsBytes;
    const bytes = Math.max(16, (paramsBytes + 15) & ~15);
    const program: Program = {
      computeSrc,
      renderSrc,
      renderFlags,
      blendModeId,
      texId,
      paramsBytes,
      cull,
      compact,
      paramsBuffer: shareCompute
        ? base.paramsBuffer
        : b.createBuffer({
            label: `swarm${s.id}.params`,
            size: bytes,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
          }),
      sharedCompute: shareCompute,
      step: shareCompute ? base.step : null,
      spawn: shareCompute ? base.spawn : null,
      spawnPop: shareCompute ? base.spawnPop : null,
      kill: shareCompute ? base.kill : null,
      count: shareCompute ? base.count : null,
      freeInit: shareCompute ? base.freeInit : null,
      cullPipeline: shareCompute ? base.cullPipeline : null,
      renderModule: null,
      render: null,
      pick: null,
      pickBuilding: false,
      ready: false,
      groupsVersion: -1,
      stepGroup: null,
      opGroup: null,
      countGroup: null,
      cullGroup: null,
      renderGroup: null,
      pickGroup: null,
    };
    const superseded = s.pending;
    if (superseded) {
      releaseProgram(
        superseded,
        superseded.paramsBuffer === program.paramsBuffer ||
          superseded.paramsBuffer === s.active?.paramsBuffer,
      );
    }
    s.pending = program;
    const started = epoch;
    buildProgram(s, program, shareCompute && base.step !== null).then(
      () => {
        if (started !== epoch || s.destroyed || s.pending !== program) return;
        const old = s.active;
        s.active = program;
        s.pending = null;
        program.ready = true;
        if (old && old.paramsBuffer !== program.paramsBuffer) {
          releaseProgram(old, false);
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
            releaseProgram(program, false);
          }
        }
      },
    );
  }

  async function buildProgram(
    s: GpuSwarm,
    p: Program,
    reuseCompute: boolean,
  ): Promise<void> {
    const b = backend!;
    const c = ctx!;
    const renderModule: RhiShaderModule = b.createShaderModule({
      label: `swarm${s.id}.render`,
      wgsl: p.renderSrc,
    });
    p.renderModule = renderModule;
    const renderPromise = b.createRenderPipeline({
      label: `swarm${s.id}.render`,
      shader: renderModule,
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
      bindGroupLayouts: [
        c.viewLayout,
        c.textureLayout,
        renderLayouts[p.compact ? LAYOUT_VISIBLE : 0],
      ],
      vertexBuffers: [],
      topology: 'triangle-strip',
      blend: BLEND_MODES[p.blendModeId] ?? 'normal',
      sampleCount: c.sampleCount,
    });
    if (s.pickId !== 0) buildPick(s, p);
    if (!reuseCompute) {
      const module = b.createShaderModule({
        label: `swarm${s.id}.compute`,
        wgsl: p.computeSrc,
      });
      const layouts = (group: RhiBindGroupLayout): RhiBindGroupLayout[] => [
        c.viewLayout,
        emptyLayout!,
        group,
      ];
      const compute = (
        entry: string,
        group: RhiBindGroupLayout,
      ): Promise<RhiComputePipeline> =>
        b.createComputePipeline({
          label: `swarm${s.id}.${entry}`,
          shader: module,
          entry,
          bindGroupLayouts: layouts(group),
        });
      const none = Promise.resolve(null);
      const [step, spawn, kill, count, spawnPop, freeInit, cull] =
        await Promise.all([
          compute('cs_step', stepLayout!),
          compute('cs_spawn', opLayout!),
          compute('cs_kill', opLayout!),
          compute('cs_count', countLayout!),
          s.gpuAlloc ? compute('cs_spawn_pop', opLayout!) : none,
          s.gpuAlloc ? compute('cs_free_init', stepLayout!) : none,
          p.compact ? compute('cs_cull', cullLayout!) : none,
        ]);
      p.step = step;
      p.spawn = spawn;
      p.kill = kill;
      p.count = count;
      p.spawnPop = spawnPop;
      p.freeInit = freeInit;
      p.cullPipeline = cull;
    }
    p.render = await renderPromise;
  }

  /** Starts the pick pipeline of `p` (once). Picks miss until it resolves. */
  function buildPick(s: GpuSwarm, p: Program): void {
    if (p.pick || p.pickBuilding || !p.renderModule) return;
    p.pickBuilding = true;
    const c = ctx!;
    const started = epoch;
    backend!
      .createRenderPipeline({
        label: `swarm${s.id}.pick`,
        shader: p.renderModule,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_pick',
        bindGroupLayouts: [
          c.viewLayout,
          c.textureLayout,
          renderLayouts[(p.compact ? LAYOUT_VISIBLE : 0) | LAYOUT_PICK],
        ],
        vertexBuffers: [],
        topology: 'triangle-strip',
        colorFormat: PICK_TARGET_FORMAT,
        blend: 'none',
        sampleCount: 1,
      })
      .then(
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

  // ─── swarm lifecycle ──────────────────────────────────────────────────────

  function unreadable(id: number): CozyGPUError {
    const code = refused.get(id);
    return code
      ? new CozyGPUError(
          code,
          `swarm ${id} was refused or disabled by the core (${code})`,
        )
      : new CozyGPUError('INVALID_ARGUMENT', `swarm ${id} does not exist`);
  }

  function failCountWaiters(s: GpuSwarm, error: CozyGPUError): void {
    const waiters = s.countWaiters;
    s.countWaiters = [];
    s.countState = COUNT_IDLE;
    for (let k = 0; k < waiters.length; k++) waiters[k](error);
  }

  function destroySwarm(s: GpuSwarm, error?: CozyGPUError): void {
    s.destroyed = true;
    s.ownHot.destroy();
    s.ownCold.destroy();
    s.draw.destroy();
    s.free.destroy();
    s.counters.destroy();
    s.frames.destroy();
    s.arena.destroy();
    s.killList.destroy();
    s.visible?.destroy();
    s.args?.destroy();
    s.pickBuffer?.destroy();
    const params = new Set<RhiBuffer>();
    if (s.active) params.add(s.active.paramsBuffer);
    if (s.pending) params.add(s.pending.paramsBuffer);
    params.forEach(buffer => buffer.destroy());
    swarms.delete(s.id);
    const index = list.indexOf(s);
    if (index >= 0) list.splice(index, 1);
    if (s.countWaiters.length > 0) {
      failCountWaiters(
        s,
        error ?? new CozyGPUError('DESTROYED', `swarm ${s.id} was destroyed`),
      );
    }
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

    const caps = b.caps;
    if (!caps.compute || !caps.vertexStorage) {
      refused.set(id, 'UNSUPPORTED');
      if (!unsupportedReported) {
        unsupportedReported = true;
        postError(
          'UNSUPPORTED',
          'Swarm requires compute shaders and vertex-stage storage buffers',
        );
      }
      return;
    }
    const gpuAlloc = (renderFlags & SwarmInternalRenderFlag.GPU_ALLOC) !== 0;
    if (gpuAlloc && !caps.indirectDraw) {
      refused.set(id, 'UNSUPPORTED');
      postError(
        'UNSUPPORTED',
        `Swarm ${id}: allocation 'gpu' requires indirect draws`,
      );
      return;
    }
    const hotBytes = capacity * SWARM_HOT_BYTES;
    const limit = Math.min(
      caps.maxStorageBufferBindingSize,
      caps.maxBufferSize,
    );
    if (capacity <= 0 || hotBytes > limit) {
      refused.set(id, 'OUT_OF_CAPACITY');
      postError(
        'OUT_OF_CAPACITY',
        `Swarm capacity ${capacity} needs ${hotBytes} B per storage buffer; ` +
          `the device allows ${limit} B (try limits: 'max')`,
      );
      return;
    }

    const totalBytes =
      capacity * (SWARM_HOT_BYTES + SWARM_COLD_BYTES + (gpuAlloc ? 8 : 0));
    if (totalBytes > SWARM_LARGE_ALLOCATION_BYTES && !largeWarned) {
      largeWarned = true;
      const gib = (totalBytes / (1 << 30)).toFixed(1);
      (globalThis as { console?: Console }).console?.warn(
        `[cozygpu] Swarm ${id}: capacity ${capacity} allocates ${gib} GiB of ` +
          `GPU memory (${SWARM_HOT_BYTES + SWARM_COLD_BYTES} B per object). ` +
          'That is accepted up to the device buffer limit, but expect very ' +
          'slow frames and readbacks; use the smallest capacity that fits.',
      );
    }

    const hot = b.createBuffer({
      label: `swarm${id}.hot`,
      size: hotBytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    });
    const cold = b.createBuffer({
      label: `swarm${id}.cold`,
      size: capacity * SWARM_COLD_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    });
    const s: GpuSwarm = {
      id,
      capacity,
      gpuAlloc,
      ownHot: hot,
      ownCold: cold,
      hot,
      cold,
      draw: b.createBuffer({
        label: `swarm${id}.draw`,
        size: SWARM_DRAW_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
      free: b.createBuffer({
        label: `swarm${id}.free`,
        size: gpuAlloc ? capacity * 4 : 4,
        usage: BufferUsage.STORAGE,
      }),
      counters: b.createBuffer({
        label: `swarm${id}.counters`,
        size: SWARM_COUNTERS_BYTES,
        usage:
          BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
      }),
      frames: b.createBuffer({
        label: `swarm${id}.frames`,
        size: 16,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      }),
      arena: b.createBuffer({
        label: `swarm${id}.arena`,
        size: 4 * SWARM_UNIFORM_STRIDE,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
      arenaEntries: 4,
      killList: b.createBuffer({
        label: `swarm${id}.kill`,
        size: 16,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      }),
      killWords: 4,
      visible: null,
      args: null,
      pickBuffer: null,
      pickId: 0,
      srcHot: 0,
      srcCold: 0,
      srcFlags: 0,
      srcLimit: capacity,
      resourceVersion: 0,
      active: null,
      pending: null,
      ops: new OpQueue(),
      drawCount: 0,
      compactDirty: true,
      countState: COUNT_IDLE,
      countRange: 0,
      countWaiters: [],
      allocation: null,
      destroyed: false,
    };
    // Default frame: the whole texture.
    arenaF32[0] = 0;
    arenaF32[1] = 0;
    arenaF32[2] = 1;
    arenaF32[3] = 1;
    b.writeBuffer(s.frames, 0, arenaU8, 0, 16);
    // Counters: the whole capacity is free ('gpu'), nothing alive.
    smallU32[SWARM_COUNTER_FREE_TOP >> 2] = gpuAlloc ? capacity : 0;
    smallU32[SWARM_COUNTER_ALIVE >> 2] = 0;
    smallU32[2] = 0;
    smallU32[3] = 0;
    b.writeBuffer(s.counters, 0, smallU8, 0, SWARM_COUNTERS_BYTES);
    if (gpuAlloc) s.ops.u32[s.ops.reserve(1)] = OP_INIT_FREE;
    swarms.set(id, s);
    list.push(s);
    watchAllocation(s);
    startProgram(s, reader, texId, blendModeId, renderFlags, paramsBytes);
  }

  function watchAllocation(s: GpuSwarm): void {
    // Capacity-sized buffers only; the small ones cannot realistically fail.
    const hot = bufferAllocated(s.ownHot);
    const cold = bufferAllocated(s.ownCold);
    const visible = s.visible ? bufferAllocated(s.visible) : undefined;
    const free = s.gpuAlloc ? bufferAllocated(s.free) : undefined;
    if (!hot && !cold && !visible && !free) return;
    const started = epoch;
    // Supersedes (and includes) an allocation still being watched.
    const allocation = Promise.all([
      s.allocation ?? true,
      hot ?? true,
      cold ?? true,
      visible ?? true,
      free ?? true,
    ]).then(r => r[0] && r[1] && r[2] && r[3] && r[4]);
    s.allocation = allocation;
    allocation.then(
      ok => {
        if (started !== epoch || s.destroyed || s.allocation !== allocation) {
          return;
        }
        s.allocation = null;
        if (ok) return;
        const bytes =
          s.capacity * (SWARM_HOT_BYTES + SWARM_COLD_BYTES) +
          (s.visible ? s.capacity * 4 : 0) +
          (s.gpuAlloc ? s.capacity * 4 : 0);
        refused.set(s.id, 'OUT_OF_CAPACITY');
        destroySwarm(s, unreadable(s.id));
        postError(
          'OUT_OF_CAPACITY',
          `Swarm ${s.id}: the GPU could not allocate ${bytes} B for capacity ` +
            `${s.capacity} (out of memory); the swarm is disabled`,
        );
      },
      () => {
        if (s.allocation === allocation) s.allocation = null;
      },
    );
  }

  function setFrames(s: GpuSwarm, reader: CommandReader): void {
    const count = reader.u32();
    if (count === 0) return;
    const bytes = count * 16;
    const at = reader.blob(bytes);
    if (bytes > s.frames.size) {
      s.frames.destroy();
      s.frames = backend!.createBuffer({
        label: `swarm${s.id}.frames`,
        size: bytes,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      s.resourceVersion++;
    }
    backend!.writeBuffer(s.frames, 0, reader.u8, at, bytes);
  }

  function setPick(s: GpuSwarm, pickId: number): void {
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

  /** A released or lost external source, or one without COPY_SRC. */
  function unreadableSource(id: number): CozyGPUError {
    return new CozyGPUError('UNSUPPORTED', `swarm ${id}: source unreadable`);
  }

  /** Applies a SWARM_SET_SOURCE (ids resolved by `syncSource`). */
  function applySource(s: GpuSwarm, u32: Uint32Array, at: number): void {
    s.srcHot = u32[at];
    s.srcCold = u32[at + 1];
    s.srcFlags = u32[at + 2];
    s.hot = s.ownHot;
    s.cold = s.ownCold;
    s.srcLimit = s.capacity;
    s.resourceVersion++;
  }

  /**
   * Resolves the external source of `s` for this frame. False when a source
   * is set but one of its buffers is unknown (released, or dropped by a device
   * loss): the swarm then draws and dispatches nothing. Allocation-free.
   */
  function syncSource(s: GpuSwarm): boolean {
    if (s.srcHot === 0) return true;
    const c = ctx!;
    const hot = c.getExternalBuffer?.(s.srcHot);
    const cold = s.srcCold ? c.getExternalBuffer?.(s.srcCold) : s.ownCold;
    if (!hot || !cold) return false;
    if (hot !== s.hot || cold !== s.cold) {
      s.hot = hot;
      s.cold = cold;
      s.resourceVersion++;
      s.srcLimit = Math.min(
        s.capacity,
        (hot.size / SWARM_HOT_BYTES) | 0,
        (cold.size / SWARM_COLD_BYTES) | 0,
      );
    }
    return true;
  }

  function writeRecords(
    s: GpuSwarm,
    reader: CommandReader,
    opcode: number,
  ): void {
    const hot = opcode === OP_WRITE_HOT;
    const recordBytes = hot ? SWARM_HOT_BYTES : SWARM_COLD_BYTES;
    const first = reader.u32();
    const count = reader.u32();
    const at = reader.blob(count * recordBytes);
    if (first >= s.capacity) return;
    const n = Math.min(count, s.capacity - first);
    if (n <= 0) return;
    if (s.ops.length === 0 && s.allocation === null) {
      backend!.writeBuffer(
        hot ? s.hot : s.cold,
        first * recordBytes,
        reader.u8,
        at,
        n * recordBytes,
      );
      return;
    }
    const w = s.ops.reserve(3 + (n * recordBytes) / 4);
    const ops = s.ops;
    ops.u32[w] = opcode;
    ops.u32[w + 1] = first;
    ops.u32[w + 2] = n;
    ops.u8.set(reader.u8.subarray(at, at + n * recordBytes), (w + 3) * 4);
  }

  // ─── compute ──────────────────────────────────────────────────────────────

  let pass: ComputePass | null = null;
  let passList: CommandList | null = null;

  function beginPass(): ComputePass {
    if (!pass) pass = passList!.beginComputePass('swarm');
    return pass;
  }

  function dispatch(
    p: ComputePass,
    pipeline: RhiComputePipeline,
    group: RhiBindGroup,
    offset: number,
    count: number,
  ): void {
    const c = ctx!;
    p.setPipeline(pipeline);
    p.setBindGroup(0, c.viewBindGroup);
    p.setBindGroup(1, emptyGroup!);
    dynOffset[0] = offset;
    p.setBindGroup(2, group, dynOffset);
    const groups = Math.ceil(count / SWARM_WORKGROUP_SIZE);
    const x = Math.min(groups, SWARM_MAX_WORKGROUPS);
    const y = Math.ceil(groups / SWARM_MAX_WORKGROUPS);
    p.dispatch(x, y, 1);
  }

  /** Writes a SwarmSim entry (dt, time, count, substep) at arena entry `e`. */
  function writeSim(
    e: number,
    dt: number,
    time: number,
    count: number,
    substep: number,
  ): void {
    const w = e * STRIDE_WORDS;
    arenaF32[w] = dt;
    arenaF32[w + 1] = time;
    arenaU32[w + 2] = count;
    arenaU32[w + 3] = substep;
  }

  function computeSwarm(s: GpuSwarm, frame: CoreFrameState): void {
    const prog = s.active;
    const ops = s.ops;
    if (!prog || !prog.ready || s.allocation !== null) {
      if (ops.length === 0) return;
      if (!prog && !s.pending) {
        // No program and none compiling (the compile failed): nothing will
        // ever drain the queue, so drop everything instead of growing it
        // every frame and replaying stale spawns when a fixed shader lands.
        ops.length = 0;
      } else {
        ops.retainFrom(0); // drop steps, keep the rest
      }
      return;
    }
    // Apply source switches queued at the front (they dispatch nothing).
    while (ops.length > 0 && ops.u32[0] === OP_SOURCE) {
      applySource(s, ops.u32, 1);
      ops.u32.copyWithin(0, 4, ops.length);
      ops.length -= 4;
    }
    if (!syncSource(s)) {
      // External buffer gone: keep writes/switches, drop steps, dispatch
      // nothing. Alive counts wait until the swarm has buffers again.
      if (ops.length > 0) ops.retainFrom(0);
      return;
    }
    const countRequested = s.countState === COUNT_REQUESTED;
    if (
      ops.length === 0 &&
      !prog.cull &&
      !countRequested &&
      !(s.gpuAlloc && s.compactDirty)
    ) {
      return;
    }
    const u32 = ops.u32;

    // 1. plan: entries, kill-list words, stop index
    let entries = 0;
    let killWords = 0;
    let stop = ops.length;
    let dispatched = false;
    for (let k = 0; k < ops.length; k += ops.sizeAt(k)) {
      const op = u32[k];
      if (op === OP_WRITE_HOT || op === OP_WRITE_COLD || op === OP_SOURCE) {
        if (dispatched) {
          stop = k;
          break;
        }
        // A source switch changes the bind groups: stop there and apply it
        // first next frame (with syncSource), so ops before and after it bind
        // the right buffers.
        if (op === OP_SOURCE) {
          stop = k;
          break;
        }
      } else if (op === OP_STEP) {
        entries += Math.max(1, u32[k + 2]);
        dispatched = true;
      } else {
        if (op === OP_KILL_LIST) killWords += u32[k + 1];
        entries++;
        dispatched = true;
      }
    }
    if (dispatched && s.gpuAlloc) s.compactDirty = true;
    const compact =
      prog.compact &&
      prog.cullPipeline !== null &&
      s.drawCount > 0 &&
      (prog.cull || s.compactDirty);
    if (compact) entries++;
    // A cull pass counts alive objects too; otherwise use cs_count.
    const count = countRequested && !compact && prog.count !== null;
    if (count) entries++;
    if (entries > 0) ensureArena(s, entries);
    if (killWords > 0) ensureKillList(s, killWords);
    ensureGroups(s, prog);

    // 2. record in stream order
    const b = backend!;
    let e = 0;
    let kw = 0;
    for (let k = 0; k < stop; k += ops.sizeAt(k)) {
      const op = u32[k];
      if (op === OP_WRITE_HOT || op === OP_WRITE_COLD) {
        const hot = op === OP_WRITE_HOT;
        const recordBytes = hot ? SWARM_HOT_BYTES : SWARM_COLD_BYTES;
        b.writeBuffer(
          hot ? s.hot : s.cold,
          u32[k + 1] * recordBytes,
          ops.u8,
          (k + 3) * 4,
          u32[k + 2] * recordBytes,
        );
        continue;
      }
      const base = e * STRIDE_WORDS;
      if (op === OP_SPAWN) {
        for (let j = 0; j < SPAWN_WORDS; j++)
          arenaU32[base + j] = u32[k + 1 + j];
        const n = u32[k + 2];
        if (n > 0) {
          const offset = e * SWARM_UNIFORM_STRIDE;
          if (s.gpuAlloc) {
            dispatch(beginPass(), prog.spawnPop!, prog.opGroup!, offset, 1);
          }
          dispatch(beginPass(), prog.spawn!, prog.opGroup!, offset, n);
        }
        e++;
      } else if (op === OP_KILL_RANGE || op === OP_KILL_LIST) {
        const isList = op === OP_KILL_LIST;
        const n = isList ? u32[k + 1] : u32[k + 2];
        arenaU32[base] = isList ? 0 : u32[k + 1]; // first
        arenaU32[base + 1] = n; // count
        arenaU32[base + 2] = isList ? 1 : 0; // mode (seed field)
        arenaU32[base + 3] = kw; // list offset (frame field)
        if (isList) {
          for (let j = 0; j < n; j++) killU32[kw + j] = u32[k + 2 + j];
          kw += n;
        }
        if (n > 0) {
          dispatch(
            beginPass(),
            prog.kill!,
            prog.opGroup!,
            e * SWARM_UNIFORM_STRIDE,
            n,
          );
        }
        e++;
      } else if (op === OP_STEP) {
        const substeps = Math.max(1, u32[k + 2]);
        if (s.srcHot !== 0 && (s.srcFlags & SwarmSourceFlag.SIMULATE) === 0) {
          // A draw-only external source is moved by outside code: no step.
          e += substeps;
          continue;
        }
        const n = Math.min(u32[k + 3], s.srcLimit);
        const dt = ops.f32[k + 1] / substeps;
        s.drawCount = n;
        for (let sub = 0; sub < substeps; sub++) {
          writeSim(e + sub, dt, frame.time, n, sub);
          if (n > 0) {
            dispatch(
              beginPass(),
              prog.step!,
              prog.stepGroup!,
              (e + sub) * SWARM_UNIFORM_STRIDE,
              n,
            );
          }
        }
        e += substeps;
      } else if (op === OP_INIT_FREE) {
        writeSim(e, 0, frame.time, s.capacity, 0);
        dispatch(
          beginPass(),
          prog.freeInit!,
          prog.stepGroup!,
          e * SWARM_UNIFORM_STRIDE,
          s.capacity,
        );
        e++;
      }
    }

    if (compact) {
      writeSim(e, 0, frame.time, s.drawCount, 0);
      b.writeBuffer(s.args!, 0, argsReset);
      b.writeBuffer(s.counters, SWARM_COUNTER_ALIVE, zeroWord);
      dispatch(
        beginPass(),
        prog.cullPipeline!,
        prog.cullGroup!,
        e * SWARM_UNIFORM_STRIDE,
        s.drawCount,
      );
      e++;
      s.compactDirty = false;
      if (countRequested) s.countState = COUNT_DISPATCHED;
    } else if (count) {
      const n = Math.min(s.countRange, s.capacity);
      writeSim(e, 0, frame.time, n, 0);
      b.writeBuffer(s.counters, SWARM_COUNTER_ALIVE, zeroWord);
      if (n > 0) {
        dispatch(
          beginPass(),
          prog.count!,
          prog.countGroup!,
          e * SWARM_UNIFORM_STRIDE,
          n,
        );
      }
      e++;
      s.countState = COUNT_DISPATCHED;
    }

    if (e > 0) b.writeBuffer(s.arena, 0, arenaU8, 0, e * SWARM_UNIFORM_STRIDE);
    if (kw > 0) b.writeBuffer(s.killList, 0, killU8, 0, kw * 4);

    if (stop < ops.length) ops.retainFrom(stop);
    else ops.length = 0;
  }

  /** After submit: answers alive-count requests whose pass just ran. */
  function finishCount(s: GpuSwarm): void {
    s.countState = COUNT_IDLE;
    const waiters = s.countWaiters;
    s.countWaiters = [];
    backend!.readBuffer(s.counters, SWARM_COUNTER_ALIVE, 4).then(
      data => {
        for (let k = 0; k < waiters.length; k++) {
          waiters[k](k === 0 ? data : data.slice(0));
        }
      },
      (error: unknown) => {
        const e =
          error instanceof CozyGPUError
            ? error
            : new CozyGPUError('INTERNAL', String(error));
        for (let k = 0; k < waiters.length; k++) waiters[k](e);
      },
    );
  }

  /** Parses a SWARM_DRAW payload into the draw uniform scratch. */
  function readDraw(reader: CommandReader): GpuSwarm | null {
    const s = swarms.get(reader.u32());
    if (!s) return null;
    for (let k = 0; k < 7; k++) drawF32[k] = reader.f32(); // a b c d tx ty alpha
    s.drawCount = s.gpuAlloc ? s.capacity : Math.min(reader.u32(), s.srcLimit);
    return s;
  }

  function issueDraw(s: GpuSwarm, prog: Program, renderPass: RenderPass): void {
    if (prog.compact && s.args) {
      renderPass.drawIndirect(s.args, 0);
    } else if (s.drawCount > 0) {
      renderPass.draw(SWARM_QUAD_VERTICES, s.drawCount, 0, 0);
    }
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
          writeRecords(s, reader, OP_WRITE_HOT);
          break;
        case Op.SWARM_WRITE_COLD:
          writeRecords(s, reader, OP_WRITE_COLD);
          break;
        case Op.SWARM_SPAWN: {
          const at = reader.blob(SWARM_SPAWN_BYTES) >> 2;
          const src = reader.u32View;
          const first = s.gpuAlloc ? 0 : src[at];
          if (first >= s.capacity) break;
          const w = ops.reserve(1 + SPAWN_WORDS);
          ops.u32[w] = OP_SPAWN;
          for (let j = 0; j < SPAWN_WORDS; j++)
            ops.u32[w + 1 + j] = src[at + j];
          ops.u32[w + 1] = first;
          // clamp count to capacity
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
          const src = reader.u32View;
          const dst = ops.u32;
          for (let j = 0; j < n; j++) dst[w + 2 + j] = src[at + j];
          let kept = n;
          if (s.gpuAlloc && n > 1) {
            // A slot listed twice would be pushed on the free list twice.
            const view = dst.subarray(w + 2, w + 2 + n);
            view.sort();
            kept = 1;
            for (let j = 1; j < n; j++) {
              if (view[j] !== view[kept - 1]) view[kept++] = view[j];
            }
            ops.length = w + 2 + kept;
          }
          dst[w + 1] = kept;
          break;
        }
        case Op.SWARM_SET_PARAMS: {
          const byteOffset = reader.u32();
          const byteLength = reader.u32();
          const at = reader.blob(byteLength);
          const p = latestProgram(s);
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
          ops.u32[w + 3] = s.gpuAlloc ? s.capacity : count;
          break;
        }
        case Op.SWARM_SET_FRAMES:
          setFrames(s, reader);
          break;
        case Op.SWARM_SET_PICK:
          setPick(s, reader.u32());
          break;
        case Op.SWARM_SET_SOURCE: {
          // allocation 'gpu' swarms never get one (the front refuses it).
          const at = reader.blob(12) >> 2;
          if (ops.length === 0) {
            applySource(s, reader.u32View, at);
            break;
          }
          const w = ops.reserve(4);
          ops.u32[w] = OP_SOURCE;
          ops.u32.set(reader.u32View.subarray(at, at + 3), w + 1);
          break;
        }
        default:
          break;
      }
    },

    compute(commandList: CommandList, frame: CoreFrameState): void {
      if (!backend || list.length === 0) return;
      passList = commandList;
      for (let i = 0; i < list.length; i++) computeSwarm(list[i], frame);
      if (pass) {
        pass.end();
        pass = null;
      }
      passList = null;
    },

    draw(reader: CommandReader, renderPass: RenderPass): void {
      if (!backend || reader.opcode !== Op.SWARM_DRAW) return;
      const s = readDraw(reader);
      if (!s) return;
      const prog = s.active;
      if (!prog || !prog.ready || !prog.render || s.allocation !== null) {
        return;
      }
      if (!syncSource(s)) return;
      drawU32[7] = prog.renderFlags;
      backend.writeBuffer(s.draw, 0, drawU8, 0, SWARM_DRAW_BYTES);
      ensureGroups(s, prog);
      const c = ctx!;
      renderPass.setPipeline(prog.render);
      renderPass.setBindGroup(0, c.viewBindGroup);
      renderPass.setBindGroup(1, c.getTexture(prog.texId).bindGroup);
      renderPass.setBindGroup(2, prog.renderGroup!);
      issueDraw(s, prog, renderPass);
    },

    drawPick(
      reader: CommandReader,
      renderPass: RenderPass,
      _frame: CoreFrameState,
      view: RhiBindGroup,
    ): void {
      if (!backend || reader.opcode !== Op.SWARM_DRAW) return;
      const s = readDraw(reader);
      if (!s || s.pickId === 0) return;
      const prog = s.active;
      if (!prog || !prog.ready || s.allocation !== null) return;
      if (!syncSource(s)) return;
      if (!prog.pick) {
        buildPick(s, prog);
        return;
      }
      // Same bytes as draw() wrote this frame (collapsed writes are equal).
      drawU32[7] = prog.renderFlags;
      backend.writeBuffer(s.draw, 0, drawU8, 0, SWARM_DRAW_BYTES);
      ensureGroups(s, prog);
      if (!prog.pickGroup) return;
      renderPass.setPipeline(prog.pick);
      renderPass.setBindGroup(0, view);
      renderPass.setBindGroup(1, ctx!.getTexture(prog.texId).bindGroup);
      renderPass.setBindGroup(2, prog.pickGroup);
      issueDraw(s, prog, renderPass);
    },

    endFrame(): void {
      if (!backend) return;
      for (let i = 0; i < list.length; i++) {
        if (list[i].countState === COUNT_DISPATCHED) finishCount(list[i]);
      }
    },

    async restore(context: CoreContext): Promise<void> {
      epoch++;
      // Old GPU objects belong to the lost device; forget them.
      const lost = new CozyGPUError('DEVICE_LOST', 'GPU device was lost');
      for (let i = 0; i < list.length; i++) {
        if (list[i].countWaiters.length > 0) failCountWaiters(list[i], lost);
      }
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
      const s = swarms.get(srcId);
      if (!backend) {
        return Promise.reject(
          new CozyGPUError('DESTROYED', 'swarm core was destroyed'),
        );
      }
      if (!s) return Promise.reject(unreadable(srcId));
      const b = backend;
      if (srcKind === ReadbackSource.SWARM_ALIVE) {
        if (s.gpuAlloc) {
          const read = (): Promise<ArrayBuffer> =>
            s.destroyed
              ? Promise.reject(unreadable(srcId))
              : b.readBuffer(s.counters, SWARM_COUNTER_ALIVE, 4);
          return s.allocation ? s.allocation.then(read) : read();
        }
        return new Promise<ArrayBuffer>((resolve, reject) => {
          s.countWaiters.push(result =>
            result instanceof CozyGPUError ? reject(result) : resolve(result),
          );
          if (s.countState === COUNT_IDLE) {
            s.countState = COUNT_REQUESTED;
            s.countRange = count;
          } else if (s.countState === COUNT_REQUESTED) {
            s.countRange = Math.max(s.countRange, count);
          }
        });
      }
      const isHot = srcKind === SwarmReadbackKind.HOT;
      const recordBytes = isHot ? SWARM_HOT_BYTES : SWARM_COLD_BYTES;
      const ok = syncSource(s);
      const buffer = isHot ? s.hot : s.cold;
      if (!ok || !(buffer.usage & BufferUsage.COPY_SRC)) {
        return Promise.reject(unreadableSource(srcId));
      }
      const start = Math.min(first, s.srcLimit);
      const n = Math.min(count, s.srcLimit - start);
      const read = (): Promise<ArrayBuffer> =>
        s.destroyed
          ? Promise.reject(unreadable(srcId))
          : b.readBuffer(buffer, start * recordBytes, n * recordBytes);
      return s.allocation ? s.allocation.then(read) : read();
    },

    readbackBuffer(srcKind: number, swarmId: number): RhiBuffer | undefined {
      const s = swarms.get(swarmId);
      if (!s) return undefined;
      if (srcKind === SwarmReadbackKind.HOT) return s.hot;
      if (srcKind === SwarmReadbackKind.COLD) return s.cold;
      return undefined;
    },
  };
  return system;
}
