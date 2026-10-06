// cozygpu filter composite (WGSL). docs/ARCHITECTURE.md §22.2 step 2: one
// quad that puts the chain's last target back where the group sat, in the
// pass the chain interrupted, with the group's blend mode and world alpha.

struct View {
  col0: vec2f,
  col1: vec2f,
  translate: vec2f,
  resolution: vec2f,
  time: f32,
  dt: f32,
  dpr: f32,
  _pad: f32,
}

struct Composite {
  // x, y, width, height of the filter area, css px, canvas space.
  rect: vec4f,
  // u0, v0, u1, v1 of that area inside the pooled target (top-left origin).
  uvRect: vec4f,
  alpha: f32,
  _pad: vec3f,
}

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var srcSampler: sampler;
@group(2) @binding(0) var<uniform> quad: Composite;

struct CompositeOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> CompositeOut {
  let q = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let p = quad.rect.xy + quad.rect.zw * q;
  var out: CompositeOut;
  out.pos = vec4f(
    p.x / view.resolution.x * 2.0 - 1.0,
    1.0 - p.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );
  out.uv = mix(quad.uvRect.xy, quad.uvRect.zw, q);
  return out;
}

@fragment
fn fs_main(in: CompositeOut) -> @location(0) vec4f {
  // The target holds premultiplied texels; scaling by alpha stays premultiplied.
  return textureSample(src, srcSampler, in.uv) * quad.alpha;
}
