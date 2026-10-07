/**
 * Scene graph public API, implemented in src/scene/**. M2 additions: `pickable`, the bulk
 * child transform API and `TextureProvider` (the assets ↔ scene seam). M2.5
 * additions: `userId` and external columns (`bindColumns`, ARCHITECTURE
 * §19.1, §19.3).
 *
 * Tier 1 of cozygpu: a CPU scene graph (Pixi-like). Nodes are small handles;
 * their numeric state lives in shared typed-array stores (SoA) and the
 * renderer uploads only dirty instance ranges. Property setters only write a
 * typed array slot and set a dirty bit — they never allocate.
 *
 * Interfaces are suffixed (`SceneNode`, `ContainerNode`, …) so the concrete
 * classes (`Container`, `Sprite`, `Texture`, `Swarm`) can use the plain names.
 */
import type { BlendMode } from '../backend/types';
import type { Filter, FilterOptions } from '../filters/types';
import type { MaskTarget } from '../masks/types';
import type { FrontFrame } from '../types/core';

export type NodeKind = 'container' | 'sprite' | 'swarm' | 'group' | 'graphics';

export interface NodeOptions {
  label?: string;
  x?: number;
  y?: number;
  rotation?: number;
  /** Sets scaleX and scaleY. */
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  skewX?: number;
  skewY?: number;
  pivotX?: number;
  pivotY?: number;
  alpha?: number;
  visible?: boolean;
  /** M2. See SceneNode.pickable. */
  pickable?: boolean;
  /** M2.5. See SceneNode.userId. */
  userId?: number;
}

export interface SceneNode {
  /** Process-unique u32 (ids.node). */
  readonly id: number;
  readonly kind: NodeKind;
  readonly parent: ContainerNode | null;
  label: string;

  x: number;
  y: number;
  /** Radians. */
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  pivotX: number;
  pivotY: number;
  /** 0..1, multiplied down the tree. */
  alpha: number;
  /** Invisible nodes (and their subtrees) are skipped entirely: no transform update, no draw. */
  visible: boolean;
  /**
   * M2. Whether `renderer.pick()` can return this node. Default true for
   * Sprite, false for Swarm (opt-in; particles usually should not block
   * picks). Containers have no pixels; the flag has no effect on them or on
   * their children. Changing it rewrites the sprite instance (no structure change).
   */
  pickable: boolean;
  /**
   * M2.5. A u32 the caller owns (an entity id, an index, a handle), default
   * 0. cozygpu only stores it and returns it as `PickHit.userId` for sprite
   * hits; it never changes drawing, so setting it marks nothing dirty.
   * Values are coerced with `>>> 0`. For a Swarm node this is the node's own
   * id; instance ids live in `cold.user` (SpawnOptions.user).
   */
  userId: number;

  setPosition(x: number, y: number): this;
  /** `y` defaults to `x`. */
  setScale(x: number, y?: number): this;
  setPivot(x: number, y: number): this;

  /**
   * Stage-space affine [a, b, c, d, tx, ty] as of the last render()
   * (or `updateTransform()`), at `worldTransformOffset`. The array is shared
   * storage: read, don't keep, don't write.
   */
  readonly worldTransform: Float32Array;
  readonly worldTransformOffset: number;
  readonly worldAlpha: number;

  removeFromParent(): void;
  destroy(options?: DestroyOptions): void;
  readonly destroyed: boolean;
}

export interface DestroyOptions {
  /** Also destroy all descendants (default true). */
  children?: boolean;
  /** Also destroy the texture source (default false). */
  texture?: boolean;
}

export interface ContainerNode extends SceneNode {
  readonly children: readonly SceneNode[];
  addChild<T extends SceneNode>(child: T): T;
  addChildAt<T extends SceneNode>(child: T, index: number): T;
  removeChild<T extends SceneNode>(child: T): T;
  /** Removes children in [begin, end) and returns them. */
  removeChildren(begin?: number, end?: number): SceneNode[];
  setChildIndex(child: SceneNode, index: number): void;
  getChildIndex(child: SceneNode): number;
  /** Recomputes world transforms of this subtree now (render() does it automatically). */
  updateTransform(): void;

  /**
   * M2 bulk path (ARCHITECTURE §16.1). Returns this container's reused
   * writer for its **direct children** with dense arrays indexed by child
   * index, allocated (or grown) for the requested `fields` only. Write the
   * arrays, then `commit()`. Allocation-free once sized. The arrays are
   * invalidated when the children list changes (compare `writer.version`
   * with `container.childrenVersion`); acquire again after add/remove.
   */
  bulkChildren(fields: number): BulkChildren;
  /** M2. Bumped whenever this container's children list changes. */
  readonly childrenVersion: number;

