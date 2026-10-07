// cozygpu graphics mesh shader (ARCHITECTURE §26.5). Vertices are in
// GraphicsContext space (layouts.ts GMV_*); each instance is one node record
// (GN_*) with the node's world affine, tint × alpha and pick id, so one mesh
// is drawn by every node that shares the context. Texture fills sample at
// uv = uvMatrix × local position (group 2, dynamic offset); untextured draws
// bind the white texture. Output is premultiplied alpha.

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

struct UvMatrix {
  ad: vec4f,  // a, b, c, d
  t: vec4f,   // tx, ty
}

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var fillTexture: texture_2d<f32>;
@group(1) @binding(1) var fillSampler: sampler;
@group(2) @binding(0) var<uniform> uvm: UvMatrix;

// layouts.ts SI_PICK_SHIFT.
const PICK_SHIFT: u32 = 8u;

struct VertexIn {
  @location(0) pos: vec2f,     // context space
  @location(1) color: vec4f,   // straight RGBA
  @location(2) ad: vec4f,      // node world a, b, c, d
  @location(3) t: vec2f,       // node world tx, ty
  @location(4) tint: vec4f,    // tint × worldAlpha
  @location(5) flags: u32,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) flags: u32,
}

@vertex
fn vs_main(v: VertexIn) -> VertexOut {
  let w = v.ad.xy * v.pos.x + v.ad.zw * v.pos.y + v.t;          // stage px
  let c = view.col0 * w.x + view.col1 * w.y + view.translate;   // css px
  var out: VertexOut;
  out.position = vec4f(
    c.x / view.resolution.x * 2.0 - 1.0,
    1.0 - c.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );
  out.uv = uvm.ad.xy * v.pos.x + uvm.ad.zw * v.pos.y + uvm.t.xy;
  out.color = v.color * v.tint;
  out.flags = v.flags;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Textures are stored premultiplied.
  let texel = textureSample(fillTexture, fillSampler, in.uv);
  return vec4f(in.color.rgb * in.color.a, in.color.a) * texel;
}

// Pick pass: every triangle of a pickable node writes (pickId, 0, 0, 0).
@fragment
fn fs_pick(in: VertexOut) -> @location(0) vec4u {
  let id = in.flags >> PICK_SHIFT;
  if (id == 0u) {
    discard;
  }
  return vec4u(id, 0u, 0u, 0u);
}
