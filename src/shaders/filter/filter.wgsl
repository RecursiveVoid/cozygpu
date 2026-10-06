// cozygpu filter pass prelude (WGSL). docs/ARCHITECTURE.md §22.2, §22.3.
// The core prepends this to every composed filter fragment, so the two form
// one shader module: this half owns the full-screen triangle and the shared
// bindings, the composed half owns `FilterPass` (group 2) and `fs_main`.
//
// `uv` is a TOP-LEFT source coordinate in [0, 1] over the whole pooled
// target, identical in both languages: +texel.y moves one texel DOWN on
// WebGPU and on WebGL2. Sample through cozySample / cozySampleAux, never
// through textureSample, or a WebGL2 twin will come out flipped.

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

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var srcSampler: sampler;
// The group's untouched capture, or a displacement map (ARCHITECTURE §22.6).
@group(3) @binding(0) var aux: texture_2d<f32>;
@group(3) @binding(1) var auxSampler: sampler;

struct FilterIn {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> FilterIn {
  let u = f32((vi << 1u) & 2u);
  let v = f32(vi & 2u);
  var out: FilterIn;
  out.pos = vec4f(u * 2.0 - 1.0, 1.0 - v * 2.0, 0.0, 1.0);
  out.uv = vec2f(u, v);
  return out;
}

fn cozySample(uv: vec2f) -> vec4f {
  return textureSample(src, srcSampler, uv);
}

fn cozySampleAux(uv: vec2f) -> vec4f {
  return textureSample(aux, auxSampler, uv);
}
