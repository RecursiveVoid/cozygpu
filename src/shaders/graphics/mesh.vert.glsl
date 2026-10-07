#version 300 es
// cozygpu graphics mesh vertex shader, GLSL ES 3.0 twin of mesh.wgsl
// vs_main (ARCHITECTURE §13.3, §26.5). Buffer 0: mesh vertices (context
// space); buffer 1: node records, one per instance.
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

layout(std140) uniform G2_B0 {
  vec4 ad;
  vec4 t;
} uvm;

layout(location = 0) in vec2 a_pos;   // context space
layout(location = 1) in vec4 a_color; // straight RGBA
layout(location = 2) in vec4 a_ad;    // node world a, b, c, d
layout(location = 3) in vec2 a_t;     // node world tx, ty
layout(location = 4) in vec4 a_tint;  // tint x worldAlpha
layout(location = 5) in uint a_flags; // pick id in bits 8-31

out vec2 v_uv;
out vec4 v_color;
flat out uint v_flags;

void main() {
  vec2 w = a_ad.xy * a_pos.x + a_ad.zw * a_pos.y + a_t;
  vec2 c = view.col0 * w.x + view.col1 * w.y + view.translate;
  gl_Position = vec4(
    c.x / view.resolution.x * 2.0 - 1.0,
    1.0 - c.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );
  v_uv = uvm.ad.xy * a_pos.x + uvm.ad.zw * a_pos.y + uvm.t.xy;
  v_color = a_color * a_tint;
  v_flags = a_flags;
}
