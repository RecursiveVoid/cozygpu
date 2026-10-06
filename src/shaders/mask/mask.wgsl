// cozygpu mask shader (docs/ARCHITECTURE.md §21.3).
// Mask quads use the ordinary 40-byte sprite instance record, so the vertex
// stage is the sprite one. The alpha channel of the instance color carries
// the mask threshold (binary modes) or the mask's own alpha (soft masks).
//
//  fs_main   stencil / scissor shape: discards texels below the threshold and
//            writes no color (the pipeline disables color writes).
//  fs_alpha  soft mask: writes coverage into the alpha channel of a pooled
//            target, which the composite pass multiplies the group by.

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
@group(1) @binding(0) var maskTexture: texture_2d<f32>;
@group(1) @binding(1) var maskSampler: sampler;

struct Instance {
  @location(1) ad: vec4f,     // a, b, c, d
  @location(2) t: vec2f,      // tx, ty
  @location(3) color: vec4f,  // .a = threshold (binary) or mask alpha (soft)
  @location(4) uv: vec4f,     // u0, v0, u1, v1
  @location(5) flags: u32,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) level: f32,
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
  out.level = inst.color.a;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let texel = textureSample(maskTexture, maskSampler, in.uv);
  if (texel.a < in.level) {
    discard;
  }
  return vec4f(1.0, 1.0, 1.0, 1.0);
}

@fragment
fn fs_alpha(in: VertexOut) -> @location(0) vec4f {
  let texel = textureSample(maskTexture, maskSampler, in.uv);
  let a = texel.a * in.level;
  return vec4f(0.0, 0.0, 0.0, a);
}
