/**
 * Lazily registered core systems for main-thread
 * renderers (bundle size, ARCHITECTURE §18.1).
 *
 * A sprite-only program should not ship the Swarm core (~13 KB minified).
 * Front modules that need a core system register its factory when they are
 * evaluated (Swarm.ts registers the swarm core), so bundlers drop the core
 * together with the unused front class. LocalTransport creates a
 * `LazyCoreSystem` placeholder per optional range; it instantiates the real
 * system on the first command of that range, even when the front module was
 * loaded after the renderer was created (e.g. a dynamic import).
 *
 * M2: a front module can register an asynchronous loader instead
 * (`registerCoreSystemLoader(range, () => import('./core').then(m =>
 * m.createSwarmCoreSystem))`), so the core becomes a separate chunk. The
 * front then asks `frame.isSystemReady(range)` (→ `isCoreSystemReady`) each
 * frame: the first call starts the import, and commands for the range stay
 * queued on the front until it returns true.
 *
 * The worker bundle keeps using createDefaultCoreSystems() (everything).
 *
 * Requirement for lazily created systems: they must accept commands right
 * after `init(ctx)` is called (anything asynchronous, like pipelines, has to
 * be tolerated by draw/compute, as the Swarm core already does).
 */
import type {
  CommandList,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
} from '../backend/types';
import type { CommandReader } from '../commands/types';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';

type CoreSystemFactory = () => CoreSystem;
type CoreSystemLoader = () => Promise<CoreSystemFactory>;

const factories: (CoreSystemFactory | undefined)[] = [];
const loaders: (CoreSystemLoader | undefined)[] = [];
/** In-flight imports per range (null = none). */
const loading: (Promise<void> | null | undefined)[] = [];

/** Registers the core system factory for opcode range `range` (idempotent). */
export function registerCoreSystemFactory(
  range: number,
  factory: CoreSystemFactory,
): void {
  factories[range] = factory;
}

/**
 * M2. Registers an asynchronous loader for `range` (idempotent). It runs on
 * the first `isCoreSystemReady(range)` / `loadCoreSystem(range)` call, never
 * at registration, so importing a front module does not fetch its core. A
 * synchronously registered factory wins over a loader.
 */
export function registerCoreSystemLoader(
  range: number,
  loader: CoreSystemLoader,
): void {
  loaders[range] = loader;
}

/**
 * Starts (or joins) the import for `range`; resolves once the factory is
 * registered. Rejects when the loader fails; a later call retries.
 */
export function loadCoreSystem(range: number): Promise<void> {
  if (factories[range] !== undefined) return Promise.resolve();
  const pending = loading[range];
  if (pending) return pending;
  const loader = loaders[range];
  if (loader === undefined) return Promise.resolve();
  const promise = loader().then(
    factory => {
      if (factories[range] === undefined) factories[range] = factory;
      loading[range] = null;
    },
    (error: unknown) => {
      loading[range] = null;
      throw error;
    },
  );
  loading[range] = promise;
  return promise;
}

/**
 * M2 (ARCHITECTURE §18.1). True when the system for `range` can take
 * commands in this heap: its factory is registered, or nothing lazy is
 * registered for the range (the M1 synchronous path). With only a loader
 * registered, the first call starts the import and returns false until it
 * finished. A failed import is reported once to the console and retried on a
 * later call. Allocation-free once ready.
 */
export function isCoreSystemReady(range: number): boolean {
  if (factories[range] !== undefined || loaders[range] === undefined) {
    return true;
  }
  if (!loading[range]) {
    loadCoreSystem(range).catch(reportLoadError);
  }
  return false;
}

let reportedLoadError = false;
function reportLoadError(error: unknown): void {
  if (reportedLoadError) return;
  reportedLoadError = true;
  const c = (globalThis as { console?: { error(...args: unknown[]): void } })
    .console;
  c?.error('cozygpu: loading a core system chunk failed', error);
}

export class LazyCoreSystem implements CoreSystem {
  readonly name: string;
  private inner: CoreSystem | null = null;
  private ctx: CoreContext | null = null;
  private destroyed = false;

  constructor(
    readonly range: number,
    name: string,
  ) {
    this.name = name;
  }

  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    this.resolve();
  }

  /** The real system, created on first use once its factory is registered. */
  protected resolve(): CoreSystem | null {
    if (this.inner || this.destroyed || !this.ctx) return this.inner;
    const factory = factories[this.range];
    if (!factory) return null;
    const inner = factory();
    this.inner = inner;
    // Synchronous part of init runs now; failures surface like any init error.
    inner.init(this.ctx).catch(err =>
      this.ctx?.post({
        type: 'error',
        code: 'INTERNAL',
        message: `${inner.name}.init: ${(err as Error)?.message ?? String(err)}`,
      }),
    );
    return inner;
  }

  execute(reader: CommandReader, frame: CoreFrameState): void {
    const inner = this.inner ?? this.resolve();
    if (inner) inner.execute(reader, frame);
  }

  compute(list: CommandList, frame: CoreFrameState): void {
    const inner = this.inner;
    if (inner && inner.compute) inner.compute(list, frame);
  }

  draw(reader: CommandReader, pass: RenderPass, frame: CoreFrameState): void {
    // Resolve here too: a range whose commands are all DRAW (a scissor-only
    // mask never uploads anything) would otherwise never instantiate.
    const inner = this.inner ?? this.resolve();
    if (inner) inner.draw(reader, pass, frame);
  }

  /**
   * Declared unconditionally (RenderCore only calls it when the property
   * exists), so a lazily created system can still open the pass it needs —
   * the stencil attachment of a mask, the offscreen target of a filter.
   */
  passBreak(
    reader: CommandReader,
    list: CommandList,
    frame: CoreFrameState,
  ): RenderPassDesc | null {
    const inner = this.inner ?? this.resolve();
    return inner && inner.passBreak
      ? inner.passBreak(reader, list, frame)
      : null;
  }

  /**
   * Declared unconditionally (RenderCore only calls it when the property
   * exists), so a lazily created system that supports picking still replays
   * its draws into the pick pass.
   */
  drawPick(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    view: RhiBindGroup,
  ): void {
    const inner = this.inner;
    if (inner && inner.drawPick) inner.drawPick(reader, pass, frame, view);
  }

  endFrame(frame: CoreFrameState): void {
    const inner = this.inner;
    if (inner && inner.endFrame) inner.endFrame(frame);
  }

  readback(
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): Promise<ArrayBuffer> | undefined {
    const inner = this.inner;
    return inner && inner.readback
      ? inner.readback(srcKind, srcId, first, count)
      : undefined;
  }

  async restore(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    if (this.inner) await this.inner.restore(ctx);
  }

  destroy(): void {
    this.destroyed = true;
    const inner = this.inner;
    this.inner = null;
    this.ctx = null;
    inner?.destroy();
  }
}
