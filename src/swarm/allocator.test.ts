import { RangeAllocator } from './allocator';

describe('RangeAllocator', () => {
  test('first fit, high water, merge on free', () => {
    const a = new RangeAllocator(100);
    expect(a.highWater).toBe(0);
    expect(a.alloc(10)).toBe(0);
    expect(a.alloc(20)).toBe(10);
    expect(a.alloc(5)).toBe(30);
    expect(a.highWater).toBe(35);
    a.free(10, 20);
    expect(a.highWater).toBe(35);
    expect(a.alloc(15)).toBe(10); // reuses the hole
    expect(a.alloc(6)).toBe(35); // hole [25,30) is too small
    a.free(30, 11); // frees [30, 41) → trailing
    expect(a.highWater).toBe(25);
    expect(a.freeCount).toBe(75);
  });

  test('full and double free', () => {
    const a = new RangeAllocator(8);
    expect(a.alloc(8)).toBe(0);
    expect(a.alloc(1)).toBe(-1);
    a.free(2, 2);
    a.free(2, 2);
    a.free(3, 1);
    expect(a.freeCount).toBe(2);
    expect(a.alloc(3)).toBe(-1);
    expect(a.alloc(2)).toBe(2);
    a.free(0, 100);
    expect(a.freeCount).toBe(8);
    expect(a.highWater).toBe(0);
  });
});
