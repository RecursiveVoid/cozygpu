/**
 * Front ↔ core internal contracts. SHARED + FROZEN during build.
 *
 *   FRONT (main thread, public API)          CORE (render thread: main or worker)
 *   Renderer, Container, Sprite, Swarm  ──►  RenderCore → CoreSystem[] → Backend (RHI)
 *          │  encode into CommandEncoder          ▲ decode FramePacket
 *          └──────────── Transport (local | worker) ┘
 *
 * See docs/ARCHITECTURE.md §2–§6.
 */
import type {
  Backend,
  BackendPreference,
  Capabilities,
  CommandList,
  RenderPass,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiSampler,
  RhiTexture,
} from '../backend/types';
import type {
  CommandEncoder,
  CommandReader,
  FramePacket,
} from '../commands/types';
import type { ContainerNode } from '../scene/types';
import type { PickHit } from './renderer';
import type { CoreMessage } from './transport';

// ─── FRONT side ───────────────────────────────────────────────────────────────

/** Per-frame context handed to front-side code while encoding a frame. Reused object. */
export interface FrontFrame {
  readonly rendererId: number;
  /**
   * M2. The core's capabilities (plain data). Front code picks WGSL or GLSL
   * variants by `caps.shaderLanguage` / `caps.compute` (Swarm on WebGL2).
   */
  readonly caps: Capabilities;
  readonly encoder: CommandEncoder;
  readonly frameId: number;
  /** Seconds since renderer creation. */
  readonly time: number;
  /** Seconds since previous render(), clamped to [0, 0.1]. */
  readonly dt: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly resolution: number;
  /**
   * True when the core can read front memory directly (main-thread mode, or
   * worker mode with SharedArrayBuffer). Then use *_SHARED upload opcodes;
   * otherwise copy bytes inline into the stream.
   */
  readonly sharedMemory: boolean;
  /** True when a SharedArrayBuffer should be allocated for stores (worker + crossOriginIsolated). */
  readonly useSharedArrayBuffer: boolean;
  /**
   * Bumped after a device loss is recovered. Front objects compare against
   * their last-seen generation and re-create/re-upload everything they own.
   */
  readonly generation: number;
  /** Emits SHARED_REGISTER once per (buffer, generation); returns the sharedId. */
  registerShared(buffer: ArrayBuffer | SharedArrayBuffer): number;
  /** Allocates a requestId, emits READBACK, resolves with the bytes. */
  readback(
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer>;
  /**
   * M2. True when the core system for opcode range `range` can take commands.
   * Worker mode: always true (the worker bundle is eager). Local mode: false
   * until a lazily imported system (ARCHITECTURE §18.1) finished loading;
   * the first call starts the import. Front code emits nothing for that range
   * while false and retries next frame.
   */
  isSystemReady(range: number): boolean;
}

/**
 * M2. Per-frame front hook (assets). Registered through
 * `RendererHost._addFrameHook`; `encodeFrame` runs inside render() after the
 * control commands and before the scene is packed.
 */
export interface FrontFrameHook {
  encodeFrame(frame: FrontFrame): void;
  /** After `deviceRestored` (generation already bumped): re-upload GPU-only data. */
  onDeviceRestored?(): void;
  /** Renderer destroyed: drop GPU bookkeeping (the core is gone). */
  onRendererDestroyed?(): void;
}

/**
 * M2. Internal surface of the concrete Renderer (src/renderer/Renderer.ts)
 * for library modules that must encode outside the scene pack. Not public.
 */
export interface RendererHost {
  readonly _rendererId: number;
  readonly _caps: Capabilities;
  /** Adds a hook; returns its remover. */
  _addFrameHook(hook: FrontFrameHook): () => void;
}

/** Owner: "sprites" (src/sprites/front.ts → createScenePacker). */
export interface ScenePacker {
  /**
   * Walks `stage` in draw order: updates dirty world transforms, packs sprite
   * instances, emits SPRITE_UPLOAD(_SHARED) for dirty ranges and SPRITE_DRAW
   * per contiguous (texture, blend) batch; for CustomDrawable nodes it flushes
   * the open batch and calls `emitDraw`.
   */
  pack(stage: ContainerNode, frame: FrontFrame): void;
  destroy(): void;
}

/** Implemented by non-sprite drawables (Swarm now; Graphics/Text later). */
export interface CustomDrawable {
  /** @internal Called in traversal order with the node's world transform. */
  _emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void;
}

export function isCustomDrawable(node: unknown): node is CustomDrawable {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as { _emitDraw?: unknown })._emitDraw === 'function'
  );
}

// ─── CORE side ────────────────────────────────────────────────────────────────

export interface CoreInitOptions {
  backend: BackendPreference;
  powerPreference?: 'low-power' | 'high-performance';
  limits?: 'default' | 'max';
  alphaMode?: 'opaque' | 'premultiplied';
  antialias: boolean;
  /** WebGPU error scopes + shader warnings. Default false (or `globalThis.__COZYGPU_DEBUG__`). */
  debug?: boolean;
}

export interface CoreTexture {
  readonly texture: RhiTexture;
  readonly sampler: RhiSampler;
  /** Built against CoreContext.textureLayout (binding 0 texture, binding 1 sampler). */
  readonly bindGroup: RhiBindGroup;
  readonly width: number;
  readonly height: number;
}

