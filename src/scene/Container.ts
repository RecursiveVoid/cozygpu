/** Container. Groups nodes; children draw in array order. */
import { CozyGPUError } from '../types/errors';
import { ChildBulk, ColumnBindingImpl } from './bulk';
import { NodeBase, computeLocalAffine, computeWorld } from './Node';
import { Dirty, bumpChildren, markDirty, materializeWorld } from './store';
import type {
  BindColumnsOptions,
  BulkChildren,
  ColumnBinding,
  ContainerNode,
  DestroyOptions,
  NodeOptions,
  SceneNode,
  SpriteColumns,
} from './types';

export interface ContainerOptions extends NodeOptions {
  children?: SceneNode[];
}

/**
 * Optional hook for SceneNode implementations that do not extend NodeBase,
 * so `parent` stays correct.
 */
interface ParentHook {
  _setParent?(parent: ContainerNode | null): void;
}

function setParent(child: SceneNode, parent: ContainerNode | null): void {
  if (child instanceof NodeBase) {
    child._parent = parent;
    markDirty(child._slot, Dirty.LOCAL | Dirty.ALPHA);
  } else {
    (child as ParentHook)._setParent?.(parent);
  }
}

export class Container extends NodeBase implements ContainerNode {
  /** @internal */
  readonly _children: SceneNode[] = [];
  /** @internal Bumped on every children list change. */
  _childrenVersion = 0;
  /** @internal Lazily created bulk writer. */
  _bulk: ChildBulk | null = null;
  /** @internal Lazily created column binding (M2.5). */
  _cols: ColumnBindingImpl | null = null;

  constructor(options?: ContainerOptions) {
    super(options);
    const children = options?.children;
    if (children) {
      for (let i = 0; i < children.length; i++) this.addChild(children[i]);
    }
  }

  get kind(): 'container' {
    return 'container';
  }

  get children(): readonly SceneNode[] {
    return this._children;
  }

  /** M2 (ARCHITECTURE §16.1). Bumped whenever the children list changes. */
  get childrenVersion(): number {
    return this._childrenVersion;
  }

  /**
   * M2 (ARCHITECTURE §16.1). This container's reused dense writer for its
   * direct children. Allocation-free while the children list and the
   * requested fields stay the same.
   */
  bulkChildren(fields: number): BulkChildren {
    this._assertAlive('bulkChildren');
    let bulk = this._bulk;
    if (!bulk) bulk = this._bulk = new ChildBulk(this);
    bulk._acquire(fields);
    return bulk;
  }

  /**
   * M2.5 (ARCHITECTURE §19.1). Binds caller-owned typed arrays to the direct
   * children; returns this container's single reused binding. Shares the
   * bulk writer's copy path (src/scene/bulk.ts).
   */
  bindColumns(
    columns: SpriteColumns,
    options?: BindColumnsOptions,
  ): ColumnBinding {
    let cols = this._cols;
    if (!cols) cols = this._cols = new ColumnBindingImpl(this);
    cols.rebind(columns, options);
    return cols;
  }

  /** @internal Children list changed at index >= `index`. */
  private _childrenChanged(index: number): void {
    this._childrenVersion = (this._childrenVersion + 1) | 0;
    bumpChildren(this, index);
  }

  addChild<T extends SceneNode>(child: T): T {
    return this.addChildAt(child, this._children.length);
  }

  addChildAt<T extends SceneNode>(child: T, index: number): T {
    this._assertAlive('addChild');
    if (child.destroyed) {
      throw new CozyGPUError('DESTROYED', 'cannot add a destroyed node');
    }
    for (let p: ContainerNode | null = this; p; p = p.parent) {
      if (p === (child as SceneNode)) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          'cannot add a node to itself or its descendant',
        );
      }
    }
    const oldParent = child.parent;
    // Indices refer to the children array after the child left its old
    // parent. Re-adding to this container: an index equal to the current
    // length still means "the end" (Pixi's bring-to-front idiom).
    let n = this._children.length;
    if (oldParent === this) {
      n--;
      if (index === n + 1) index = n;
    }
    // Validate before detaching, so a bad index leaves the tree untouched.
    if (index < 0 || index > n) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `addChildAt: index ${index} out of [0, ${n}]`,
      );
    }
    if (oldParent) oldParent.removeChild(child);
    if (index === n) this._children.push(child);
    else this._children.splice(index, 0, child);
    setParent(child, this);
    this._childrenChanged(index);
    return child;
  }

  removeChild<T extends SceneNode>(child: T): T {
    // lastIndexOf: removing recently added children is the common case.
    const i = this._children.lastIndexOf(child);
    if (i < 0) return child;
    if (i === this._children.length - 1) this._children.pop();
    else this._children.splice(i, 1);
    setParent(child, null);
    this._childrenChanged(i);
    return child;
  }

  removeChildren(begin = 0, end = this._children.length): SceneNode[] {
    const n = this._children.length;
    const b = Math.max(0, begin);
    const e = Math.min(n, end);
    if (e <= b) return [];
    const removed = this._children.splice(b, e - b);
    for (let i = 0; i < removed.length; i++) setParent(removed[i], null);
    this._childrenChanged(b);
    return removed;
  }

  setChildIndex(child: SceneNode, index: number): void {
    const from = this._children.indexOf(child);
    if (from < 0) {
      throw new CozyGPUError('INVALID_ARGUMENT', 'setChildIndex: not a child');
    }
    const n = this._children.length;
    if (index < 0 || index >= n) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `setChildIndex: index ${index} out of [0, ${n})`,
      );
    }
    if (from === index) return;
    this._children.splice(from, 1);
    this._children.splice(index, 0, child);
    this._childrenChanged(from < index ? from : index);
  }

  getChildIndex(child: SceneNode): number {
    return this._children.indexOf(child);
  }

  /**
   * Recomputes world transforms of this subtree now, using the parent's last
   * world transform. Dirty bits are kept, so the next render still uploads.
   */
  updateTransform(): void {
    const p = this._parent;
    if (p instanceof NodeBase) materializeWorld(p._slot);
    updateSubtree(this, p instanceof NodeBase ? p._slot : -1);
  }

  destroy(options?: DestroyOptions): void {
    if (this._destroyed) return;
    const children = this._children;
    if (options?.children !== false) {
      // Detach from the end (O(1) per child) before destroying, so a child's
      // removeFromParent() never scans this array: O(n) for n children.
      if (children.length > 0) this._childrenChanged(0);
      while (children.length > 0) {
        const child = children.pop() as SceneNode;
        setParent(child, null);
        child.destroy(options);
      }
    } else {
      this.removeChildren();
    }
    this._bulk = null;
    this._cols?.unbind();
    super.destroy(options);
  }
}

function updateSubtree(node: SceneNode, parentSlot: number): void {
  if (!(node instanceof NodeBase)) return;
  computeLocalAffine(node._slot);
  computeWorld(node._slot, parentSlot);
  if (node instanceof Container) {
    const c = node._children;
    for (let i = 0; i < c.length; i++) updateSubtree(c[i], node._slot);
  }
}
