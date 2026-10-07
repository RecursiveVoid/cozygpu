// cozygpu graphics SDF shape shader (ARCHITECTURE §26.5). One instance per
// shape (layouts.ts GFX_SHAPE_BYTES, GS_*): the vertex shader expands a quad
// around the shape, the fragment shader evaluates its signed distance d
// (negative inside, shape units) and composites stroke over fill.
//
// Kinds (GfxShapeKind): RECT (corner radius p0; miter, round or bevel
// corners), ELLIPSE, SEGMENT (centre line (-halfW, 0)..(halfW, 0)) and ARC
// (radius halfW, from p0 over p1). SEGMENT and ARC are centred strokes of
// width strokeIn + strokeOut in the stroke colour (a SEGMENT with no band
// uses halfH as its half width). PIXEL_LINE widths are device px.

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

@group(0) @binding(0) var<uniform> view: View;

// layouts.ts GFX_KIND_MASK, GfxShapeKind, GfxShapeFlag, GFX_AA_PX, SI_PICK_SHIFT.
const KIND_MASK: u32 = 15u;
const SEGMENT: u32 = 2u;
const ARC: u32 = 3u;
const ROUND: u32 = 16u;   // CAP_ROUND / JOIN_ROUND
const SQUARE: u32 = 32u;  // CAP_SQUARE / JOIN_BEVEL
const PIXEL: u32 = 64u;
const FILL: u32 = 128u;
const AA_PX: f32 = 1.0;
const PICK_SHIFT: u32 = 8u;
const PI: f32 = 3.14159265;

struct Shape {
  @location(0) ad: vec4f,      // a, b, c, d
  @location(1) t: vec2f,       // tx, ty
  @location(2) ext: vec4f,     // halfW, halfH, p0, p1
  @location(3) band: vec2f,    // strokeIn, strokeOut
  @location(4) fill: vec4f,    // straight RGBA
  @location(5) stroke: vec4f,  // straight RGBA
  @location(6) flags: u32,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) ext: vec4f,
  @location(2) @interpolate(flat) band: vec2f,
  @location(3) @interpolate(flat) fill: vec4f,
  @location(4) @interpolate(flat) stroke: vec4f,
  @location(5) @interpolate(flat) flags: u32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, s: Shape) -> VertexOut {
  let kind = s.flags & KIND_MASK;
  // Device px per shape unit along the shape's axes.
  let px = max(
    vec2f(
      length(view.col0 * s.ad.x + view.col1 * s.ad.y),
      length(view.col0 * s.ad.z + view.col1 * s.ad.w),
    ) * view.dpr,
    vec2f(1e-6),
  );
  // How far the paint reaches past the shape (a segment is a centre line).
  var base = s.ext.xy;
  var reach = vec2f(s.band.y);
  if (kind >= SEGMENT) {
    var hw = 0.5 * (s.band.x + s.band.y);
    if (kind == SEGMENT) {
      base.y = 0.0;
      if (hw <= 0.0) {
        hw = s.ext.y;
      }
    }
    reach = vec2f(hw);
  }
  if ((s.flags & PIXEL) != 0u) {
    reach = reach / px;
  }
  let e = base + reach + AA_PX / px;
  let q = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let p = q * e;
  let w = s.ad.xy * p.x + s.ad.zw * p.y + s.t;                  // stage px
  let c = view.col0 * w.x + view.col1 * w.y + view.translate;   // css px
  var out: VertexOut;
  out.position = vec4f(
    c.x / view.resolution.x * 2.0 - 1.0,
    1.0 - c.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );
  out.p = p;
  out.ext = s.ext;
  out.band = s.band;
  out.fill = s.fill;
  out.stroke = s.stroke;
  out.flags = s.flags;
  return out;
}