export interface CoreContext {
  readonly backend: Backend;
  /** @group(0): binding 0 = View uniform (layouts.ts VIEW_UNIFORM_BYTES), VERTEX|FRAGMENT|COMPUTE. */
  readonly viewLayout: RhiBindGroupLayout;
  readonly viewBindGroup: RhiBindGroup;
  /** @group(1) layout for a texture + sampler pair. */
  readonly textureLayout: RhiBindGroupLayout;
  /** 1×1 opaque white, always valid. */
  readonly whiteTexture: CoreTexture;
  /** Unknown/destroyed ids return whiteTexture. */
  getTexture(texId: number): CoreTexture;
  getShared(sharedId: number): ArrayBuffer | SharedArrayBuffer | undefined;
  /** Main pass sample count (4 when antialias). Pipelines must match. */
  readonly sampleCount: 1 | 4;
  post(message: CoreMessage, transfer?: Transferable[]): void;
}

export interface CoreFrameState {
  readonly frameId: number;
  readonly time: number;
  readonly dt: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly resolution: number;
}

/**
 * A pluggable consumer of one opcode range. Owners: sprites → src/sprites/core.ts,
 * swarm → src/swarm/core.ts. RenderCore (backend) routes by `range`.
 *
 * Per packet RenderCore does:
 *   1. for each command: DRAW-flagged → remember offset; else system.execute()
 *   2. compute phase: system.compute(list) for systems that queued work
 *   3. main render pass: replay DRAW commands in order → system.draw()
 *   4. submit, then system.endFrame()
 */
export interface CoreSystem {
  readonly name: string;
  /** Opcode high byte (OpcodeRange.*). */
  readonly range: number;
  init(ctx: CoreContext): Promise<void>;
  execute(reader: CommandReader, frame: CoreFrameState): void;
  compute?(list: CommandList, frame: CoreFrameState): void;
  draw(reader: CommandReader, pass: RenderPass, frame: CoreFrameState): void;
  endFrame?(frame: CoreFrameState): void;
  /**
   * READBACK hook. Returns undefined when (srcKind, srcId) is not this
   * system's source. Reads GPU memory as of the last submitted frame.
   */
  readback?(
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer> | undefined;
  /**
   * M2 picking (ARCHITECTURE §16.3). Replays this system's DRAW command
   * during the pick pass (same stream order as `draw`). Bind `view` as
   * group 0 instead of `CoreContext.viewBindGroup`. Pick pipelines target
   * `PICK_TARGET_FORMAT` (rg32uint), sampleCount 1, blend 'none', and write
   * `vec2u(objectId, instance + 1)` (sprites: `(pickId, 0)`). Systems without
   * this hook are invisible to picking.
   */
  drawPick?(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    view: RhiBindGroup,
  ): void;
  /** Device restored: rebuild GPU objects from retained CPU state. GPU-only data is gone. */
  restore(ctx: CoreContext): Promise<void>;
  destroy(): void;
}

// ─── Picking seams (M2) ───────────────────────────────────────────────────────

/**
 * What RenderCore hands the core picking module to replay DRAW commands.
 * Reused object; valid only during `CorePicking.render`.
 */
export interface PickReplay {
  /** DRAW commands recorded this packet. */
  readonly drawCount: number;
  /** Seeks DRAW command `index` and calls its system's `drawPick` (no-op if absent). */
  drawPick(index: number, pass: RenderPass, view: RhiBindGroup): void;
}

/**
 * Owner: "sprites" (src/renderer/pickingCore.ts → createCorePicking).
 * RenderCore calls it; it owns the 1×1 pick target, the pick View uniforms
 * and the readbacks. DOM-free.
 */
export interface CorePicking {
  /** PICK command seen while executing a packet. */
  request(requestId: number, x: number, y: number): void;
  /** Requests waiting for `render` this packet. */
  readonly pending: number;
  /** After the main pass, on the same CommandList (before submit). */
  render(list: CommandList, replay: PickReplay, frame: CoreFrameState): void;
  /** After `list.submit()`: starts readbacks; posts CoreMessage 'pick' when done. */
  afterSubmit(): void;
  /** Answers every queued or in-flight request with `code` (device loss, destroy). */
  failAll(code: 'DEVICE_LOST' | 'DESTROYED', message: string): void;
  restore(ctx: CoreContext): Promise<void>;
  destroy(): void;
}

/**
 * Owner: "sprites" (src/renderer/picking.ts → createPickClient). Front half of
 * `renderer.pick()`; the Renderer forwards 'pick' messages to it.
 */
export interface PickClient {
  /** Queues a PICK for the next render(); resolves when the core answers. */
  pick(x: number, y: number): Promise<PickHit | null>;
  /** Called while encoding a frame (after control commands): emits queued PICK commands. */
  encode(frame: FrontFrame): void;
  handleMessage(message: Extract<CoreMessage, { type: 'pick' }>): void;
  /** Device lost / renderer destroyed: rejects pending picks. */
  rejectAll(code: 'DEVICE_LOST' | 'DESTROYED', message: string): void;
}

/** Owner: "backend" (src/renderer/RenderCore.ts → createRenderCore). */
export interface RenderCore {
  readonly caps: Backend['caps'];
  /** M2. Why `backend: 'auto'` fell back to WebGL2, when it did (§13.5). */
  readonly fallbackReason?: string;
  /** M2, dev-only. Debug actions driven from the front (see Transport.debug). */
  debug?(action: 'loseDevice'): void;
  /** Executes one packet synchronously; posts FRAME_DONE (with the buffer for recycling). */
  execute(packet: FramePacket): void;
  destroy(): void;
}
