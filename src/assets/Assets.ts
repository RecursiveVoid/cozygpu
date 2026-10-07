/**
 * M2 asset manager (ARCHITECTURE §15). Loaded lazily through
 * ./proxy.ts (`renderer.assets`) or used directly as
 * `new GPU.Assets(renderer, options)`.
 *
 * Front side only (main thread in both renderer modes): fetch, detection,
 * decode (createImageBitmap), KTX2 parsing, cache + refcounts, bundles,
 * concurrency, abort, GPU budget with LRU eviction, atlas packing and
 * device-loss reloads. Pixels reach the core by transfer through a
 * `FrontFrameHook`; nothing is retained on the front unless asked for
 * (`keepPixels`, `hitMask`).
 *
 * M2.5 (ARCHITECTURE §19.2): `assetProgress` per finished asset or bundle
 * entry and `assetError` per failed load go to the renderer's events sink
 * through `RendererHost._emit`.
 */
import type { Capabilities, TextureFormat } from '../backend/types';
import { TEXTURE_MIP_LEVELS_SHIFT, TextureFlag } from '../commands/opcodes';
import type { TextureHandle } from '../scene/types';
import type { FrontFrame, FrontFrameHook, RendererHost } from '../types/core';
import { CozyGPUError } from '../types/errors';
import { ids } from '../types/ids';
import type { Renderer } from '../types/renderer';
import { detectFormat, isImageFormat } from './detect';
import {
  isCompressedFormat,
  levelByteLength,
  rgba8Bytes,
  supportsFormat,
  transcodeTargets,
} from './formats';
import {
  AtlasPage,
  GpuUnit,
  StandaloneTexture,
  emitDestroy,
  pageKey,
} from './gpu';
import { parseKtx2, sliceKtx2Levels } from './ktx2';
import { LruList } from './lru';
import { JobQueue, abortError } from './queue';
import {
  buildHitMask,
  checkSheet,
  isSpritesheetJson,
  parseSpritesheet,
  testHitMask,
} from './spritesheet';
import type {
  AssetDescriptor,
  AssetFormat,
  AssetHandle,
  AssetKind,
  AssetSource,
  AssetState,
  AssetsApi,
  AssetsOptions,
  AssetsStats,
  BundleHandle,
  HitMask,
  LoadOptions,
  LoadProgress,
  SpritesheetAsset,
  TextureAsset,
  TextureAssetOptions,
  TextureTranscoder,
  TranscodeTarget,
} from './types';

const MIB = 1024 * 1024;
/** Texel bytes encoded per frame by the eager upload pass (§15.4). */
export const UPLOAD_BYTES_PER_FRAME = 64 * MIB;

const DEFAULT_ATLAS = { pageSize: 2048, maxImageSize: 256, padding: 2 };

// ─── Values ───────────────────────────────────────────────────────────────────

class TextureAssetImpl implements TextureAsset {
  constructor(
    readonly texture: TextureHandle,
    readonly width: number,
    readonly height: number,
    readonly format: TextureFormat,
    readonly gpuBytes: number,
    readonly packed: boolean,
    readonly pixels: Uint8Array | null,
    readonly hitMask: HitMask | null,
  ) {}

  hitTest(x: number, y: number): boolean {
    if (this.hitMask !== null) return testHitMask(this.hitMask, x, y);
    const pixels = this.pixels;
    if (pixels !== null) {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height)
        return false;
      return pixels[(iy * this.width + ix) * 4 + 3] >= 128;
    }
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      'hitTest needs a texture loaded with { hitMask: true } or { keepPixels: true }',
    );
  }
}

// ─── Cache entries and handles ────────────────────────────────────────────────

/** @internal */
export class Entry {
  state: AssetState = 'loading';
  refs = 0;
  value: unknown = undefined;
  /** Resolves when loaded; rejects on failure. */
  promise: Promise<void> | null = null;
  controller = new AbortController();
  waiters = 0;
  /** GPU unit of a standalone texture (or the page of a packed image). */
  unit: StandaloneTexture | null = null;
  page: AtlasPage | null = null;
  /** Packed rect inside `page`. */
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  /** Handles this entry holds on other entries (spritesheet page). */
  children: AssetHandle[] = [];
  /** A device-loss reload is running. */
  reloading = false;

  constructor(
    readonly key: string,
    readonly url: string,
    readonly descriptor: AssetDescriptor,
  ) {}

  get isGpu(): boolean {
    return this.unit !== null || this.page !== null;
  }
}

class Handle<T> implements AssetHandle<T> {
  private released = false;

  constructor(
    private readonly manager: Assets,
    private readonly entry: Entry,
    readonly kind: AssetKind,
  ) {}

  get key(): string {
    return this.entry.key;
  }

  get state(): AssetState {
    return this.released ? 'released' : this.entry.state;
  }

  get value(): T {
    if (this.released) {
      throw new CozyGPUError(
        'DESTROYED',
        `asset handle "${this.entry.key}" was released`,
      );
    }
    return this.entry.value as T;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.manager._release(this.entry);
  }
}

class Bundle implements BundleHandle {
  constructor(
    readonly name: string,
    readonly handles: readonly AssetHandle[],
    private readonly byKey: ReadonlyMap<string, AssetHandle>,
  ) {}

  get<T = unknown>(key: string): AssetHandle<T> {
    const handle = this.byKey.get(key);
    if (handle === undefined) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `bundle "${this.name}" has no entry "${key}"`,
      );
    }
    return handle as AssetHandle<T>;
  }

  release(): void {
    for (let i = 0; i < this.handles.length; i++) this.handles[i].release();
  }
}

