/**
 * u32 resource ids shared by the front (public objects) and the core
 * (GPU resources) sides of the command stream. Id 0 is reserved and means
 * "none"; NO_ID (0xFFFFFFFF) is also never allocated.
 *
 * One allocator per resource kind, per process (ids are unique across
 * renderers, which keeps multi-renderer setups simple).
 */
export const NONE_ID = 0;
export const NO_ID = 0xffffffff;

export interface IdAllocator {
  alloc(): number;
  free(id: number): void;
}

export function createIdAllocator(): IdAllocator {
  let next = 1;
  const freeList: number[] = [];
  return {
    alloc(): number {
      if (freeList.length > 0) return freeList.pop() as number;
      if (next >= NO_ID) throw new RangeError('id space exhausted');
      return next++;
    },
    free(id: number): void {
      if (id !== NONE_ID && id !== NO_ID) freeList.push(id);
    },
  };
}

/** Process-wide allocators, one per resource kind in the command stream. */
export const ids = {
  texture: createIdAllocator(),
  spriteBuffer: createIdAllocator(),
  swarm: createIdAllocator(),
  shared: createIdAllocator(),
  readback: createIdAllocator(),
  node: createIdAllocator(),
} as const;
