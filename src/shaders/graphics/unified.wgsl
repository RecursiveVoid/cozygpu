// cozygpu unified graphics shader (ARCHITECTURE §27.4). One non-instanced
// triangle list whose index buffer is an item stream: the vertex index IS the
// item (gfxLayouts.ts GFX_ITEM_*). Bits 30-31 name the kind, the rest the
// record it pulls from the storage arrays of group 1:
//   VERTEX  unified mesh vertex (GUV_*, context space) placed by its node
//           record (GN_*); flat colour.
//   SHAPE   SDF shape record (GS_*), corner in bits 0-1; coverage as in
//           shape.wgsl.
//   SPRITE  baked sprite record (§4.1 SpriteInstance), corner in bits 0-1;
//           texture slot in SI_FLAGS bits 3-5 (group 2), as sprite.wgsl.
// Every position is then mapped by the draw's transform slot (group 3) and
// the View; colours are multiplied by the slot's alpha. Output is
// premultiplied alpha.

struct View {            // @size(48)
  col0: vec2f,
  col1: vec2f,
  translate: vec2f,
  resolution: vec2f,
  time: f32,
  dt: f32,
  dpr: f32,
  _pad: f32,
}

// gfxLayouts.ts GT_*: world affine and alpha of a static container.
struct Transform {
  ad: vec4f,
  t: vec2f,
  alpha: f32,
  _r: f32,
}

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var<storage, read> shapes: array<vec4u>;   // 4 per record
@group(1) @binding(1) var<storage, read> nodes: array<vec4u>;    // 2 per record
@group(1) @binding(2) var<storage, read> verts: array<vec4u>;    // 1 per vertex
@group(1) @binding(3) var<storage, read> sprites: array<u32>;    // 10 per record
@group(2) @binding(0) var t0: texture_2d<f32>;
@group(2) @binding(1) var t1: texture_2d<f32>;
@group(2) @binding(2) var t2: texture_2d<f32>;
@group(2) @binding(3) var t3: texture_2d<f32>;
@group(2) @binding(4) var t4: texture_2d<f32>;
@group(2) @binding(5) var t5: texture_2d<f32>;
@group(2) @binding(6) var t6: texture_2d<f32>;
@group(2) @binding(7) var t7: texture_2d<f32>;
@group(2) @binding(8) var slotSampler: sampler;
@group(3) @binding(0) var<uniform> xf: Transform;

// gfxLayouts.ts GfxItemKind, GFX_ITEM_INDEX_MASK; GFX_KIND_MASK,
// GfxShapeKind, GfxShapeFlag, GFX_AA_PX; layouts.ts SpriteInstanceFlag,
// GFX_SPRITE_SLOT_SHIFT, SI_PICK_SHIFT, PICK_ALPHA_THRESHOLD.
const K_VERTEX: u32 = 0u;
const K_SHAPE: u32 = 1u;
const INDEX_MASK: u32 = 0x3fffffffu;
const KIND_MASK: u32 = 15u;
const SEGMENT: u32 = 2u;
const ROUND: u32 = 16u;
const SQUARE: u32 = 32u;
const PIXEL: u32 = 64u;
const FILL: u32 = 128u;
const AA_PX: f32 = 1.0;
const ALPHA_ONLY: u32 = 1u;
const MSDF: u32 = 2u;
const SLOT_SHIFT: u32 = 3u;
const PICK_SHIFT: u32 = 8u;
const PICK_ALPHA_THRESHOLD: f32 = 0.5;
const PI: f32 = 3.14159265;

struct VertexOut {
  @builtin(position) position: vec4f,
  // SHAPE: shape-space position; SPRITE: texture coordinates.
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) ext: vec4f,
  @location(2) @interpolate(flat) band: vec2f,
  // SHAPE: fill; VERTEX, SPRITE: the colour (straight alpha).
  @location(3) @interpolate(flat) fill: vec4f,
  @location(4) @interpolate(flat) stroke: vec4f,
  @location(5) @interpolate(flat) flags: u32,
  @location(6) @interpolate(flat) kind: u32,
}

fn f2(w: vec2u) -> vec2f {
  return bitcast<vec2f>(w);
}

