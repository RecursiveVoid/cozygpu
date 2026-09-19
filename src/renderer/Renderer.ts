/**
 * Owner: "renderer-hooks" (M2.5). Public Renderer (front side, always on the
 * main thread).
 *
 * render() follows ARCHITECTURE §2 "Frame lifecycle": skip when the transport
 * is busy, otherwise encode FRAME_BEGIN, queued control commands, the scene
 * (ScenePacker) and FRAME_END into one packet and submit it. Steady state
 * allocates nothing: the FrontFrame object, stats and encoder are reused.
 *
 * M2.5 (ARCHITECTURE §19.2, §19.4): rare lifecycle events go to
 * `RendererOptions.events` through `_emit` (never per frame), and
 * `interop()` loads its implementation chunk on first use.
 */
import { createCommandEncoder } from '../commands';
import {
  COMMAND_HEADER_BYTES,
  CH_FLAGS,
  CH_PAYLOAD_BYTES,
  CommandFlag,
  Op,
  PACKET_HEADER_BYTES,
} from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import { createAssetsProxy } from '../assets/proxy';
import type { AssetsApi } from '../assets/types';
import type { Capabilities } from '../backend/types';
import { Container } from '../scene/Container';
import type { ContainerNode } from '../scene/types';
import { dropTextureUploads } from '../scene/Texture';
import { createScenePacker } from '../sprites/front';
import { dropSwarmDestroys, flushSwarmDestroys } from '../swarm/destroyQueue';
import type {
  FrontFrame,
  FrontFrameHook,
  PickClient,
  RendererHost,
  ScenePacker,
} from '../types/core';
import { CozyGPUError, type CozyGPUErrorCode } from '../types/errors';
import type { EventName, Events } from '../types/events';
import { ids } from '../types/ids';
import type { RendererInterop } from '../types/interop';
import type {
  PickHit,
  Renderer,
  RendererInfo,
  RendererOptions,
  RendererStats,
} from '../types/renderer';
import type { CoreMessage, Transport } from '../types/transport';
import { isCoreSystemReady } from './lazySystems';

let nextRendererId = 1;

/** Resolved, validated options the Renderer needs after transport creation. */
export interface RendererConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  worker: boolean;
  cssWidth: number;
  cssHeight: number;
  /** 'device' tracks devicePixelRatio. */
  resolution: number | 'device';
  autoResize: boolean;
  background: number;
  backgroundAlpha: number;
  onDeviceLost?: RendererOptions['onDeviceLost'];
  onDeviceRestored?: RendererOptions['onDeviceRestored'];
  /** M2. Options for the lazily created `renderer.assets`. */
  assets?: RendererOptions['assets'];
  /** M2.5. Lifecycle event sink. */
  events?: RendererOptions['events'];
}

interface PendingReadback {
  requestId: number;
  srcKind: number;
  srcId: number;
  first: number;
  count: number;
}

interface ReadbackWaiter {
  resolve(data: ArrayBuffer): void;
  reject(error: unknown): void;
}

class Stats implements RendererStats {
  frameId = 0;
  drawCalls = 0;
  packetBytes = 0;
  cpuMs = 0;
  skippedFrames = 0;
}

/** The reused per-frame context handed to the ScenePacker and CustomDrawables. */
class Frame implements FrontFrame {
  encoder!: CommandEncoder;
  frameId = 0;
  time = 0;
  dt = 0;
  cssWidth = 0;
  cssHeight = 0;
  resolution = 1;
  generation = 0;

  constructor(
    readonly rendererId: number,
    readonly sharedMemory: boolean,
    readonly useSharedArrayBuffer: boolean,
    private readonly owner: RendererImpl,
  ) {}

  get caps(): Capabilities {
    return this.owner._caps;
  }

  isSystemReady(range: number): boolean {
    return this.owner._isSystemReady(range);
  }

