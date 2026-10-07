/**
 * The recording format of GraphicsContext (see its file header), shared by
 * the `graphics` and `graphics-tess` chunks. GraphicsContext.ts keeps a
 * private copy of these numbers so the shell exports nothing a chunk imports.
 */

import {
  GFX_DRAW_MESH_BYTES,
  GFX_DRAW_MESH_COUNT_WORD,
  GFX_DRAW_SHAPES_BYTES,
  GFX_DRAW_SHAPES_COUNT_WORD,
} from '../commands/gfxOpcodes';
import {
  GFX_KIND_MASK,
  GFX_SHAPE_F32_PER,
  GS_HALF_H,
  GS_P0,
  GS_P1,
  GS_RESERVED,
  GS_STROKE_OUT,
  GfxShapeFlag,
  GfxShapeKind,
} from '../types/gfxLayouts';

// Opcodes. Path calls are 1..G_POLY; paints and markers follow.
export const G_XFORM = 0;
export const G_MOVE = 1;
export const G_LINE = 2;
export const G_QUAD = 3;
export const G_CUBIC = 4;
/** x, y, r, start, sweep (signed, already resolved from end/ccw). */
export const G_ARC = 5;
export const G_ARC_TO = 6;
export const G_CLOSE = 7;
export const G_RECT = 8;
export const G_RRECT = 9;
/** cx, cy, rx, ry (circle: rx = ry). */
export const G_ELLIPSE = 10;
/** n, closed (0|1), x0, y0, … */
export const G_POLY = 11;
export const G_FILL = 12;
export const G_STROKE = 13;
export const G_CUT = 14;
export const G_BEGIN = 15;

// Resolved paint style (16 numbers).
export const P_COLOR = 0; // packed RGBA8, alpha included
export const P_TEX = 1; // index in _tex, -1 = none
export const P_GLOBAL = 2; // textureSpace 'global'
export const P_HAS_MAT = 3;
export const P_MAT = 4; // 6 numbers
export const P_WIDTH = 10;
export const P_JOIN = 11; // 0 miter, 1 round, 2 bevel
export const P_CAP = 12; // 0 butt, 1 round, 2 square
export const P_MITER = 13;
export const P_ALIGN = 14;
export const P_PIXEL = 15;
export const P_SIZE = 16;

/** Numbers per recorded opcode (G_POLY: 2 + 2n). */
export const G_ARGS = [6, 2, 2, 4, 6, 5, 5, 0, 4, 5, 4, 2, 16, 16, 0, 0];

// ─── Shape-instance words and draw-command sizes, as the chunks use them ──
/** u32/f32 words of a shape instance (GFX_SHAPE_BYTES / 4) and fields (GS_* / 4). */
export const SHAPE_WORDS = GFX_SHAPE_F32_PER;
export const W_HALF_H = GS_HALF_H / 4;
export const W_P0 = GS_P0 / 4;
export const W_P1 = GS_P1 / 4;
export const W_STROKE_OUT = GS_STROKE_OUT / 4;
export const W_RESERVED = GS_RESERVED / 4;
/** GfxShapeKind. */
export const K_RECT = GfxShapeKind.RECT;
export const K_ELLIPSE = GfxShapeKind.ELLIPSE;
export const K_SEGMENT = GfxShapeKind.SEGMENT;
export const K_ARC = GfxShapeKind.ARC;
export const KIND_MASK = GFX_KIND_MASK;
/** GfxShapeFlag. */
export const F_CAP_ROUND = GfxShapeFlag.CAP_ROUND;
export const F_CAP_SQUARE = GfxShapeFlag.CAP_SQUARE;
export const F_JOIN_ROUND = GfxShapeFlag.JOIN_ROUND;
export const F_JOIN_BEVEL = GfxShapeFlag.JOIN_BEVEL;
export const F_PIXEL_LINE = GfxShapeFlag.PIXEL_LINE;
export const F_FILL = GfxShapeFlag.FILL;
export const DRAW_SHAPES_BYTES = GFX_DRAW_SHAPES_BYTES;
export const DRAW_MESH_BYTES = GFX_DRAW_MESH_BYTES;
export const SHAPES_COUNT_WORD = GFX_DRAW_SHAPES_COUNT_WORD;
export const MESH_COUNT_WORD = GFX_DRAW_MESH_COUNT_WORD;
