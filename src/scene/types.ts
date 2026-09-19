/**
 * Scene graph public API. SHARED + FROZEN during the M2 build; implemented by
 * owner "sprites" (src/scene/**). M2 additions: `pickable`, the bulk child
 * transform API and `TextureProvider` (the assets ↔ scene seam).
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
import type { FrontFrame } from '../types/core';

export type NodeKind = 'container' | 'sprite' | 'swarm';

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
} as const;

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