@vertex
fn vs_main(@builtin(vertex_index) item: u32) -> VertexOut {
  var out: VertexOut;
  let kind = item >> 30u;
  let index = item & INDEX_MASK;
  let corner = vec2f(f32(index & 1u), f32((index >> 1u) & 1u));
  var w = vec2f(0.0);
  out.kind = kind;
  out.ext = vec4f(0.0);
  out.band = vec2f(0.0);
  out.stroke = vec4f(0.0);
  out.p = vec2f(0.0);
  if (kind == K_SHAPE) {
    let r = (index >> 2u) * 4u;
    let s0 = shapes[r];
    let s1 = shapes[r + 1u];
    let s2 = shapes[r + 2u];
    let s3 = shapes[r + 3u];
    let la = bitcast<vec4f>(s0);
    // Shape space → stage (record affine) → transform slot.
    let ad = vec4f(
      xf.ad.xy * la.x + xf.ad.zw * la.y,
      xf.ad.xy * la.z + xf.ad.zw * la.w,
    );
    let lt = f2(s1.xy);
    let t = xf.ad.xy * lt.x + xf.ad.zw * lt.y + xf.t;
    let ext = vec4f(f2(s1.zw), f2(s2.xy));
    let band = f2(s2.zw);
    let flags = s3.z;
    let skind = flags & KIND_MASK;
    let px = max(
      vec2f(
        length(view.col0 * ad.x + view.col1 * ad.y),
        length(view.col0 * ad.z + view.col1 * ad.w),
      ) * view.dpr,
      vec2f(1e-6),
    );
    var base = ext.xy;
    var reach = vec2f(band.y);
    if (skind >= SEGMENT) {
      var hw = 0.5 * (band.x + band.y);
      if (skind == SEGMENT) {
        base.y = 0.0;
        if (hw <= 0.0) {
          hw = ext.y;
        }
      }
      reach = vec2f(hw);
    }
    if ((flags & PIXEL) != 0u) {
      reach = reach / px;
    }
    let p = (corner * 2.0 - 1.0) * (base + reach + AA_PX / px);
    w = ad.xy * p.x + ad.zw * p.y + t;
    out.p = p;
    out.ext = ext;
    out.band = band;
    out.fill = unpack4x8unorm(s3.x);
    out.stroke = unpack4x8unorm(s3.y);
    out.flags = flags;
  } else if (kind == K_VERTEX) {
    let v = verts[index];
    let n = v.w * 2u;
    let n0 = bitcast<vec4f>(nodes[n]);
    let n1 = nodes[n + 1u];
    let pos = f2(v.xy);
    let lw = n0.xy * pos.x + n0.zw * pos.y + f2(n1.xy);
    w = xf.ad.xy * lw.x + xf.ad.zw * lw.y + xf.t;
    out.fill = unpack4x8unorm(v.z) * unpack4x8unorm(n1.z);
    out.flags = n1.w;
  } else {
    let r = (index >> 2u) * 10u;
    let ad = bitcast<vec4f>(
      vec4u(sprites[r], sprites[r + 1u], sprites[r + 2u], sprites[r + 3u]),
    );
    let lt = f2(vec2u(sprites[r + 4u], sprites[r + 5u]));
    let lw = ad.xy * corner.x + ad.zw * corner.y + lt;
    w = xf.ad.xy * lw.x + xf.ad.zw * lw.y + xf.t;
    out.fill = unpack4x8unorm(sprites[r + 6u]);
    out.p = mix(
      unpack2x16unorm(sprites[r + 7u]),
      unpack2x16unorm(sprites[r + 8u]),
      corner,
    );
    out.flags = sprites[r + 9u];
  }
  out.fill.a *= xf.alpha;
  out.stroke.a *= xf.alpha;
  let c = view.col0 * w.x + view.col1 * w.y + view.translate;   // css px
  out.position = vec4f(
    c.x / view.resolution.x * 2.0 - 1.0,
    1.0 - c.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );
  return out;
}

