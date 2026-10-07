/**
 * SpriteLayer contracts (ARCHITECTURE §28, §29): opcodes, stream layouts and
 * the stubs. Implementation tests live next to the modules.
 */
import { FilterOp, MaskOp, Op, OpcodeRange } from '../commands/opcodes';
import { GfxOp } from '../commands/gfxOpcodes';
import { RetainOp } from '../commands/retainOpcodes';
import {
  LAYER_CREATE_BYTES,
  LAYER_CULL_BYTES,
  LAYER_DRAW_BYTES,
  LAYER_SET_SOURCE_BYTES,
  LayerOp,
} from '../commands/layerOpcodes';
import {
  LAYER_COLOR_BYTES,
  LAYER_FRAME_BYTES,
  LAYER_INDIRECT_BYTES,
  LAYER_POSITION_BYTES,
  LAYER_STREAM_COUNT,
  LAYER_USER_BYTES,
  LAYER_XFORM_BYTES,
  LF_SLOT,
  LP_Y,
  LX_FRAME,
  LayerStream,
  LayerStreamBit,
} from '../types/layerLayouts';
import { createSpriteLayerCoreSystem } from './core';
import { SpriteLayer, loadSpriteLayer } from './index';

describe('sprite layer opcodes', () => {
  it('live in the SPRITE_LAYER range and collide with nothing', () => {
    const others = [
      ...Object.values(Op),
      ...Object.values(MaskOp),
      ...Object.values(FilterOp),
      ...Object.values(GfxOp),
      ...Object.values(RetainOp),
    ];
    for (const code of Object.values(LayerOp)) {
      expect(code >>> 8).toBe(OpcodeRange.SPRITE_LAYER);
      expect(others).not.toContain(code);
    }
  });

  it('keeps the fixed payload sizes word-aligned', () => {
    expect(LAYER_CREATE_BYTES).toBe(5 * 4);
    expect(LAYER_SET_SOURCE_BYTES).toBe(6 * 4);
    expect(LAYER_CULL_BYTES).toBe(9 * 4);
    expect(LAYER_DRAW_BYTES).toBe(11 * 4);
  });
});

describe('sprite layer layouts', () => {
  it('sizes the streams 8 / 8 / 4 / 4 bytes', () => {
    expect(LAYER_POSITION_BYTES).toBe(LP_Y + 4);
    expect(LAYER_XFORM_BYTES).toBe(LX_FRAME + 2);
    expect(LAYER_COLOR_BYTES).toBe(4);
    expect(LAYER_USER_BYTES).toBe(4);
    expect(LAYER_FRAME_BYTES).toBe(LF_SLOT + 4);
    expect(LAYER_INDIRECT_BYTES).toBe(16);
  });

  it('numbers the streams and their bits consistently', () => {
    expect(Object.keys(LayerStream)).toHaveLength(LAYER_STREAM_COUNT);
    for (const [name, index] of Object.entries(LayerStream)) {
      expect(LayerStreamBit[name as keyof typeof LayerStreamBit]).toBe(
        1 << index,
      );
    }
  });
});

describe('sprite layer entry points', () => {
  it('are built', async () => {
    expect(() => new SpriteLayer({ capacity: 1 })).toThrow(/INVALID_ARGUMENT/);
    expect(createSpriteLayerCoreSystem().range).toBe(OpcodeRange.SPRITE_LAYER);
    await expect(loadSpriteLayer()).resolves.toBeUndefined();
  });
});
