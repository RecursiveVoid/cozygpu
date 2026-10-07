/**
 * Retained rendering contracts (ARCHITECTURE §27, §29): retain opcodes, the
 * unified-batch layouts and the seams.
 */
import { FilterOp, MaskOp, Op, OpcodeRange } from '../commands/opcodes';
import {
  GFX_DRAW_UNIFIED_BYTES,
  GFX_DRAW_UNIFIED_COUNT_WORD,
  GfxOp,
  GfxPoolKind,
} from '../commands/gfxOpcodes';
import { LayerOp } from '../commands/layerOpcodes';
import {
  RETAIN_MIN_ENTRIES,
  RETAIN_WARMUP_FRAMES,
  RetainOp,
} from '../commands/retainOpcodes';
import {
  PACKER_RETAIN_MIN_ENTRIES,
  PACKER_RETAIN_WARMUP_FRAMES,
} from '../sprites/front';
import {
  GFX_ITEM_CORNER_BITS,
  GFX_ITEM_INDEX_MASK,
  GFX_ITEM_KIND_SHIFT,
  GFX_ITEM_MAX_RECORD,
  GFX_SPRITE_SLOT_MASK,
  GFX_SPRITE_SLOT_SHIFT,
  GFX_TRANSFORM_BYTES,
  GFX_UVERTEX_BYTES,
  GT_RESERVED,
  GUV_NODE,
  GfxItemKind,
  GFX_MAX_TEXTURE_SLOTS,
} from '../types/gfxLayouts';
import { SI_PICK_SHIFT, SpriteInstanceFlag } from '../types/layouts';
import { isRetainableDrawable } from '../types/core';
import { Container } from '../scene/Container';
import { createRetainCoreSystem } from './core';
import { createStaticBinding } from './static';

describe('retain opcodes', () => {
  it('live in the RETAIN range and collide with nothing', () => {
    const others = [
      ...Object.values(Op),
      ...Object.values(MaskOp),
      ...Object.values(FilterOp),
      ...Object.values(GfxOp),
      ...Object.values(LayerOp),
    ];
    for (const code of Object.values(RetainOp)) {
      expect(code >>> 8).toBe(OpcodeRange.RETAIN);
      expect(others).not.toContain(code);
    }
  });
});

describe('unified batch layouts', () => {
  it('encodes every item kind below the reserved kind 3', () => {
    for (const kind of Object.values(GfxItemKind)) {
      expect(kind).toBeLessThan(3);
      // kind 3 with all bits set would be the primitive-restart index
      expect(
        ((kind << GFX_ITEM_KIND_SHIFT) | GFX_ITEM_INDEX_MASK) >>> 0,
      ).not.toBe(0xffffffff);
    }
    expect(GFX_ITEM_MAX_RECORD).toBe(2 ** (30 - GFX_ITEM_CORNER_BITS) - 1);
  });

  it('keeps record strides and draw payload sizes', () => {
    expect(GFX_UVERTEX_BYTES).toBe(GUV_NODE + 4);
    expect(GFX_TRANSFORM_BYTES).toBe(GT_RESERVED + 4);
    expect(GFX_DRAW_UNIFIED_BYTES).toBe(11 * 4);
    expect(GFX_DRAW_UNIFIED_COUNT_WORD).toBe(2);
    expect(Object.values(GfxPoolKind)).toEqual([0, 1, 2]);
  });

  it('fits the baked sprite slot between the sprite flags and the pick id', () => {
    const slotBits = GFX_SPRITE_SLOT_MASK << GFX_SPRITE_SLOT_SHIFT;
    for (const flag of Object.values(SpriteInstanceFlag)) {
      expect(flag & slotBits).toBe(0);
    }
    expect(slotBits < 1 << SI_PICK_SHIFT).toBe(true);
    expect(GFX_MAX_TEXTURE_SLOTS).toBe(GFX_SPRITE_SLOT_MASK + 1);
  });
});

describe('retained seams', () => {
  it('the packer keeps its own copies of the warm-up constants', () => {
    expect(PACKER_RETAIN_MIN_ENTRIES).toBe(RETAIN_MIN_ENTRIES);
    expect(PACKER_RETAIN_WARMUP_FRAMES).toBe(RETAIN_WARMUP_FRAMES);
  });

  it('recognises retainable drawables by _syncDraw', () => {
    const custom = { _emitDraw: () => undefined };
    expect(isRetainableDrawable(custom)).toBe(false);
    expect(
      isRetainableDrawable({ ...custom, _syncDraw: () => undefined }),
    ).toBe(true);
  });

  it('container.static round-trips and comes from the options', () => {
    const c = new Container();
    expect(c.static).toBe(false);
    c.static = true;
    expect(c.static).toBe(true);
    c.static = false;
    expect(c.static).toBe(false);
    const d = new Container({ static: true });
    expect(d.static).toBe(true);
    d.destroy();
    expect(d.static).toBe(false);
    c.destroy();
  });

  it('core and static factories build their systems', () => {
    const core = createRetainCoreSystem();
    expect(core.range).toBe(OpcodeRange.RETAIN);
    expect(typeof core.drawSpan).toBe('function');
    const binding = createStaticBinding(new Container());
    expect(typeof binding.emit).toBe('function');
    binding.destroy();
  });
});
