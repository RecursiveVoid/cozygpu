/**
 * Graphics public contracts (ARCHITECTURE §26, docs/API.md "Graphics").
 *
 * A Pixi-like vector API with two render paths chosen per paint operation:
 *
 *   - analytic SDF shapes (rect, roundRect, circle, ellipse, single line
 *     segments, arcs): one 64-byte instance each, fill and stroke in the
 *     same instance, anti-aliased in the fragment shader, no tessellation;
 *   - everything else (polygons, curves, holes, joins, texture fills): CPU
 *     tessellation into a mesh in context space, cached until the context
 *     changes or a node needs a finer curve tolerance.
 *
 * No WebGPU/WebGL types here: this file is part of the public surface.
 */
import type { BlendMode } from '../backend/types';
import type { ColorSource } from '../math/types';
import type {
  DestroyOptions,
  NodeOptions,
  SceneNode,
  TextureHandle,
} from '../scene/types';
import type { FrontFrame } from '../types/core';

export type LineJoin = 'miter' | 'round' | 'bevel';
export type LineCap = 'butt' | 'round' | 'square';

/** Flat [x0, y0, x1, y1, …] or an array of points. */
export type PolygonPoints =
  | ArrayLike<number>
  | readonly { readonly x: number; readonly y: number }[];

/** 2D affine [a, b, c, d, tx, ty] (x' = a·x + c·y + tx; y' = b·x + d·y + ty). */
export type Affine2D = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface FillStyle {
  /** Default 0xffffff. */
  color?: ColorSource;
  /** 0..1, multiplied with the colour's own alpha. Default 1. */
  alpha?: number;
  /**
   * Texture fill. Always takes the mesh path (§26.3): uv = matrix × local
   * position. Default none.
   */
  texture?: TextureHandle | null;
  /**
   * Maps the texture onto the shape. 'local' (default): the texture frame
   * spans the bounding box of the filled path. 'global': one texture pixel
   * per context unit, from the context origin.
   */
  textureSpace?: 'local' | 'global';
  /** Extra transform applied to the texture mapping (context space). */
  matrix?: Affine2D | null;
}

export interface StrokeStyle extends FillStyle {
  /** Local px (scales with the transform). Default 1. */
  width?: number;
  /** Default 'miter'. */
  join?: LineJoin;
  /** Default 'butt'. */
  cap?: LineCap;
  /** Miter length / width above which a miter becomes a bevel. Default 10. */
  miterLimit?: number;
  /**
   * Where the stroke sits on a closed edge: 0.5 centred (default), 1 fully
   * inside, 0 fully outside. Open paths are always centred.
   */
  alignment?: number;
  /**
   * Width in device pixels, independent of every transform (hairlines).
   * Exact on the SDF path; on the mesh path the width is resolved at the
   * tessellation scale (§26.4).
   */
  pixelLine?: boolean;
}

/** Axis-aligned bounds in context (local) space. Empty: minX > maxX. */
export interface GraphicsBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** What the last compile produced (for tests, benchmarks, tooling). */
export interface GraphicsInfo {
  /** Paint operations that became SDF shape instances. */
  readonly sdfShapes: number;
  /** Mesh vertices / triangles at the current tessellation scale. */
  readonly meshVertices: number;
  readonly meshTriangles: number;
  /** Bumped by every change to the context (any recording call or clear). */
  readonly version: number;
}

export interface GraphicsContextOptions {
  /**
   * Maximum distance, in device pixels, between a flattened curve and the
   * true curve. Default 0.25. Applied at the largest world scale any node
   * drawing this context is seen at (§26.4).
   */
  tolerance?: number;
  /**
   * false: every paint operation takes the mesh path (debugging, or exact
   * parity with a tessellating renderer). Default true.
   */
  sdf?: boolean;
}

/**
 * The recording surface shared by `GraphicsContext` and `Graphics` (which
 * forwards to its context). Pixi v8 semantics:
 *
 *   - shape calls (`rect`, `circle`, …) and path calls (`moveTo`, `lineTo`,
 *     curves, `arc`, `closePath`) add to the CURRENT PATH;
 *   - `fill` / `stroke` paint the current path; several paints in a row
 *     apply to the same path (`rect().fill().stroke()`), and the next shape
 *     or path call after a paint starts a new path;
 *   - `cut` turns the current path into holes of the most recent paint
 *     group (the fill and/or stroke just applied).
 *
 * Every method returns `this` and records plain numbers into typed arrays:
 * nothing is tessellated or uploaded until a frame needs it.
 */
