// cozygpu SpriteLayer render shader (ARCHITECTURE §28.2, §28.3).
// Vertex pulling: instance_index (through vis[] when culled) indexes the
// stream arrays. The core prepends `const STREAMS = <LayerStreamBit mask>u;`
// per pipeline, so absent streams fold to constants. Triangle strip, 4
// vertices. Output is premultiplied alpha.

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

// layerLayouts.ts LF_*: uv rect, size in px, unorm16x2 anchor, texture slot.
struct Frame {
  uv: vec4f,
  size: vec2f,
  anchor: u32,
  slot: u32,
}

// Per draw (uniform slot written from LAYER_DRAW): the layer's world
// affine, its world alpha, its pick id and whether vis[] holds the
// instances (LAYER_CULL ran this frame).
struct Draw {
  ad: vec4f,
  t: vec2f,
  alpha: f32,
  pick: u32,
  culled: u32,
}

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var<storage, read> pos: array<vec2f>;
@group(1) @binding(1) var<storage, read> xf: array<vec2u>;
@group(1) @binding(2) var<storage, read> col: array<u32>;
@group(1) @binding(3) var<storage, read> usr: array<u32>;
@group(1) @binding(4) var<storage, read> frames: array<Frame>;
@group(1) @binding(5) var<storage, read> vis: array<u32>;
@group(2) @binding(0) var t0: texture_2d<f32>;
@group(2) @binding(1) var s0: sampler;
@group(2) @binding(2) var t1: texture_2d<f32>;
@group(2) @binding(3) var s1: sampler;
@group(2) @binding(4) var t2: texture_2d<f32>;
@group(2) @binding(5) var s2: sampler;
@group(2) @binding(6) var t3: texture_2d<f32>;
@group(2) @binding(7) var s3: sampler;
@group(2) @binding(8) var t4: texture_2d<f32>;
@group(2) @binding(9) var s4: sampler;
@group(2) @binding(10) var t5: texture_2d<f32>;
@group(2) @binding(11) var s5: sampler;
@group(2) @binding(12) var t6: texture_2d<f32>;
@group(2) @binding(13) var s6: sampler;
@group(2) @binding(14) var t7: texture_2d<f32>;
@group(2) @binding(15) var s7: sampler;
@group(3) @binding(0) var<uniform> d: Draw;

// 2π / LAYER_ROTATION_UNITS.
const TURN: f32 = 9.587379924285257e-5;

struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) slot: u32,
  // original instance + 1, USER value
  @location(3) @interpolate(flat) pick: vec2u,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> Out {
  var i = ii;
  if (d.culled != 0u) {
    i = vis[ii];
  }
  var sc = vec2f(1.0);
  var rot = 0.0;
  var fi = 0u;
  var c = vec4f(1.0);
  var user = 0u;
  if ((STREAMS & 2u) != 0u) {
    let x = xf[i];
    sc = unpack2x16float(x.x);
    rot = f32(x.y & 0xffffu) * TURN;
    fi = x.y >> 16u;
  }
  if ((STREAMS & 4u) != 0u) {
    c = unpack4x8unorm(col[i]);
  }
  if ((STREAMS & 8u) != 0u) {
    user = usr[i];
  }
  let f = frames[min(fi, arrayLength(&frames) - 1u)];
  let q = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let l = (q - unpack2x16unorm(f.anchor)) * f.size * sc;
  let cs = cos(rot);
  let sn = sin(rot);
  let lp = vec2f(l.x * cs - l.y * sn, l.x * sn + l.y * cs) + pos[i];
  let p = d.ad.xy * lp.x + d.ad.zw * lp.y + d.t;
  let s = view.col0 * p.x + view.col1 * p.y + view.translate;
  var o: Out;
  o.position = vec4f(
    s.x / view.resolution.x * 2.0 - 1.0,
    1.0 - s.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );
  o.uv = mix(f.uv.xy, f.uv.zw, q);
  o.color = vec4f(c.rgb, c.a * d.alpha);
  o.slot = f.slot;
  o.pick = vec2u(i + 1u, user);
  return o;
}

// The slot varies per instance, so the gradients are taken first (uniform
// control flow) and every slot samples with them.
fn tex(slot: u32, uv: vec2f) -> vec4f {
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  switch slot {
    case 1u: { return textureSampleGrad(t1, s1, uv, dx, dy); }
    case 2u: { return textureSampleGrad(t2, s2, uv, dx, dy); }
    case 3u: { return textureSampleGrad(t3, s3, uv, dx, dy); }
    case 4u: { return textureSampleGrad(t4, s4, uv, dx, dy); }
    case 5u: { return textureSampleGrad(t5, s5, uv, dx, dy); }
    case 6u: { return textureSampleGrad(t6, s6, uv, dx, dy); }
    case 7u: { return textureSampleGrad(t7, s7, uv, dx, dy); }
    default: { return textureSampleGrad(t0, s0, uv, dx, dy); }
  }
}

@fragment
fn fs_main(in: Out) -> @location(0) vec4f {
  // Textures are stored premultiplied; the colour is straight.
  let t = tex(in.slot, in.uv);
  let a = in.color.a;
  return vec4f(t.rgb * in.color.rgb * a, t.a * a);
}

// Pick pass: (pickId, instance + 1, user, 0); texels under
// PICK_ALPHA_THRESHOLD are transparent to picking.
@fragment
fn fs_pick(in: Out) -> @location(0) vec4u {
  let t = tex(in.slot, in.uv);
  if (t.a * in.color.a < 0.5) {
    discard;
  }
  return vec4u(d.pick, in.pick.x, in.pick.y, 0u);
}
