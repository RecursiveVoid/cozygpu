/**
 * Front half of masking (ARCHITECTURE §21.2, §21.4).
 * Loaded lazily by `Group` the first time a mask is set; it registers the
 * core system, which travels in the same chunk (`mask-core`), so a
 * main-thread renderer is ready as soon as the chunk landed.
 *
 * Per frame it decides the implementation ('auto'), packs the mask geometry
 * into its own instance buffer when the mask is not a plain rect, and emits
 * MASK_PUSH_* / MASK_POP around the group's subtree. Zero allocations once
 * the mask stopped changing: the quads are packed into a reused buffer and
 * only uploaded when their bytes changed.
 *
 * M4 (ARCHITECTURE §26.8): a mask source that draws its own geometry (a
 * `Graphics`, `MaskDrawable`) is never packed into quads. One plain rect
 * becomes a scissor; any other shape is pushed with `MaskFlag.EXTERNAL`, the
 * node emits its draws as mask geometry, and MASK_GEOMETRY_END follows.
 */
import {
  CommandFlag,
  MaskFlag,
  MaskOp,
  OpcodeRange,
} from '../commands/opcodes';
import { affineFromTRS, affineMultiply } from '../math/affine';
import { registerCoreSystemFactory } from '../renderer/lazySystems';
import { NodeBase } from '../scene/Node';
import { Sprite } from '../scene/Sprite';
import {
  L_ANCHOR_X,
  L_ANCHOR_Y,
  L_FRAME_H,
  L_FRAME_W,
  LOCAL_STRIDE,
  UV_STRIDE,
  nodeStore,
} from '../scene/store';
import { ensureTextureUploaded } from '../scene/Texture';
import type { ContainerNode, SceneNode } from '../scene/types';
import type { FrontFrame, MaskDrawable } from '../types/core';
import { MASK_ALPHA_THRESHOLD, SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { createMaskCoreSystem } from './core';
import type { MaskBinding, MaskMode, MaskRect, MaskTarget } from './types';

registerCoreSystemFactory(OpcodeRange.MASK, createMaskCoreSystem);

/** Quads a mask node may contribute; deeper subtrees are cut off here. */
const MAX_QUADS = 64;
const F32_PER = SPRITE_INSTANCE_BYTES / 4;
const U16_PER = SPRITE_INSTANCE_BYTES / 2;
const I_COLOR = 6;
const I_UV16 = 14;
const I_FLAGS = 9;

/**
 * Mask buffer ids are private to the mask core system's own table, so they
 * have their own tiny allocator rather than a slot in `ids`. A destroyed
 * binding has no frame to emit MASK_BUFFER_DESTROY on, so its id goes back on
 * the free list instead: the next MASK_BUFFER_ALLOC under that id destroys
 * the old GPU buffer, which bounds live mask buffers by live masks.
 */
let nextBufferId = 1;
const freeBufferIds: number[] = [];
/** The frame whose first stencil push already carried the pass break. */
let stencilBreakFrame = -1;
/** The renderer frame counter that `stencilBreakFrame` belongs to. */
let stencilBreakRenderer = -1;

/** Scratch affines (module-level: one mask is packed at a time). */
const parentWorld = new Float32Array(6);
const localWorld = new Float32Array(6);
const childWorld = new Float32Array(6);
/** A MaskDrawable's plain rect (local x, y, width, height). */
const drawableRect = new Float32Array(4);

/**
 * True when draws of other systems inside the pass are clipped by the stencil
 * buffer. WebGL2 applies stencil state to whatever draws next, so sprites
 * inside a masked group are clipped with no change to their pipelines. WebGPU
 * binds the stencil state to the pipeline, and a pipeline without it may not
 * even be used in a pass that has a stencil attachment, so 'auto' cannot pick
 * stencil there until the sprite and swarm pipelines declare it.
 */
function stencilClipsSubtree(backend: string): boolean {
  return backend === 'webgl2';
}

/** World transform of a detached mask node into `localWorld` (§21.1). */
function placeDetached(n: SceneNode): void {
  affineFromTRS(
    localWorld,
    0,
    n.x,
    n.y,
    n.rotation,
    n.scaleX,
    n.scaleY,
    n.skewX,
    n.skewY,
    n.pivotX,
    n.pivotY,
  );
  affineMultiply(localWorld, 0, parentWorld, 0, localWorld, 0);
}

function isRect(source: unknown): source is MaskRect {
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as MaskRect).width === 'number' &&
    typeof (source as SceneNode).kind !== 'string'
  );
}

