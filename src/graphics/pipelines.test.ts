/**
 * Graphics pipeline descriptors against the shared layouts (layouts.ts
 * GS_* / GMV_* / GN_*) and the shader sources, plus draw → pipeline variant
 * selection (ARCHITECTURE §26.5).
 */
import type { VertexBufferLayout, VertexFormat } from '../backend/types';
import { BlendModeId } from '../backend/types';
import meshFrag from '../shaders/graphics/mesh.frag.glsl';
import meshVert from '../shaders/graphics/mesh.vert.glsl';
import meshWGSL from '../shaders/graphics/mesh.wgsl';
import shapeWGSL from '../shaders/graphics/shape.wgsl';
import unifiedFrag from '../shaders/graphics/unified.frag.glsl';
import unifiedVert from '../shaders/graphics/unified.vert.glsl';
import unifiedWGSL from '../shaders/graphics/unified.wgsl';
import { SI_PICK_SHIFT, SpriteInstanceFlag } from '../types/layouts';
import {
  GFX_AA_PX,
  GFX_KIND_MASK,
  GFX_MESH_VERTEX_BYTES,
  GFX_NODE_BYTES,
  GFX_SHAPE_BYTES,
  GfxShapeFlag,
  GfxShapeKind,
  GMV_COLOR,
  GMV_X,
  GN_A,
  GN_COLOR,
  GN_FLAGS,
  GN_TX,
  GS_A,
  GS_FILL,
  GS_FLAGS,
  GS_HALF_W,
  GS_P0,
  GS_P1,
  GS_STROKE,
  GS_STROKE_IN,
  GS_STROKE_OUT,
  GS_TX,
  GFX_ITEM_INDEX_MASK,
  GFX_SPRITE_SLOT_SHIFT,
  GfxItemKind,
} from '../types/gfxLayouts';
import { DATA_TEXTURE_WIDTH } from './dataTexture';
import {
  GFX_BLEND_MODES,
  GFX_MESH_LAYOUTS,
  GFX_SHAPE_LAYOUT,
  GFX_VARIANT_MASK,
  GFX_VARIANT_PICK,
  gfxVariant,
} from './pipelines';

const FORMAT_BYTES: Partial<Record<VertexFormat, number>> = {
  float32x2: 8,
  float32x4: 16,
  unorm8x4: 4,
  uint32: 4,
};

function spans(layout: VertexBufferLayout): [number, number][] {
  return layout.attributes
    .map(
      a => [a.offset, a.offset + FORMAT_BYTES[a.format]!] as [number, number],
    )
    .sort((a, b) => a[0] - b[0]);
}

/** `@location(n)` of the struct named `name` in a WGSL source. */
function wgslLocations(source: string, name: string): number[] {
  const body = source.slice(source.indexOf(`struct ${name} {`));
  const struct = body.slice(0, body.indexOf('}'));
  return [...struct.matchAll(/@location\((\d+)\)/g)].map(m => Number(m[1]));
}

function glslInputs(source: string): number[] {
  return [...source.matchAll(/layout\(location = (\d+)\) in /g)].map(m =>
    Number(m[1]),
  );
}

