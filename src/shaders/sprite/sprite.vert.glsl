#version 300 es
// cozygpu sprite vertex shader, GLSL ES 3.0 twin of sprite.wgsl vs_main
// (owner "webgl2"; ARCHITECTURE §4.1, §13.3). Geometry from gl_VertexID
// (triangle-strip, 4 vertices); per-instance data is the 40-byte record.
precision highp float;
precision highp int;

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

layout(location = 1) in vec4 a_ad;    // a, b, c, d
layout(location = 2) in vec2 a_t;     // tx, ty
layout(location = 3) in vec4 a_color; // straight RGBA (tint x worldAlpha)
layout(location = 4) in vec4 a_uv;    // u0, v0, u1, v1
layout(location = 5) in uint a_flags; // bits 0-7 flags, 8-31 pick id

out vec2 v_uv;
out vec4 v_color;
flat out uint v_flags;

void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 p = a_ad.xy * q.x + a_ad.zw * q.y + a_t;
  vec2 s = view.col0 * p.x + view.col1 * p.y + view.translate;
  gl_Position = vec4(
    s.x / view.resolution.x * 2.0 - 1.0,
    1.0 - s.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );
  v_uv = mix(a_uv.xy, a_uv.zw, q);
  v_color = a_color;
  v_flags = a_flags;
}