class MaskBindingImpl implements MaskBinding {
  mode: Exclude<MaskMode, 'auto'> = 'scissor';

  private source: SceneNode | null = null;
  private rect: MaskRect | null = null;
  private requested: MaskMode = 'auto';
  private invert = false;
  private threshold = MASK_ALPHA_THRESHOLD;

  /** Packed quads (sprite instance layout) and their typed views. */
  private bytes = new ArrayBuffer(SPRITE_INSTANCE_BYTES * 4);
  private f32 = new Float32Array(this.bytes);
  private u32 = new Uint32Array(this.bytes);
  private u16 = new Uint16Array(this.bytes);
  private previous = new Uint32Array(this.f32.length);
  private capacity = 4;
  private count = 0;
  private texId = 0;
  /** Bounds of the packed quads in stage px. */
  private minX = 0;
  private minY = 0;
  private maxX = 0;
  private maxY = 0;
  private axisAligned = true;

  private bufferId = 0;
  private allocated = 0;
  private generation = -1;
  private uploaded = false;
  /** The mode of the push emitted this frame, or null when nothing was. */
  private pushedMode: Exclude<MaskMode, 'auto'> | null = null;

  constructor(private readonly group: ContainerNode) {}

  update(target: MaskTarget): void {
    this.source = null;
    this.rect = null;
    this.requested = 'auto';
    this.invert = false;
    this.threshold = MASK_ALPHA_THRESHOLD;
    this.uploaded = false;
    if (target === null) return;
    let source: unknown = target;
    const spec = target as { source?: unknown };
    if (spec.source !== undefined) {
      source = spec.source;
      const s = target as {
        mode?: MaskMode;
        invert?: boolean;
        threshold?: number;
      };
      if (s.mode !== undefined) this.requested = s.mode;
      if (s.invert !== undefined) this.invert = s.invert;
      if (s.threshold !== undefined) this.threshold = s.threshold;
    }
    if (isRect(source)) this.rect = source as MaskRect;
    else this.source = source as SceneNode;
  }

  emitBegin(
    frame: FrontFrame,
    _world: Float32Array,
    _worldOffset: number,
    _worldAlpha: number,
  ): boolean {
    this.pushedMode = null;
    if (this.source === null && this.rect === null) return true;
    // Local mode may still be importing the chunk this module registered.
    if (!frame.isSystemReady(OpcodeRange.MASK)) return false;
    this.readParentWorld();
    const source = this.source;
    // Duck-typed (not isMaskDrawable): importing it would split a shared
    // chunk off the minimal program.
    if (
      typeof (source as Partial<MaskDrawable> | null)?._emitMaskGeometry ===
      'function'
    ) {
      return this.emitDrawable(frame, source as SceneNode & MaskDrawable);
    }
    this.pack(frame);
    // A mask with no geometry masks everything away; it never draws the
    // subtree unclipped.
    if (this.count === 0) return false;
    const mode = this.resolveMode(frame);
    this.mode = mode;
    // The level the quads carry depends on the RESOLVED mode, and the mode
    // depends on the packed geometry (axis alignment), so it is written after
    // packing rather than inside writeQuad.
    this.applyLevel(mode === 'alpha' ? 1 : this.threshold);
    // The quads travel even for a scissor mask: they are two commands on the
    // first frame, they give the core the bounds it falls back to, and a
    // range whose commands are all DRAW would not reach a core system that is
    // created on its first executed command.
    if (!this.upload(frame)) return false;
    if (mode === 'scissor') this.emitScissor(frame);
    else if (mode === 'stencil') this.emitStencil(frame);
    else this.emitAlpha(frame);
    this.pushedMode = mode;
    return true;
  }

  emitEnd(frame: FrontFrame): void {
    const mode = this.pushedMode;
    if (mode === null) return;
    this.pushedMode = null;
    const enc = frame.encoder;
    // Alpha masks composite on pop, which needs the captured target's pass to
    // end first (ARCHITECTURE §21.3).
    enc.begin(
      MaskOp.MASK_POP,
      4,
      mode === 'alpha'
        ? CommandFlag.DRAW | CommandFlag.PASS_BREAK
        : CommandFlag.DRAW,
    );
    enc.u32(this.group.id);
    enc.end();
  }

