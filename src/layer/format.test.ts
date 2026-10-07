/** The lazy-side copies in format.ts match the public layerLayouts.ts. */
import * as L from '../types/layerLayouts';
import * as F from './format';

describe('layer format copies', () => {
  it('equal layerLayouts', () => {
    expect(F.STREAM_BYTES).toEqual([
      L.LAYER_POSITION_BYTES,
      L.LAYER_XFORM_BYTES,
      L.LAYER_COLOR_BYTES,
      L.LAYER_USER_BYTES,
    ]);
    expect([F.POSITION, F.XFORM, F.COLOR]).toEqual([
      L.LayerStream.POSITION,
      L.LayerStream.XFORM,
      L.LayerStream.COLOR,
    ]);
    expect(F.FRAME_BYTES).toBe(L.LAYER_FRAME_BYTES);
    expect([F.F_WIDTH, F.F_HEIGHT, F.F_ANCHOR]).toEqual([
      L.LF_WIDTH,
      L.LF_HEIGHT,
      L.LF_ANCHOR,
    ]);
    expect(F.MAX_TEXTURES).toBe(L.LAYER_MAX_TEXTURES);
    expect(F.INDIRECT_BYTES).toBe(L.LAYER_INDIRECT_BYTES);
    expect(F.VISIBLE_BYTES).toBe(L.LAYER_VISIBLE_BYTES);
    expect(F.CULL_WORKGROUP).toBe(L.LAYER_CULL_WORKGROUP);
  });
});
