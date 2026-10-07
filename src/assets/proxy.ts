/**
 * The object behind `renderer.assets` (ARCHITECTURE §15.1).
 *
 * Renderer.ts imports ONLY this module statically, so it stays tiny
 * (< 1 KB min+gzip) and imports the implementation with a dynamic
 * `import('./Assets')` on the first call that needs it. Before the
 * implementation is loaded, sync peeks answer "empty" (get → undefined,
 * has → false, stats → zeros); `addBundle` / `preload` start the import and
 * replay once it lands. `detectFormat` is the (small) pure function itself.
 */
import { CozyGPUError } from '../types/errors';
import type { Renderer } from '../types/renderer';
import { detectFormat } from './detect';
import type { AssetsApi, AssetsOptions, AssetsStats } from './types';

type Api = AssetsApi & Record<string, (...args: unknown[]) => unknown>;

export function createAssetsProxy(
  renderer: Renderer,
  options: AssetsOptions | undefined,
): AssetsApi {
  let impl: Api | undefined;
  let loading: Promise<Api> | undefined;
  let dead = false;
  const names = new Set<string>();

  const load = (): Promise<Api> =>
    (loading ||= import('./Assets').then(m => {
      impl = new m.Assets(renderer, options) as unknown as Api;
      if (dead) impl.destroy();
      return impl;
    }));
  const later =
    (name: string) =>
    (...args: unknown[]): Promise<unknown> =>
      dead
        ? Promise.reject(new CozyGPUError('DESTROYED', 'renderer.assets'))
        : load().then(a => a[name](...args));
  const sync =
    (name: string) =>
    (...args: unknown[]): unknown => {
      if (impl) return impl[name](...args);
      if (!dead) load().then(a => a[name](...args));
      return undefined;
    };
  const peek =
    (name: string, empty?: unknown) =>
    (...args: unknown[]): unknown =>
      impl ? impl[name](...args) : empty;
  const zero: AssetsStats = {
    entries: 0,
    referenced: 0,
    inFlight: 0,
    queued: 0,
    gpuBytes: 0,
    gpuBudgetBytes: 0,
    atlasPages: 0,
    evictions: 0,
  };
  const addBundle = sync('addBundle');

  return {
    load: later('load'),
    loadAll: later('loadAll'),
    loadBundle: later('loadBundle'),
    addBundle(name, entries) {
      // Duplicate names must throw synchronously even before the import.
      if (!impl && names.has(name)) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `bundle "${name}" already exists`,
        );
      }
      names.add(name);
      addBundle(name, entries);
    },
    preload: sync('preload'),
    get: peek('get'),
    has: peek('has', false),
    unload: peek('unload'),
    trim: peek('trim'),
    get stats() {
      return impl ? impl.stats : zero;
    },
    detectFormat,
    destroy() {
      dead = true;
      impl?.destroy();
    },
  } as AssetsApi;
}
