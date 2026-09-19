/**
 * Owner: "assets". Intrusive doubly linked LRU list: `touch` moves a node to
 * the most-recently-used end in O(1) without allocating (it runs from
 * `TextureProvider.upload`, i.e. per drawn texture per frame).
 */
export interface LruNode {
  lruPrev: LruNode | null;
  lruNext: LruNode | null;
  lruLinked: boolean;
}

export class LruList<T extends LruNode> {
  /** Least recently used. */
  head: T | null = null;
  /** Most recently used. */
  tail: T | null = null;
  size = 0;

  /** Appends (or moves) `node` to the most-recently-used end. */
  touch(node: T): void {
    if (this.tail === node) return;
    if (node.lruLinked) this.unlink(node);
    node.lruPrev = this.tail;
    node.lruNext = null;
    if (this.tail !== null) this.tail.lruNext = node;
    else this.head = node;
    this.tail = node;
    node.lruLinked = true;
    this.size++;
  }

  remove(node: T): void {
    if (node.lruLinked) this.unlink(node);
  }

  next(node: T): T | null {
    return node.lruNext as T | null;
  }

  private unlink(node: T): void {
    const prev = node.lruPrev;
    const next = node.lruNext;
    if (prev !== null) prev.lruNext = next;
    else this.head = next as T | null;
    if (next !== null) next.lruPrev = prev;
    else this.tail = prev as T | null;
    node.lruPrev = null;
    node.lruNext = null;
    node.lruLinked = false;
    this.size--;
  }
}
