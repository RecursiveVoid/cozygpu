/**
 * Front-side Swarm node (see ./types.ts for the contract).
 *
 * Holds no GPU objects. Everything it does is encoded into its own command
 * queue and flushed into the frame by `_emitDraw` (called by the ScenePacker
 * at the swarm's position in the tree):
 *   first use per (renderer, generation): SWARM_CREATE + SWARM_SET_FRAMES
 *   changed blend/behaviors:              SWARM_SET_PIPELINE
 *   pickable changed:                     SWARM_SET_PICK
 *   queued spawn/kill/write commands, SWARM_SET_PARAMS (when dirty),
 *   SWARM_STEP (autoStep / step()), SWARM_DRAW.
 * Steady state per frame: ~70 bytes and zero allocations.
 *
 * Shader language (ARCHITECTURE §14.1): WGSL when the renderer has compute +
 * vertex storage; GLSL (transform feedback) otherwise. The GLSL composer is
 * loaded with a dynamic import on the first WebGL2 frame; the swarm emits
 * nothing until it is ready. On WebGL2 a behavior without `glsl`, allocation
 * 'gpu' or a capacity above SWARM_GL_MAX_CAPACITY disables the swarm for that
 * renderer: one console error, nothing drawn, readbacks reject with the code.
 *
 * External sources (M2.5, ARCHITECTURE §19.4): `setSource` queues
 * SWARM_SET_SOURCE behind the commands already queued, so earlier spawns and
 * writes still reach the own buffers. While a source is set the draw (and,
 * with `simulate`, step) count is `setSourceCount`'s value, carried by the
 * existing SWARM_DRAW / SWARM_STEP words; nothing else is sent per frame.
 */
import { BlendModeId } from '../backend/types';
import type { BlendMode } from '../backend/types';
import {
  CommandFlag,
  Op,
  OpcodeRange,
  ReadbackSource,
  SwarmSourceFlag,
} from '../commands/opcodes';
import { registerCoreSystemLoader } from '../renderer/lazySystems';
import type { CommandWriter } from '../commands/types';
import { ensureTextureUploaded } from '../scene/Texture';
import { NodeBase } from '../scene/Node';
import type { DestroyOptions, TextureHandle } from '../scene/types';
import type { SwarmExternalSource } from './types';
import type { CustomDrawable, FrontFrame, RendererHost } from '../types/core';
import { CozyGPUError } from '../types/errors';
import type { CozyGPUErrorCode } from '../types/errors';
import { ids, NO_ID } from '../types/ids';
import {
  SWARM_COLD_BYTES,
  SWARM_HOT_BYTES,
  SI_PICK_MAX,
  SwarmRenderFlag,
} from '../types/layouts';
import { RangeAllocator } from './allocator';
import {
  flushSwarmDestroys,
  queueSwarmDestroy,
  queueSwarmRelease,
} from './destroyQueue';
import {
  composeSwarmShaders,
  firstBehaviorWithoutGlsl,
  isGlslComposerLoaded,
} from './composer';
import {
  SWARM_DEFAULT_CIRCLE_SIZE,
  SwarmInternalRenderFlag,
  SwarmReadbackKind,
} from './constants';
import { SWARM_GL_MAX_CAPACITY, SWARM_GL_WARN_CAPACITY } from './types';
import { createBehaviorSet } from './params';
import type { BehaviorSet } from './params';
import { CommandQueue } from './queue';
import { encodeSpawnParams, SPAWN_WORDS } from './spawn';
import type {
  Behavior,
  BehaviorDefinition,
  ComposedSwarmShaders,
  ParamSpec,
  SpawnOptions,
  SwarmNode,
  SwarmOptions,
} from './types';

/** The renderer's Frame forwards rare events (optional: test frames do not). */
type FrameWithEmit = FrontFrame & { _emit?: RendererHost['_emit'] };

function validateOptions(options: SwarmOptions): SwarmOptions {
  const capacity = Math.floor(options?.capacity ?? 0);
  if (!(capacity > 0) || capacity > 0xffffffff / SWARM_HOT_BYTES) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `Swarm capacity must be a positive integer (got ${options?.capacity})`,
    );
  }
  return options;
}

