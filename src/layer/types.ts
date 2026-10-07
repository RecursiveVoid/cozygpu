/**
 * SpriteLayer public types (M5, ARCHITECTURE §28, docs/API.md "SpriteLayer").
 *
 * A SpriteLayer draws up to millions of quads from compact GPU-resident
 * streams (8–24 B per instance, `src/types/layerLayouts.ts`) in ONE draw:
 * no node per sprite, no per-sprite CPU work per frame. Instances are rows,
 * not scene nodes; the layer itself is one leaf node of the scene graph, so
 * it moves, fades, masks and filters like any other node. Data comes from
 * caller columns (an ECS), the layer's own typed arrays, or GPU buffers
 * written by external compute (main-thread mode).
 */
import type { BlendMode } from '../backend/types';
import type {
  ColumnSource,
  NodeOptions,
  SceneNode,
  TextureHandle,
} from '../scene/types';
import type { ExternalInstanceBuffer } from '../types/interop';

/** Which optional per-instance streams a layer has (POSITION always). */
export interface SpriteLayerStreams {
  /** scale x/y, rotation, frame index. Default true. */
  xform?: boolean;
  /** tint × alpha. Default true. */
  color?: boolean;
  /** u32 user id per instance, returned as `PickHit.userId`. Default false. */
  user?: boolean;
}

export interface SpriteLayerOptions extends NodeOptions {
  /**
   * Instances the GPU streams hold. Raising `capacity` later re-allocates
   * the streams and re-uploads every row, so size it once.
   */
  capacity: number;
  /** Rows drawn: [0, count). Default 0. */
  count?: number;
  /**
   * The frame table: the XFORM stream's frame index picks one entry. Frames
   * of up to LAYER_MAX_TEXTURES (8) distinct texture sources stay in one
   * draw (atlas pages); more is INVALID_ARGUMENT. Default: none — then
   * `textures` must be given and each texture is one whole-texture frame.
   */
  frames?: readonly TextureHandle[];
  /** Shorthand for `frames` when every frame is a whole texture. */
  textures?: readonly TextureHandle[];
  /** Anchor of every frame, 0..1 of the frame (default 0.5: centred). */
  anchor?: number;
  anchorX?: number;
  anchorY?: number;
  /** Optional streams. Default `{ xform: true, color: true, user: false }`. */
  streams?: SpriteLayerStreams;
  blendMode?: BlendMode;
  /**
   * GPU frustum culling with order-preserving compaction (WebGPU with
   * compute and indirect draws; ignored elsewhere). Pays off when a large
   * share of the layer is off screen. Default false.
   */
  cull?: boolean;
  /** Extra css px kept around the viewport when culling. Default 0. */
  cullMargin?: number;
}

/**
 * Caller-owned columns for `layer.bindColumns`. Row i drives instance i.
 * Units match the Sprite setters: layer px, radians, 0..1 alpha,
 * 0xRRGGBB tint.
 *
 * Columns whose memory already has a stream's record layout are uploaded
 * straight from the caller's buffer (zero CPU work; main thread, or worker
 * mode with a SharedArrayBuffer): `xy` (POSITION), `xform` (XFORM),
 * `color` (COLOR), `userId` (USER). They must be dense. Every other column
 * is packed into the layer's own stream store when committed.
 */
export interface LayerColumns {
  /** Interleaved [x0, y0, x1, y1, …], the POSITION stream as-is. */
  readonly xy?: Float32Array;
  /** Use `x` + `y` (packed) or `xy` (direct), not both. */
  readonly x?: ColumnSource<Float32Array>;
  readonly y?: ColumnSource<Float32Array>;
  /** Uniform scale; `scaleX` / `scaleY` override it per axis. */
  readonly scale?: ColumnSource<Float32Array>;
  readonly scaleX?: ColumnSource<Float32Array>;
  readonly scaleY?: ColumnSource<Float32Array>;
  /** Radians. */
  readonly rotation?: ColumnSource<Float32Array>;
  /** Index into the frame table. */
  readonly frame?: ColumnSource<Uint32Array>;
  /**
   * Pre-packed XFORM records, two u32 per row (`layerLayouts.LX_*`):
   * uploaded as-is. Excludes scale / rotation / frame columns.
   */
  readonly xform?: Uint32Array;
  /** 0xRRGGBB. */
  readonly tint?: ColumnSource<Uint32Array>;
  /** 0..1. */
  readonly alpha?: ColumnSource<Float32Array>;
  /**
   * Pre-packed RGBA8 (`r | g << 8 | b << 16 | a << 24`, straight alpha):
   * uploaded as-is. Excludes tint / alpha columns.
   */
  readonly color?: Uint32Array;
  /** u32 per row (USER stream, `PickHit.userId`): uploaded as-is. */
  readonly userId?: Uint32Array;
}