// Distance to a centred arc stroke of half width hw (caps by flag).
fn arc(p: vec2f, r: f32, start: f32, sweep: f32, hw: f32, cap: u32) -> f32 {
  let half = min(abs(sweep) * 0.5, PI);
  let mid = start + sweep * 0.5;
  // Rotate the arc's middle onto +y and fold across the y axis.
  let cm = cos(mid);
  let sm = sin(mid);
  let q = vec2f(abs(p.x * sm - p.y * cm), p.x * cm + p.y * sm);
  let sc = vec2f(sin(half), cos(half));
  let radial = abs(length(q) - r) - hw;
  // Signed distance past the end line (positive outside the sweep).
  let past = sc.y * q.x - sc.x * q.y;
  if (past <= 0.0) {
    return radial;
  }
  if (cap == ROUND) {
    return length(q - sc * r) - hw;
  }
  return max(radial, past - select(0.0, hw, cap == SQUARE));
}

// (fill, stroke) coverage. Derivatives are taken before any branch that
// could leave the quad's control flow non-uniform (WGSL uniformity).
fn coverage(in: VertexOut) -> vec2f {
  let kind = in.flags & KIND_MASK;
  let p = in.p;
  let h = in.ext.xy;
  // g: a band-independent field whose gradient is the edge normal.
  var g = 0.0;
  if (kind == 0u) {
    let r = clamp(in.ext.z, 0.0, min(h.x, h.y));
    let q = abs(p) - h + r;
    let m = max(q.x, q.y);
    g = m; // miter: Chebyshev outside the box
    if (r > 0.0 || (in.flags & ROUND) != 0u) {
      g = length(max(q, vec2f(0.0))) + min(m, 0.0) - r;
    } else if ((in.flags & SQUARE) != 0u) {
      g = max(m, q.x + q.y); // bevel: 45° clip
    }
  } else if (kind == 1u) {
    if (h.x == h.y) {
      g = length(p) - h.x;
    } else {
      let k1 = length(p / h);
      let k2 = length(p / (h * h));
      g = k1 * (k1 - 1.0) / max(k2, 1e-6);
    }
  } else if (kind == SEGMENT) {
    g = p.y;
  } else {
    g = length(p) - h.x;
  }
  // Shape units per device px across the edge.
  let k = max(length(vec2f(dpdx(g), dpdy(g))), 1e-6);
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
    // The whole body is "stroke": aa(d + inf) - aa(d) = aa(-d).
    bandIn = 1e6 * k;
    bandOut = 0.0;
  }
  let dp = d / k;
  let fill = select(clamp(0.5 - dp, 0.0, 1.0), 0.0, kind >= SEGMENT);
  let stroke = clamp(dp + bandIn / k + 0.5, 0.0, 1.0) -
    clamp(dp - bandOut / k + 0.5, 0.0, 1.0);
  return vec2f(fill, stroke);
}

// Geometric coverage for picking and stencil masks: the fill counts wherever
// the paint has one (GfxShapeFlag.FILL, so a fill with alpha 0 is a hit
// area); a stroke counts wherever it has a band.
fn hit(in: VertexOut, cov: vec2f) -> f32 {
  let kind = in.flags & KIND_MASK;
  let stroked = kind >= SEGMENT || in.band.x + in.band.y > 0.0;
  let filled = kind < SEGMENT && (in.flags & FILL) != 0u;
  return max(select(0.0, cov.x, filled), select(0.0, cov.y, stroked));
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let cov = coverage(in);
  let f = in.fill.a * cov.x;
  let s = in.stroke.a * cov.y;
  let a = s + f * (1.0 - s);
  if (a <= 0.0) {
    discard;
  }
  return vec4f(in.stroke.rgb * s + in.fill.rgb * (f * (1.0 - s)), a);
}

// Pick pass (rgba32uint, blend none): (pickId, 0, 0, 0) where the shape
// covers at least PICK_ALPHA_THRESHOLD (0.5); pick id 0 is not pickable.
@fragment
fn fs_pick(in: VertexOut) -> @location(0) vec4u {
  let cov = coverage(in);
  let id = in.flags >> PICK_SHIFT;
  if (id == 0u || hit(in, cov) < 0.5) {
    discard;
  }
  return vec4u(id, 0u, 0u, 0u);
}

// Stencil mask geometry (GfxDrawFlag.MASK_WRITE): colour writes are off; only
// fragments covering at least half a pixel increment the stencil.
@fragment
fn fs_mask(in: VertexOut) -> @location(0) vec4f {
  let cov = coverage(in);
  if (hit(in, cov) < 0.5) {
    discard;
  }
  return vec4f(1.0);
}