  /**
   * M2.5 external columns (ARCHITECTURE §19.1). Binds caller-owned typed
   * arrays (an ECS archetype's columns, or plain arrays) to this container's
   * direct children: row i drives child i. Register once, then call
   * `binding.commit(count)` once per frame. Bind again (same call, or
   * `binding.rebind`) whenever an array object is replaced, e.g. after an
   * archetype grows. Validates and stores references only; never copies at
   * bind time. Returns this container's single reused binding.
   */
  bindColumns(
    columns: SpriteColumns,
    options?: BindColumnsOptions,
  ): ColumnBinding;
}

// ─── Groups: masks and filters (M3, ARCHITECTURE §21, §22) ────────────────────

export interface GroupOptions extends NodeOptions {
  children?: SceneNode[];
  mask?: MaskTarget;
  filters?: readonly Filter[] | null;
  filterOptions?: FilterOptions;
}

/**
 * M3. A Container that can carry a mask and/or a filter chain. Effects are
 * deliberately NOT on every Container: a group is a batch boundary and may
 * cost a render target, and keeping them here also keeps the mask and filter
 * code out of programs that never import `Group` (ARCHITECTURE §22.8).
 *
 * Both effects load their implementation chunk on first use. Until it is
 * ready (usually the same or the next frame) the group's subtree is NOT
 * drawn, so a mask never flashes unclipped content; `ready` resolves when it
 * is.
 */
export interface GroupNode extends ContainerNode {
  readonly kind: 'group';
  /**
   * Clips this group's subtree: a scene node whose pixels are the mask, a
   * plain rect, or a `MaskSpec` with `mode` / `invert` / `threshold`.
   * `null` removes it.
   */
  mask: MaskTarget;
  /**
   * Full-screen passes applied to this group's subtree, in order. `null` or
   * an empty array removes them. A chain whose entries are all `cheap`
   * (color matrix, text outline) never takes a render target.
   */
  filters: readonly Filter[] | null;
  /** Resolution, area, blend and target reuse of the filter chain. */
  filterOptions: FilterOptions;
  /** Resolves when every effect chunk of this group has loaded. */
  readonly ready: Promise<void>;
}

/** M2. Bit set for `ContainerNode.bulkChildren` / `BulkChildren.commit`. */
export const BulkField = {
  /** position: [x0, y0, x1, y1, …] */
  POSITION: 1 << 0,
  /** rotation: radians per child */
  ROTATION: 1 << 1,
  /** scale: [sx0, sy0, …] */
  SCALE: 1 << 2,
  /** alpha: 0..1 per child */
  ALPHA: 1 << 3,
  /** tint: 0xRRGGBB per child (sprites only; ignored for other kinds) */
  TINT: 1 << 4,
  /**
   * M2.5, columns only: `frame` index into BindColumnsOptions.frames
   * (sprites only). `bulkChildren` ignores it.
   */
  FRAME: 1 << 5,
  /** M2.5, columns only: `userId` per child. `bulkChildren` ignores it. */
  USER_ID: 1 << 6,
} as const;

// ─── External columns (M2.5, ARCHITECTURE §19.1) ─────────────────────────────

/**
 * A column: a dense typed array (row i at index i), or a strided view into a
 * shared array (row i at `offset + i × stride`), for interleaved storage such
 * as `[x0, y0, x1, y1, …]` → `{ array, offset: 0, stride: 2 }` for x and
 * `{ array, offset: 1, stride: 2 }` for y.
 */
export type ColumnSource<T extends Float32Array | Uint32Array> =
  | T
  | { readonly array: T; readonly offset?: number; readonly stride?: number };

/**
 * Columns for `bindColumns`. Units match the node setters: stage px, radians,
 * 0..1 alpha, 0xRRGGBB tint. Omitted columns are not touched by `commit`.
 */
export interface SpriteColumns {
  readonly x: ColumnSource<Float32Array>;
  readonly y: ColumnSource<Float32Array>;
  readonly rotation?: ColumnSource<Float32Array>;
  readonly scaleX?: ColumnSource<Float32Array>;
  readonly scaleY?: ColumnSource<Float32Array>;
  readonly alpha?: ColumnSource<Float32Array>;
  /** 0xRRGGBB; sprite children only. */
  readonly tint?: ColumnSource<Uint32Array>;
  /** Index into `BindColumnsOptions.frames`; sprite children only. */
  readonly frame?: ColumnSource<Uint32Array>;
  /** u32 per child, stored as `SceneNode.userId` (picking). */
  readonly userId?: ColumnSource<Uint32Array>;
}

export interface BindColumnsOptions {
  /**
   * Default element stride for columns given as plain typed arrays
   * (default 1). A `{ array, offset, stride }` column overrides it.
   */
  stride?: number;
  /**
   * Textures addressed by the `frame` column (required when it is bound).
   * Frames of one source keep batches intact (a frame change is an instance
   * rewrite); frames of different sources work but a change moves a batch
   * boundary and costs a structure update.
   */
  frames?: readonly TextureHandle[];
}