export interface LayerColumnOptions {
  /**
   * Default element stride of the packed columns given as plain typed
   * arrays (default 1). Direct columns are always dense.
   */
  stride?: number;
}

/** A layer's reused column binding (register once, commit per frame). */
export interface LayerColumnBinding {
  /** LayerStreamBit mask of the streams the bound columns feed. */
  readonly streams: number;
  /**
   * Rows [first, first + count) changed: render() reads them from the bound
   * columns (direct columns are uploaded from the caller's memory, packed
   * ones are converted into the layer's stores) — so keep the arrays
   * unchanged until then. Without `first`, also sets `layer.count = count`
   * (the usual ECS call: every live row changed). Zero allocations.
   * INVALID_ARGUMENT when first + count exceeds `capacity` or a column is
   * too short; DESTROYED after the layer is destroyed.
   */
  commit(count: number, first?: number): void;
  /** Bind again after a column's array object was replaced. */
  rebind(columns: LayerColumns, options?: LayerColumnOptions): void;
  /** Drops the references (the arrays can be collected). */
  unbind(): void;
}

/**
 * The layer's own stream stores (CPU). Write them directly, then call
 * `markDirty`. Views are replaced when `capacity` changes.
 */
export interface SpriteLayerData {
  /** [x0, y0, x1, y1, …] */
  readonly position: Float32Array;
  /**
   * 4 u16 per row: f16 bits of scaleX, f16 bits of scaleY, rotation in
   * turns × 65536, frame. Zero-length without the XFORM stream.
   */
  readonly xform: Uint16Array;
  /** Packed RGBA8 per row. Zero-length without the COLOR stream. */
  readonly color: Uint32Array;
  /** Zero-length without the USER stream. */
  readonly user: Uint32Array;
}

/**
 * GPU buffers written by outside code (main-thread mode, renderer interop
 * §19.4), registered with the matching `ExternalLayout`. The layer draws
 * from them with zero copies; cozygpu never writes them.
 */
export interface LayerExternalSource {
  /** 'layer-position'. */
  readonly position: ExternalInstanceBuffer;
  /** 'layer-xform'; omitted = the layer's own XFORM stream (or defaults). */
  readonly xform?: ExternalInstanceBuffer;
  /** 'layer-color'. */
  readonly color?: ExternalInstanceBuffer;
  /** 'layer-user'. */
  readonly user?: ExternalInstanceBuffer;
  /**
   * 'draw-indirect' (WebGPU): the draw count is its instanceCount, written
   * on the GPU. Without it the count is `count` / `setSourceCount`.
   */
  readonly indirect?: ExternalInstanceBuffer;
  /** Rows drawn (ignored with `indirect`). Default: the smallest capacity. */
  readonly count?: number;
}

export interface SpriteLayerNode extends SceneNode {
  readonly kind: 'layer';
  /** See SpriteLayerOptions.capacity. */
  capacity: number;
  /** Rows drawn: [0, count). */
  count: number;
  /** LayerStreamBit mask of the layer's streams (fixed at construction). */
  readonly streams: number;
  frames: readonly TextureHandle[];
  blendMode: BlendMode;
  cull: boolean;
  cullMargin: number;
  /** The layer's own stores; see SpriteLayerData. */
  readonly data: SpriteLayerData;
  /**
   * Writes one row of the own stores (setup and sparse edits; not for
   * millions of rows per frame). Arguments past `y` default to rotation 0,
   * scale 1, frame 0, color 0xffffffff. Marks the row dirty.
   */
  setInstance(
    index: number,
    x: number,
    y: number,
    rotation?: number,
    scale?: number,
    frame?: number,
    color?: number,
  ): void;
  /** Rows [first, first + count) of `data` changed (`streams` default: all). */
  markDirty(first: number, count: number, streams?: number): void;
  /** Binds caller columns; returns the layer's single reused binding. */
  bindColumns(
    columns: LayerColumns,
    options?: LayerColumnOptions,
  ): LayerColumnBinding;
  /**
   * Draw from external GPU buffers (main-thread mode; UNSUPPORTED in worker
   * mode). `null` returns to the own stores, whose contents were kept.
   */
  setSource(source: LayerExternalSource | null): void;
  readonly source: LayerExternalSource | null;
  /** Draw count of an external source without `indirect`. */
  setSourceCount(count: number): void;
  /** Resolves when the layer's chunks have loaded and it can draw. */
  readonly ready: Promise<void>;
}

export interface SpriteLayerConstructor {
  new (options: SpriteLayerOptions): SpriteLayerNode;
  readonly prototype: SpriteLayerNode;
}