describe('graphics vertex layouts', () => {
  it('cover the 64-byte shape instance field by field', () => {
    expect(GFX_SHAPE_LAYOUT.stride).toBe(GFX_SHAPE_BYTES);
    const at = (location: number) =>
      GFX_SHAPE_LAYOUT.attributes.find(a => a.location === location)!;
    expect(at(0).offset).toBe(GS_A);
    expect(at(1).offset).toBe(GS_TX);
    // halfW, halfH, p0, p1 are contiguous; so are strokeIn, strokeOut.
    expect(at(2).offset).toBe(GS_HALF_W);
    expect(GS_P1 - GS_HALF_W).toBe(12);
    expect(GS_P0).toBe(GS_HALF_W + 8);
    expect(at(3).offset).toBe(GS_STROKE_IN);
    expect(GS_STROKE_OUT).toBe(GS_STROKE_IN + 4);
    expect(at(4).offset).toBe(GS_FILL);
    expect(at(5).offset).toBe(GS_STROKE);
    expect(at(6).offset).toBe(GS_FLAGS);
    // No overlaps; the reserved word (60..64) is the only gap.
    const s = spans(GFX_SHAPE_LAYOUT);
    for (let i = 1; i < s.length; i++) expect(s[i][0]).toBe(s[i - 1][1]);
    expect(s[s.length - 1][1]).toBe(GFX_SHAPE_BYTES - 4);
  });

  it('cover the mesh vertex and the node record', () => {
    const [vertex, node] = GFX_MESH_LAYOUTS;
    expect(vertex.stride).toBe(GFX_MESH_VERTEX_BYTES);
    expect(vertex.attributes.map(a => a.offset)).toEqual([GMV_X, GMV_COLOR]);
    expect(spans(vertex).pop()![1]).toBe(GFX_MESH_VERTEX_BYTES);
    expect(node.stride).toBe(GFX_NODE_BYTES);
    expect(node.attributes.map(a => a.offset)).toEqual([
      GN_A,
      GN_TX,
      GN_COLOR,
      GN_FLAGS,
    ]);
    expect(spans(node).pop()![1]).toBe(GFX_NODE_BYTES);
  });

  it('match the locations the WGSL and GLSL shaders declare', () => {
    const shape = GFX_SHAPE_LAYOUT.attributes.map(a => a.location);
    expect(wgslLocations(shapeWGSL, 'Shape')).toEqual(shape);
    const mesh = GFX_MESH_LAYOUTS.flatMap(l =>
      l.attributes.map(a => a.location),
    );
    expect(wgslLocations(meshWGSL, 'VertexIn')).toEqual(mesh);
    expect(glslInputs(meshVert)).toEqual(mesh);
  });

  it('shader constants mirror layouts.ts', () => {
    expect(shapeWGSL).toContain(`KIND_MASK: u32 = ${GFX_KIND_MASK}u`);
    expect(shapeWGSL).toContain(`SEGMENT: u32 = ${GfxShapeKind.SEGMENT}u`);
    expect(shapeWGSL).toContain(`ARC: u32 = ${GfxShapeKind.ARC}u`);
    expect(shapeWGSL).toContain(`ROUND: u32 = ${GfxShapeFlag.CAP_ROUND}u`);
    expect(GfxShapeFlag.JOIN_ROUND).toBe(GfxShapeFlag.CAP_ROUND);
    expect(shapeWGSL).toContain(`SQUARE: u32 = ${GfxShapeFlag.CAP_SQUARE}u`);
    expect(GfxShapeFlag.JOIN_BEVEL).toBe(GfxShapeFlag.CAP_SQUARE);
    expect(shapeWGSL).toContain(`PIXEL: u32 = ${GfxShapeFlag.PIXEL_LINE}u`);
    expect(shapeWGSL).toContain(`AA_PX: f32 = ${GFX_AA_PX.toFixed(1)}`);
    expect(shapeWGSL).toContain(`PICK_SHIFT: u32 = ${SI_PICK_SHIFT}u`);
    expect(meshWGSL).toContain(`PICK_SHIFT: u32 = ${SI_PICK_SHIFT}u`);
    expect(meshFrag).toContain(`v_flags >> ${SI_PICK_SHIFT}u`);
    // Unified batch (§27.4).
    expect(unifiedWGSL).toContain(`K_VERTEX: u32 = ${GfxItemKind.VERTEX}u`);
    expect(unifiedWGSL).toContain(`K_SHAPE: u32 = ${GfxItemKind.SHAPE}u`);
    expect(unifiedWGSL).toContain(
      `INDEX_MASK: u32 = 0x${GFX_ITEM_INDEX_MASK.toString(16)}u`,
    );
    expect(unifiedWGSL).toContain(`KIND_MASK: u32 = ${GFX_KIND_MASK}u`);
    expect(unifiedWGSL).toContain(`PIXEL: u32 = ${GfxShapeFlag.PIXEL_LINE}u`);
    expect(unifiedWGSL).toContain(`FILL: u32 = ${GfxShapeFlag.FILL}u`);
    expect(unifiedWGSL).toContain(
      `ALPHA_ONLY: u32 = ${SpriteInstanceFlag.ALPHA_ONLY}u`,
    );
    expect(unifiedWGSL).toContain(`MSDF: u32 = ${SpriteInstanceFlag.MSDF}u`);
    expect(unifiedWGSL).toContain(
      `SLOT_SHIFT: u32 = ${GFX_SPRITE_SLOT_SHIFT}u`,
    );
    expect(unifiedWGSL).toContain(`PICK_SHIFT: u32 = ${SI_PICK_SHIFT}u`);
    expect(unifiedVert).toContain(
      `item & 0x${GFX_ITEM_INDEX_MASK.toString(16)}u`,
    );
    expect(unifiedVert).toContain(`i & ${DATA_TEXTURE_WIDTH - 1}u`);
    expect(unifiedVert).toContain(`i >> ${Math.log2(DATA_TEXTURE_WIDTH)}u`);
    expect(unifiedFrag).toContain(`v_flags & ${GfxShapeFlag.PIXEL_LINE}u`);
    expect(unifiedFrag).toContain(`v_flags >> ${GFX_SPRITE_SLOT_SHIFT}u) & 7u`);
    expect(unifiedFrag).toContain(`v_flags >> ${SI_PICK_SHIFT}u`);
  });

  it('GLSL sources start with the version line (defines go after it)', () => {
    for (const source of [unifiedVert, unifiedFrag, meshVert, meshFrag]) {
      expect(source.split('\n')[0]).toBe('#version 300 es');
    }
    expect(unifiedFrag).toContain('#ifdef PICK');
    expect(unifiedFrag).toContain('defined(MASK)');
    expect(meshFrag).toContain('#ifdef PICK');
  });

  it('WGSL takes derivatives before anything can discard', () => {
    const body = shapeWGSL.slice(shapeWGSL.indexOf('fn coverage('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('dpdx(g)');
    expect(fn).not.toContain('discard');
    expect(fn.indexOf('dpdx(g)')).toBeLessThan(fn.indexOf('arc('));
    // Unified: every derivative in covers(), which each entry point calls
    // first; textures are read with explicit gradients.
    const u = unifiedWGSL.slice(unifiedWGSL.indexOf('fn covers('));
    const covers = u.slice(0, u.indexOf('\n}\n'));
    expect(covers).toContain('dpdx(g)');
    expect(covers).toContain('fwidth(md)');
    expect(covers).not.toContain('discard');
    expect(unifiedWGSL).not.toMatch(/textureSample\(/);
    for (const entry of ['fs_main', 'fs_pick', 'fs_mask']) {
      const body = unifiedWGSL.slice(unifiedWGSL.indexOf(`fn ${entry}(`));
      expect(body.split('\n')[1].trim()).toBe('let c = covers(in);');
    }
  });
});

describe('graphics pipeline selection', () => {
  it('maps blend mode ids in BlendModeId order', () => {
    for (const [mode, id] of Object.entries(BlendModeId)) {
      expect(GFX_BLEND_MODES[id]).toBe(mode);
      expect(gfxVariant(id, false, false)).toBe(id);
    }
  });

  it('draws unknown blend ids as normal', () => {
    expect(gfxVariant(99, false, false)).toBe(BlendModeId.normal);
  });

  it('mask geometry uses the stencil-write variant and never picks', () => {
    expect(gfxVariant(BlendModeId.add, true, false)).toBe(GFX_VARIANT_MASK);
    expect(gfxVariant(BlendModeId.add, true, true)).toBe(-1);
  });

  it('every other draw picks with the pick variant', () => {
    expect(gfxVariant(BlendModeId.screen, false, true)).toBe(GFX_VARIANT_PICK);
  });
});