// Distance to a centred arc stroke of half width hw (caps by flag).
fn arc(p: vec2f, r: f32, start: f32, sweep: f32, hw: f32, cap: u32) -> f32 {
  let half = min(abs(sweep) * 0.5, PI);
  let mid = start + sweep * 0.5;
  let cm = cos(mid);
  let sm = sin(mid);
  let q = vec2f(abs(p.x * sm - p.y * cm), p.x * cm + p.y * sm);
  let sc = vec2f(sin(half), cos(half));
  let radial = abs(length(q) - r) - hw;
  let past = sc.y * q.x - sc.x * q.y;
  if (past <= 0.0) {
    return radial;
  }
  if (cap == ROUND) {
    return length(q - sc * r) - hw;
  }
  return max(radial, past - select(0.0, hw, cap == SQUARE));
}

// The SDF field whose gradient is the edge normal (0 for other kinds).
fn field(in: VertexOut) -> f32 {
  if (in.kind != K_SHAPE) {
    return 0.0;
  }
  let kind = in.flags & KIND_MASK;
  let p = in.p;
  let h = in.ext.xy;
  if (kind == 0u) {
    let r = clamp(in.ext.z, 0.0, min(h.x, h.y));
    let q = abs(p) - h + r;
    let m = max(q.x, q.y);
    if (r > 0.0 || (in.flags & ROUND) != 0u) {
      return length(max(q, vec2f(0.0))) + min(m, 0.0) - r;
    }
    if ((in.flags & SQUARE) != 0u) {
      return max(m, q.x + q.y);
    }
    return m;
  }
  if (kind == 1u) {
    if (h.x == h.y) {
      return length(p) - h.x;
    }
    let k1 = length(p / h);
    let k2 = length(p / (h * h));
    return k1 * (k1 - 1.0) / max(k2, 1e-6);
  }
  if (kind == SEGMENT) {
    return p.y;
  }
  return length(p) - h.x;
}

// (fill, stroke) coverage of a shape from its field g and |grad g| k.
fn coverage(in: VertexOut, g: f32, k: f32) -> vec2f {
  let kind = in.flags & KIND_MASK;
  let p = in.p;
  let h = in.ext.xy;
  let unit = select(1.0, k, (in.flags & PIXEL) != 0u);
  var d = g;
  var bandIn = in.band.x * unit;
  var bandOut = in.band.y * unit;
  if (kind >= SEGMENT) {
    var hw = 0.5 * (bandIn + bandOut);
    if (kind == SEGMENT && hw <= 0.0) {
      hw = h.y * unit;
    }
    let cap = in.flags & (ROUND | SQUARE);
    if (kind == SEGMENT) {
      let a = abs(p);
      if (cap == ROUND) {
        d = length(vec2f(max(a.x - h.x, 0.0), a.y)) - hw;
      } else {
        d = max(a.y - hw, a.x - h.x - select(0.0, hw, cap == SQUARE));
      }
    } else {
      d = arc(p, h.x, in.ext.z, in.ext.w, hw, cap);
    }
    bandIn = 1e6 * k;
    bandOut = 0.0;
  }
  let dp = d / k;
  let fill = select(clamp(0.5 - dp, 0.0, 1.0), 0.0, kind >= SEGMENT);
  let stroke = clamp(dp + bandIn / k + 0.5, 0.0, 1.0) -
    clamp(dp - bandOut / k + 0.5, 0.0, 1.0);
  return vec2f(fill, stroke);
}

// Geometric coverage of a shape for picking and stencil masks (shape.wgsl).
fn hit(in: VertexOut, cov: vec2f) -> f32 {
  let kind = in.flags & KIND_MASK;
  let stroked = kind >= SEGMENT || in.band.x + in.band.y > 0.0;
  let filled = kind < SEGMENT && (in.flags & FILL) != 0u;
  return max(select(0.0, cov.x, filled), select(0.0, cov.y, stroked));
}

