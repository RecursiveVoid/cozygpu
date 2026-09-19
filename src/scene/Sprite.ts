/** Sprite — owner: "sprites". A textured quad; leaf node. */
import { BlendModeId } from '../backend/types';
import type { BlendMode } from '../backend/types';
import { CozyGPUError } from '../types/errors';
import { NodeBase } from './Node';
import {
  Dirty,
  L_ANCHOR_X,
  L_ANCHOR_Y,
  L_FRAME_H,
  L_FRAME_W,
  L_SCALE_X,
  L_SCALE_Y,
  LOCAL_STRIDE,
  UV_STRIDE,
  bumpNode,
  markDirty,
  nodeStore,
} from './store';
import { Texture, sameTextureSource } from './Texture';
import type {
  DestroyOptions,
  SpriteNode,
  SpriteOptions,
  TextureHandle,
} from './types';

function isTextureHandle(v: unknown): v is TextureHandle {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as TextureHandle).sourceId === 'number' &&
    typeof (v as TextureHandle).sub === 'function'
  );
}

/** Index = BlendModeId. */
const BLEND_NAMES: BlendMode[] = [];
for (const name in BlendModeId) {
  BLEND_NAMES[BlendModeId[name as BlendMode]] = name as BlendMode;
}

function unorm16(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 0xffff : Math.round(v * 0xffff);
}

export class Sprite extends NodeBase implements SpriteNode {
  /** @internal */
  _texture: TextureHandle;
  /** @internal BlendModeId value. */
  _blendId: number = BlendModeId.normal;

  /** `new Sprite(texture)` or `new Sprite({ texture, x, y, anchor, … })`. */
  constructor(textureOrOptions?: TextureHandle | SpriteOptions) {
    const handle = isTextureHandle(textureOrOptions);
    const options = handle ? undefined : textureOrOptions;
    super(options);
    this._texture = Texture.WHITE;
    this._setTextureData(
      handle ? textureOrOptions : (options?.texture ?? Texture.WHITE),
    );
    if (options) {
      const L = nodeStore.local;
      const lo = this._slot * LOCAL_STRIDE;
      if (options.anchor !== undefined) {
        L[lo + L_ANCHOR_X] = options.anchor;
        L[lo + L_ANCHOR_Y] = options.anchor;
      }
      if (options.anchorX !== undefined) L[lo + L_ANCHOR_X] = options.anchorX;
      if (options.anchorY !== undefined) L[lo + L_ANCHOR_Y] = options.anchorY;
      if (options.tint !== undefined) this.tint = options.tint;
      if (options.blendMode !== undefined) this.blendMode = options.blendMode;
      if (options.width !== undefined) this.width = options.width;
      if (options.height !== undefined) this.height = options.height;
    }
  }

  get kind(): 'sprite' {
    return 'sprite';
  }

  // ─── Texture ───────────────────────────────────────────────────────────────

  get texture(): TextureHandle {
    return this._texture;
  }
  set texture(t: TextureHandle) {
    if (t === this._texture) return;
    if (!sameTextureSource(t, this._texture)) bumpNode(this);
    this._setTextureData(t);
  }

  /** Converts the frame to unorm16 UVs once per texture change. */
  private _setTextureData(t: TextureHandle): void {
    this._texture = t;
    const s = nodeStore;
    const slot = this._slot;
    const f = t.frame;
    const sw = t.sourceWidth || 1;
    const sh = t.sourceHeight || 1;
    const uo = slot * UV_STRIDE;
    s.uv[uo] = unorm16(f.x / sw);
    s.uv[uo + 1] = unorm16(f.y / sh);
    s.uv[uo + 2] = unorm16((f.x + f.width) / sw);
    s.uv[uo + 3] = unorm16((f.y + f.height) / sh);
    s.local[slot * LOCAL_STRIDE + L_FRAME_W] = f.width;
    s.local[slot * LOCAL_STRIDE + L_FRAME_H] = f.height;
    markDirty(slot, Dirty.SPRITE);
  }

  // ─── Anchor, tint, blend ───────────────────────────────────────────────────

  get anchorX(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_ANCHOR_X];
  }
  set anchorX(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_ANCHOR_X] = v;
    markDirty(this._slot, Dirty.SPRITE);
  }
  get anchorY(): number {
    return nodeStore.local[this._slot * LOCAL_STRIDE + L_ANCHOR_Y];
  }
  set anchorY(v: number) {
    nodeStore.local[this._slot * LOCAL_STRIDE + L_ANCHOR_Y] = v;
    markDirty(this._slot, Dirty.SPRITE);
  }

  setAnchor(x: number, y: number = x): this {
    const L = nodeStore.local;
    L[this._slot * LOCAL_STRIDE + L_ANCHOR_X] = x;
    L[this._slot * LOCAL_STRIDE + L_ANCHOR_Y] = y;
    markDirty(this._slot, Dirty.SPRITE);
    return this;
  }

  get tint(): number {
    return nodeStore.tint[this._slot];
  }
  set tint(v: number) {
    nodeStore.tint[this._slot] = v & 0xffffff;
    markDirty(this._slot, Dirty.SPRITE);
  }

  get blendMode(): BlendMode {
    return BLEND_NAMES[this._blendId];
  }
  set blendMode(mode: BlendMode) {
    const id = BlendModeId[mode];
    if (id === undefined) {
      throw new CozyGPUError('INVALID_ARGUMENT', `unknown blendMode "${mode}"`);
    }
    if (id === this._blendId) return;
    this._blendId = id;
    bumpNode(this);
  }

  // ─── Size ──────────────────────────────────────────────────────────────────

  get width(): number {
    const L = nodeStore.local;
    return (
      Math.abs(L[this._slot * LOCAL_STRIDE + L_SCALE_X]) *
      L[this._slot * LOCAL_STRIDE + L_FRAME_W]
    );
  }
  set width(v: number) {
    const L = nodeStore.local;
    const fw = L[this._slot * LOCAL_STRIDE + L_FRAME_W];
    const sign = L[this._slot * LOCAL_STRIDE + L_SCALE_X] < 0 ? -1 : 1;
    L[this._slot * LOCAL_STRIDE + L_SCALE_X] = fw > 0 ? (sign * v) / fw : sign;
    markDirty(this._slot, Dirty.LOCAL);
  }
  get height(): number {
    const L = nodeStore.local;
    return (
      Math.abs(L[this._slot * LOCAL_STRIDE + L_SCALE_Y]) *
      L[this._slot * LOCAL_STRIDE + L_FRAME_H]
    );
  }
  set height(v: number) {
    const L = nodeStore.local;
    const fh = L[this._slot * LOCAL_STRIDE + L_FRAME_H];
    const sign = L[this._slot * LOCAL_STRIDE + L_SCALE_Y] < 0 ? -1 : 1;
    L[this._slot * LOCAL_STRIDE + L_SCALE_Y] = fh > 0 ? (sign * v) / fh : sign;
    markDirty(this._slot, Dirty.LOCAL);
  }

  destroy(options?: DestroyOptions): void {
    if (this._destroyed) return;
    if (options?.texture) this._texture.destroy();
    super.destroy(options);
  }
}
