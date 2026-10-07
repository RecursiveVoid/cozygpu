/**
 * Graphics GPU memory layouts (M4, ARCHITECTURE §26): SDF shape instances,
 * mesh vertices and node records. Kept out of `layouts.ts` because only the
 * lazily loaded graphics chunks read them; the shaders in
 * src/shaders/graphics/** must match these exactly.
 */
/**
 * SDF shape instance (vertex buffer, stepMode 'instance') — 64 B.
 * The affine maps SHAPE space (origin at the shape's centre, unit = local
 * px) to stage space: node world × context transform × translate(centre).
 * The vertex shader expands the quad [-1, 1]² × (halfW, halfH) by the outer
 * stroke band plus GFX_AA_PX device pixels, so the shader computes coverage
 * from the signed distance d (negative inside) of the shape:
 *   fill   = aa(-d)                                  (if fill alpha > 0)
 *   stroke = aa(d + strokeIn) − aa(d − strokeOut)    (if strokeIn+Out > 0)
 *   out    = stroke over fill, premultiplied
 * Colours are straight RGBA8 with tint × worldAlpha already applied.
 */
export const GFX_SHAPE_BYTES = 64;
export const GS_A = 0; // f32
export const GS_B = 4; // f32
export const GS_C = 8; // f32
export const GS_D = 12; // f32
export const GS_TX = 16; // f32
export const GS_TY = 20; // f32
/** f32 half extents in shape space (ELLIPSE: rx, ry; SEGMENT: half length, half width; ARC: radius, radius). */
export const GS_HALF_W = 24;
export const GS_HALF_H = 28;
/** f32 kind parameter 0: RECT corner radius; ARC start angle (rad). */
export const GS_P0 = 32;
/** f32 kind parameter 1: ARC sweep (rad, signed). */
export const GS_P1 = 36;
/** f32 stroke band inside the edge (local px, or device px with PIXEL_LINE). */
export const GS_STROKE_IN = 40;
/** f32 stroke band outside the edge. */
export const GS_STROKE_OUT = 44;
/** u32 packed RGBA8 fill colour (GfxShapeFlag.FILL says whether there is a fill). */
export const GS_FILL = 48;
/** u32 packed RGBA8 stroke colour. */
export const GS_STROKE = 52;
/** u32: bits 0–3 GfxShapeKind, 4–7 GfxShapeFlag, 8–31 pick id (SI_PICK_SHIFT). */
export const GS_FLAGS = 56;
/** f32 reserved, written 0 (dash phase later). */
export const GS_RESERVED = 60;
export const GFX_SHAPE_F32_PER = GFX_SHAPE_BYTES / 4;

/** GS_FLAGS bits 0–3. */
export const GfxShapeKind = {
  /** Rectangle; GS_P0 = uniform corner radius (0 = sharp). */
  RECT: 0,
  /** Ellipse (circle when halfW = halfH, which takes the exact cheap path). */
  ELLIPSE: 1,
  /** Line segment from (-halfW, 0) to (halfW, 0), thickness 2·halfH; stroke colour only. */
  SEGMENT: 2,
  /** Circular arc of radius halfW, from GS_P0 over GS_P1; stroke colour only. */
  ARC: 3,
} as const;
export const GFX_KIND_MASK = 0xf;

/** GS_FLAGS bits 4–7. */
export const GfxShapeFlag = {
  /** SEGMENT / ARC ends: round cap (default butt). */
  CAP_ROUND: 1 << 4,
  /** SEGMENT / ARC ends: square cap. */
  CAP_SQUARE: 1 << 5,
  /** RECT stroke corners: round join (default miter). Same bit as CAP_ROUND. */
  JOIN_ROUND: 1 << 4,
  /** RECT stroke corners: bevel join. Same bit as CAP_SQUARE. */
  JOIN_BEVEL: 1 << 5,
  /** Stroke bands are in device px and do not scale with the transform. */
  PIXEL_LINE: 1 << 6,
  /**
   * The paint has a fill (RECT / ELLIPSE). Its region picks and masks even
   * when the fill colour's alpha is 0 (a hit area); without the flag only the
   * stroke band does. Bits 8–31 are the pick id.
   */
  FILL: 1 << 7,
} as const;

/** Width of the analytic anti-aliasing ramp, device px. */
export const GFX_AA_PX = 1;

/**
 * Mesh vertex (vertex buffer, stepMode 'vertex') — 12 B. Positions are in
 * GraphicsContext space; the node record supplies the world transform, so a
 * context's mesh is uploaded once and drawn by every node that shares it.
 */
