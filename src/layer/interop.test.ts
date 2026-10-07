/** Layer record sizes and usages of `registerInstanceBuffer` (§28.5). */
import { BufferUsage } from '../backend/types';
import type { ImportBufferDesc } from '../backend/types';
import { createInterop } from '../renderer/interopImpl';
import type { CoreInterop } from '../types/core';

function setup(storageBuffers: boolean) {
  const registered: ImportBufferDesc[] = [];
  const core: CoreInterop = {
    backend: storageBuffers ? 'webgpu' : 'webgl2',
    device: () => ({}),
    lossEpoch: 0,
    registerBuffer: (_id, _native, desc) => void registered.push(desc),
    releaseBuffer() {},
    invalidateState() {},
  };
  const interop = createInterop(core, {
    destroyed: false,
    _caps: { storageBuffers },
  });
  return { interop, registered };
}

describe('layer external layouts', () => {
  it('size each layout by its record', () => {
    const { interop, registered } = setup(true);
    const native = {};
    for (const layout of [
      'layer-position',
      'layer-xform',
      'layer-color',
      'layer-user',
    ] as const) {
      interop.registerInstanceBuffer(native, { layout, capacity: 10 });
    }
    interop.registerInstanceBuffer(native, {
      layout: 'draw-indirect',
      capacity: 1,
    });
    expect(registered.map(d => d.size)).toEqual([80, 80, 40, 40, 16]);
    expect(registered.map(d => d.usage)).toEqual([
      BufferUsage.STORAGE,
      BufferUsage.STORAGE,
      BufferUsage.STORAGE,
      BufferUsage.STORAGE,
      BufferUsage.INDIRECT,
    ]);
  });

  it('reads streams as vertex buffers on WebGL2, which has no indirect', () => {
    const { interop, registered } = setup(false);
    interop.registerInstanceBuffer(
      {},
      { layout: 'layer-position', capacity: 2 },
    );
    expect(registered[0].usage).toBe(BufferUsage.VERTEX);
    expect(() =>
      interop.registerInstanceBuffer(
        {},
        { layout: 'draw-indirect', capacity: 1 },
      ),
    ).toThrow(/UNSUPPORTED/);
  });
});