  /**
   * @internal Rare events observed by front drawables (a Swarm refused on
   * WebGL2 emits 'error' once per refusal). Never per frame. Optional on
   * FrontFrame consumers: test frames need not implement it.
   */
  _emit<K extends EventName>(name: K, payload: Events[K]): void {
    this.owner._emit(name, payload);
  }

  registerShared(buffer: ArrayBuffer | SharedArrayBuffer): number {
    return this.owner._registerShared(buffer);
  }

  readback(
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer> {
    return this.owner._readback(srcKind, srcId, first, count);
  }
}

export class RendererImpl implements Renderer, RendererHost {
  readonly stage: ContainerNode;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly info: RendererInfo;
  readonly stats = new Stats();

  private readonly transport: Transport;
  private readonly encoder: CommandEncoder;
  private readonly packer: ScenePacker;
  private readonly frame: Frame;
  /** M2: per-frame hooks (assets); iterated by index, mutated only on add/remove. */
  private readonly frameHooks: FrontFrameHook[] = [];
  /** Loaded with the picking chunk on the first pick() (ARCHITECTURE §18.1). */
  private pickClient: PickClient | null = null;
  private pickLoading: Promise<PickClient> | null = null;
  private assetsApi: AssetsApi | null = null;
  private interopHandle: Promise<RendererInterop> | null = null;
  /** Event names whose sink threw once (logged once each). */
  private sinkErrors: Set<string> | null = null;

  private cssWidth: number;
  private cssHeight: number;
  private currentResolution: number;
  private readonly trackDevicePixelRatio: boolean;
  private backgroundColor: number;
  private backgroundOpacity: number;

  private resizePending = true;
  private clearColorPending = true;
  private viewPending = true;
  private encoding = false;
  private isDestroyed = false;
  private coreDead = false;

  private readonly startTime: number;
  private lastRenderTime: number;

  private readonly sharedIds = new WeakMap<object, number>();
  private readonly sharedGenerations = new WeakMap<object, number>();
  private readonly pendingReadbacks: PendingReadback[] = [];
  /**
   * requestId → waiter. `null` marks a request already rejected by a device
   * loss whose id stays allocated until the core answers it (so a late answer
   * can never settle a newer request that reused the id).
   */
  private readonly readbackWaiters = new Map<number, ReadbackWaiter | null>();

  private resizeObserver: ResizeObserver | null = null;
  private observesDevicePixels = false;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.watchDevicePixelRatio();

