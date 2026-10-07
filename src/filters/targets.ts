/**
 * Pooled offscreen render targets (ARCHITECTURE §22.4),
 * shared by the filter chain and by alpha masks. DOM-free.
 *
 * Targets are keyed by (width, height, format, sampleCount) after rounding
 * the size up to FILTER_TARGET_GRANULARITY physical pixels, so a group that
 * resizes a little keeps reusing one texture. A target is acquired for the
 * duration of a frame and released at `endFrame`; nothing is created in a
 * steady-state frame, and unused targets are dropped after
 * TARGET_IDLE_FRAMES frames.
 *
 * `acquireTargetPool` / `releaseTargetPool` hand out ONE refcounted pool per
 * backend, so the filter core and the mask core never build a second one.
 * The same record carries `currentPassDesc`, the pass an inner effect has to
 * reopen: `null` means the frame's main pass, and a filter capture sets it to
 * its own target while the group's subtree is drawn.
 */
import type {
  Backend,
  RenderPassDesc,
  RhiTexture,
  TextureFormat,
} from '../backend/types';
import { TextureUsage } from '../backend/types';
import { CozyGPUError } from '../types/errors';
import { FILTER_TARGET_GRANULARITY } from '../types/layouts';

/** Frames a pooled target may stay unused before it is destroyed. */
export const TARGET_IDLE_FRAMES = 120;

export interface TargetPool {
  /**
   * A target at least `width` × `height` physical px (rounded up), or
   * exactly that size when `exact` is set (soft masks draw their capture
   * with the main pass' viewport, so it must match the canvas).
   */
  acquire(
    width: number,
    height: number,
    format?: TextureFormat,
    sampleCount?: 1 | 4,
    exact?: boolean,
  ): RhiTexture;
  release(target: RhiTexture): void;
  /** Releases every target still held and ages the free list. */
  endFrame(): void;
  /**
   * Called just before a pooled texture is destroyed (aged out, or the pool
   * itself going away), so holders of per-texture GPU objects — bind groups
   * keyed by the target — can drop them instead of accumulating entries for
   * textures that no longer exist.
   */
  onDestroyed(listener: (texture: RhiTexture) => void): void;
  offDestroyed(listener: (texture: RhiTexture) => void): void;
  /**
   * Forgets every target without destroying it: after a device restore the
   * textures belong to the lost device, so they can neither be reused nor
   * destroyed on the new one. The next acquire creates fresh targets.
   */
  reset(): void;
  /** Physical bytes currently held. */
  readonly bytes: number;
  destroy(): void;
}

/** Bytes per texel of the formats a pooled target may use. */
function texelBytes(format: TextureFormat): number {
  if (format === 'r8unorm') return 1;
  if (format === 'rgba16float') return 8;
  if (format === 'rgba32float' || format === 'rgba32uint') return 16;
  if (format === 'r32uint') return 4;
  if (format === 'rg32uint') return 8;
  return 4;
}

function roundUp(value: number): number {
  const g = FILTER_TARGET_GRANULARITY;
  return Math.max(g, Math.ceil(value / g) * g);
}

/** One pooled texture. Created on a miss, reused for the rest of its life. */
interface PoolEntry {
  texture: RhiTexture;
  width: number;
  height: number;
  format: TextureFormat;
  sampleCount: number;
  inUse: boolean;
  /** Frames since it was last released. */
  idle: number;
}

class TargetPoolImpl implements TargetPool {
  private readonly entries: PoolEntry[] = [];
  private readonly listeners: ((texture: RhiTexture) => void)[] = [];
  private held = 0;
  private destroyed = false;

  constructor(private readonly backend: Backend) {}

  get bytes(): number {
    return this.held;
  }

  onDestroyed(listener: (texture: RhiTexture) => void): void {
    if (this.listeners.indexOf(listener) < 0) this.listeners.push(listener);
  }

  offDestroyed(listener: (texture: RhiTexture) => void): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  /** Index loop, no closure: this runs when a texture dies, not per frame. */
  private announce(texture: RhiTexture): void {
    const listeners = this.listeners;
    for (let i = 0; i < listeners.length; i++) listeners[i](texture);
  }

