/**
 * `GPU.Graphics` (ARCHITECTURE §26): a leaf scene node that draws a
 * `GraphicsContext`.
 *
 * This shell holds the public surface and nothing else. The recording calls
 * forward to the context; drawing is the `graphics` chunk (classification,
 * SDF packing, arenas, command emission), loaded the first time a Graphics is
 * created. That chunk registers a loader for the graphics core system and,
 * when a context needs a mesh, loads the `graphics-tess` chunk. Until those
 * have landed the node draws nothing.
 *
 * The scene packer sees a CustomDrawable (§21.4 / §5.2): it flushes the open
 * sprite batch and calls `_emitDraw` in draw order. Consecutive Graphics
 * nodes still share draws, because the binding grows the previous draw
 * command in place when nothing else was encoded in between (§26.6).
 */
import type { BlendMode } from '../backend/types';
import type { ColorSource } from '../math/types';
import { NodeBase } from '../scene/Node';
import { nodeStore, touchScope } from '../scene/store';
import type {
  FrontFrame,
  MaskDrawable,
  RetainableDrawable,
} from '../types/core';
import { GraphicsContext } from './GraphicsContext';
import type {
  FillStyle,
  GraphicsBinding,
  GraphicsBounds,
  GraphicsContextApi,
  GraphicsDestroyOptions,
  GraphicsNode,
  GraphicsOptions,
  PolygonPoints,
  StrokeStyle,
} from './types';

type EmitModule = typeof import('./emit');

/** The binding as the `graphics` chunk builds it: retained-rendering aware. */
interface RetainBinding extends GraphicsBinding {
  readonly drawVersion: number;
  syncDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void;
}

/** A tint or blend change alters records or draws without touching a node. */
function bumpDrawEpoch(): void {
  nodeStore.drawEpoch = (nodeStore.drawEpoch + 1) | 0;
}

/** Shared by every Graphics in the page. */
let emitChunk: Promise<EmitModule> | null = null;

/**
 * Preloads the Graphics chunks so the first frame that draws one is not
 * skipped. 'all' (default) also loads the tessellator, which only contexts
 * with paths, polygons, holes or texture fills need.
 */
export function loadGraphics(which: 'core' | 'all' = 'all'): Promise<void> {
  emitChunk ??= import('./emit');
  return emitChunk.then(m => m.preloadGraphics(which));
}

function isContext(
  o: GraphicsOptions | GraphicsContextApi | undefined,
): o is GraphicsContextApi {
  return (
    o !== undefined && typeof (o as { circle?: unknown }).circle === 'function'
  );
}

