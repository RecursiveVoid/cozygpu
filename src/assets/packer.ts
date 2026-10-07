/**
 * Skyline bottom-left rectangle packer (ARCHITECTURE §15.7).
 * Pure and Node-tested. Freed rectangles are never reused (M2).
 *
 * `pack(w, h)` reserves `w + 2·padding` × `h + 2·padding` and reports the
 * INNER origin through `x` / `y`, so neighbours are `2·padding` apart and
 * page edges `padding` away.
 */
export class SkylinePacker {
  /** Inner origin of the last successful `pack`. */
  x = 0;
  y = 0;
  /** Texels reserved so far (including padding). */
  usedArea = 0;
  /** Skyline segments: xs[i] start, ys[i] height, ws[i] width; sorted by x. */
  private xs: number[] = [0];
  private ys: number[] = [0];
  private ws: number[];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly padding = 0,
  ) {
    this.ws = [width];
  }

  get segments(): number {
    return this.xs.length;
  }

  /** Fraction of the page reserved (0..1). */
  get fill(): number {
    return this.usedArea / (this.width * this.height);
  }

  /** True when a w×h image could fit on an empty page of this size. */
  fitsEmpty(w: number, h: number): boolean {
    const p = this.padding * 2;
    return w + p <= this.width && h + p <= this.height;
  }

  pack(w: number, h: number): boolean {
    const rw = w + this.padding * 2;
    const rh = h + this.padding * 2;
    if (rw > this.width || rh > this.height || w <= 0 || h <= 0) return false;
    let bestIndex = -1;
    let bestY = Infinity;
    let bestWidth = Infinity;
    const xs = this.xs;
    for (let i = 0; i < xs.length; i++) {
      const y = this.fitAt(i, rw, rh);
      if (y < 0) continue;
      if (y < bestY || (y === bestY && this.ws[i] < bestWidth)) {
        bestY = y;
        bestIndex = i;
        bestWidth = this.ws[i];
      }
    }
    if (bestIndex < 0) return false;
    const px = xs[bestIndex];
    this.addSegment(bestIndex, px, bestY + rh, rw);
    this.usedArea += rw * rh;
    this.x = px + this.padding;
    this.y = bestY + this.padding;
    return true;
  }

  /** y where a rw×rh rect starting at segment i rests; -1 if it does not fit. */
  private fitAt(index: number, rw: number, rh: number): number {
    const x = this.xs[index];
    if (x + rw > this.width) return -1;
    let remaining = rw;
    let y = 0;
    let i = index;
    while (remaining > 0) {
      if (i >= this.xs.length) return -1;
      if (this.ys[i] > y) y = this.ys[i];
      if (y + rh > this.height) return -1;
      remaining -= this.ws[i];
      i++;
    }
    return y;
  }

  private addSegment(index: number, x: number, y: number, w: number): void {
    const xs = this.xs;
    const ys = this.ys;
    const ws = this.ws;
    xs.splice(index, 0, x);
    ys.splice(index, 0, y);
    ws.splice(index, 0, w);
    // Shrink or remove the segments now covered by the new one.
    for (let i = index + 1; i < xs.length; ) {
      const end = xs[i - 1] + ws[i - 1];
      if (xs[i] >= end) break;
      const shrink = end - xs[i];
      if (ws[i] <= shrink) {
        xs.splice(i, 1);
        ys.splice(i, 1);
        ws.splice(i, 1);
      } else {
        xs[i] += shrink;
        ws[i] -= shrink;
        break;
      }
    }
    // Merge neighbours of equal height.
    for (let i = 0; i < xs.length - 1; ) {
      if (ys[i] === ys[i + 1]) {
        ws[i] += ws[i + 1];
        xs.splice(i + 1, 1);
        ys.splice(i + 1, 1);
        ws.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }
}