  constructor(
    transport: Transport,
    private readonly config: RendererConfig,
  ) {
    this.transport = transport;
    this.canvas = config.canvas;
    this.cssWidth = config.cssWidth;
    this.cssHeight = config.cssHeight;
    this.trackDevicePixelRatio = config.resolution === 'device';
    this.currentResolution =
      config.resolution === 'device' ? devicePixelRatio() : config.resolution;
    this.backgroundColor = config.background;
    this.backgroundOpacity = config.backgroundAlpha;

    this.info = {
      backend: transport.caps.backend,
      fallbackReason: transport.fallbackReason,
      worker: transport.kind === 'worker',
      sharedMemory: transport.sharedMemory,
      get capabilities() {
        return transport.caps;
      },
    };

    this.encoder = createCommandEncoder();
    this.frame = new Frame(
      nextRendererId++,
      transport.sharedMemory,
      transport.useSharedArrayBuffer,
      this,
    );
    this.frame.encoder = this.encoder;
    this.packer = createScenePacker();
    this.stage = new Container({ label: 'stage' });

    this.startTime = now();
    this.lastRenderTime = this.startTime;

    transport.setListener(message => this.onCoreMessage(message));

    if (config.autoResize) this.observeCanvasSize();
    if (this.trackDevicePixelRatio) this.watchDevicePixelRatio();

    // Before createRenderer() resolves (ARCHITECTURE §19.2).
    const info = this.info;
    const reason = info.fallbackReason;
    if (reason)
      this._emit('fallback', { from: 'webgpu', to: 'webgl2', reason });
    this._emit('ready', {
      backend: info.backend,
      worker: info.worker,
      sharedMemory: info.sharedMemory,
      fallbackReason: reason,
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  get resolution(): number {
    return this.currentResolution;
  }

  get background(): number {
    return this.backgroundColor;
  }

  set background(value: number) {
    if (value === this.backgroundColor) return;
    this.backgroundColor = value;
    this.clearColorPending = true;
  }

  get backgroundAlpha(): number {
    return this.backgroundOpacity;
  }

  set backgroundAlpha(value: number) {
    const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
    if (clamped === this.backgroundOpacity) return;
    this.backgroundOpacity = clamped;
    this.clearColorPending = true;
  }

  get destroyed(): boolean {
    return this.isDestroyed;
  }

  /** M2. Lazily created facade; the implementation chunk loads on first use. */
  get assets(): AssetsApi {
    if (!this.assetsApi) {
      this.assetsApi = createAssetsProxy(this, this.config.assets);
    }
    return this.assetsApi;
  }

  render(): void {
    if (this.isDestroyed) return;
    const start = now();
    const transport = this.transport;
    if (transport.busy) {
      // dt keeps accumulating: lastRenderTime is not advanced.
      this.stats.skippedFrames++;
      return;
    }

    let dt = (start - this.lastRenderTime) / 1000;
    if (dt < 0) dt = 0;
    else if (dt > 0.1) dt = 0.1;
    this.lastRenderTime = start;

    const encoder = this.encoder;
    const frame = this.frame;
    encoder.reset(transport.takeRecycledBuffer());
    frame.frameId = ++this.stats.frameId;
    frame.time = (start - this.startTime) / 1000;
    frame.dt = dt;
    frame.cssWidth = this.cssWidth;
    frame.cssHeight = this.cssHeight;
    frame.resolution = this.currentResolution;

    this.encoding = true;
    try {
      encoder.begin(Op.FRAME_BEGIN, 8);
      encoder.f32(frame.time);
      encoder.f32(dt);
      encoder.end();
      this.encodeControl();
      const hooks = this.frameHooks;
      for (let i = 0; i < hooks.length; i++) hooks[i].encodeFrame(frame);
      this.pickClient?.encode(frame);
      flushSwarmDestroys(frame);
      this.packer.pack(this.stage, frame);
      encoder.begin(Op.FRAME_END, 0);
      encoder.end();
    } finally {
      this.encoding = false;
    }

    const packet = encoder.finish(frame.frameId);
    this.stats.packetBytes = packet.byteLength;
    this.stats.drawCalls = countDrawCommands(encoder, packet.byteLength);
    this.stats.cpuMs = now() - start;
    transport.submit(packet, encoder.transferList);
  }

  resize(width: number, height: number, resolution?: number): void {
    if (this.isDestroyed) return;
    const w = Math.max(0, width);
    const h = Math.max(0, height);
    const res =
      resolution !== undefined && resolution > 0
        ? resolution
        : this.currentResolution;
    if (
      w === this.cssWidth &&
      h === this.cssHeight &&
      res === this.currentResolution
    ) {
      return;
    }
    this.cssWidth = w;
    this.cssHeight = h;
    this.currentResolution = res;
    this.resizePending = true;
    this._emit('resize', { width: w, height: h, resolution: res });
  }

  pick(x: number, y: number): Promise<PickHit | null> {
    if (this.isDestroyed) {
      return Promise.reject(
        new CozyGPUError('DESTROYED', 'renderer was destroyed'),
      );
    }
    const client = this.pickClient;
    if (client) return client.pick(x, y);
    return (this.pickLoading ??= import('./picking').then(
      m => (this.pickClient = m.createPickClient(this)),
    )).then(c =>
      this.isDestroyed
        ? Promise.reject(
            new CozyGPUError('DESTROYED', 'renderer was destroyed'),
          )
        : c.pick(x, y),
    );
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.unobserve();
    const error = new CozyGPUError('DESTROYED', 'renderer was destroyed');
    this.readbackWaiters.forEach(waiter => waiter?.reject(error));
    this.readbackWaiters.clear();
    this.pendingReadbacks.length = 0;
    this.pickClient?.rejectAll('DESTROYED', 'renderer was destroyed');
    try {
      const hooks = this.frameHooks.slice();
      for (let i = 0; i < hooks.length; i++) hooks[i].onRendererDestroyed?.();
      this.frameHooks.length = 0;
      this.assetsApi?.destroy();
      this.stage.destroy({ children: true });
    } finally {
      this.packer.destroy();
      dropSwarmDestroys(this.frame.rendererId);
      dropTextureUploads(this.frame.rendererId);
      this.transport.destroy();
    }
  }

  // ─── RendererHost (M2, internal) ───────────────────────────────────────────

  get _rendererId(): number {
    return this.frame.rendererId;
  }

  get _caps(): Capabilities {
    return this.transport.caps;
  }

  _addFrameHook(hook: FrontFrameHook): () => void {
    this.frameHooks.push(hook);
    return () => {
      const i = this.frameHooks.indexOf(hook);
      if (i >= 0) this.frameHooks.splice(i, 1);
    };
  }

  /**
   * M2.5 (ARCHITECTURE §19.2): forwards a rare event to
   * `RendererOptions.events`. A throwing sink is caught and logged once per
   * event name.
   */
  _emit<K extends EventName>(name: K, payload: Events[K]): void {
    const sink = this.config.events;
    if (!sink) return;
    try {
      sink.emit(name, payload);
    } catch (err) {
      const seen = (this.sinkErrors ??= new Set());
      if (seen.has(name)) return;
      seen.add(name);
      // eslint-disable-next-line no-console
      console.error(`[cozygpu] events sink threw on "${name}"`, err);
    }
  }

  /** M2.5 (ARCHITECTURE §19.4): main-thread mode only; lazy chunk. */
  interop(): Promise<RendererInterop> {
    const transport = this.transport;
    if (this.isDestroyed || !transport.interop) {
      return Promise.reject(
        this.isDestroyed
          ? new CozyGPUError('DESTROYED', 'renderer was destroyed')
          : new CozyGPUError('UNSUPPORTED', 'interop needs worker: false'),
      );
    }
    // A failed chunk load (network error, stale chunk after a deploy) or a
    // throwing setup is not cached: the next interop() call tries again.
    return (this.interopHandle ??= import('./interopImpl')
      .then(m => m.createInterop(transport.interop!(m.createCoreInterop), this))
      .catch(error => {
        this.interopHandle = null;
        throw error;
      }));
  }

  /**
   * @internal Dev-only debug hook. Runs `action` on the core wherever it lives
   * (main thread or worker); see `Transport.debug`. Requires `debug: true`.
   */
  _debug(action: 'loseDevice'): void {
    this.transport.debug?.(action);
  }

  /** @internal */
  _isSystemReady(range: number): boolean {
    return this.transport.kind === 'worker' || isCoreSystemReady(range);
  }

  // ─── FrontFrame hooks ──────────────────────────────────────────────────────

  /** @internal */
  _registerShared(buffer: ArrayBuffer | SharedArrayBuffer): number {
    const generation = this.frame.generation;
    let id = this.sharedIds.get(buffer);
    if (id !== undefined && this.sharedGenerations.get(buffer) === generation) {
      return id;
    }
    if (id === undefined) {
      id = ids.shared.alloc();
      this.sharedIds.set(buffer, id);
    }
    this.sharedGenerations.set(buffer, generation);
    const encoder = this.encoder;
    const objectIndex = encoder.addObject(buffer, false);
    encoder.begin(Op.SHARED_REGISTER, 8);
    encoder.u32(id);
    encoder.u32(objectIndex);
    encoder.end();
    return id;
  }

  /** @internal */
  _readback(
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer> {
    if (this.isDestroyed) {
      return Promise.reject(
        new CozyGPUError('DESTROYED', 'renderer was destroyed'),
      );
    }
    const requestId = ids.readback.alloc();
    const promise = new Promise<ArrayBuffer>((resolve, reject) => {
      this.readbackWaiters.set(requestId, { resolve, reject });
    });
    const request = { requestId, srcKind, srcId, first, count };
    if (this.encoding) this.encodeReadback(request);
    else this.pendingReadbacks.push(request);
    return promise;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private encodeControl(): void {
    const encoder = this.encoder;
    if (this.resizePending) {
      this.resizePending = false;
      encoder.begin(Op.RESIZE, 12);
      encoder.f32(this.cssWidth);
      encoder.f32(this.cssHeight);
      encoder.f32(this.currentResolution);
      encoder.end();
    }
    if (this.clearColorPending) {
      this.clearColorPending = false;
      const c = this.backgroundColor;
      encoder.begin(Op.SET_CLEAR_COLOR, 16);
      encoder.f32(((c >> 16) & 0xff) / 255);
      encoder.f32(((c >> 8) & 0xff) / 255);
      encoder.f32((c & 0xff) / 255);
      encoder.f32(this.backgroundOpacity);
      encoder.end();
    }
    if (this.viewPending) {
      // M1 has no camera API: identity stage → css transform.
      this.viewPending = false;
      encoder.begin(Op.SET_VIEW, 24);
      encoder.f32(1);
      encoder.f32(0);
      encoder.f32(0);
      encoder.f32(1);
      encoder.f32(0);
      encoder.f32(0);
      encoder.end();
    }
    const pending = this.pendingReadbacks;
    if (pending.length > 0) {
      for (let i = 0; i < pending.length; i++) this.encodeReadback(pending[i]);
      pending.length = 0;
    }
  }

  private encodeReadback(request: PendingReadback): void {
    const encoder = this.encoder;
    encoder.begin(Op.READBACK, 20);
    encoder.u32(request.requestId);
    encoder.u32(request.srcKind);
    encoder.u32(request.srcId);
    encoder.u32(request.first);
    encoder.u32(request.count);
    encoder.end();
  }

  private onCoreMessage(message: CoreMessage): void {
    switch (message.type) {
      case 'ready':
      case 'frameDone':
        return;
      case 'readback': {
        const waiter = this.readbackWaiters.get(message.requestId);
        if (waiter === undefined) return;
        this.readbackWaiters.delete(message.requestId);
        ids.readback.free(message.requestId);
        if (waiter === null) return; // already rejected (device loss)
        if (message.code !== undefined) {
          waiter.reject(
            new CozyGPUError(
              message.code,
              `readback ${message.requestId} failed` +
                (message.message ? `: ${message.message}` : ''),
            ),
          );
        } else {
          waiter.resolve(message.data);
        }
        return;
      }
      case 'pick':
        this.pickClient?.handleMessage(message);
        return;
      case 'deviceLost':
        this.rejectReadbacksOnLoss(message.message);
        this.pickClient?.rejectAll('DEVICE_LOST', message.message);
        this.lost(message.message, true);
        return;
      case 'deviceRestored':
        this.frame.generation++;
        this.resizePending = true;
        this.clearColorPending = true;
        this.viewPending = true;
        for (let i = 0; i < this.frameHooks.length; i++) {
          this.frameHooks[i].onDeviceRestored?.();
        }
        this.config.onDeviceRestored?.();
        this._emit('deviceRestored', {
          backend: this.info.backend,
          generation: this.frame.generation,
        });
        return;
      case 'error':
        if (message.code === 'DEVICE_LOST') {
          if (this.coreDead) return;
          this.coreDead = true;
          this.lost(message.message, false);
          this.destroy();
          return;
        }
        // eslint-disable-next-line no-console
        console.error(`[cozygpu:${message.code}] ${message.message}`);
        this._emit('error', {
          code: message.code as CozyGPUErrorCode,
          message: message.message,
        });
        return;
    }
  }

  /** onDeviceLost, then the deviceLost event. */
  private lost(message: string, willRestore: boolean): void {
    this.config.onDeviceLost?.({ message, willRestore });
    this._emit('deviceLost', {
      backend: this.info.backend,
      message,
      willRestore,
    });
  }

  /** Readbacks in flight when the device is lost can never return data. */
  private rejectReadbacksOnLoss(reason: string): void {
    const waiters = this.readbackWaiters;
    if (waiters.size === 0) return;
    const error = new CozyGPUError(
      'DEVICE_LOST',
      `readback aborted: GPU device lost (${reason})`,
    );
    waiters.forEach((waiter, requestId) => {
      if (!waiter) return;
      waiters.set(requestId, null);
      waiter.reject(error);
    });
  }

  private observeCanvasSize(): void {
    const canvas = this.canvas;
    if (
      typeof ResizeObserver === 'undefined' ||
      typeof HTMLCanvasElement === 'undefined' ||
      !(canvas instanceof HTMLCanvasElement)
    ) {
      return;
    }
    const observer = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1];
      let cssW: number;
      let cssH: number;
      const box = entry.contentBoxSize?.[0];
      if (box) {
        cssW = box.inlineSize;
        cssH = box.blockSize;
      } else {
        cssW = entry.contentRect.width;
        cssH = entry.contentRect.height;
      }
      let res = this.currentResolution;
      if (this.trackDevicePixelRatio) {
        res = devicePixelRatio();
        // Exact device pixels when the browser reports them and they agree
        // with devicePixelRatio (emulated DPRs can report CSS-sized boxes).
        const dp = entry.devicePixelContentBoxSize?.[0];
        if (dp && cssW > 0 && Math.abs(dp.inlineSize - cssW * res) <= 1) {
          res = dp.inlineSize / cssW;
        }
      }
      this.resize(cssW, cssH, res);
    });
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' });
      // This box also changes (and notifies) when only the DPR changes.
      this.observesDevicePixels = true;
    } catch {
      observer.observe(canvas);
    }
    this.resizeObserver = observer;
  }

  /** Re-arms a `(resolution: Xdppx)` query; fires when the DPR changes. */
  private watchDevicePixelRatio(): void {
    if (this.dprQuery) {
      this.dprQuery.removeEventListener('change', this.onDprChange);
      this.dprQuery = null;
    }
    if (this.isDestroyed || typeof matchMedia !== 'function') return;
    const dpr = devicePixelRatio();
    if (dpr !== this.currentResolution && !this.observesDevicePixels) {
      this.resize(this.cssWidth, this.cssHeight, dpr);
    }
    this.dprQuery = matchMedia(`(resolution: ${dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private unobserve(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.dprQuery) {
      this.dprQuery.removeEventListener('change', this.onDprChange);
      this.dprQuery = null;
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function devicePixelRatio(): number {
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  return typeof dpr === 'number' && dpr > 0 ? dpr : 1;
}

/** Counts DRAW-flagged commands in the finished packet (no allocation). */
export function countDrawCommands(
  encoder: CommandEncoder,
  byteLength: number,
): number {
  const u8 = encoder.u8;
  const u32 = encoder.u32View;
  let count = 0;
  let offset = PACKET_HEADER_BYTES;
  while (offset + COMMAND_HEADER_BYTES <= byteLength) {
    const flags = u8[offset + CH_FLAGS] | (u8[offset + CH_FLAGS + 1] << 8);
    if ((flags & CommandFlag.DRAW) !== 0) count++;
    offset += COMMAND_HEADER_BYTES + u32[(offset + CH_PAYLOAD_BYTES) >> 2];
  }
  return count;
}