/**
 * Internal options (`Particles`, ARCHITECTURE §24.4): `curves` compiles the
 * over-life curve lookup into the render shader (SwarmRenderFlag.CURVES) and
 * makes SWARM_SET_CURVES take effect. Not part of the public SwarmOptions.
 * @internal
 */
export interface SwarmCurveOptions extends SwarmOptions {
  readonly curves?: boolean;
}

type ShaderLanguage = 'wgsl' | 'glsl300es';

/** GLSL composer loading state (shared by every Swarm in this heap). */
let glslLoading = false;
let glslFailed = false;

/** True when the GLSL composer can be used; starts loading it otherwise. */
function glslReady(): boolean {
  if (isGlslComposerLoaded()) return true;
  if (!glslLoading && !glslFailed) {
    glslLoading = true;
    import('./glsl').then(
      module => {
        module.installGlslComposer();
        glslLoading = false;
      },
      (error: unknown) => {
        glslLoading = false;
        glslFailed = true;
        (globalThis as { console?: Console }).console?.error(
          '[cozygpu:INTERNAL] Swarm: loading the GLSL composer failed',
          error,
        );
      },
    );
  }
  return false;
}

const HOT_WORDS = SWARM_HOT_BYTES / 4;
const COLD_WORDS = SWARM_COLD_BYTES / 4;
const utf8 = new TextEncoder();

export { flushSwarmDestroys } from './destroyQueue';

// Main-thread renderers load the swarm core only when Swarm is bundled, and
// only once a swarm actually draws (§18.1): core.ts + coreGl.ts are ~32 KB
// minified and would otherwise sit in the entry chunk. `_emitDraw` emits
// nothing until `frame.isSystemReady(OpcodeRange.SWARM)` turns true.
registerCoreSystemLoader(OpcodeRange.SWARM, () =>
  import('./core').then(m => m.createSwarmCoreSystem),
);

export class Swarm extends NodeBase implements SwarmNode, CustomDrawable {
  readonly capacity: number;
  readonly allocation: 'ring' | 'manual' | 'gpu';
  autoStep: boolean;
  substeps: number;
  timeScale: number;

  /** Command-stream id (ids.swarm). */
  readonly swarmId: number;

  private _blendMode: BlendMode;
  private _activeCount = 0;
  private cursor = 0;
  private seedCounter = 0;
  private pendingStepDt = 0;
  private readonly allocator: RangeAllocator | null;
  private readonly queue = new CommandQueue();
  private readonly onRestore: SwarmOptions['onRestore'];

  private readonly texture: TextureHandle | undefined;
  private readonly frames: readonly TextureHandle[];
  private readonly frameUVs: Float32Array;
  private readonly defaultWidth: number;
  private readonly defaultHeight: number;
  private readonly renderFlags: number;

  private definitions: readonly BehaviorDefinition[];
  private composed!: ComposedSwarmShaders;
  private computeUtf8!: Uint8Array;
  private renderUtf8!: Uint8Array;
  private behaviorSet!: BehaviorSet;

  private rendererId = -1;
  private generation = -1;
  private created = false;
  private pipelineDirty = false;
  private texId = NO_ID;
  private lastFrame: FrontFrame | null = null;
  /** Language of the program last sent to the core. */
  private language: ShaderLanguage = 'wgsl';
  private glslComputeUtf8: Uint8Array | null = null;
  private glslRenderUtf8: Uint8Array | null = null;
  /** Set while this swarm cannot run on its renderer (WebGL2 limits). */
  private disabledCode: CozyGPUErrorCode | null = null;
  private disabledMessage = '';
  private reportedDisabled = '';
  private glWarned = false;
  /** SWARM_SET_PICK value the core has for this swarm. */
  private sentPickId = 0;
  /** M2.5 external source (null = own buffers) and its draw count. */
  private source: SwarmExternalSource | null = null;
  private sourceCount = 0;
  /** A source was set at least once (clear() must keep a queued switch). */
  private sourceUsed = false;