  destroy(): void {
    this.source = null;
    this.rect = null;
    this.count = 0;
    if (this.bufferId !== 0) freeBufferIds.push(this.bufferId);
    this.bufferId = 0;
    this.allocated = 0;
  }

  // ── geometry ───────────────────────────────────────────────────────────────

  /** The space a rect mask and a detached mask node live in (§21.1). */
  private readParentWorld(): void {
    const parent = this.group.parent;
    if (parent) {
      const w = parent.worldTransform;
      const o = parent.worldTransformOffset;
      for (let i = 0; i < 6; i++) parentWorld[i] = w[o + i];
    } else {
      parentWorld[0] = 1;
      parentWorld[1] = 0;
      parentWorld[2] = 0;
      parentWorld[3] = 1;
      parentWorld[4] = 0;
      parentWorld[5] = 0;
    }
  }

  private ensureCapacity(quads: number): void {
    if (quads <= this.capacity) return;
    let cap = this.capacity;
    while (cap < quads) cap *= 2;
    const bytes = new ArrayBuffer(SPRITE_INSTANCE_BYTES * cap);
    const u32 = new Uint32Array(bytes);
    u32.set(this.u32); // keep the quads packed so far
    this.bytes = bytes;
    this.f32 = new Float32Array(bytes);
    this.u32 = u32;
    this.u16 = new Uint16Array(bytes);
    this.previous = new Uint32Array(u32.length);
    this.capacity = cap;
    this.uploaded = false;
  }

  /** Packs the mask geometry into the reused instance buffer. */
  private pack(frame: FrontFrame): void {
    this.count = 0;
    this.texId = 0;
    this.axisAligned = true;
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
    const rect = this.rect;
    if (rect) {
      this.ensureCapacity(1);
      this.writeQuad(
        parentWorld,
        0,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        0xffff,
        0xffff,
        0,
      );
      return;
    }
    const root = this.source;
    if (!root || root.destroyed) return;
    // A mask node that sits in the scene tree already has a world transform;
    // a detached one is placed relative to the masked group's parent.
    const stored = root.parent !== null;
    if (!stored) placeDetached(root);
    this.walk(frame, root, stored, localWorld, 0);
  }