// Texture slot `slot` with explicit gradients (non-uniform control flow).
fn sampleSlot(slot: u32, uv: vec2f, gx: vec2f, gy: vec2f) -> vec4f {
  switch slot {
    case 0u: { return textureSampleGrad(t0, slotSampler, uv, gx, gy); }
    case 1u: { return textureSampleGrad(t1, slotSampler, uv, gx, gy); }
    case 2u: { return textureSampleGrad(t2, slotSampler, uv, gx, gy); }
    case 3u: { return textureSampleGrad(t3, slotSampler, uv, gx, gy); }
    case 4u: { return textureSampleGrad(t4, slotSampler, uv, gx, gy); }
    case 5u: { return textureSampleGrad(t5, slotSampler, uv, gx, gy); }
    case 6u: { return textureSampleGrad(t6, slotSampler, uv, gx, gy); }
    default: { return textureSampleGrad(t7, slotSampler, uv, gx, gy); }
  }
}

// Everything that needs derivatives, taken in uniform control flow before
// any branch on the kind: (shape coverage x, y; sprite coverage; texel alpha).
struct Cov {
  shape: vec2f,
  texel: vec4f,
  msdf: f32,
}

fn covers(in: VertexOut) -> Cov {
  let g = field(in);
  let k = max(length(vec2f(dpdx(g), dpdy(g))), 1e-6);
  let gx = dpdx(in.p);
  let gy = dpdy(in.p);
  var texel = vec4f(1.0);
  if (in.kind > K_SHAPE) {
    texel = sampleSlot((in.flags >> SLOT_SHIFT) & 7u, in.p, gx, gy);
  }
  let md = max(min(texel.r, texel.g), min(max(texel.r, texel.g), texel.b)) - 0.5;
  let fw = fwidth(md);
  var out: Cov;
  out.shape = vec2f(0.0);
  if (in.kind == K_SHAPE) {
    out.shape = coverage(in, g, k);
  }
  out.texel = texel;
  out.msdf = clamp(md / max(fw, 1e-4) + 0.5, 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let c = covers(in);
  if (in.kind == K_SHAPE) {
    let f = in.fill.a * c.shape.x;
    let s = in.stroke.a * c.shape.y;
    let a = s + f * (1.0 - s);
    if (a <= 0.0) {
      discard;
    }
    return vec4f(in.stroke.rgb * s + in.fill.rgb * (f * (1.0 - s)), a);
  }
  let a = in.fill.a;
  if (in.kind == K_VERTEX) {
    return vec4f(in.fill.rgb * a, a);
  }
  // Baked sprite (sprite.wgsl): textures are stored premultiplied.
  let texel = c.texel;
  if ((in.flags & MSDF) != 0u) {
    let cov = c.msdf * a;
    return vec4f(in.fill.rgb * cov, cov);
  }
  if ((in.flags & ALPHA_ONLY) != 0u) {
    return vec4f(in.fill.rgb * texel.a * a, texel.a * a);
  }
  return vec4f(texel.rgb * in.fill.rgb * a, texel.a * a);
}

// Pick pass (rgba32uint, blend none): (pickId, 0, 0, 0) where the item covers
// at least PICK_ALPHA_THRESHOLD; pick id 0 is not pickable.
@fragment
fn fs_pick(in: VertexOut) -> @location(0) vec4u {
  let c = covers(in);
  let id = in.flags >> PICK_SHIFT;
  var cov = 1.0;
  if (in.kind == K_SHAPE) {
    cov = hit(in, c.shape);
  } else if (in.kind != K_VERTEX) {
    cov = select(c.texel.a, c.msdf, (in.flags & MSDF) != 0u) * in.fill.a;
  }
  if (id == 0u || cov < PICK_ALPHA_THRESHOLD) {
    discard;
  }
  return vec4u(id, 0u, 0u, 0u);
}

// Stencil mask geometry (GfxDrawFlag.MASK_WRITE): colour writes are off; only
// fragments covering at least half a pixel increment the stencil.
@fragment
fn fs_mask(in: VertexOut) -> @location(0) vec4f {
  let c = covers(in);
  var cov = 1.0;
  if (in.kind == K_SHAPE) {
    cov = hit(in, c.shape);
  } else if (in.kind != K_VERTEX) {
    cov = select(c.texel.a, c.msdf, (in.flags & MSDF) != 0u);
  }
  if (cov < 0.5) {
    discard;
  }
  return vec4f(1.0);
}