  constructor(options: SwarmOptions) {
    super(validateOptions(options));
    const capacity = Math.floor(options.capacity);
    this.swarmId = ids.swarm.alloc();

    this.capacity = capacity;
    this.allocation = options.allocation ?? 'ring';
    this.allocator =
      this.allocation === 'manual' ? new RangeAllocator(capacity) : null;
    this._blendMode = options.blendMode ?? 'normal';
    this.autoStep = options.autoStep ?? true;
    this.substeps = Math.max(1, Math.floor(options.substeps ?? 1));
    this.timeScale = options.timeScale ?? 1;
    this.onRestore = options.onRestore;

    // textures / frames
    this.texture = options.texture ?? options.frames?.[0];
    this.frames =
      options.frames && options.frames.length > 0
        ? options.frames
        : this.texture
          ? [this.texture]
          : [];
    const n = Math.max(1, this.frames.length);
    this.frameUVs = new Float32Array(n * 4);
    if (this.frames.length === 0) {
      this.frameUVs.set([0, 0, 1, 1]);
    }
    for (let f = 0; f < this.frames.length; f++) {
      const t = this.frames[f];
      if (this.texture && t.sourceId !== this.texture.sourceId) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          'Swarm frames must all share one texture source',
        );
      }
      this.frameUVs[f * 4] = t.frame.x / t.sourceWidth;
      this.frameUVs[f * 4 + 1] = t.frame.y / t.sourceHeight;
      this.frameUVs[f * 4 + 2] = (t.frame.x + t.frame.width) / t.sourceWidth;
      this.frameUVs[f * 4 + 3] = (t.frame.y + t.frame.height) / t.sourceHeight;
    }
    const shape = options.shape ?? 'quad';
    this.defaultWidth =
      shape === 'quad' && this.frames.length > 0
        ? this.frames[0].width
        : SWARM_DEFAULT_CIRCLE_SIZE;
    this.defaultHeight =
      shape === 'quad' && this.frames.length > 0
        ? this.frames[0].height
        : SWARM_DEFAULT_CIRCLE_SIZE;

    let flags = 0;
    const render = options.render;
    if (render?.fadeOut) flags |= SwarmRenderFlag.FADE_OUT;
    if (render?.shrink) flags |= SwarmRenderFlag.SHRINK;
    if (render?.alignToVelocity) flags |= SwarmRenderFlag.ALIGN_TO_VELOCITY;
    if (shape === 'circle') flags |= SwarmRenderFlag.CIRCLE;
    if ((options as SwarmCurveOptions).curves) flags |= SwarmRenderFlag.CURVES;
    if (render?.cull) flags |= SwarmInternalRenderFlag.CULL;
    if (this.allocation === 'gpu') flags |= SwarmInternalRenderFlag.GPU_ALLOC;
    this.renderFlags = flags;

    this.definitions = options.behaviors ?? [];
    this.applyBehaviors(this.definitions);
  }

  // ─── SceneNode ────────────────────────────────────────────────────────────

  get kind(): 'swarm' {
    return 'swarm';
  }

  destroy(options?: DestroyOptions): void {
    if (this._destroyed) return;
    super.destroy(options);
    this.queue.reset();
    if (this.created) {
      queueSwarmDestroy(this.rendererId, this.swarmId);
    } else {
      ids.swarm.free(this.swarmId);
    }
    this.created = false;
    this.lastFrame = null;
  }

  // ─── Swarm state ──────────────────────────────────────────────────────────

  get activeCount(): number {
    return this._activeCount;
  }

  get blendMode(): BlendMode {
    return this._blendMode;
  }

  set blendMode(mode: BlendMode) {
    if (mode === this._blendMode) return;
    this._blendMode = mode;
    if (this.created) this.pipelineDirty = true;
  }

  get behaviors(): readonly Behavior[] {
    return this.behaviorSet.handles as readonly Behavior[];
  }

  behavior<P extends ParamSpec = ParamSpec>(name: string): Behavior<P> {
    const handle = this.behaviorSet.byName.get(name);
    if (!handle) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `Swarm has no behavior named "${name}"`,
      );
    }
    return handle as unknown as Behavior<P>;
  }

  setBehaviors(definitions: readonly BehaviorDefinition[]): void {
    this.assertAlive();
    this.applyBehaviors(definitions);
    if (this.created) this.pipelineDirty = true;
  }

  // ─── Mutations (queued) ───────────────────────────────────────────────────

  spawn(count: number, options?: SpawnOptions): number {
    this.assertOwnData();
    const n = Math.min(Math.floor(count), this.capacity);
    if (!(n > 0)) {
      return this.allocator ? -1 : this.allocation === 'gpu' ? 0 : this.cursor;
    }
    const seed =
      options?.seed ??
      Math.imul(this.swarmId, 0x9e3779b1) ^
        Math.imul(++this.seedCounter, 0x85ebca77);

    if (this.allocation === 'gpu') {
      // Slots come from the GPU free list; the core ignores `first`.
      this.enqueueSpawn(0, n, seed, options);
      this._activeCount = this.capacity;
      return 0;
    }

    if (this.allocator) {
      const first = this.allocator.alloc(n);
      if (first < 0) return -1;
      this.enqueueSpawn(first, n, seed, options);
      this._activeCount = this.allocator.highWater;
      return first;
    }

    const first = this.cursor;
    const end = first + n;
    if (end <= this.capacity) {
      this.enqueueSpawn(first, n, seed, options);
    } else {
      this.enqueueSpawn(first, this.capacity - first, seed, options);
      this.enqueueSpawn(0, end - this.capacity, seed, options);
    }
    this.cursor = end % this.capacity;
    this._activeCount = Math.min(
      this.capacity,
      Math.max(this._activeCount, end),
    );
    return first;
  }

  write(first: number, hot?: Float32Array, cold?: Uint32Array): void {
    this.assertOwnData();
    if (first < 0 || first >= this.capacity) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `Swarm.write: first ${first} out of range`,
      );
    }
    if (hot && hot.length > 0) {
      if (hot.length % HOT_WORDS !== 0) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `Swarm.write: hot length must be a multiple of ${HOT_WORDS}`,
        );
      }
      const count = Math.min(hot.length / HOT_WORDS, this.capacity - first);
      this.enqueueWrite(Op.SWARM_WRITE_HOT, first, count, SWARM_HOT_BYTES, hot);
      if (this.allocation === 'gpu') {
        this._activeCount = this.capacity;
      } else if (!this.allocator) {
        this._activeCount = Math.max(this._activeCount, first + count);
      }
    }
    if (cold && cold.length > 0) {
      if (cold.length % COLD_WORDS !== 0) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `Swarm.write: cold length must be a multiple of ${COLD_WORDS}`,
        );
      }
      const count = Math.min(cold.length / COLD_WORDS, this.capacity - first);
      this.enqueueWrite(
        Op.SWARM_WRITE_COLD,
        first,
        count,
        SWARM_COLD_BYTES,
        cold,
      );
    }
  }

  kill(first: number, count = 1): void {
    this.assertOwnData();
    const f = Math.floor(first);
    const start = Math.max(0, f);
    // Clip [first, first + count) to [0, capacity).
    const n = Math.min(f + Math.floor(count), this.capacity) - start;
    if (!(n > 0)) return;
    const w = this.queue.begin(Op.SWARM_KILL_RANGE, 12, CommandFlag.COMPUTE);
    const u32 = this.queue.u32;
    u32[w] = this.swarmId;
    u32[w + 1] = start;
    u32[w + 2] = n;
    if (this.allocator) {
      this.allocator.free(start, n);
      this._activeCount = this.allocator.highWater;
    }
  }

  killList(indices: Uint32Array, count = indices.length): void {
    this.assertOwnData();
    const n = Math.min(count, indices.length);
    if (!(n > 0)) return;
    const w = this.queue.begin(
      Op.SWARM_KILL_LIST,
      8 + n * 4,
      CommandFlag.COMPUTE,
    );
    const u32 = this.queue.u32;
    u32[w] = this.swarmId;
    u32[w + 1] = n;
    u32.set(indices.subarray(0, n), w + 2);
    if (this.allocator) {
      for (let k = 0; k < n; k++) this.allocator.free(indices[k], 1);
      this._activeCount = this.allocator.highWater;
    }
  }

  clear(): void {
    this.assertOwnData();
    this.queue.reset();
    // The reset may have dropped a queued setSource(null).
    if (this.sourceUsed) this.enqueueSource();
    if (this._activeCount > 0) {
      const w = this.queue.begin(Op.SWARM_KILL_RANGE, 12, CommandFlag.COMPUTE);
      const u32 = this.queue.u32;
      u32[w] = this.swarmId;
      u32[w + 1] = 0;
      u32[w + 2] = this._activeCount;
    }
    this.cursor = 0;
    this._activeCount = 0;
    this.allocator?.reset();
  }

  step(dt: number): void {
    if (dt > 0) this.pendingStepDt += dt;
  }

  // ─── Readback ─────────────────────────────────────────────────────────────

  readHot(first: number, count: number): Promise<Float32Array> {
    return this.readback(SwarmReadbackKind.HOT, first, count).then(
      buffer => new Float32Array(buffer),
    );
  }

  readCold(first: number, count: number): Promise<Uint32Array> {
    return this.readback(SwarmReadbackKind.COLD, first, count).then(
      buffer => new Uint32Array(buffer),
    );
  }

  /**
   * M2 (ARCHITECTURE §14.3). 'gpu': the free-list counter maintained by the
   * compaction pass; 'ring' / 'manual': live objects in [0, activeCount),
   * counted by a compute pass (WebGPU) or on the core thread (WebGL2).
   */
  aliveCount(): Promise<number> {
    const range = this.source ? this.sourceCount : this._activeCount;
    return this.readback(ReadbackSource.SWARM_ALIVE, 0, range).then(buffer =>
      buffer.byteLength >= 4 ? new Uint32Array(buffer, 0, 1)[0] : 0,
    );
  }

  /** M2.5 (ARCHITECTURE §19.4). See SwarmNode.setSource. */
  setSource(source: SwarmExternalSource | null): void {
    this.assertAlive();
    if (!source) {
      if (!this.source) return;
      this.source = null;
      this.enqueueSource();
      return;
    }
    if (this.allocation === 'gpu') {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        "Swarm.setSource: allocation 'gpu' swarms cannot use an external source",
      );
    }
    if (this.created && this.language === 'glsl300es') {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'Swarm.setSource: external sources need the WebGPU backend',
      );
    }
    const { hot, cold } = source;
    if (!hot || hot.layout !== 'swarm-hot' || !hot.valid) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        "Swarm.setSource: hot must be a valid 'swarm-hot' buffer",
      );
    }
    if (cold && (cold.layout !== 'swarm-cold' || !cold.valid)) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        "Swarm.setSource: cold must be a valid 'swarm-cold' buffer",
      );
    }
    const count = Math.floor(source.count);
    if (
      !(count >= 0) ||
      count > hot.capacity ||
      (cold !== undefined && count > cold.capacity)
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `Swarm.setSource: count ${source.count} exceeds the buffer capacity`,
      );
    }
    this.source = source;
    this.sourceUsed = true;
    this.sourceCount = Math.min(count, this.capacity);
    this.enqueueSource();
  }

  /** M2.5 (ARCHITECTURE §19.4). See SwarmNode.setSourceCount. */
  setSourceCount(count: number): void {
    const source = this.source;
    if (!source) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'Swarm.setSourceCount: no external source is set',
      );
    }
    let limit = Math.min(this.capacity, source.hot.capacity);
    if (source.cold) limit = Math.min(limit, source.cold.capacity);
    const n = Math.floor(count);
    this.sourceCount = n > 0 ? Math.min(n, limit) : 0;
  }

  // ─── Frame encoding ───────────────────────────────────────────────────────

  /** @internal */
  _emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    if (this._destroyed) return;
    // Local mode may still be importing the swarm core chunk; nothing would
    // consume SWARM commands yet. Retry next frame.
    if (!frame.isSystemReady(OpcodeRange.SWARM)) return;
    flushSwarmDestroys(frame);
    const enc = frame.encoder;

    const caps = frame.caps;
    const language: ShaderLanguage =
      !(caps.compute && caps.vertexStorage) && caps.transformFeedback
        ? 'glsl300es'
        : 'wgsl';
    if (language === 'glsl300es') {
      if (!this.checkGlSupport(frame)) {
        // Nothing will consume the queue on this renderer.
        this.queue.reset();
        this.pendingStepDt = 0;
        this.lastFrame = frame;
        return;
      }
      if (!glslReady()) return;
      if (!this.glslComputeUtf8) this.composeGlsl();
    } else {
      this.disabledCode = null;
    }

    if (this.texture) {
      const texId = ensureTextureUploaded(frame, this.texture);
      if (texId !== this.texId) {
        this.texId = texId;
        if (this.created) this.pipelineDirty = true;
      }
    }

    if (
      !this.created ||
      frame.rendererId !== this.rendererId ||
      frame.generation !== this.generation
    ) {
      const recreated = this.created;
      const restored =
        this.created &&
        frame.rendererId === this.rendererId &&
        frame.generation !== this.generation;
      if (this.created && frame.rendererId !== this.rendererId) {
        // Moved to another renderer: free the GPU buffers on the old one.
        queueSwarmRelease(this.rendererId, this.swarmId);
      }
      this.rendererId = frame.rendererId;
      this.generation = frame.generation;
      this.created = true;
      this.pipelineDirty = false;
      this.language = language;
      this.sentPickId = 0;
      this.emitCreate(enc);
      this.emitFrames(enc);
      this.behaviorSet.mirror.dirty = true;
      if (restored) {
        // GPU contents are gone: start from an empty swarm. Queued
        // spawns/kills/writes target the lost state and slot ranges the
        // reset cursor/allocator will hand out again, so drop them too.
        this.queue.reset();
        this.cursor = 0;
        this._activeCount = 0;
        this.allocator?.reset();
        // The core dropped every external registration together with the
        // device (ARCHITECTURE §19.4), so the source went with it. Dropping
        // it here too puts the swarm back on its own buffers, which is what
        // lets `onRestore` refill them: a draw-only source (hot only) still
        // reads colour, frame and user id from the swarm's own cold records,
        // and those are empty again after a restore, so a swarm that only
        // re-registered its hot buffer would draw fully transparent quads.
        // The caller recreates and re-registers its buffers on the new device
        // and calls setSource() again; the stale handles are invalid, so a
        // re-registration that was missed throws instead of drawing nothing.
        this.source = null;
        this.sourceCount = 0;
        this.onRestore?.(this);
      }
      // Moved to another renderer: re-send the source there. After a restore
      // the source was dropped above, and setSource() enqueues its own
      // command if onRestore set a new one.
      if (recreated && !restored && this.source) this.enqueueSource();
    } else if (this.pipelineDirty || language !== this.language) {
      this.pipelineDirty = false;
      this.language = language;
      this.emitPipeline(enc, Op.SWARM_SET_PIPELINE);
    }
    this.lastFrame = frame;

    const pickId = this.pickable && this.id <= SI_PICK_MAX ? this.id : 0;
    if (pickId !== this.sentPickId) {
      this.sentPickId = pickId;
      enc.begin(Op.SWARM_SET_PICK, 8);
      enc.u32(this.swarmId);
      enc.u32(pickId);
      enc.end();
    }

    if (!this.queue.empty) this.queue.flushInto(enc);

    const mirror = this.behaviorSet.mirror;
    if (mirror.dirty) {
      mirror.dirty = false;
      enc.begin(Op.SWARM_SET_PARAMS, 12 + mirror.bytes);
      enc.u32(this.swarmId);
      enc.u32(0);
      enc.u32(mirror.bytes);
      const words = mirror.bytes >> 2;
      for (let k = 0; k < words; k++) enc.u32(mirror.u32[k]);
      enc.end();
    }

    const dt =
      this.pendingStepDt + (this.autoStep ? frame.dt * this.timeScale : 0);
    this.pendingStepDt = 0;
    const source = this.source;
    const active = source ? this.sourceCount : this._activeCount;
    if (dt > 0 && active > 0 && (!source || source.simulate)) {
      enc.begin(Op.SWARM_STEP, 16, CommandFlag.COMPUTE);
      enc.u32(this.swarmId);
      enc.f32(dt);
      enc.u32(this.substeps);
      enc.u32(active);
      enc.end();
    }

    if (active > 0) {
      enc.begin(Op.SWARM_DRAW, 36, CommandFlag.DRAW);
      enc.u32(this.swarmId);
      for (let k = 0; k < 6; k++) enc.f32(world[worldOffset + k]);
      enc.f32(worldAlpha);
      enc.u32(active);
      enc.end();
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this._destroyed) {
      throw new CozyGPUError('DESTROYED', 'Swarm has been destroyed');
    }
  }

  /** Mutations need the swarm's own buffers (no external source, §19.4). */
  private assertOwnData(): void {
    this.assertAlive();
    if (this.source) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'Swarm: spawn, kill, killList, write and clear are not available ' +
          'while an external source is set (setSource(null) first)',
      );
    }
  }

  /** Queues SWARM_SET_SOURCE behind the commands already queued. */
  private enqueueSource(): void {
    const w = this.queue.begin(Op.SWARM_SET_SOURCE, 16);
    const u32 = this.queue.u32;
    const source = this.source;
    u32[w] = this.swarmId;
    u32[w + 1] = source ? source.hot.id : 0;
    u32[w + 2] = source?.cold ? source.cold.id : 0;
    u32[w + 3] = source?.simulate ? SwarmSourceFlag.SIMULATE : 0;
  }

  /**
   * WebGL2 limits (ARCHITECTURE §14.1). Returns false (and reports once) when
   * this swarm cannot run there.
   */
  private checkGlSupport(frame: FrontFrame): boolean {
    let code: CozyGPUErrorCode | null = null;
    let message = '';
    const missing = firstBehaviorWithoutGlsl(this.definitions);
    if (this.source) {
      // M2.5: setSource before the first WebGL2 frame (it throws after).
      code = 'UNSUPPORTED';
      message = 'Swarm: external sources (setSource) need the WebGPU backend';
    } else if (this.allocation === 'gpu') {
      code = 'UNSUPPORTED';
      message =
        "Swarm: allocation 'gpu' needs WebGPU compute; use 'ring' on WebGL2";
    } else if (this.capacity > SWARM_GL_MAX_CAPACITY) {
      code = 'OUT_OF_CAPACITY';
      message =
        `Swarm: capacity ${this.capacity} exceeds the WebGL2 limit of ` +
        `${SWARM_GL_MAX_CAPACITY} objects`;
    } else if (missing !== undefined) {
      code = 'UNSUPPORTED';
      message =
        `Swarm: behavior "${missing}" has no GLSL variant (\`glsl\`), so ` +
        'the swarm cannot run on WebGL2';
    }
    this.disabledCode = code;
    this.disabledMessage = message;
    const console = (globalThis as { console?: Console }).console;
    if (code) {
      if (this.reportedDisabled !== message) {
        this.reportedDisabled = message;
        const text = `${message}; nothing is drawn.`;
        console?.error(`[cozygpu:${code}] ${text}`);
        // The same refusal a WebGPU core reports as an 'error' message: tell
        // RendererOptions.events too (once per refusal, never per frame).
        (frame as FrameWithEmit)._emit?.('error', { code, message: text });
      }
      return false;
    }
    if (this.capacity > SWARM_GL_WARN_CAPACITY && !this.glWarned) {
      this.glWarned = true;
      console?.warn(
        `[cozygpu] Swarm: capacity ${this.capacity} on WebGL2 simulates ` +
          'every slot with transform feedback each frame; expect less than ' +
          `60 fps above ${SWARM_GL_WARN_CAPACITY} objects on integrated GPUs.`,
      );
    }
    return true;
  }

  private composeGlsl(): void {
    // Render flags internal to WebGPU (cull) do not apply on WebGL2.
    const flags = this.renderFlags & 0xff;
    const composed = composeSwarmShaders(this.definitions, flags, 'glsl300es');
    this.glslComputeUtf8 = utf8.encode(composed.compute);
    this.glslRenderUtf8 = utf8.encode(composed.render);
  }

  private applyBehaviors(definitions: readonly BehaviorDefinition[]): void {
    const composed = composeSwarmShaders(definitions, this.renderFlags);
    this.behaviorSet = createBehaviorSet(
      definitions,
      composed,
      this.behaviorSet,
    );
    this.definitions = definitions;
    this.composed = composed;
    this.computeUtf8 = utf8.encode(composed.compute);
    this.renderUtf8 = utf8.encode(composed.render);
    this.glslComputeUtf8 = null;
    this.glslRenderUtf8 = null;
  }

  private enqueueSpawn(
    first: number,
    count: number,
    seed: number,
    options: SpawnOptions | undefined,
  ): void {
    const w = this.queue.begin(
      Op.SWARM_SPAWN,
      4 + SPAWN_WORDS * 4,
      CommandFlag.COMPUTE,
    );
    this.queue.u32[w] = this.swarmId;
    encodeSpawnParams(
      this.queue.u32,
      this.queue.f32,
      w + 1,
      first,
      count,
      seed,
      options,
      this.defaultWidth,
      this.defaultHeight,
    );
  }

  private enqueueWrite(
    opcode: number,
    first: number,
    count: number,
    recordBytes: number,
    data: Float32Array | Uint32Array,
  ): void {
    const bytes = count * recordBytes;
    const w = this.queue.begin(opcode, 12 + bytes);
    const q = this.queue;
    q.u32[w] = this.swarmId;
    q.u32[w + 1] = first;
    q.u32[w + 2] = count;
    q.u8.set(new Uint8Array(data.buffer, data.byteOffset, bytes), (w + 3) * 4);
  }

  private emitCreate(enc: CommandWriter): void {
    this.emitPipeline(enc, Op.SWARM_CREATE);
  }

  /** SWARM_CREATE (with capacity) or SWARM_SET_PIPELINE (without). */
  private emitPipeline(enc: CommandWriter, opcode: number): void {
    const withCapacity = opcode === Op.SWARM_CREATE;
    const gl = this.language === 'glsl300es';
    const c = gl ? this.glslComputeUtf8! : this.computeUtf8;
    const r = gl ? this.glslRenderUtf8! : this.renderUtf8;
    const header = withCapacity ? 32 : 28;
    enc.begin(
      opcode,
      header + ((c.byteLength + 3) & ~3) + ((r.byteLength + 3) & ~3),
    );
    enc.u32(this.swarmId);
    if (withCapacity) enc.u32(this.capacity);
    enc.u32(this.texture ? this.texId : NO_ID);
    enc.u32(BlendModeId[this._blendMode] ?? BlendModeId.normal);
    enc.u32(gl ? this.renderFlags & 0xff : this.renderFlags);
    enc.u32(this.composed.paramsBytes);
    enc.u32(c.byteLength);
    enc.u32(r.byteLength);
    enc.bytes(c);
    enc.bytes(r);
    enc.end();
  }

  private emitFrames(enc: CommandWriter): void {
    const uv = this.frameUVs;
    const count = uv.length / 4;
    enc.begin(Op.SWARM_SET_FRAMES, 8 + uv.length * 4);
    enc.u32(this.swarmId);
    enc.u32(count);
    for (let k = 0; k < uv.length; k++) enc.f32(uv[k]);
    enc.end();
  }

  private readback(
    kind: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer> {
    if (this._destroyed) {
      return Promise.reject(
        new CozyGPUError('DESTROYED', 'Swarm has been destroyed'),
      );
    }
    if (this.disabledCode) {
      return Promise.reject(
        new CozyGPUError(this.disabledCode, this.disabledMessage),
      );
    }
    const frame = this.lastFrame;
    if (!frame || !this.created) {
      return Promise.reject(
        new CozyGPUError(
          'INVALID_ARGUMENT',
          'Swarm readback needs the swarm to have been rendered once',
        ),
      );
    }
    const start = Math.max(0, Math.floor(first));
    const n = Math.max(0, Math.min(Math.floor(count), this.capacity - start));
    return frame.readback(kind, this.swarmId, start, n);
  }
}
