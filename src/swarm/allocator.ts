/**
 * CPU free list of slot ranges for `allocation: 'manual'`.
 * Free ranges are kept sorted and merged. Not a per-frame structure.
 */
export class RangeAllocator {
  readonly capacity: number;
  private starts: number[] = [];
  private ends: number[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
    this.reset();
  }

  /** Everything free. */
  reset(): void {
    this.starts = [0];
    this.ends = [this.capacity];
    if (this.capacity === 0) {
      this.starts.length = 0;
      this.ends.length = 0;
    }
  }

  /** First fit. Returns the first slot of a contiguous range, or -1. */
  alloc(count: number): number {
    for (let r = 0; r < this.starts.length; r++) {
      const start = this.starts[r];
      if (this.ends[r] - start >= count) {
        this.starts[r] = start + count;
        if (this.starts[r] === this.ends[r]) {
          this.starts.splice(r, 1);
          this.ends.splice(r, 1);
        }
        return start;
      }
    }
    return -1;
  }

  /** Frees [first, first + count). Freeing already-free slots is harmless. */
  free(first: number, count: number): void {
    let start = Math.max(0, first);
    let end = Math.min(this.capacity, first + count);
    if (end <= start) return;
    const starts: number[] = [];
    const ends: number[] = [];
    let placed = false;
    for (let r = 0; r < this.starts.length; r++) {
      const s = this.starts[r];
      const e = this.ends[r];
      if (e < start) {
        starts.push(s);
        ends.push(e);
      } else if (s > end) {
        if (!placed) {
          starts.push(start);
          ends.push(end);
          placed = true;
        }
        starts.push(s);
        ends.push(e);
      } else {
        // overlapping or adjacent: merge
        start = Math.min(start, s);
        end = Math.max(end, e);
      }
    }
    if (!placed) {
      starts.push(start);
      ends.push(end);
    }
    this.starts = starts;
    this.ends = ends;
  }

  /** Highest allocated slot + 1 (0 when everything is free). */
  get highWater(): number {
    const n = this.starts.length;
    if (n > 0 && this.ends[n - 1] === this.capacity) return this.starts[n - 1];
    return this.capacity;
  }

  /** Number of free slots. */
  get freeCount(): number {
    let total = 0;
    for (let r = 0; r < this.starts.length; r++) {
      total += this.ends[r] - this.starts[r];
    }
    return total;
  }
}
