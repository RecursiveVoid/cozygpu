/**
 * Graphics contracts (ARCHITECTURE §26.10): layouts, opcode table and the
 * shell's public surface. Implementation tests live next to the modules.
 */
import {
  FilterOp,
  MaskOp,
  Op,
  OpcodeRange,
  opcodeRange,
} from '../commands/opcodes';
import {
  GFX_DRAW_MESH_BYTES,
  GFX_DRAW_MESH_COUNT_WORD,
  GFX_DRAW_SHAPES_BYTES,
  GFX_DRAW_SHAPES_COUNT_WORD,
  GfxOp,
} from '../commands/gfxOpcodes';
import { SI_PICK_SHIFT } from '../types/layouts';
import {
  GFX_KIND_MASK,
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GN_FLAGS,
  GMV_COLOR,
  GS_FLAGS,
  GS_RESERVED,
  GfxShapeFlag,
  GfxShapeKind,
} from '../types/gfxLayouts';
import { isCustomDrawable, isMaskDrawable } from '../types/core';
import { Graphics, GraphicsContext } from './index';

describe('graphics layouts', () => {
  it('keeps the instance, vertex and node strides', () => {
    expect(GFX_SHAPE_BYTES).toBe(64);
    expect(GS_RESERVED + 4).toBe(GFX_SHAPE_BYTES);
    expect(GFX_MESH_VERTEX_BYTES).toBe(GMV_COLOR + 4);
    expect(GFX_NODE_BYTES).toBe(GN_FLAGS + 4);
    expect(GS_FLAGS % 4).toBe(0);
  });

  it('fits kinds and flags below the pick id', () => {
    for (const kind of Object.values(GfxShapeKind)) {
      expect(kind & ~GFX_KIND_MASK).toBe(0);
    }
    for (const flag of Object.values(GfxShapeFlag)) {
      expect(flag & GFX_KIND_MASK).toBe(0);
      expect(flag < 1 << SI_PICK_SHIFT).toBe(true);
    }
  });
});

describe('graphics opcodes', () => {
  it('live in the GRAPHICS range and collide with nothing', () => {
    const all = [
      ...Object.values(Op),
      ...Object.values(MaskOp),
      ...Object.values(FilterOp),
      ...Object.values(GfxOp),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const op of Object.values(GfxOp)) {
      expect(opcodeRange(op)).toBe(OpcodeRange.GRAPHICS);
    }
  });

  it('puts the growable counts inside the draw payloads', () => {
    expect(GFX_DRAW_SHAPES_COUNT_WORD * 4).toBeLessThan(GFX_DRAW_SHAPES_BYTES);
    expect(GFX_DRAW_MESH_COUNT_WORD * 4).toBeLessThan(GFX_DRAW_MESH_BYTES);
  });
});

describe('Graphics shell', () => {
  it('is a leaf CustomDrawable and MaskDrawable of kind graphics', () => {
    const g = new Graphics();
    expect(g.kind).toBe('graphics');
    expect(isCustomDrawable(g)).toBe(true);
    expect(isMaskDrawable(g)).toBe(true);
    expect(g.context).toBeInstanceOf(GraphicsContext);
    g.destroy();
    expect(g.context.destroyed).toBe(true);
  });

  it('shares a passed context and leaves it alive on destroy', () => {
    const ctx = new GraphicsContext({ tolerance: 0.5 });
    const a = new Graphics(ctx);
    const b = new Graphics({ context: ctx, tint: 0xff0000 });
    expect(a.context).toBe(ctx);
    expect(b.context).toBe(ctx);
    expect(b.tint).toBe(0xff0000);
    expect(ctx.tolerance).toBe(0.5);
    a.destroy();
    b.destroy();
    expect(ctx.destroyed).toBe(false);
  });
});
