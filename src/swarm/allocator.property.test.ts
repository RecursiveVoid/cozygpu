/**
 * Tester (logic, round 1): RangeAllocator against a per-slot bitmap
 * reference model under random alloc/free sequences (seeded).
 */
import { RangeAllocator } from './allocator';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference: used[i] = 1 when slot i is allocated. */
class Model {
  used: Uint8Array;
  constructor(readonly capacity: number) {
    this.used = new Uint8Array(capacity);
  }
  firstFit(count: number): number {
    let run = 0;
    for (let i = 0; i < this.capacity; i++) {
      run = this.used[i] ? 0 : run + 1;
      if (run === count) return i - count + 1;
    }
    return -1;
  }
  free(first: number, count: number): void {
    const s = Math.max(0, first);
    const e = Math.min(this.capacity, first + count);
    for (let i = s; i < e; i++) this.used[i] = 0;
  }
  get highWater(): number {
    for (let i = this.capacity - 1; i >= 0; i--) if (this.used[i]) return i + 1;
    return 0;
  }
  get freeCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) n += this.used[i] ? 0 : 1;
    return n;
  }
}

/** Reads the private range lists to check the representation invariants. */
function ranges(a: RangeAllocator): [number[], number[]] {
  const r = a as unknown as { starts: number[]; ends: number[] };
  return [r.starts, r.ends];
}

describe('RangeAllocator vs bitmap model (random)', () => {
  it.each([1, 7, 64, 257])(
    'capacity %i: alloc/free/highWater/freeCount agree over 3000 ops',
    capacity => {
      const r = rng(capacity * 7919);
      const a = new RangeAllocator(capacity);
      const m = new Model(capacity);
      for (let step = 0; step < 3000; step++) {
        const pick = r();
        if (pick < 0.5) {
          const count = 1 + Math.floor(r() * Math.max(1, capacity / 4));
          const expected = m.firstFit(count);
          const got = a.alloc(count);
          expect(got).toBe(expected);
          if (got >= 0) m.used.fill(1, got, got + count);
        } else if (pick < 0.95) {
          // frees may overlap free slots, run past the end or start below 0
          const first = Math.floor(r() * (capacity + 4)) - 2;
          const count = Math.floor(r() * Math.max(2, capacity / 3));
          a.free(first, count);
          m.free(first, count);
        } else {
          a.reset();
          m.used.fill(0);
        }
        expect(a.highWater).toBe(m.highWater);
        expect(a.freeCount).toBe(m.freeCount);

        // sorted, disjoint, non-adjacent (merged), non-empty, in bounds
        const [s, e] = ranges(a);
        let bad = s.length !== e.length;
        for (let k = 0; k < s.length && !bad; k++) {
          bad =
            s[k] < 0 ||
            e[k] > capacity ||
            e[k] <= s[k] ||
            (k > 0 && s[k] <= e[k - 1]);
        }
        if (bad) throw new Error(`bad ranges at step ${step}: ${s} / ${e}`);
      }
    },
  );

  it('capacity 0 never allocates', () => {
    const a = new RangeAllocator(0);
    expect(a.alloc(1)).toBe(-1);
    expect(a.highWater).toBe(0);
    expect(a.freeCount).toBe(0);
    a.free(0, 10);
    expect(a.freeCount).toBe(0);
  });

  it('a full allocation reports highWater = capacity; freeing the tail lowers it', () => {
    const a = new RangeAllocator(10);
    expect(a.alloc(10)).toBe(0);
    expect(a.highWater).toBe(10);
    a.free(7, 3);
    expect(a.highWater).toBe(7);
    a.free(0, 7);
    expect(a.highWater).toBe(0);
    expect(a.alloc(10)).toBe(0);
  });
});
