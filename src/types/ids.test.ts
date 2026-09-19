import { createIdAllocator, NONE_ID } from './ids';

describe('createIdAllocator', () => {
  it('never hands out 0 and reuses freed ids', () => {
    const a = createIdAllocator();
    const first = a.alloc();
    expect(first).not.toBe(NONE_ID);
    const second = a.alloc();
    a.free(first);
    expect(a.alloc()).toBe(first);
    expect(second).toBe(first + 1);
  });
});
