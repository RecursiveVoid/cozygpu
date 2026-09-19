// cozygpu sprite shader. Layout: docs/ARCHITECTURE.md §4.1.
// Geometry comes from vertex_index (triangle-strip, 4 vertices); per-instance
// data is the 40-byte SpriteInstance record. Output is premultiplied alpha.

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
@group(1) @binding(0) var spriteTexture: texture_2d<f32>;
@group(1) @binding(1) var spriteSampler: sampler;

const ALPHA_ONLY: u32 = 1u;
// Picking (ARCHITECTURE §4.7, §16.3): layouts.ts SI_PICK_SHIFT / PICK_ALPHA_THRESHOLD.
const PICK_SHIFT: u32 = 8u;
const PICK_ALPHA_THRESHOLD: f32 = 0.5;

struct Instance {
  @location(1) ad: vec4f,     // a, b, c, d
  @location(2) t: vec2f,      // tx, ty
  @location(3) color: vec4f,  // straight RGBA (tint × worldAlpha)
  @location(4) uv: vec4f,     // u0, v0, u1, v1
  @location(5) flags: u32,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) flags: u32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, inst: Instance) -> VertexOut {
  let q = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let p = inst.ad.xy * q.x + inst.ad.zw * q.y + inst.t;          // stage px
  let s = view.col0 * p.x + view.col1 * p.y + view.translate;    // css px
  var out: VertexOut;
  out.position = vec4f(
    s.x / view.resolution.x * 2.0 - 1.0,
    1.0 - s.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );
  out.uv = mix(inst.uv.xy, inst.uv.zw, q);
  out.color = inst.color;
  out.flags = inst.flags;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Textures are stored premultiplied.
  let texel = textureSample(spriteTexture, spriteSampler, in.uv);
  let a = in.color.a;
  let tinted = vec4f(texel.rgb * in.color.rgb * a, texel.a * a);
  let alphaOnly = vec4f(in.color.rgb * texel.a * a, texel.a * a);
  return select(tinted, alphaOnly, (in.flags & ALPHA_ONLY) != 0u);
}

// Pick pass: 1×1 rgba32uint target, blend none. Writes (pickId, 0, 0, 0):
// instance decodes to -1 for sprites; the user id comes from the node. Texels below the alpha threshold and sprites
// that are not pickable (pick id 0) are transparent to picking.
@fragment
fn fs_pick(in: VertexOut) -> @location(0) vec4u {
  let texel = textureSample(spriteTexture, spriteSampler, in.uv);
  let id = in.flags >> PICK_SHIFT;
  if (id == 0u || texel.a * in.color.a < PICK_ALPHA_THRESHOLD) {
    discard;
  }
  return vec4u(id, 0u, 0u, 0u);
}
