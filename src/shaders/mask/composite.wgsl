// cozygpu soft-mask composite (docs/ARCHITECTURE.md §21.3).
// A full-screen triangle that multiplies the captured group (premultiplied)
// by the coverage the mask pass wrote into the alpha channel of a second
// target. `fs_invert` keeps what is outside the mask instead.

@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var srcSampler: sampler;
@group(1) @binding(2) var coverage: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  // (-1,-1), (3,-1), (-1,3) — one triangle covering the viewport.
  let x = f32((vi & 1u) << 2u) - 1.0;
  let y = f32((vi & 2u) << 1u) - 1.0;
  var out: VertexOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let color = textureSample(src, srcSampler, in.uv);
  let a = textureSample(coverage, srcSampler, in.uv).a;
  return color * a;
}

@fragment
fn fs_invert(in: VertexOut) -> @location(0) vec4f {
  let color = textureSample(src, srcSampler, in.uv);
  let a = textureSample(coverage, srcSampler, in.uv).a;
  return color * (1.0 - a);
}
