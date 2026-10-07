/**
 * `GPU.SpriteLayer` shell (M5, ARCHITECTURE §28.4). It stays in the
 * importer's entry chunk because its writes are synchronous: options, the
 * own stream stores (one per stream, sized to `capacity`), `setInstance`,
 * `markDirty` (up to 8 dirty ranges per stream), column binding validation
 * and the committed row ranges. Everything per frame — packing columns,
 * uploads, LAYER_* commands — is the lazily loaded `layer` chunk
 * (`front.ts`), which registers the core loader; the core and its shaders
 * are further chunks. Until they have landed the layer draws nothing.
 */
import type { BlendMode } from '../backend/types';
import { NodeBase } from '../scene/Node';
import type { TextureHandle } from '../scene/types';
import { DirtyRanges } from '../sprites/DirtyRanges';
import type { CustomDrawable, FrontFrame } from '../types/core';
import { CozyGPUError } from '../types/errors';
import {
  LAYER_MAX_FRAMES,
  LAYER_MAX_TEXTURES,
  LayerStreamBit,
} from '../types/layerLayouts';
import type {
  LayerColumnBinding,
  LayerColumnOptions,
  LayerColumns,
  LayerExternalSource,
  SpriteLayerData,
  SpriteLayerNode,
  SpriteLayerOptions,
} from './types';

type Front = typeof import('./front');
let frontChunk: Promise<Front> | null = null;

