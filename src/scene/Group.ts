/**
 * Group: a Container with a mask and/or a filter chain (ARCHITECTURE §21.4).
 *
 * It is the ONLY scene class that knows about effects, and nothing on the
 * minimal path references it, so a program that never imports `Group` carries
 * no mask or filter code at all. The two implementations arrive as their own
 * chunks the first time `mask` / `filters` is set; until they are here the
 * subtree is not drawn (a mask must never flash unclipped content), and
 * `ready` resolves when it is drawable again.
 *
 * The scene packer treats a Group like a CustomDrawable that has children: it
 * flushes the open sprite batch, calls `_emitGroupBegin`, walks the subtree,
 * then calls `_emitGroupEnd` (§21.4).
 */
import type { FilterBinding, Filter, FilterOptions } from '../filters/types';
import type { MaskBinding, MaskTarget } from '../masks/types';
import type { FrontFrame, RenderGroup } from '../types/core';
import type { GroupNode, GroupOptions } from './types';
import { Container } from './Container';
import { CozyGPUError } from '../types/errors';
import { nodeStore } from './store';

/** Resolved once each; the chunks are shared by every Group in the page. */
let maskChunk: Promise<typeof import('../masks/mask')> | null = null;
let filterChunk: Promise<typeof import('../filters/filters')> | null = null;

export class Group extends Container implements GroupNode, RenderGroup {
  /** @internal */
  _mask: MaskTarget = null;
  /** @internal */
  _filters: readonly Filter[] | null = null;
  /** @internal */
  _filterOptions: FilterOptions = {};
  /** @internal Bindings, once their chunk landed. */
  _maskBinding: MaskBinding | null = null;
  /** @internal */
  _filterBinding: FilterBinding | null = null;
  /** @internal Chunk loads in flight. */
  _ready: Promise<void> = Promise.resolve();

  constructor(options?: GroupOptions) {
    super(options);
    // The packer takes full rebuilds while a group is alive (§21.4).
    nodeStore.groups++;
    if (options) {
      if (options.filterOptions) this._filterOptions = options.filterOptions;
      if (options.mask !== undefined) this.mask = options.mask;
      if (options.filters !== undefined) this.filters = options.filters;
    }
  }

  override get kind(): 'group' {
    return 'group';
  }

  get mask(): MaskTarget {
    return this._mask;
  }

  set mask(target: MaskTarget) {
    const t = target as { kind?: string; source?: { kind?: string } } | null;
    if (t && (t.kind ?? t.source?.kind) === 'layer') {
      // ARCHITECTURE §28.6: a SpriteLayer cannot be a mask source.
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'Group.mask: a SpriteLayer cannot be a mask source',
      );
    }
    this._mask = target;
    if (this._maskBinding) {
      this._maskBinding.update(target);
    } else if (target !== null) {
      this._load();
    }
  }

  get filters(): readonly Filter[] | null {
    return this._filters;
  }

  set filters(chain: readonly Filter[] | null) {
    this._filters = chain && chain.length > 0 ? chain : null;
    if (this._filterBinding) {
      this._filterBinding.update(this._filters, this._filterOptions);
    } else if (this._filters !== null) {
      this._load();
    }
  }

  get filterOptions(): FilterOptions {
    return this._filterOptions;
  }

  set filterOptions(options: FilterOptions) {
    this._filterOptions = options;
    this._filterBinding?.update(this._filters, options);
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  /** @internal Starts the chunk loads this group's current effects need. */
  private _load(): void {
    const wants: Promise<unknown>[] = [];
    if (this._mask !== null && !this._maskBinding) {
      maskChunk ??= import('../masks/mask');
      wants.push(
        maskChunk.then(m => {
          if (this.destroyed || this._mask === null) return;
          const binding = m.createMaskBinding(this);
          this._maskBinding = binding;
          binding.update(this._mask);
        }),
      );
    }
    if (this._filters !== null && !this._filterBinding) {
      filterChunk ??= import('../filters/filters');
      wants.push(
        filterChunk.then(m => {
          if (this.destroyed || this._filters === null) return;
          const binding = m.createFilterBinding(this);
          this._filterBinding = binding;
          binding.update(this._filters, this._filterOptions);
        }),
      );
    }
    if (wants.length > 0)
      this._ready = Promise.all(wants).then(() => undefined);
  }

  /** @internal RenderGroup: see ARCHITECTURE §21.4. */
  _emitGroupBegin(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): boolean {
    const mask = this._maskBinding;
    const filter = this._filterBinding;
    // An effect was asked for but its chunk is not here yet: skip the subtree.
    if ((this._mask !== null && !mask) || (this._filters !== null && !filter)) {
      return false;
    }
    if (filter && !filter.emitBegin(frame, world, worldOffset, worldAlpha)) {
      return false;
    }
    if (mask && !mask.emitBegin(frame, world, worldOffset, worldAlpha)) {
      if (filter) filter.emitEnd(frame);
      return false;
    }
    return true;
  }

  /** @internal */
  _emitGroupEnd(frame: FrontFrame): void {
    this._maskBinding?.emitEnd(frame);
    this._filterBinding?.emitEnd(frame);
  }

  override destroy(options?: { children?: boolean; texture?: boolean }): void {
    if (!this.destroyed) nodeStore.groups--;
    this._maskBinding?.destroy();
    this._filterBinding?.destroy();
    this._maskBinding = null;
    this._filterBinding = null;
    this._mask = null;
    this._filters = null;
    super.destroy(options);
  }
}

/**
 * Preloads the mask and filter chunks, so the first frame that uses a group
 * is not skipped. Rejects like any dynamic import.
 */
export function loadEffects(
  which: 'mask' | 'filters' | 'all' = 'all',
): Promise<void> {
  const wants: Promise<unknown>[] = [];
  if (which !== 'filters') wants.push((maskChunk ??= import('../masks/mask')));
  if (which !== 'mask') {
    wants.push((filterChunk ??= import('../filters/filters')));
  }
  return Promise.all(wants).then(() => undefined);
}
