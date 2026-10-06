#version 300 es
// cozygpu filter composite vertex shader, GLSL ES 3.0 twin of composite.wgsl.
precision highp float;

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
  vec4 rect;
  vec4 uvRect;
  float alpha;
  vec3 _pad;
} quad;

out vec2 vUv;

void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 p = quad.rect.xy + quad.rect.zw * q;
  gl_Position = vec4(
    p.x / view.resolution.x * 2.0 - 1.0,
    1.0 - p.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );
  // The target's v axis runs the other way in GL (ARCHITECTURE §22.3).
  vUv = vec2(mix(quad.uvRect.x, quad.uvRect.z, q.x),
             1.0 - mix(quad.uvRect.y, quad.uvRect.w, q.y));
}