export interface GraphicsBuilder {
  rect(x: number, y: number, width: number, height: number): this;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius?: number,
  ): this;
  circle(x: number, y: number, radius: number): this;
  ellipse(x: number, y: number, radiusX: number, radiusY: number): this;
  /** Closed by default. */
  poly(points: PolygonPoints, close?: boolean): this;
  regularPoly(
    x: number,
    y: number,
    radius: number,
    sides: number,
    rotation?: number,
  ): this;
  star(
    x: number,
    y: number,
    points: number,
    radius: number,
    innerRadius?: number,
    rotation?: number,
  ): this;

  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): this;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): this;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): this;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this;
  closePath(): this;
  /** Drops the current path without painting it. */
  beginPath(): this;

  /** Paints the current path. No argument: the style from `setFillStyle`. */
  fill(style?: ColorSource | FillStyle, alpha?: number): this;
  /** Strokes the current path. No argument: the style from `setStrokeStyle`. */
  stroke(style?: ColorSource | StrokeStyle): this;
  /** The current path becomes holes of the most recent paint group. */
  cut(): this;
  setFillStyle(style: ColorSource | FillStyle): this;
  setStrokeStyle(style: ColorSource | StrokeStyle): this;

  /**
   * Replaces the recording transform: shapes recorded after it are
   * transformed by it (context space). Multiplying variants are
   * `translate/rotate/scale` on a context and
   * `translateTransform/rotateTransform/scaleTransform` on a node, whose
   * own `x`, `rotation`, `scaleX`… are its scene transform (Pixi naming).
   */
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
  ): this;
  resetTransform(): this;
  /** Pushes / pops the transform and the fill and stroke styles. */
  save(): this;
  restore(): this;

  /** Removes everything recorded; the context stays usable and shared. */
  clear(): this;

  readonly bounds: GraphicsBounds;
}

/** Recorded vector content, shareable between any number of `Graphics`. */
export interface GraphicsContextApi extends GraphicsBuilder {
  translate(x: number, y: number): this;
  rotate(radians: number): this;
  /** `y` defaults to `x`. */
  scale(x: number, y?: number): this;
  readonly tolerance: number;
  readonly sdf: boolean;
  readonly info: GraphicsInfo;
  readonly destroyed: boolean;
  /** Frees the CPU recording and the meshes uploaded for it. */
  destroy(): void;
}

export interface GraphicsOptions extends NodeOptions {
  /**
   * Draw this (shared) context instead of a private one. Recording calls on
   * the node then record into the shared context, as in Pixi.
   */
  context?: GraphicsContextApi;
  /** 0xRRGGBB multiplied into every colour. Default 0xffffff. */
  tint?: number;
  /** Default 'normal'. */
  blendMode?: BlendMode;
}

export interface GraphicsDestroyOptions extends DestroyOptions {
  /** Also destroy the context, even when it was passed in. Default: only a private one. */
  context?: boolean;
}

export interface GraphicsNode extends SceneNode, GraphicsBuilder {
  readonly kind: 'graphics';
  /** Swapping contexts is cheap: nothing is re-tessellated that is cached. */
  context: GraphicsContextApi;
  tint: number;
  blendMode: BlendMode;
  translateTransform(x: number, y: number): this;
  rotateTransform(radians: number): this;
  /** `y` defaults to `x`. */
  scaleTransform(x: number, y?: number): this;
  /**
   * Resolves once the node can draw: the `graphics` chunk, its core system
   * and, when the context needs one, the tessellator have loaded. Until then
   * the node draws nothing (it never draws half a shape).
   */
  readonly ready: Promise<void>;
  destroy(options?: GraphicsDestroyOptions): void;
}

// ─── Internal seams between the shell and the lazily loaded chunks ──────────

/**
 * Created by `createGraphicsBinding` (src/graphics/emit.ts, chunk
 * `graphics`) for one Graphics node. Holds the node's per-renderer arena
 * ranges, its node records and the change detection; zero allocations per
 * frame once the context stopped changing.
 */
export interface GraphicsBinding {
  /** Called by the node's `_emitDraw` (CustomDrawable). */
  emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void;
  /** See `MaskDrawable._maskRect` (src/types/core.ts). */
  maskRect(out: Float32Array): boolean;
  /** See `MaskDrawable._emitMaskGeometry`. */
  emitMaskGeometry(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    stencil: boolean,
  ): boolean;
  /** The node switched contexts. */
  setContext(context: GraphicsContextApi): void;
  /** Resolves when everything the current context needs has loaded. */
  readonly ready: Promise<void>;
  destroy(): void;
}

export type CreateGraphicsBinding = (node: GraphicsNode) => GraphicsBinding;
