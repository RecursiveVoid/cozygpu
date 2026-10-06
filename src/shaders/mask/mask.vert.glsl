#version 300 es
// cozygpu mask vertex shader, GLSL ES 3.0 twin of mask.wgsl vs_main
// (ARCHITECTURE §21.3, §13.3). Mask quads use the 40-byte sprite instance
// record, so the attribute layout matches sprite.vert.glsl.
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
layout(location = 3) in vec4 a_color; // .a = threshold (binary) or mask alpha
layout(location = 4) in vec4 a_uv;    // u0, v0, u1, v1
layout(location = 5) in uint a_flags;

out vec2 v_uv;
flat out float v_level;

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
  v_level = a_color.a;
}
