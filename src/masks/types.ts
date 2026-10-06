/**
 * Masking public API (M3), implemented in src/masks/**. Spec:
 * docs/ARCHITECTURE.md §21 and docs/API.md "Masks".
 *
 * A mask clips a `Group`'s subtree. cozygpu picks one of three
 * implementations automatically from the mask itself (`mode: 'auto'`):
 *
 *   scissor  axis-aligned rect, no rotation/skew in the mask's world
 *            transform → `RenderPass.setScissor`. No extra draw, no target.
 *   stencil  any sprite/container geometry, hard edges → the mask quads are
 *            drawn into a stencil attachment, then the subtree draws with
 *            `compare: 'equal'`. One pass break per frame (§21.3).
 *   alpha    soft masks (gradients, feathered edges, `invert` on a
 *            semi-transparent mask) → the subtree is captured into a pooled
 *            render target and multiplied by the mask's alpha.
 *
 * No WebGPU/WebGL types here; the core half talks through the MASK opcode
 * range (0x04).
 */
import type { ContainerNode, SceneNode } from '../scene/types';
import type { FrontFrame } from '../types/core';

/** Axis-aligned rectangle in the masked group's parent space (stage px). */
export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What clips the group: a scene node (its drawn pixels — a Sprite, or a
 * Container of sprites, including a `Text`) or a plain rectangle.
 * The node does NOT have to be in the scene tree; if it is, it also draws
 * normally. Its world transform is used either way, so a mask node that is
 * not in the tree is positioned relative to the masked group's parent.
 */
export type MaskSource = SceneNode | MaskRect;

/** The long form, when the defaults are not what you want. */
export interface MaskSpec {
  source: MaskSource;
  /**
   * Which implementation to use. Default 'auto' (see the module comment).
   * An explicit mode that the backend cannot do (stencil without
   * `caps.stencil`) falls back to 'alpha' and reports `error` once.
   */
  mode?: MaskMode;
  /** Keep what is OUTSIDE the mask. Default false. */
  invert?: boolean;
  /**
   * Alpha below which a mask texel does not mask, for 'scissor' and
   * 'stencil' (which are binary). Default layouts.MASK_ALPHA_THRESHOLD.
   * Ignored by 'alpha' masks, which are continuous.
   */
  threshold?: number;
}

export type MaskMode = 'auto' | 'scissor' | 'stencil' | 'alpha';

/** Value of `GroupNode.mask`. */
export type MaskTarget = MaskSource | MaskSpec | null;

/**
 * @internal Front half of a group's mask, created by the lazily imported
 * masks chunk (`createMaskBinding`, src/masks/mask.ts) and driven by `Group`.
 * Zero allocations per frame once the mask stopped changing.
 */
export interface MaskBinding {
  /** The mask changed (or was cleared). Cheap; no GPU work here. */
  update(target: MaskTarget): void;
  /** The implementation chosen for the current target ('auto' resolved). */
  readonly mode: Exclude<MaskMode, 'auto'>;
  /**
   * Emits the push command. False = not ready this frame (shape not
   * uploaded, core system still loading): the group's subtree is skipped.
   */
  emitBegin(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): boolean;
  /** Emits MASK_POP (with PASS_BREAK when the push broke the pass). */
  emitEnd(frame: FrontFrame): void;
  destroy(): void;
}

/** @internal Entry point of the masks chunk. */
export type CreateMaskBinding = (group: ContainerNode) => MaskBinding;
