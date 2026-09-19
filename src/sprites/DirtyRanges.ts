/**
 * Up to MAX_RANGES half-open instance ranges [start, end) — owner: "sprites"
 * (ARCHITECTURE §5.2 step 3). Adds are O(1) for the common in-order case.
 */
export const MAX_RANGES = 8;
/** Gaps up to this many instances are merged (bytes are cheaper than calls). */
export const MERGE_GAP = 32;

export class DirtyRanges {
  readonly starts = new Uint32Array(MAX_RANGES + 1);
  readonly ends = new Uint32Array(MAX_RANGES + 1);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  add(index: number): void {
    this.addRange(index, index + 1);
  }

  addRange(start: number, end: number): void {
    if (end <= start) return;
    const s = this.starts;
    const e = this.ends;
    let n = this.count;
    // Fast path: at or after the last range.
    if (n > 0 && start >= s[n - 1]) {
      if (start <= e[n - 1] + MERGE_GAP) {
        if (end > e[n - 1]) e[n - 1] = end;
        return;
      }
    } else if (n > 0) {
      // Out of order: insert sorted, then coalesce overlaps.
      let i = n;
      while (i > 0 && s[i - 1] > start) {
        s[i] = s[i - 1];
        e[i] = e[i - 1];
        i--;
      }
      s[i] = start;
      e[i] = end;
      this.count = n + 1;
      this.coalesce();
      if (this.count > MAX_RANGES) this.mergeNearest();
      return;
    }
    s[n] = start;
    e[n] = end;
    this.count = ++n;
    if (n > MAX_RANGES) this.mergeNearest();
  }

  /** If the dirty instances cover more than half of the overall span, upload one range. */
  finalize(): void {
    const n = this.count;
    if (n < 2) return;
    let covered = 0;
    for (let i = 0; i < n; i++) covered += this.ends[i] - this.starts[i];
    const span = this.ends[n - 1] - this.starts[0];
    if (covered * 2 > span) {
      this.ends[0] = this.ends[n - 1];
      this.count = 1;
    }
  }

  private coalesce(): void {
    const s = this.starts;
    const e = this.ends;
    let w = 0;
    for (let i = 1; i < this.count; i++) {
      if (s[i] <= e[w] + MERGE_GAP) {
        if (e[i] > e[w]) e[w] = e[i];
      } else {
        w++;
        s[w] = s[i];
        e[w] = e[i];
      }
    }
    this.count = w + 1;
  }

  private mergeNearest(): void {
    const s = this.starts;
    const e = this.ends;
    const n = this.count;
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < n - 1; i++) {
      const gap = s[i + 1] - e[i];
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (e[best + 1] > e[best]) e[best] = e[best + 1];
    for (let i = best + 1; i < n - 1; i++) {
      s[i] = s[i + 1];
      e[i] = e[i + 1];
    }
    this.count = n - 1;
  }
}