/** M2.5. A container's reused column binding. */
export interface ColumnBinding {
  /** BulkField bits of the bound columns. */
  readonly fields: number;
  /**
   * Copies rows [first, first + count) of the bound columns (all bound, or
   * only `fields` when given) into children [first, first + count) in one
   * tight loop, with the same store writes, dirty bits and single `touch`
   * bump as `BulkChildren.commit`, so the next render() uploads one dirty
   * range. Throws INVALID_ARGUMENT when first + count exceeds the child
   * count or a column is too short, DESTROYED after the container is
   * destroyed. Zero allocations.
   */
  commit(count: number, first?: number, fields?: number): void;
  /** Same as `container.bindColumns(columns, options)` on the same object. */
  rebind(columns: SpriteColumns, options?: BindColumnsOptions): void;
  /** Drops the array references (the arrays can be collected). */
  unbind(): void;
}

/**
 * M2. Dense, typed-array view of a container's direct children. Arrays not
 * requested in `bulkChildren(fields)` are zero-length. Values are NOT read
 * back from the nodes on acquire unless `pull()` is called.
 */
export interface BulkChildren {
  /** children.length when acquired. */
  readonly count: number;
  /** childrenVersion when acquired. `commit` throws INVALID_ARGUMENT if stale. */
  readonly version: number;
  readonly position: Float32Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
  readonly alpha: Float32Array;
  readonly tint: Uint32Array;
  /** Copies the nodes' current values of `fields` into the arrays. */
  pull(fields: number, first?: number, count?: number): void;
  /**
   * Copies `fields` of children [first, first + count) into the node store in
   * one tight loop and marks them dirty in bulk (POSITION-only commits keep
   * the packer's translation fast path). Node getters see the new values
   * immediately.
   */
  commit(fields: number, first?: number, count?: number): void;
}

export interface SpriteOptions extends NodeOptions {
  texture?: TextureHandle;
  /** 0..1 in texture-frame space; sets anchorX & anchorY. */
  anchor?: number;
  anchorX?: number;
  anchorY?: number;
  /** 0xRRGGBB. */
  tint?: number;
  blendMode?: BlendMode;
  /** Sets scaleX so the rendered width equals this (px). */
  width?: number;
  height?: number;
}

/** Leaf node; cannot have children (use a Container). */
export interface SpriteNode extends SceneNode {
  readonly kind: 'sprite';
  texture: TextureHandle;
  anchorX: number;
  anchorY: number;
  setAnchor(x: number, y?: number): this;
  /** 0xRRGGBB. */
  tint: number;
  blendMode: BlendMode;
  /** Rendered size in local px (texture frame size × scale). Setting changes scale. */
  width: number;
  height: number;
}

// ─── Textures ─────────────────────────────────────────────────────────────────

export interface TextureOptions {
  label?: string;
  /** Nearest-neighbour sampling (pixel art). Default false. */
  nearest?: boolean;
  repeat?: boolean;
  mipmaps?: boolean;
  /** Source pixels are already premultiplied. */
  premultiplied?: boolean;
}

/**
 * M2 assets ↔ scene seam (ARCHITECTURE §15.6). An asset-managed texture
 * source: GPU-only, uploaded and restored by the asset manager rather than
 * from a retained bitmap. Implemented in src/assets; consumed by
 * `Texture.fromProvider()` (src/scene/Texture.ts) and
 * `ensureTextureUploaded()`.
 */
export interface TextureProvider {
  /** texId in the command stream (from ids.texture; owned by the provider). */
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /**
   * Emits TEXTURE_CREATE + upload commands for `frame.rendererId` at
   * `frame.generation` if not done yet, and returns true when the texture has
   * content for that renderer. Returns false while (re)loading (after a
   * device loss or eviction); ensureTextureUploaded then returns NO_ID so the
   * batch draws with the core's white texture for that frame. Must not
   * allocate in steady state.
   */
  upload(frame: FrontFrame): boolean;
  /** Called when every Texture handle of this provider is destroyed. */
  release(): void;
}

export interface TextureFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A texture is a (source, frame) pair. Frames of the same source share one
 * GPU texture, so sprites using frames of one atlas batch together.
 * No GPU types here: upload happens lazily through the command stream the
 * first time a renderer draws it.
 */
export interface TextureHandle {
  /** Id of the underlying source (== texId in the command stream). */
  readonly sourceId: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Frame within the source, in source pixels. */
  readonly frame: TextureFrame;
  /** Frame size in px. */
  readonly width: number;
  readonly height: number;
  /** New handle for a sub-rectangle (in this frame's coordinates). */
  sub(x: number, y: number, width: number, height: number): TextureHandle;
  /** Destroys the SOURCE (all frames). */
  destroy(): void;
  readonly destroyed: boolean;
}

/** Inputs accepted by loadTexture(). */
export type TextureInput =
  | string
  | URL
  | Blob
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageData;