export const GFX_MESH_VERTEX_BYTES = 12;
export const GMV_X = 0; // f32
export const GMV_Y = 4; // f32
/** u32 packed RGBA8, straight alpha: the paint colour × its alpha. */
export const GMV_COLOR = 8;

/**
 * Node record (vertex buffer, stepMode 'instance') — 32 B. One per Graphics
 * node per mesh draw run: consecutive nodes that share a context become one
 * instanced GFX_DRAW_MESH.
 */
export const GFX_NODE_BYTES = 32;
export const GN_A = 0; // f32 world affine (node world; the context transform is baked into the mesh)
export const GN_B = 4;
export const GN_C = 8;
export const GN_D = 12;
export const GN_TX = 16;
export const GN_TY = 20;
/** u32 packed RGBA8: tint × worldAlpha, multiplied into every vertex colour. */
export const GN_COLOR = 24;
/** u32: bits 0–7 reserved, 8–31 pick id. */
export const GN_FLAGS = 28;

// ─── Unified batch (M5, ARCHITECTURE §27.4) ───────────────────────────────────
/**
 * Item: one u32 per vertex of a GFX_DRAW_UNIFIED triangle list. The vertex
 * shader receives it as the index value (`vertex_index` / `gl_VertexID` of an
 * indexed draw) and pulls the record it names:
 *   bits 30–31  GfxItemKind
 *   VERTEX:     bits 0–29 = unified vertex index (GFX_UVERTEX_BYTES records)
 *   SHAPE:      bits 2–29 = SDF shape record (GFX_SHAPE_BYTES, the shape
 *               buffer), bits 0–1 = quad corner (x = bit 0, y = bit 1)
 *   SPRITE:     bits 2–29 = baked sprite record (SPRITE_INSTANCE_BYTES),
 *               bits 0–1 = quad corner
 * A quad is six items (corners 0, 1, 2, 2, 1, 3). Records stay where they
 * are; only the item stream encodes draw order, so a run of mixed shapes,
 * paths and sprites is one draw.
 */
export const GFX_ITEM_BYTES = 4;
export const GFX_ITEM_KIND_SHIFT = 30;
export const GFX_ITEM_INDEX_MASK = 0x3fffffff;
export const GFX_ITEM_CORNER_BITS = 2;
export const GFX_ITEM_CORNER_MASK = 0x3;
export const GfxItemKind = {
  VERTEX: 0,
  SHAPE: 1,
  SPRITE: 2,
  // 3 reserved
} as const;
/** Largest record index a SHAPE or SPRITE item can address (2^28 − 1). */
export const GFX_ITEM_MAX_RECORD = GFX_ITEM_INDEX_MASK >>> GFX_ITEM_CORNER_BITS;

/**
 * Unified mesh vertex — 16 B. Like GFX_MESH_VERTEX_BYTES plus the node
 * record that places it, so meshes of different contexts and nodes share
 * one non-instanced draw. Positions stay in context space: moving a node
 * rewrites its 32-byte node record only.
 */
export const GFX_UVERTEX_BYTES = 16;
export const GUV_X = 0; // f32, context space
export const GUV_Y = 4; // f32
/** u32 packed RGBA8, straight alpha (paint colour × paint alpha). */
export const GUV_COLOR = 8;
/** u32 node record index in the draw's node buffer (GFX_NODE_BYTES). */
export const GUV_NODE = 12;

/**
 * Transform table slot — 32 B (GFX_SET_TRANSFORM). A unified draw maps
 * every record through `table[transformId]` after its own affine: static
 * containers bake their subtree relative to themselves and put their world
 * affine and alpha here.
 */
export const GFX_TRANSFORM_BYTES = 32;
export const GT_A = 0; // f32
export const GT_B = 4;
export const GT_C = 8;
export const GT_D = 12;
export const GT_TX = 16;
export const GT_TY = 20;
/** f32 alpha multiplier. */
export const GT_ALPHA = 24;
/** u32 reserved, written 0. */
export const GT_RESERVED = 28;
/** Slots per renderer (WebGL2: one 16 KiB uniform block). */
export const GFX_MAX_TRANSFORMS = 512;

/** Textures one unified draw can sample (GFX_SET_TEXTURE_SLOTS). */
export const GFX_MAX_TEXTURE_SLOTS = 8;
/**
 * Baked sprite records keep the §4.1 layout; SI_FLAGS bits 3–5 (free in
 * SpriteInstanceFlag) carry the texture slot.
 */
export const GFX_SPRITE_SLOT_SHIFT = 3;
export const GFX_SPRITE_SLOT_MASK = 0x7;