  private walk(
    frame: FrontFrame,
    node: SceneNode,
    stored: boolean,
    world: Float32Array,
    depth: number,
  ): void {
    if (!node.visible || this.count >= MAX_QUADS || depth > 8) return;
    let matrix = world;
    let offset = 0;
    if (stored) {
      matrix = node.worldTransform;
      offset = node.worldTransformOffset;
    }
    if (node.kind === 'sprite' && node instanceof Sprite) {
      this.writeSprite(frame, node, matrix, offset);
    }
    const children = (node as ContainerNode).children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (stored) {
        this.walk(frame, child, true, matrix, depth + 1);
      } else {
        affineFromTRS(
          childWorld,
          0,
          child.x,
          child.y,
          child.rotation,
          child.scaleX,
          child.scaleY,
          child.skewX,
          child.skewY,
          child.pivotX,
          child.pivotY,
        );
        affineMultiply(childWorld, 0, matrix, offset, childWorld, 0);
        this.walk(frame, child, false, childWorld, 0);
      }
    }
  }

  private writeSprite(
    frame: FrontFrame,
    sprite: Sprite,
    world: Float32Array,
    offset: number,
  ): void {
    const texture = sprite.texture;
    const texId = ensureTextureUploaded(frame, texture);
    // One push carries one texture; the first sprite decides which.
    if (this.count === 0) this.texId = texId;
    else if (texId !== this.texId) return;
    const slot = (sprite as unknown as NodeBase)._slot;
    const L = nodeStore.local;
    const lo = slot * LOCAL_STRIDE;
    const fw = L[lo + L_FRAME_W];
    const fh = L[lo + L_FRAME_H];
    const uo = slot * UV_STRIDE;
    const uv = nodeStore.uv;
    this.ensureCapacity(this.count + 1);
    this.writeQuad(
      world,
      offset,
      -L[lo + L_ANCHOR_X] * fw,
      -L[lo + L_ANCHOR_Y] * fh,
      fw,
      fh,
      uv[uo],
      uv[uo + 1],
      uv[uo + 2],
      uv[uo + 3],
      nodeStore.flags[slot] & 0xff,
    );
  }

  /** One instance: world · T(x, y) · S(width, height), plus its uv rect. */
  private writeQuad(
    world: Float32Array,
    offset: number,
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    flags: number,
  ): void {
    const a = world[offset];
    const b = world[offset + 1];
    const c = world[offset + 2];
    const d = world[offset + 3];
    const tx = world[offset + 4] + a * x + c * y;
    const ty = world[offset + 5] + b * x + d * y;
    if (b !== 0 || c !== 0) this.axisAligned = false;
    const i = this.count++;
    const o = i * F32_PER;
    const f32 = this.f32;
    f32[o] = a * width;
    f32[o + 1] = b * width;
    f32[o + 2] = c * height;
    f32[o + 3] = d * height;
    f32[o + 4] = tx;
    f32[o + 5] = ty;
    // The color's alpha is written by applyLevel, once the mode is resolved.
    this.u32[o + I_COLOR] = 0xffffffff;
    const io = i * U16_PER + I_UV16;
    this.u16[io] = u0;
    this.u16[io + 1] = v0;
    this.u16[io + 2] = u1;
    this.u16[io + 3] = v1;
    this.u32[o + I_FLAGS] = flags;
    // Stage-space bounds of the quad (all four corners).
    for (let k = 0; k < 4; k++) {
      const qx = k & 1 ? width : 0;
      const qy = k & 2 ? height : 0;
      const px = tx + a * qx + c * qy;
      const py = ty + b * qx + d * qy;
      if (px < this.minX) this.minX = px;
      if (px > this.maxX) this.maxX = px;
      if (py < this.minY) this.minY = py;
      if (py > this.maxY) this.maxY = py;
    }
  }

  /**
   * Writes the alpha the shader compares a texel against (binary modes) or
   * multiplies the coverage by (soft masks) into the packed quads. A soft
   * mask takes the mask's own alpha, 1, so the subtree keeps its opacity
   * where the mask is opaque; the threshold would dim it instead.
   */
  private applyLevel(level: number): void {
    const a8 = level <= 0 ? 0 : level >= 1 ? 255 : (level * 255 + 0.5) | 0;
    const packed = (0xffffff | (a8 << 24)) >>> 0;
    const u32 = this.u32;
    for (let i = 0; i < this.count; i++) {
      u32[i * F32_PER + I_COLOR] = packed;
    }
  }

  // ── external geometry (M4, ARCHITECTURE §26.8) ─────────────────────────────

  private emitDrawable(
    frame: FrontFrame,
    node: SceneNode & MaskDrawable,
  ): boolean {
    // Like a mask without geometry, a hidden or destroyed one masks
    // everything away.
    if (node.destroyed || !node.visible) return false;
    let world: Float32Array = localWorld;
    let offset = 0;
    if (node.parent !== null) {
      world = node.worldTransform;
      offset = node.worldTransformOffset;
    } else {
      placeDetached(node);
    }
    this.minX = this.minY = this.maxX = this.maxY = this.count = 0;
    // Only a plain rect can become a scissor: anything else counts as
    // rotated for the mode choice.
    this.axisAligned = false;
    if (node._maskRect(drawableRect)) {
      // Stage bounds of the rect (the scissor itself when axis-aligned).
      const r = drawableRect;
      this.minX = this.minY = Infinity;
      this.maxX = this.maxY = -Infinity;
      this.axisAligned = true;
      this.writeQuad(world, offset, r[0], r[1], r[2], r[3], 0, 0, 0, 0, 0);
    }
    // No quads travel with an external push (count 0).
    this.count = 0;
    let mode = this.resolveMode(frame);
    // An external stencil mask cannot be inverted (no quads to redraw).
    if (mode === 'stencil' && this.invert) mode = 'alpha';
    this.mode = mode;
    if (mode === 'scissor') {
      this.emitScissor(frame);
      this.pushedMode = mode;
      return true;
    }
    const stencil = mode === 'stencil';
    if (stencil) this.emitStencil(frame, MaskFlag.EXTERNAL);
    else this.emitAlpha(frame, MaskFlag.EXTERNAL);
    // From here the push is out, so the stack has to stay balanced: geometry
    // that cannot draw yet leaves the subtree fully masked for this frame.
    node._emitMaskGeometry(frame, world, offset, stencil);
    const enc = frame.encoder;
    enc.begin(
      MaskOp.MASK_GEOMETRY_END,
      4,
      stencil ? CommandFlag.DRAW : CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    enc.u32(this.group.id);
    enc.end();
    this.pushedMode = mode;
    return true;
  }

  // ── mode and commands ──────────────────────────────────────────────────────

  private resolveMode(frame: FrontFrame): Exclude<MaskMode, 'auto'> {
    const caps = frame.caps;
    const canScissor = this.axisAligned && !this.invert;
    const canStencil = caps.stencil && stencilClipsSubtree(caps.backend);
    switch (this.requested) {
      case 'scissor':
        if (canScissor) return 'scissor';
        break;
      case 'stencil':
        if (canStencil) return 'stencil';
        return 'alpha';
      case 'alpha':
        return 'alpha';
      default:
        break;
    }
    if (canScissor) return 'scissor';
    return canStencil ? 'stencil' : 'alpha';
  }

  private emitScissor(frame: FrontFrame): void {
    const enc = frame.encoder;
    enc.begin(MaskOp.MASK_PUSH_SCISSOR, 24, CommandFlag.DRAW);
    enc.u32(this.group.id);
    enc.f32(this.minX);
    enc.f32(this.minY);
    enc.f32(this.maxX - this.minX);
    enc.f32(this.maxY - this.minY);
    enc.u32(this.invert ? MaskFlag.INVERT : 0);
    enc.end();
  }

  private emitStencil(frame: FrontFrame, external = 0): void {
    const enc = frame.encoder;
    // One pass break per frame adds the stencil attachment (§21.3).
    let flags = CommandFlag.DRAW;
    if (
      stencilBreakRenderer !== frame.rendererId ||
      stencilBreakFrame !== frame.frameId
    ) {
      stencilBreakRenderer = frame.rendererId;
      stencilBreakFrame = frame.frameId;
      flags |= CommandFlag.PASS_BREAK;
    }
    enc.begin(MaskOp.MASK_PUSH_STENCIL, 28, flags);
    enc.u32(this.group.id);
    enc.u32(this.bufferId);
    enc.u32(0);
    enc.u32(this.count);
    enc.u32(this.texId);
    enc.u32(this.maskFlags() | external);
    enc.f32(this.threshold);
    enc.end();
  }

  private emitAlpha(frame: FrontFrame, external = 0): void {
    const enc = frame.encoder;
    enc.begin(
      MaskOp.MASK_PUSH_ALPHA,
      44,
      CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    enc.u32(this.group.id);
    enc.u32(this.bufferId);
    enc.u32(0);
    enc.u32(this.count);
    enc.u32(this.texId);
    enc.u32(this.maskFlags() | external);
    enc.f32(this.minX);
    enc.f32(this.minY);
    enc.f32(this.maxX - this.minX);
    enc.f32(this.maxY - this.minY);
    enc.f32(frame.resolution);
    enc.end();
  }

  private maskFlags(): number {
    let flags = MaskFlag.ALPHA_TEST;
    if (this.invert) flags |= MaskFlag.INVERT;
    return flags;
  }

  /** (Re)allocates and uploads the quads; false when nothing can draw yet. */
  private upload(frame: FrontFrame): boolean {
    const enc = frame.encoder;
    if (this.bufferId === 0) {
      this.bufferId = freeBufferIds.pop() ?? nextBufferId++;
    }
    if (frame.generation !== this.generation) {
      this.generation = frame.generation;
      this.allocated = 0;
      this.uploaded = false;
    }
    if (this.allocated < this.capacity) {
      this.allocated = this.capacity;
      enc.begin(MaskOp.MASK_BUFFER_ALLOC, 8, 0);
      enc.u32(this.bufferId);
      enc.u32(this.capacity);
      enc.end();
      this.uploaded = false;
    }
    const words = this.count * F32_PER;
    let changed = !this.uploaded;
    const u32 = this.u32;
    const previous = this.previous;
    for (let i = 0; i < words; i++) {
      if (previous[i] !== u32[i]) {
        previous[i] = u32[i];
        changed = true;
      }
    }
    if (changed) {
      const payload = this.count * SPRITE_INSTANCE_BYTES;
      enc.begin(MaskOp.MASK_UPLOAD, 12 + payload, 0);
      enc.u32(this.bufferId);
      enc.u32(0);
      enc.u32(this.count);
      enc.bytes(this.u16, 0, payload);
      enc.end();
      this.uploaded = true;
    }
    return true;
  }
}

export function createMaskBinding(group: ContainerNode): MaskBinding {
  return new MaskBindingImpl(group);
}