  acquire(
    width: number,
    height: number,
    format?: TextureFormat,
    sampleCount: 1 | 4 = 1,
    exact = false,
  ): RhiTexture {
    if (this.destroyed) {
      throw new CozyGPUError('DESTROYED', 'filter target pool');
    }
    const caps = this.backend.caps;
    const fmt = format ?? caps.canvasFormat;
    const max = caps.maxTextureSize;
    const w = Math.min(max, exact ? Math.max(1, width) : roundUp(width));
    const h = Math.min(max, exact ? Math.max(1, height) : roundUp(height));
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (
        !e.inUse &&
        e.width === w &&
        e.height === h &&
        e.format === fmt &&
        e.sampleCount === sampleCount
      ) {
        e.inUse = true;
        e.idle = 0;
        return e.texture;
      }
    }
    const texture = this.backend.createTexture({
      label: `cozygpu.filter.target#${entries.length}`,
      width: w,
      height: h,
      format: fmt,
      usage:
        TextureUsage.RENDER_TARGET |
        TextureUsage.SAMPLED |
        TextureUsage.COPY_SRC,
      sampleCount,
    });
    entries.push({
      texture,
      width: w,
      height: h,
      format: fmt,
      sampleCount,
      inUse: true,
      idle: 0,
    });
    this.held += w * h * texelBytes(fmt) * sampleCount;
    return texture;
  }

  release(target: RhiTexture): void {
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].texture === target) {
        entries[i].inUse = false;
        entries[i].idle = 0;
        return;
      }
    }
  }

  endFrame(): void {
    const entries = this.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.inUse) {
        e.inUse = false;
        e.idle = 0;
        continue;
      }
      if (++e.idle > TARGET_IDLE_FRAMES) {
        this.held -= e.width * e.height * texelBytes(e.format) * e.sampleCount;
        this.announce(e.texture);
        e.texture.destroy();
        const last = entries.length - 1;
        if (i !== last) entries[i] = entries[last];
        entries.length = last;
      }
    }
  }

  reset(): void {
    this.entries.length = 0;
    this.held = 0;
  }

  destroy(): void {
    this.destroyed = true;
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      this.announce(entries[i].texture);
      entries[i].texture.destroy();
    }
    entries.length = 0;
    this.listeners.length = 0;
    this.held = 0;
  }
}

export function createTargetPool(backend: Backend): TargetPool {
  return new TargetPoolImpl(backend);
}

/**
 * @internal The one pool (and nested-pass bookkeeping) per backend, shared by
 * the filter and mask core systems. Refcounted: each system acquires it in
 * `init` / `restore` and releases it in `destroy`.
 */
interface SharedPool {
  pool: TargetPool;
  refs: number;
  /**
   * The pass an inner PASS_BREAK has to reopen, or null for the frame's main
   * pass. A filter capture sets it while the group's subtree is drawn, so a
   * mask nested inside a filtered group does not break back to the canvas.
   */
  currentPassDesc: RenderPassDesc | null;
}

const shared = new Map<Backend, SharedPool>();

function record(backend: Backend): SharedPool {
  let entry = shared.get(backend);
  if (!entry) {
    entry = { pool: createTargetPool(backend), refs: 0, currentPassDesc: null };
    shared.set(backend, entry);
  }
  return entry;
}

/** @internal Takes a reference on the backend's shared target pool. */
export function acquireTargetPool(backend: Backend): TargetPool {
  const entry = record(backend);
  entry.refs++;
  return entry.pool;
}

/** @internal Drops a reference; the last one destroys the pool. */
export function releaseTargetPool(backend: Backend): void {
  const entry = shared.get(backend);
  if (!entry) return;
  if (--entry.refs > 0) return;
  entry.pool.destroy();
  shared.delete(backend);
}

/**
 * @internal Drops the backend's pooled targets after a device restore (the
 * backend object survives it, so the shared record does too) and forgets any
 * capture pass left open by the lost frame. Safe to call from every system's
 * `restore`: the second call finds an empty pool.
 */
export function resetTargetPool(backend: Backend): void {
  const entry = shared.get(backend);
  if (!entry) return;
  entry.pool.reset();
  entry.currentPassDesc = null;
}

/** @internal The pass an effect nested in this one must reopen. */
export function currentPassDesc(backend: Backend): RenderPassDesc | null {
  return shared.get(backend)?.currentPassDesc ?? null;
}

/** @internal Sets it while a capture is open; null restores the main pass. */
export function setCurrentPassDesc(
  backend: Backend,
  desc: RenderPassDesc | null,
): void {
  record(backend).currentPassDesc = desc;
}