/** Preloads the SpriteLayer chunks for the current backend. */
export function loadSpriteLayer(): Promise<void> {
  return (frontChunk ??= import('./front')).then(m => m.preload());
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** f32 → IEEE half-float bits, rounded to nearest (layerLayouts LX_SCALE_*). */
export function toHalf(v: number): number {
  F32[0] = v;
  const x = U32[0];
  const s = (x >>> 16) & 0x8000;
  const e = (x >>> 23) & 0xff;
  if (e < 103) return s;
  if (e > 142) return s | 0x7c00;
  if (e < 113) {
    return s | (((((x & 0x7fffff) | 0x800000) >>> (125 - e)) + 1) >>> 1);
  }
  return (s | (((e - 112) << 10) | ((x >>> 13) & 0x3ff))) + ((x >>> 12) & 1);
}

/** Radians → u16 turns (LX_ROTATION). */
export const TURNS = 65536 / (2 * Math.PI);

/** u32 words per row of each stream's store. */
export const WORDS = [2, 2, 1, 1];

/** Packed column names; their index is the slot in `_cols`. */
export const PACKED = [
  'x',
  'y',
  'scale',
  'scaleX',
  'scaleY',
  'rotation',
  'frame',
  'tint',
  'alpha',
] as const;
/** The stream (bit) each packed column feeds. */
const PACKED_STREAM = [1, 1, 2, 2, 2, 2, 2, 4, 4];
/** Direct columns, by LayerStream. */
const DIRECT = ['xy', 'xform', 'color', 'userId'] as const;

/** A resolved packed column: array, first element, elements per row. */
export interface PackedColumn {
  readonly a: Float32Array | Uint32Array;
  readonly o: number;
  readonly s: number;
}

function fail(message: string): never {
  throw new CozyGPUError('INVALID_ARGUMENT', `SpriteLayer: ${message}`);
}

function isCount(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= max;
}

function checkOptions(o: SpriteLayerOptions): SpriteLayerOptions {
  if (!o || !isCount(o.capacity, 0x7fffffff) || o.capacity < 1) {
    fail('options.capacity must be an integer >= 1');
  }
  return o;
}

const sab = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined' &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
    true;

export class SpriteLayer
  extends NodeBase
  implements SpriteLayerNode, CustomDrawable
{
  readonly streams: number;
  cullMargin: number;
  /** @internal */
  _capacity = 0;
  /** @internal */
  _count = 0;
  /** @internal */
  _frames: readonly TextureHandle[] = [];
  /** @internal Bumped when `frames` is set. */
  _framesVersion = 0;
  /** @internal unorm16 x | unorm16 y << 16 (LF_ANCHOR). */
  readonly _anchor: number;
  /** @internal */
  _blendMode: BlendMode;
  /** @internal */
  _cull: boolean;
  /** @internal The own stores. */
  _data!: SpriteLayerData;
  /** @internal Dirty rows of the own stores, per LayerStream. */
  readonly _dirty = [
    new DirtyRanges(),
    new DirtyRanges(),
    new DirtyRanges(),
    new DirtyRanges(),
  ];
  /** @internal Rows committed through the column binding. */
  readonly _commits = new DirtyRanges();
  /** @internal Rows ever written (re-uploaded after a device loss). */
  _rows = 0;
  /** @internal Packed columns by PACKED index; direct ones by stream. */
  readonly _cols: (PackedColumn | null)[] = [];
  readonly _direct: (Float32Array | Uint32Array | null)[] = [];
  /** @internal */
  _binding: LayerColumnBinding | null = null;
  /** @internal */
  _source: LayerExternalSource | null = null;
  /** @internal */
  _sourceCount = 0;
  /** @internal Bumped when the source changes. */
  _sourceVersion = 0;
  /** @internal The last renderer had no indirect draws (WebGL2). */
  _noIndirect = false;
  /** @internal Per-renderer state of the `layer` chunk. */
  _state: unknown = null;
  /** @internal f32 → f16 bits, for the `layer` chunk (see format.ts). */
  _half = toHalf;
  /** @internal Set once the `layer` chunk landed. */
  _front: Front | null = null;
  /** @internal */
  _ready: Promise<void>;

  constructor(options: SpriteLayerOptions) {
    super(checkOptions(options));
    const s = options.streams;
    this.streams =
      LayerStreamBit.POSITION |
      (s?.xform !== false ? LayerStreamBit.XFORM : 0) |
      (s?.color !== false ? LayerStreamBit.COLOR : 0) |
      (s?.user ? LayerStreamBit.USER : 0);
    this._blendMode = options.blendMode ?? 'normal';
    this._cull = !!options.cull;
    this.cullMargin = options.cullMargin ?? 0;
    const unorm = (v: number) =>
      Math.round(Math.min(1, Math.max(0, v)) * 0xffff);
    this._anchor =
      (unorm(options.anchorX ?? options.anchor ?? 0.5) |
        (unorm(options.anchorY ?? options.anchor ?? 0.5) << 16)) >>>
      0;
    this.frames = options.frames ?? options.textures ?? [];
    this.capacity = options.capacity;
    this.count = options.count ?? 0;
    this._ready = (frontChunk ??= import('./front')).then(m => {
      if (this._destroyed) return;
      this._front = m;
      return m.preload();
    });
    // Keeps an unhandled rejection from being reported before `ready` is used.
    this._ready.catch(() => {});
  }

  get kind(): 'layer' {
    return 'layer';
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  get data(): SpriteLayerData {
    return this._data;
  }

  get capacity(): number {
    return this._capacity;
  }

  set capacity(n: number) {
    this._assertAlive('SpriteLayer.capacity');
    if (!isCount(n, 0x7fffffff) || n < 1) fail(`capacity ${n}`);
    const old = this._data;
    const keep = Math.min(n, this._capacity);
    const views: ArrayBufferView[] = [];
    for (let k = 0; k < 4; k++) {
      const bytes = this.streams & (1 << k) ? n * WORDS[k] * 4 : 0;
      const buf = sab() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
      const u32 = new Uint32Array(buf);
      // New rows: scale 1 (f16 0x3c00 twice), opaque white.
      if (k === 1) for (let i = 0; i < u32.length; i += 2) u32[i] = 0x3c003c00;
      if (k === 2) u32.fill(0xffffffff);
      if (old && bytes > 0) {
        const prev = [old.position, old.xform, old.color, old.user][k];
        u32.set(new Uint32Array(prev.buffer, 0, keep * WORDS[k]));
      }
      views.push(
        k === 0 ? new Float32Array(buf) : k === 1 ? new Uint16Array(buf) : u32,
      );
    }
    this._data = {
      position: views[0] as Float32Array,
      xform: views[1] as Uint16Array,
      color: views[2] as Uint32Array,
      user: views[3] as Uint32Array,
    };
    this._capacity = n;
    if (this._count > n) this._count = n;
    if (this._rows > n) this._rows = n;
  }

  get count(): number {
    return this._count;
  }

  set count(n: number) {
    if (!isCount(n, this._capacity)) fail(`count ${n}`);
    this._count = n;
  }

  get frames(): readonly TextureHandle[] {
    return this._frames;
  }

  set frames(frames: readonly TextureHandle[]) {
    const n = frames?.length ?? 0;
    if (n < 1 || n > LAYER_MAX_FRAMES) fail('needs 1–65536 frames or textures');
    const sources: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = frames[i].sourceId;
      if (sources.indexOf(id) < 0) sources.push(id);
    }
    if (sources.length > LAYER_MAX_TEXTURES) {
      fail(`frames use ${sources.length} texture sources (max 8)`);
    }
    this._frames = frames.slice();
    this._framesVersion++;
  }

  get blendMode(): BlendMode {
    return this._blendMode;
  }

  set blendMode(mode: BlendMode) {
    this._blendMode = mode;
  }

  get cull(): boolean {
    return this._cull;
  }

  set cull(on: boolean) {
    this._cull = on;
  }

  // ─── Own stores ────────────────────────────────────────────────────────────

  setInstance(
    index: number,
    x: number,
    y: number,
    rotation = 0,
    scale = 1,
    frame = 0,
    color = 0xffffffff,
  ): void {
    this.markDirty(index, 1);
    const d = this._data;
    d.position[2 * index] = x;
    d.position[2 * index + 1] = y;
    if (this.streams & LayerStreamBit.XFORM) {
      const h = toHalf(scale);
      const o = 4 * index;
      d.xform[o] = d.xform[o + 1] = h;
      d.xform[o + 2] = Math.round(rotation * TURNS);
      d.xform[o + 3] = frame;
    }
    if (this.streams & LayerStreamBit.COLOR) d.color[index] = color;
  }

  markDirty(first: number, count: number, streams = this.streams): void {
    this._assertAlive('SpriteLayer.markDirty');
    if (
      !isCount(first, this._capacity) ||
      !isCount(count, this._capacity - first)
    ) {
      fail(`rows [${first}, ${first + count}) outside the capacity`);
    }
    for (let k = 0; k < 4; k++) {
      if (streams & this.streams & (1 << k)) {
        this._dirty[k].addRange(first, first + count);
      }
    }
    if (first + count > this._rows) this._rows = first + count;
  }

  // ─── Columns ───────────────────────────────────────────────────────────────

  bindColumns(
    columns: LayerColumns,
    options?: LayerColumnOptions,
  ): LayerColumnBinding {
    this._bind(columns, options);
    return this._binding!;
  }

  /** @internal Resolves and validates `columns`; (re)creates the binding. */
  _bind(columns: LayerColumns, options?: LayerColumnOptions): void {
    this._assertAlive('SpriteLayer.bindColumns');
    const stride = options?.stride ?? 1;
    let packed = 0;
    let direct = 0;
    for (let j = 0; j < PACKED.length; j++) {
      const c = columns?.[PACKED[j]];
      let col: PackedColumn | null = null;
      if (c) {
        const view = ArrayBuffer.isView(c);
        const a = view ? c : c.array;
        if (!(a instanceof Float32Array || a instanceof Uint32Array)) {
          fail(`column ${PACKED[j]} must be a Float32Array or Uint32Array`);
        }
        col = {
          a,
          o: view ? 0 : (c.offset ?? 0),
          s: view ? stride : (c.stride ?? stride),
        };
        packed |= PACKED_STREAM[j];
      }
      this._cols[j] = col;
    }
    for (let k = 0; k < 4; k++) {
      const c = columns?.[DIRECT[k]] ?? null;
      if (c && !(c instanceof (k ? Uint32Array : Float32Array))) {
        fail(`column ${DIRECT[k]} has the wrong array type`);
      }
      if (c) direct |= 1 << k;
      this._direct[k] = c;
    }
    const streams = packed | direct;
    if (packed & direct)
      fail('a stream is fed by a direct and a packed column');
    if (!this._cols[0] !== !this._cols[1]) fail('x and y go together');
    if (streams & ~this.streams)
      fail('a column feeds a stream the layer lacks');
    const layer = this;
    this._binding ??= {
      streams,
      commit: (count: number, first?: number) => layer._commit(count, first),
      rebind: (c: LayerColumns, o?: LayerColumnOptions) => layer._bind(c, o),
      unbind: () => {
        layer._cols.length = 0;
        layer._direct.length = 0;
        (layer._binding as { streams: number }).streams = 0;
      },
    };
    (this._binding as { streams: number }).streams = streams;
  }

  /** @internal LayerColumnBinding.commit. */
  _commit(count: number, first?: number): void {
    this._assertAlive('LayerColumnBinding.commit');
    const from = first ?? 0;
    const end = from + count;
    if (
      !isCount(from, this._capacity) ||
      !isCount(count, this._capacity - from)
    ) {
      fail(`commit rows [${from}, ${end}) outside the capacity`);
    }
    for (let j = 0; j < PACKED.length; j++) {
      const c = this._cols[j];
      if (c && count > 0 && c.o + (end - 1) * c.s >= c.a.length) {
        fail(`column ${PACKED[j]} is too short`);
      }
    }
    for (let k = 0; k < 4; k++) {
      const c = this._direct[k];
      if (c && end * WORDS[k] > c.length)
        fail(`column ${DIRECT[k]} is too short`);
    }
    if (first === undefined) this._count = count;
    this._commits.addRange(from, end);
    if (end > this._rows) this._rows = end;
  }

  // ─── External source ───────────────────────────────────────────────────────

  get source(): LayerExternalSource | null {
    return this._source;
  }

  setSource(source: LayerExternalSource | null): void {
    this._assertAlive('SpriteLayer.setSource');
    let rows = 0x7fffffff;
    if (source) {
      const names = ['position', 'xform', 'color', 'user', 'indirect'] as const;
      for (let k = 0; k < 5; k++) {
        const b = source[names[k]];
        const layout = k < 4 ? `layer-${names[k]}` : 'draw-indirect';
        if (!b ? k === 0 : b.layout !== layout || !b.valid) {
          fail(`source.${names[k]} must be a valid '${layout}' buffer`);
        }
        if (b && k < 4) rows = Math.min(rows, b.capacity);
        if (k > 0 && k < 4 && !b && this.streams & (1 << k)) {
          rows = Math.min(rows, this._capacity);
        }
      }
      if (source.indirect && this._noIndirect) {
        throw new CozyGPUError(
          'UNSUPPORTED',
          'SpriteLayer.setSource: indirect needs the WebGPU backend',
        );
      }
      if (source.count !== undefined) rows = Math.min(rows, source.count);
    }
    this._source = source;
    this._sourceCount = source ? Math.max(0, Math.floor(rows)) : 0;
    this._sourceVersion++;
  }

  /**
   * Instance count of the external source. Does nothing without a source:
   * a device loss drops it (set it again from `deviceRestored`), and an
   * ECS loop calling this every frame must not throw meanwhile.
   */
  setSourceCount(count: number): void {
    if (!this._source) return;
    this._sourceCount = Math.max(0, Math.floor(count));
  }

  // ─── Drawing seam ──────────────────────────────────────────────────────────

  /** @internal CustomDrawable (ARCHITECTURE §28.4). */
  _emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    if (this._front !== null && !this._destroyed) {
      this._front.emitLayer(this, frame, world, worldOffset, worldAlpha);
    }
  }

  override destroy(options?: Parameters<NodeBase['destroy']>[0]): void {
    if (this._destroyed) return;
    this._front?.releaseLayer(this);
    this._cols.length = 0;
    this._direct.length = 0;
    this._source = null;
    super.destroy(options);
  }
}