export class Graphics
  extends NodeBase
  implements GraphicsNode, RetainableDrawable, MaskDrawable
{
  /** @internal */
  _context: GraphicsContextApi;
  /** @internal True when the node created its context. */
  _ownsContext: boolean;
  /** @internal 0xRRGGBB. */
  _tint = 0xffffff;
  /** @internal */
  _blendMode: BlendMode = 'normal';
  /** @internal Set once the `graphics` chunk landed. */
  _binding: RetainBinding | null = null;
  /** @internal */
  _ready: Promise<void>;

  constructor(options?: GraphicsOptions | GraphicsContextApi) {
    const opts: GraphicsOptions | undefined = isContext(options)
      ? { context: options }
      : options;
    super(opts);
    this._ownsContext = !opts?.context;
    this._context = opts?.context ?? new GraphicsContext();
    if (opts?.tint !== undefined) this._tint = opts.tint;
    if (opts?.blendMode !== undefined) this._blendMode = opts.blendMode;
    emitChunk ??= import('./emit');
    this._ready = emitChunk.then(m => {
      if (this._destroyed) return;
      this._binding = m.createGraphicsBinding(this);
      bumpDrawEpoch();
      return this._binding.ready;
    });
    // Keeps Node/browser from reporting an unhandled rejection before the
    // caller awaits `ready`.
    this._ready.catch(() => {});
  }

  get kind(): 'graphics' {
    return 'graphics';
  }

  get context(): GraphicsContextApi {
    return this._context;
  }

  set context(context: GraphicsContextApi) {
    if (context === this._context) return;
    if (this._ownsContext) this._context.destroy();
    this._ownsContext = false;
    this._context = context;
    this._binding?.setContext(context);
    bumpDrawEpoch();
  }

  get tint(): number {
    return this._tint;
  }

  set tint(value: number) {
    this._tint = value >>> 0;
    bumpDrawEpoch();
    // A static container baking this node re-bakes (its records hold the tint).
    touchScope(this._slot);
  }

  get blendMode(): BlendMode {
    return this._blendMode;
  }

  set blendMode(value: BlendMode) {
    this._blendMode = value;
    bumpDrawEpoch();
  }

  get ready(): Promise<void> {
    return this._binding ? this._binding.ready : this._ready;
  }

  get bounds(): GraphicsBounds {
    return this._context.bounds;
  }

  // ─── Recording: forwards to the context ────────────────────────────────────

  rect(x: number, y: number, width: number, height: number): this {
    this._context.rect(x, y, width, height);
    return this;
  }

  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius?: number,
  ): this {
    this._context.roundRect(x, y, width, height, radius);
    return this;
  }

  circle(x: number, y: number, radius: number): this {
    this._context.circle(x, y, radius);
    return this;
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number): this {
    this._context.ellipse(x, y, radiusX, radiusY);
    return this;
  }

  poly(points: PolygonPoints, close?: boolean): this {
    this._context.poly(points, close);
    return this;
  }

  regularPoly(
    x: number,
    y: number,
    radius: number,
    sides: number,
    rotation?: number,
  ): this {
    this._context.regularPoly(x, y, radius, sides, rotation);
    return this;
  }

  star(
    x: number,
    y: number,
    points: number,
    radius: number,
    innerRadius?: number,
    rotation?: number,
  ): this {
    this._context.star(x, y, points, radius, innerRadius, rotation);
    return this;
  }

  moveTo(x: number, y: number): this {
    this._context.moveTo(x, y);
    return this;
  }

  lineTo(x: number, y: number): this {
    this._context.lineTo(x, y);
    return this;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): this {
    this._context.quadraticCurveTo(cpx, cpy, x, y);
    return this;
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): this {
    this._context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    return this;
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): this {
    this._context.arc(x, y, radius, startAngle, endAngle, counterclockwise);
    return this;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this {
    this._context.arcTo(x1, y1, x2, y2, radius);
    return this;
  }

  closePath(): this {
    this._context.closePath();
    return this;
  }

  beginPath(): this {
    this._context.beginPath();
    return this;
  }

  fill(style?: ColorSource | FillStyle, alpha?: number): this {
    this._context.fill(style, alpha);
    return this;
  }

  stroke(style?: ColorSource | StrokeStyle): this {
    this._context.stroke(style);
    return this;
  }

  cut(): this {
    this._context.cut();
    return this;
  }

  setFillStyle(style: ColorSource | FillStyle): this {
    this._context.setFillStyle(style);
    return this;
  }

  setStrokeStyle(style: ColorSource | StrokeStyle): this {
    this._context.setStrokeStyle(style);
    return this;
  }

  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
  ): this {
    this._context.setTransform(a, b, c, d, tx, ty);
    return this;
  }

  resetTransform(): this {
    this._context.resetTransform();
    return this;
  }

  translateTransform(x: number, y: number): this {
    this._context.translate(x, y);
    return this;
  }

  rotateTransform(radians: number): this {
    this._context.rotate(radians);
    return this;
  }

  scaleTransform(x: number, y?: number): this {
    this._context.scale(x, y);
    return this;
  }

  save(): this {
    this._context.save();
    return this;
  }

  restore(): this {
    this._context.restore();
    return this;
  }

  clear(): this {
    this._context.clear();
    return this;
  }

  // ─── Drawing seams ─────────────────────────────────────────────────────────

  /** @internal CustomDrawable (ARCHITECTURE §26.6). */
  _emitDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    if (this._binding !== null && !this._destroyed) {
      this._binding.emitDraw(frame, world, worldOffset, worldAlpha);
    }
  }

  /**
   * @internal RetainableDrawable (ARCHITECTURE §27.2): changes whenever the
   * draw commands `_emitDraw` would emit change; -1 until the chunk landed.
   */
  get _drawVersion(): number {
    return this._binding !== null ? this._binding.drawVersion : -1;
  }

  /**
   * @internal Called by the `graphics` chunk while something it needs is
   * still loading: the next frame re-checks this node (§27.2).
   */
  _touchEpoch(): void {
    bumpDrawEpoch();
  }

  /** @internal RetainableDrawable: records only, while a segment replays. */
  _syncDraw(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): void {
    if (this._binding !== null && !this._destroyed) {
      this._binding.syncDraw(frame, world, worldOffset, worldAlpha);
    }
  }

  /** @internal MaskDrawable (ARCHITECTURE §26.8). */
  _maskRect(out: Float32Array): boolean {
    return this._binding !== null && this._binding.maskRect(out);
  }

  /** @internal MaskDrawable. */
  _emitMaskGeometry(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    stencil: boolean,
  ): boolean {
    return (
      this._binding !== null &&
      !this._destroyed &&
      this._binding.emitMaskGeometry(frame, world, worldOffset, stencil)
    );
  }

  override destroy(options?: GraphicsDestroyOptions): void {
    if (this._destroyed) return;
    this._binding?.destroy();
    this._binding = null;
    if (this._ownsContext || options?.context) this._context.destroy();
    super.destroy(options);
  }
}