class StatsImpl implements AssetsStats {
  entries = 0;
  referenced = 0;
  inFlight = 0;
  queued = 0;
  gpuBytes = 0;
  gpuBudgetBytes = 0;
  atlasPages = 0;
  evictions = 0;
}

interface Prefetch {
  promise: Promise<ArrayBuffer | null>;
  controller: AbortController;
  started: boolean;
}

/** Decoded texture payload before it becomes (or refills) a GPU unit. */
interface TexturePayload {
  width: number;
  height: number;
  format: TextureFormat;
  bitmap: ImageBitmap | null;
  levels: ArrayBuffer[] | null;
  bytes: number;
  texFlags: number;
  generateAfterUpload: boolean;
  pixels: Uint8Array | null;
  hitMask: HitMask | null;
  packable: boolean;
}

function progress(loaded: number, total: number): LoadProgress {
  return { loaded, total, ratio: total > 0 ? loaded / total : 1 };
}

function linkSignal(
  controller: AbortController,
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function asLoadError(error: unknown, what: string): unknown {
  if (error instanceof CozyGPUError) return error;
  if (error instanceof Error && error.name === 'AbortError')
    return abortError();
  const message = error instanceof Error ? error.message : String(error);
  return new CozyGPUError('LOAD_FAILED', `${what}: ${message}`);
}

function defaultBaseUrl(): string | undefined {
  const g = globalThis as {
    document?: { baseURI?: string };
    location?: { href?: string };
  };
  return g.document?.baseURI ?? g.location?.href;
}

export function resolveUrl(url: string, base: string | undefined): string {
  try {
    return base !== undefined ? new URL(url, base).href : new URL(url).href;
  } catch {
    return url;
  }
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class Assets implements AssetsApi, FrontFrameHook {
  private readonly host: RendererHost;
  readonly rendererId: number;
  private readonly cache = new Map<string, Entry>();
  private readonly bundles = new Map<
    string,
    Readonly<Record<string, AssetSource>>
  >();
  private readonly prefetched = new Map<string, Prefetch>();
  private readonly queue: JobQueue;
  private readonly lru = new LruList<GpuUnit>();
  private readonly units = new Set<GpuUnit>();
  /** Units that hold CPU data waiting to be encoded (eager upload pass). */
  private readonly pendingUnits: GpuUnit[] = [];
  private readonly pages: AtlasPage[] = [];
  /** Page (or standalone unit) of every packed / GPU entry. */
  private readonly pageEntries = new Map<AtlasPage, Entry[]>();
  private readonly unitEntries = new Map<GpuUnit, Entry>();
  private readonly destroyQueue: number[] = [];
  private readonly closeQueue: ImageBitmap[] = [];
  private readonly statsObject = new StatsImpl();
  private readonly budgetBytes: number;
  private readonly atlas: {
    pageSize: number;
    maxImageSize: number;
    padding: number;
  } | null;
  private readonly baseUrl: string | undefined;
  private transcoderPromise: Promise<TextureTranscoder> | null = null;
  private removeHook: (() => void) | null;
  private isDestroyed = false;
  private rendererDead = false;
  private referenced = 0;
  private inFlight = 0;
  private gpuBytes = 0;
  private evictions = 0;
  private budgetWarned = false;
  /** enforceBudget() is running (it is re-entered through child releases). */
  private sweeping = false;
  private sweepAgain = false;
  private readonly warnedOnce = new Set<string>();

  constructor(
    readonly renderer: Renderer,
    readonly options: AssetsOptions = {},
  ) {
    const host = renderer as unknown as RendererHost;
    if (typeof host._addFrameHook !== 'function') {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'Assets needs a cozygpu Renderer',
      );
    }
    this.host = host;
    this.rendererId = host._rendererId;
    this.queue = new JobQueue(options.concurrency ?? 6);
    this.budgetBytes = Math.max(0, options.gpuBudgetMB ?? 512) * MIB;
    // A relative baseUrl ('/assets/') resolves against the page.
    const base = defaultBaseUrl();
    this.baseUrl =
      options.baseUrl !== undefined ? resolveUrl(options.baseUrl, base) : base;
    if (options.atlas === false) {
      this.atlas = null;
    } else {
      const a = options.atlas ?? {};
      const pageSize = a.pageSize ?? DEFAULT_ATLAS.pageSize;
      this.atlas = {
        pageSize,
        maxImageSize: Math.min(
          a.maxImageSize ?? DEFAULT_ATLAS.maxImageSize,
          pageSize,
        ),
        padding: Math.max(0, a.padding ?? DEFAULT_ATLAS.padding),
      };
    }
    this.removeHook = host._addFrameHook(this);
    if (renderer.destroyed) this.onRendererDestroyed();
  }

  private get caps(): Capabilities {
    return this.host._caps;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  load<T = unknown>(
    source: AssetSource,
    options?: LoadOptions,
  ): Promise<AssetHandle<T>> {
    return this.loadOne<T>(source, options, true);
  }

  /** `load()`; `emit` sends assetProgress (loadMany emits its own). */
  private loadOne<T>(
    source: AssetSource,
    options: LoadOptions | undefined,
    emit: boolean,
  ): Promise<AssetHandle<T>> {
    if (this.isDestroyed) {
      return Promise.reject(
        new CozyGPUError('DESTROYED', 'Assets was destroyed'),
      );
    }
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    let descriptor: AssetDescriptor;
    let entry: Entry;
    try {
      descriptor = this.normalize(source);
      entry = this.entryFor(descriptor);
    } catch (error) {
      return Promise.reject(error);
    }
    const onProgress = options?.onProgress;
    if (entry.state === 'loaded') {
      const handle = this.acquire<T>(entry);
      onProgress?.(progress(1, 1));
      if (emit) this.emitProgress(handle.key, null, 1, 1);
      return Promise.resolve(handle);
    }
    onProgress?.(progress(0, 1));
    entry.waiters++;
    return raceAbort(entry.promise as Promise<void>, signal).then(
      () => {
        entry.waiters--;
        if (this.isDestroyed)
          throw new CozyGPUError('DESTROYED', 'Assets was destroyed');
        const handle = this.acquire<T>(entry);
        onProgress?.(progress(1, 1));
        if (emit) this.emitProgress(handle.key, null, 1, 1);
        return handle;
      },
      error => {
        entry.waiters--;
        this.cancelIfUnwanted(entry);
        throw error;
      },
    );
  }

  loadAll(
    sources: readonly AssetSource[],
    options?: LoadOptions,
  ): Promise<AssetHandle[]> {
    return this.loadMany(sources, options, null).then(r => r.handles);
  }

  addBundle(
    name: string,
    entries: Readonly<Record<string, AssetSource>>,
  ): void {
    if (this.bundles.has(name)) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `bundle "${name}" already exists`,
      );
    }
    this.bundles.set(name, entries);
  }

  loadBundle(name: string, options?: LoadOptions): Promise<BundleHandle> {
    const entries = this.bundles.get(name);
    if (entries === undefined) {
      return Promise.reject(
        new CozyGPUError('INVALID_ARGUMENT', `unknown bundle "${name}"`),
      );
    }
    const keys = Object.keys(entries);
    const sources: AssetSource[] = [];
    for (let i = 0; i < keys.length; i++) sources.push(entries[keys[i]]);
    return this.loadMany(sources, options, name).then(({ handles }) => {
      const byKey = new Map<string, AssetHandle>();
      for (let i = 0; i < handles.length; i++) {
        byKey.set(handles[i].key, handles[i]);
        byKey.set(keys[i], handles[i]);
      }
      return new Bundle(name, handles, byKey);
    });
  }

  preload(sources: readonly AssetSource[]): void {
    if (this.isDestroyed) return;
    for (let i = 0; i < sources.length; i++) {
      let descriptor: AssetDescriptor;
      try {
        descriptor = this.normalize(sources[i]);
      } catch {
        continue;
      }
      const url = resolveUrl(descriptor.url, this.baseUrl);
      const key = descriptor.alias ?? url;
      if (this.cache.has(key) || this.prefetched.has(url)) continue;
      const controller = new AbortController();
      const record: Prefetch = {
        promise: null as unknown as Promise<ArrayBuffer | null>,
        controller,
        started: false,
      };
      record.promise = this.queue.acquire(controller.signal, true).then(
        () => {
          record.started = true;
          return this.fetchBytes(url, controller.signal).then(
            buffer => {
              this.queue.release();
              return buffer;
            },
            () => {
              this.queue.release();
              this.prefetched.delete(url);
              return null;
            },
          );
        },
        () => null,
      );
      this.prefetched.set(url, record);
    }
  }

  get<T = unknown>(key: string): T | undefined {
    const entry =
      this.cache.get(key) ?? this.cache.get(resolveUrl(key, this.baseUrl));
    return entry !== undefined && entry.state === 'loaded'
      ? (entry.value as T)
      : undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  unload(key: string): void {
    const entry =
      this.cache.get(key) ?? this.cache.get(resolveUrl(key, this.baseUrl));
    if (entry === undefined) return;
    if (entry.refs > 0) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `asset "${key}" is still referenced (${entry.refs})`,
      );
    }
    if (entry.state === 'loading') {
      if (entry.waiters === 0) entry.controller.abort();
      return;
    }
    this.dropEntry(entry, 'released');
  }

  trim(targetBytes?: number): void {
    this.enforceBudget(targetBytes ?? this.budgetBytes, true);
  }

  get stats(): AssetsStats {
    const s = this.statsObject;
    s.entries = this.cache.size;
    s.referenced = this.referenced;
    s.inFlight = this.inFlight;
    s.queued = this.queue.queued;
    s.gpuBytes = this.gpuBytes;
    s.gpuBudgetBytes = this.budgetBytes;
    s.atlasPages = this.pages.length;
    s.evictions = this.evictions;
    return s;
  }

  detectFormat(url: string, head?: Uint8Array): AssetFormat {
    return detectFormat(url, head);
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    const error = abortError();
    this.queue.rejectAll(error);
    this.prefetched.forEach(p => p.controller.abort());
    this.prefetched.clear();
    const entries = Array.from(this.cache.values());
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.state === 'loading') entry.controller.abort();
      else this.dropEntry(entry, 'released');
    }
    this.cache.clear();
    const units = Array.from(this.units);
    for (let i = 0; i < units.length; i++) this.dropUnit(units[i]);
    if (this.rendererDead || this.destroyQueue.length === 0) this.detach();
  }

  // ─── FrontFrameHook ────────────────────────────────────────────────────────

  encodeFrame(frame: FrontFrame): void {
    const close = this.closeQueue;
    for (let i = 0; i < close.length; i++) close[i].close();
    close.length = 0;

    const destroys = this.destroyQueue;
    if (destroys.length > 0) {
      const enc = frame.encoder;
      for (let i = 0; i < destroys.length; i++) {
        emitDestroy(enc, destroys[i]);
        this.freeId(destroys[i]);
      }
      destroys.length = 0;
    }
    if (this.isDestroyed) {
      this.detach();
      return;
    }

    const pending = this.pendingUnits;
    let bytes = 0;
    let kept = 0;
    for (let i = 0; i < pending.length; i++) {
      const unit = pending[i];
      if (unit.dropped || !unit.hasPending) continue;
      if (bytes < UPLOAD_BYTES_PER_FRAME) {
        bytes += unit.flush(frame);
      } else {
        pending[kept++] = unit;
      }
    }
    pending.length = kept;
  }

  onDeviceRestored(): void {
    if (this.isDestroyed) return;
    const units = Array.from(this.units);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit instanceof AtlasPage) {
        const entries = (this.pageEntries.get(unit) ?? []).slice();
        for (let j = 0; j < entries.length; j++) {
          const entry = entries[j];
          if (entry.refs > 0) this.reload(entry);
          else if (entry.state === 'loaded') this.dropEntry(entry, 'evicted');
        }
      } else {
        const entry = this.unitEntries.get(unit);
        if (entry === undefined) continue;
        if (unit.hasPending) continue; // never reached the lost device
        if (entry.refs > 0) this.reload(entry);
        else if (entry.state === 'loaded') this.dropEntry(entry, 'evicted');
      }
    }
  }

  onRendererDestroyed(): void {
    this.rendererDead = true;
    const queued = this.destroyQueue;
    for (let i = 0; i < queued.length; i++) this.freeId(queued[i]);
    queued.length = 0;
    this.destroy();
    this.detach();
  }

  // ─── UnitHost ──────────────────────────────────────────────────────────────

  touch(unit: GpuUnit): void {
    if (unit.lruLinked) this.lru.touch(unit);
  }

  unitDestroyedExternally(unit: GpuUnit): void {
    if (unit instanceof AtlasPage) {
      const entries = (this.pageEntries.get(unit) ?? []).slice();
      for (let i = 0; i < entries.length; i++)
        this.forget(entries[i], 'released');
    } else {
      const entry = this.unitEntries.get(unit);
      if (entry !== undefined) this.forget(entry, 'released');
    }
    this.dropUnit(unit);
  }

  closeLater(bitmap: ImageBitmap): void {
    this.closeQueue.push(bitmap);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** @internal Called by Handle.release(). */
  _release(entry: Entry): void {
    entry.refs--;
    if (entry.refs > 0) return;
    this.referenced--;
    if (this.cache.get(entry.key) !== entry) return;
    if (entry.isGpu) {
      this.enforceBudget(this.budgetBytes, false);
    } else if (entry.state === 'loaded') {
      this.dropEntry(entry, 'released');
    }
  }

  private acquire<T>(entry: Entry): AssetHandle<T> {
    if (entry.refs === 0) this.referenced++;
    entry.refs++;
    const unit = entry.unit ?? entry.page;
    if (unit !== null && unit.lruLinked) this.lru.touch(unit);
    return new Handle<T>(this, entry, this.kindOf(entry));
  }

  private kindOf(entry: Entry): AssetKind {
    if (entry.isGpu) return 'texture';
    const value = entry.value as
      | { frames?: unknown; page?: unknown }
      | undefined;
    if (entry.descriptor.kind !== undefined) return entry.descriptor.kind;
    if (value instanceof ArrayBuffer) return 'binary';
    if (typeof value === 'string') return 'text';
    if (
      value !== null &&
      typeof value === 'object' &&
      value.page !== undefined &&
      value.frames !== undefined
    ) {
      return 'spritesheet';
    }
    return 'json';
  }

  private normalize(source: AssetSource): AssetDescriptor {
    const descriptor = typeof source === 'string' ? { url: source } : source;
    if (
      descriptor === null ||
      typeof descriptor !== 'object' ||
      typeof descriptor.url !== 'string' ||
      descriptor.url === ''
    ) {
      throw new CozyGPUError('INVALID_ARGUMENT', 'asset source needs a url');
    }
    return descriptor;
  }

  private entryFor(descriptor: AssetDescriptor): Entry {
    const url = resolveUrl(descriptor.url, this.baseUrl);
    const key = descriptor.alias ?? url;
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      if (descriptor.alias !== undefined && existing.url !== url) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `alias "${key}" already names ${existing.url}`,
        );
      }
      return existing;
    }
    const entry = new Entry(key, url, descriptor);
    this.cache.set(key, entry);
    this.inFlight++;
    const promise = this.run(entry).then(
      () => {
        this.inFlight--;
        if (this.cache.get(key) !== entry || this.isDestroyed) {
          this.discardLoaded(entry);
          throw abortError();
        }
        entry.state = 'loaded';
        if (entry.isGpu) {
          this.enforceBudget(this.budgetBytes, false);
        } else if (entry.waiters === 0 && entry.refs === 0) {
          // Nobody wants a memory asset any more.
          this.cache.delete(key);
          entry.state = 'released';
        }
      },
      error => {
        this.inFlight--;
        entry.state = 'failed';
        if (this.cache.get(key) === entry) this.cache.delete(key);
        this.releaseChildren(entry);
        const code =
          error instanceof CozyGPUError ? error.code : ('INTERNAL' as const);
        if (code !== 'ABORTED') {
          this.host._emit('assetError', {
            key,
            url,
            code,
            message: (error as Error)?.message ?? String(error),
          });
        }
        throw error;
      },
    );
    promise.catch(() => {});
    entry.promise = promise;
    return entry;
  }

  /** Cancels a loading entry nobody waits for any more. */
  private cancelIfUnwanted(entry: Entry): void {
    if (entry.state === 'loading' && entry.waiters === 0 && entry.refs === 0) {
      entry.controller.abort();
    }
  }

  /** assetProgress event (ARCHITECTURE §19.2). */
  private emitProgress(
    key: string,
    bundle: string | null,
    loaded: number,
    total: number,
  ): void {
    this.host._emit('assetProgress', {
      key,
      bundle,
      loaded,
      total,
      ratio: total > 0 ? loaded / total : 1,
    });
  }

  private loadMany(
    sources: readonly AssetSource[],
    options: LoadOptions | undefined,
    bundle: string | null,
  ): Promise<{ handles: AssetHandle[] }> {
    const total = sources.length;
    const onProgress = options?.onProgress;
    const controller = new AbortController();
    const unlink = linkSignal(controller, options?.signal);
    const handles: AssetHandle[] = new Array(total);
    let loaded = 0;
    let failed = false;
    onProgress?.(progress(0, total));
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      jobs.push(
        this.loadOne(sources[i], { signal: controller.signal }, false).then(
          handle => {
            if (failed) {
              handle.release();
              return;
            }
            handles[i] = handle;
            loaded++;
            onProgress?.(progress(loaded, total));
            this.emitProgress(handle.key, bundle, loaded, total);
          },
          error => {
            if (failed) return;
            failed = true;
            for (let j = 0; j < total; j++) handles[j]?.release();
            controller.abort();
            throw error;
          },
        ),
      );
    }
    return Promise.all(jobs).then(
      () => {
        unlink();
        return { handles };
      },
      error => {
        unlink();
        throw error;
      },
    );
  }

  // ─── Loading pipeline ──────────────────────────────────────────────────────

  private async run(entry: Entry): Promise<void> {
    const signal = entry.controller.signal;
    const buffer = await this.fetchWithSlot(entry.url, signal);
    if (signal.aborted) throw abortError();
    const descriptor = entry.descriptor;
    const format = detectFormat(
      entry.url,
      new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength)),
    );
    const kind = descriptor.kind ?? this.kindFromFormat(format);

    switch (kind) {
      case 'binary':
        entry.value = buffer;
        return;
      case 'text':
        entry.value = new TextDecoder().decode(buffer);
        return;
      case 'json':
      case 'spritesheet': {
        let data: unknown;
        try {
          data = JSON.parse(new TextDecoder().decode(buffer));
        } catch (error) {
          throw asLoadError(error, `JSON ${entry.url}`);
        }
        if (
          kind === 'spritesheet' ||
          (descriptor.kind === undefined && isSpritesheetJson(data))
        ) {
          entry.value = await this.buildSpritesheet(entry, data);
        } else {
          entry.value = data;
        }
        return;
      }
      case 'font': {
        // M3. The font code (and the MSDF parser it shares with Text) is a
        // chunk of its own: a program without text never loads it.
        const { loadFontAsset } = await import('./font');
        entry.value = await loadFontAsset(
          this,
          entry.url,
          buffer,
          descriptor,
          signal,
          entry.children,
        );
        return;
      }
      case 'texture': {
        const payload = await this.decodeTexture(
          entry.url,
          format,
          buffer,
          descriptor.texture ?? {},
          signal,
        );
        if (signal.aborted) {
          payload.bitmap?.close();
          throw abortError();
        }
        this.installTexture(entry, payload);
        return;
      }
    }
  }

  private kindFromFormat(format: AssetFormat): AssetKind {
    if (isImageFormat(format) || format === 'ktx2' || format === 'basis')
      return 'texture';
    if (format === 'json') return 'json';
    if (format === 'text') return 'text';
    return 'binary';
  }

  private async fetchWithSlot(
    url: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const pre = this.prefetched.get(url);
    if (pre !== undefined) {
      this.prefetched.delete(url);
      if (pre.started) {
        const buffer = await raceAbort(pre.promise, signal);
        if (buffer !== null) return buffer;
      } else {
        pre.controller.abort();
      }
    }
    await this.queue.acquire(signal);
    try {
      return await this.fetchBytes(url, signal);
    } finally {
      this.queue.release();
    }
  }

  private async fetchBytes(
    url: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const fetchFn =
      this.options.fetch ?? (globalThis.fetch as AssetsOptions['fetch']);
    if (fetchFn === undefined) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'fetch is not available; pass AssetsOptions.fetch',
      );
    }
    let response: Response;
    try {
      response = await fetchFn(url, { signal });
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw asLoadError(error, `fetch ${url}`);
    }
    if (!response.ok) {
      throw new CozyGPUError(
        'LOAD_FAILED',
        `HTTP ${response.status} ${response.statusText} (${url})`,
      );
    }
    try {
      return await response.arrayBuffer();
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw asLoadError(error, `read ${url}`);
    }
  }

  private flagsFor(options: TextureAssetOptions): number {
    let flags = 0;
    if (options.nearest) flags |= TextureFlag.NEAREST;
    if (options.repeat) flags |= TextureFlag.REPEAT;
    if (options.premultiplied) flags |= TextureFlag.PREMULTIPLIED;
    return flags;
  }

  private wantsMipmaps(options: TextureAssetOptions): boolean {
    return options.mipmaps ?? this.options.mipmaps ?? false;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    console.warn(`[cozygpu] assets: ${message}`);
  }

  /** Fetched bytes → decoded payload (no GPU state touched). */
  private async decodeTexture(
    url: string,
    format: AssetFormat,
    buffer: ArrayBuffer,
    options: TextureAssetOptions,
    signal: AbortSignal,
  ): Promise<TexturePayload> {
    if (format === 'ktx2' || format === 'basis') {
      return this.decodeCompressed(url, format, buffer, options, signal);
    }
    const create = (
      globalThis as { createImageBitmap?: typeof createImageBitmap }
    ).createImageBitmap;
    if (create === undefined) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'createImageBitmap is not available',
      );
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await create(new Blob([buffer]), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
    } catch (error) {
      throw new CozyGPUError(
        'LOAD_FAILED',
        `cannot decode ${url} as an image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const width = bitmap.width;
    const height = bitmap.height;
    const max = this.caps.maxTextureSize;
    if (width > max || height > max) {
      bitmap.close();
      throw new CozyGPUError(
        'UNSUPPORTED',
        `${url} is ${width}×${height}, above maxTextureSize ${max}`,
      );
    }
    let pixels: Uint8Array | null = null;
    let hitMask: HitMask | null = null;
    if (options.keepPixels || options.hitMask) {
      const rgba = readPixels(bitmap);
      if (options.hitMask) {
        const threshold =
          typeof options.hitMask === 'object' ? options.hitMask.threshold : 128;
        hitMask = buildHitMask(rgba, width, height, threshold);
      }
      if (options.keepPixels) pixels = rgba;
    }
    const mipmaps = this.wantsMipmaps(options);
    let texFlags = this.flagsFor(options);
    if (mipmaps) texFlags |= TextureFlag.MIPMAPS;
    const atlas = this.atlas;
    const packable =
      atlas !== null &&
      options.atlas !== false &&
      !options.repeat &&
      !options.keepPixels &&
      width <= atlas.maxImageSize &&
      height <= atlas.maxImageSize;
    return {
      width,
      height,
      format: 'rgba8unorm',
      bitmap,
      levels: null,
      bytes: rgba8Bytes(width, height, mipmaps),
      texFlags,
      generateAfterUpload: false,
      pixels,
      hitMask,
      packable,
    };
  }

  private async decodeCompressed(
    url: string,
    container: 'ktx2' | 'basis',
    buffer: ArrayBuffer,
    options: TextureAssetOptions,
    signal: AbortSignal,
  ): Promise<TexturePayload> {
    const caps = this.caps;
    let format: TextureFormat;
    let width: number;
    let height: number;
    let levels: ArrayBuffer[];
    let premultiplied = !!options.premultiplied;
    let generateMips = false;

    const info = container === 'ktx2' ? parseKtx2(buffer) : null;
    if (
      info !== null &&
      !info.needsTranscoder &&
      info.format !== undefined &&
      supportsFormat(caps, info.format)
    ) {
      format = info.format;
      width = info.width;
      height = info.height;
      levels = sliceKtx2Levels(buffer, info);
      premultiplied = premultiplied || info.premultiplied;
      generateMips = info.generateMips;
    } else {
      if (this.options.transcoder === undefined) {
        const what =
          info === null
            ? 'Basis Universal'
            : info.format === undefined
              ? 'Basis/supercompressed KTX2'
              : info.format;
        throw new CozyGPUError(
          'UNSUPPORTED',
          `${url}: ${what} is not supported by this GPU and no AssetsOptions.transcoder is configured`,
        );
      }
      const targets = transcodeTargets(caps);
      const transcoder = await this.transcoder();
      const result = await transcoder.transcode({
        data: buffer,
        container,
        targets,
        signal,
      });
      if (signal.aborted) throw abortError();
      if (targets.indexOf(result.format) < 0) {
        throw new CozyGPUError(
          'LOAD_FAILED',
          `${url}: transcoder returned ${result.format}, not one of ${targets.join(', ')}`,
        );
      }
      format = result.format as TranscodeTarget;
      width = result.width;
      height = result.height;
      levels = result.levels.slice();
      premultiplied =
        premultiplied ||
        !!result.premultiplied ||
        (info?.premultiplied ?? false);
      generateMips = info?.generateMips ?? false;
      if (levels.length === 0)
        throw new CozyGPUError(
          'LOAD_FAILED',
          `${url}: transcoder returned no levels`,
        );
      for (let i = 0; i < levels.length; i++) {
        const expected = levelByteLength(
          format,
          Math.max(1, width >> i),
          Math.max(1, height >> i),
        );
        if (levels[i].byteLength !== expected) {
          throw new CozyGPUError(
            'LOAD_FAILED',
            `${url}: transcoded level ${i} is ${levels[i].byteLength} B, expected ${expected}`,
          );
        }
      }
    }

    const max = caps.maxTextureSize;
    if (width > max || height > max) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        `${url} is ${width}×${height}, above maxTextureSize ${max}`,
      );
    }
    const compressed = isCompressedFormat(format);
    if (compressed && (width % 4 !== 0 || height % 4 !== 0)) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        `${url}: compressed textures need a size that is a multiple of 4 (got ${width}×${height})`,
      );
    }

    let texFlags = this.flagsFor(options);
    if (premultiplied) texFlags |= TextureFlag.PREMULTIPLIED;
    let bytes = 0;
    for (let i = 0; i < levels.length; i++) bytes += levels[i].byteLength;
    let generateAfterUpload = false;
    if (levels.length > 1) {
      texFlags |= TextureFlag.MIPMAPS;
      texFlags = (texFlags | (levels.length << TEXTURE_MIP_LEVELS_SHIFT)) >>> 0;
    } else if (this.wantsMipmaps(options) || generateMips) {
      if (compressed) {
        this.warnOnce(
          'compressed-mips',
          `${url}: single-level compressed textures cannot get GPU mipmaps`,
        );
      } else {
        texFlags |= TextureFlag.MIPMAPS;
        generateAfterUpload = true;
        bytes = Math.ceil((bytes * 4) / 3);
      }
    }
    return {
      width,
      height,
      format,
      bitmap: null,
      levels,
      bytes,
      texFlags,
      generateAfterUpload,
      pixels: null,
      hitMask: null,
      packable: false,
    };
  }

  private transcoder(): Promise<TextureTranscoder> {
    if (this.transcoderPromise === null) {
      const factory = this.options
        .transcoder as () => Promise<TextureTranscoder>;
      this.transcoderPromise = factory();
      this.transcoderPromise.catch(() => {
        this.transcoderPromise = null;
      });
    }
    return this.transcoderPromise;
  }

  /** Turns a decoded payload into a GPU unit (or a packed rect) for `entry`. */
  private installTexture(entry: Entry, payload: TexturePayload): void {
    if (payload.packable && payload.bitmap !== null) {
      const page = this.packInto(payload);
      if (page !== null) {
        entry.page = page;
        entry.x = page.packer.x;
        entry.y = page.packer.y;
        entry.width = payload.width;
        entry.height = payload.height;
        page.addRegion(payload.bitmap, entry.x, entry.y);
        this.markPending(page);
        let list = this.pageEntries.get(page);
        if (list === undefined) {
          list = [];
          this.pageEntries.set(page, list);
        }
        list.push(entry);
        page.images.push(entry);
        const pad = page.packer.padding * 2;
        const share = rgba8Bytes(
          payload.width + pad,
          payload.height + pad,
          (page.texFlags & TextureFlag.MIPMAPS) !== 0,
        );
        entry.value = new TextureAssetImpl(
          page.handle.sub(entry.x, entry.y, payload.width, payload.height),
          payload.width,
          payload.height,
          'rgba8unorm',
          share,
          true,
          null,
          payload.hitMask,
        );
        return;
      }
    }
    const unit = new StandaloneTexture(
      this,
      payload.width,
      payload.height,
      payload.format,
      payload.texFlags,
      payload.bytes,
    );
    unit.bitmap = payload.bitmap;
    unit.levels = payload.levels;
    unit.generateAfterUpload = payload.generateAfterUpload;
    this.addUnit(unit);
    this.unitEntries.set(unit, entry);
    entry.unit = unit;
    entry.width = payload.width;
    entry.height = payload.height;
    this.markPending(unit);
    entry.value = new TextureAssetImpl(
      unit.handle,
      payload.width,
      payload.height,
      payload.format,
      payload.bytes,
      false,
      payload.pixels,
      payload.hitMask,
    );
  }

  private packInto(payload: TexturePayload): AtlasPage | null {
    const atlas = this.atlas;
    if (atlas === null) return null;
    const key = pageKey(payload.texFlags);
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const page = this.pages[i];
      if (
        page.key === key &&
        !page.dropped &&
        page.packer.pack(payload.width, payload.height)
      )
        return page;
    }
    const size = Math.min(atlas.pageSize, this.caps.maxTextureSize);
    const page = new AtlasPage(this, size, atlas.padding, key);
    if (!page.packer.pack(payload.width, payload.height)) {
      // Never registered: give the id back.
      this.freeId(page.id);
      return null;
    }
    this.pages.push(page);
    this.addUnit(page);
    return page;
  }

  private addUnit(unit: GpuUnit): void {
    this.units.add(unit);
    this.gpuBytes += unit.bytes;
    this.lru.touch(unit);
  }

  private markPending(unit: GpuUnit): void {
    if (this.pendingUnits.indexOf(unit) < 0) this.pendingUnits.push(unit);
  }

  private async buildSpritesheet(
    entry: Entry,
    data: unknown,
  ): Promise<SpritesheetAsset> {
    const sheet = parseSpritesheet(data);
    const imageUrl = resolveUrl(sheet.image, entry.url);
    const handle = await this.load<TextureAsset>(
      {
        url: imageUrl,
        kind: 'texture',
        texture: { ...entry.descriptor.texture, atlas: false },
      },
      { signal: entry.controller.signal },
    );
    entry.children.push(handle);
    const page = handle.value;
    checkSheet(sheet, page.width, page.height);
    const frames: Record<string, TextureHandle> = {};
    for (let i = 0; i < sheet.frames.length; i++) {
      const f = sheet.frames[i];
      frames[f.name] = page.texture.sub(f.x, f.y, f.width, f.height);
    }
    const animations: Record<string, TextureHandle[]> = {};
    const names = Object.keys(sheet.animations);
    for (let i = 0; i < names.length; i++) {
      animations[names[i]] = sheet.animations[names[i]].map(n => frames[n]);
    }
    return { page, frames, animations, data };
  }

  // ─── Reload after device loss ──────────────────────────────────────────────

  private reload(entry: Entry): void {
    if (entry.reloading || entry.state !== 'loaded') return;
    const unit = entry.unit;
    const page = entry.page;
    if (unit === null && page === null) return;
    entry.reloading = true;
    const signal = entry.controller.signal;
    const descriptor = entry.descriptor;
    this.fetchWithSlot(entry.url, signal)
      .then(buffer => {
        const format = detectFormat(
          entry.url,
          new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength)),
        );
        return this.decodeTexture(
          entry.url,
          format,
          buffer,
          descriptor.texture ?? {},
          signal,
        );
      })
      .then(
        payload => {
          entry.reloading = false;
          const alive =
            this.cache.get(entry.key) === entry && !this.isDestroyed;
          if (
            !alive ||
            payload.width !== entry.width ||
            payload.height !== entry.height
          ) {
            payload.bitmap?.close();
            if (alive)
              this.warnOnce(
                `reload-size:${entry.key}`,
                `${entry.url} changed size; not reloaded`,
              );
            return;
          }
          if (page !== null && payload.bitmap !== null && !page.dropped) {
            page.addRegion(payload.bitmap, entry.x, entry.y);
            this.markPending(page);
          } else if (unit !== null && !unit.dropped) {
            unit.bitmap = payload.bitmap;
            unit.levels = payload.levels;
            this.markPending(unit);
          } else {
            payload.bitmap?.close();
          }
        },
        error => {
          entry.reloading = false;
          if (!signal.aborted) {
            console.warn(
              `[cozygpu] assets: reload of ${entry.url} after device loss failed:`,
              error,
            );
          }
        },
      );
  }

  // ─── Budget and eviction ───────────────────────────────────────────────────

  private unitEvictable(unit: GpuUnit): boolean {
    if (unit instanceof AtlasPage) {
      const entries = this.pageEntries.get(unit);
      if (entries === undefined) return true;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.refs > 0 || e.waiters > 0 || e.state !== 'loaded') return false;
      }
      return true;
    }
    const entry = this.unitEntries.get(unit);
    return (
      entry === undefined ||
      (entry.refs === 0 && entry.waiters === 0 && entry.state === 'loaded')
    );
  }

  private enforceBudget(target: number, explicit: boolean): void {
    if (!explicit && this.budgetBytes === 0) return;
    if (this.sweeping) {
      // Re-entered from an eviction (a spritesheet releasing its page child
      // handle): a nested sweep would evict the unit the outer loop holds as
      // `next`. Let the outer sweep go round again instead.
      this.sweepAgain = true;
      return;
    }
    if (this.gpuBytes <= target) return;
    this.sweeping = true;
    try {
      do {
        this.sweepAgain = false;
        let unit = this.lru.head;
        while (unit !== null && this.gpuBytes > target) {
          const next = this.lru.next(unit);
          if (this.unitEvictable(unit)) this.evictUnit(unit);
          unit = next;
        }
      } while (this.sweepAgain && this.gpuBytes > target);
    } finally {
      this.sweeping = false;
      this.sweepAgain = false;
    }
    if (this.gpuBytes > target && !explicit && !this.budgetWarned) {
      this.budgetWarned = true;
      console.warn(
        `[cozygpu] assets: referenced textures alone use ${(this.gpuBytes / MIB).toFixed(1)} MiB, above gpuBudgetMB ${(target / MIB).toFixed(0)}`,
      );
    }
  }

  private evictUnit(unit: GpuUnit): void {
    if (!this.units.has(unit)) return;
    if (unit instanceof AtlasPage) {
      const entries = (this.pageEntries.get(unit) ?? []).slice();
      for (let i = 0; i < entries.length; i++)
        this.forget(entries[i], 'evicted');
    } else {
      const entry = this.unitEntries.get(unit);
      if (entry !== undefined) this.forget(entry, 'evicted');
    }
    this.dropUnit(unit);
    this.evictions++;
  }

  /** Removes an entry from the cache and its page / unit bookkeeping. */
  private forget(entry: Entry, state: AssetState): void {
    if (this.cache.get(entry.key) === entry) this.cache.delete(entry.key);
    entry.state = state;
    const page = entry.page;
    if (page !== null) {
      const list = this.pageEntries.get(page);
      if (list !== undefined) {
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
      }
      const j = page.images.indexOf(entry);
      if (j >= 0) page.images.splice(j, 1);
    }
    if (entry.unit !== null) this.unitEntries.delete(entry.unit);
    this.releaseChildren(entry);
  }

  /** Drops a loaded entry now (unload, zero-ref memory asset, device loss). */
  private dropEntry(entry: Entry, state: AssetState): void {
    this.forget(entry, state);
    const page = entry.page;
    if (entry.unit !== null) {
      this.dropUnit(entry.unit);
    } else if (page !== null && page.images.length === 0) {
      this.dropUnit(page);
    }
  }

  /** A load finished for an entry that was cancelled or replaced meanwhile. */
  private discardLoaded(entry: Entry): void {
    if (entry.isGpu) this.dropEntry(entry, 'released');
    else this.releaseChildren(entry);
  }

  private releaseChildren(entry: Entry): void {
    const children = entry.children;
    entry.children = [];
    for (let i = 0; i < children.length; i++) children[i].release();
  }

  private dropUnit(unit: GpuUnit): void {
    if (!this.units.has(unit)) return;
    this.units.delete(unit);
    this.lru.remove(unit);
    this.gpuBytes -= unit.bytes;
    unit.markDropped();
    if (unit instanceof AtlasPage) {
      this.pageEntries.delete(unit);
      const i = this.pages.indexOf(unit);
      if (i >= 0) this.pages.splice(i, 1);
    } else {
      this.unitEntries.delete(unit);
    }
    if (unit.createdGeneration >= 0 && !this.rendererDead) {
      this.destroyQueue.push(unit.id);
    } else {
      this.freeId(unit.id);
    }
  }

  private freeId(id: number): void {
    ids.texture.free(id);
  }

  private detach(): void {
    const close = this.closeQueue;
    for (let i = 0; i < close.length; i++) close[i].close();
    close.length = 0;
    if (this.removeHook !== null) {
      this.removeHook();
      this.removeHook = null;
    }
  }
}

/** Straight RGBA8 pixels of a bitmap (keepPixels / hitMask). */
function readPixels(bitmap: ImageBitmap): Uint8Array {
  const Canvas = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas })
    .OffscreenCanvas;
  if (Canvas === undefined) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'keepPixels / hitMask need OffscreenCanvas',
    );
  }
  const canvas = new Canvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | null;
  if (ctx === null)
    throw new CozyGPUError(
      'UNSUPPORTED',
      'keepPixels / hitMask need a 2D context',
    );
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
