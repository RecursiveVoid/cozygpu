#version 300 es
// cozygpu SpriteLayer vertex shader, GLSL ES 3.0 twin of layer.wgsl vs_main
// (ARCHITECTURE §13.3, §28.3). Instanced attributes (divisor 1): POSITION
// float32x2, XFORM uint16x4 (half floats decoded here), COLOR unorm8x4,
// USER uint32. The core inserts `#define XFORM` / `COLOR` / `USER` for the
// streams the layer has; absent streams read constants. The frame table is
// an rgba32uint data texture, two texels per frame (layerLayouts.ts LF_*).
precision highp float;
precision highp int;
precision highp usampler2D;

layout(std140) uniform G0_B0 {
  vec2 col0;
  vec2 col1;
  vec2 translate;
  vec2 resolution;
  float time;
  float dt;
  float dpr;
  float _pad;
} view;

layout(std140) uniform G3_B0 {
  vec4 ad;
  vec2 t;
  float alpha;
  uint pick;
  uint culled;
} d;

uniform usampler2D G1_B0;

layout(location = 0) in vec2 a_pos;
#ifdef XFORM
layout(location = 1) in uvec4 a_xf;
#endif
#ifdef COLOR
layout(location = 2) in vec4 a_col;
#endif
#ifdef USER
layout(location = 3) in uint a_user;
#endif

out vec2 v_uv;
out vec4 v_color;
flat out uint v_slot;
flat out uvec2 v_pick;

void main() {
  vec2 sc = vec2(1.0);
  float rot = 0.0;
  int fi = 0;
  vec4 c = vec4(1.0);
  uint user = 0u;
#ifdef XFORM
  sc = unpackHalf2x16(a_xf.x | (a_xf.y << 16));
  rot = float(a_xf.z) * 9.587379924285257e-5;
  fi = int(a_xf.w);
#endif
#ifdef COLOR
  c = a_col;
#endif
#ifdef USER
  user = a_user;
#endif
  ivec2 size = textureSize(G1_B0, 0);
  int cols = size.x >> 1;
  fi = min(fi, cols * size.y - 1);
  ivec2 at = ivec2(fi % cols * 2, fi / cols);
  vec4 uv = uintBitsToFloat(texelFetch(G1_B0, at, 0));
  uvec4 f = texelFetch(G1_B0, at + ivec2(1, 0), 0);
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 l = (q - unpackUnorm2x16(f.z)) * uintBitsToFloat(f.xy) * sc;
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 lp = vec2(l.x * cs - l.y * sn, l.x * sn + l.y * cs) + a_pos;
  vec2 p = d.ad.xy * lp.x + d.ad.zw * lp.y + d.t;
  vec2 s = view.col0 * p.x + view.col1 * p.y + view.translate;
  gl_Position = vec4(
    s.x / view.resolution.x * 2.0 - 1.0,
    1.0 - s.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );
  v_uv = mix(uv.xy, uv.zw, q);
  v_color = vec4(c.rgb, c.a * d.alpha);
  v_slot = f.w;
  v_pick = uvec2(uint(gl_InstanceID) + 1u, user);
}
