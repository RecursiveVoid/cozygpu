#version 300 es
// cozygpu filter pass vertex shader, GLSL ES 3.0 twin of filter.wgsl vs_main
// (ARCHITECTURE §13.3, §22.3). One full-screen triangle from gl_VertexID;
// the fragment half is composed on the front and declares the bindings.
precision highp float;

out vec2 vUv;

void main() {
  float u = float((gl_VertexID << 1) & 2);
  float v = float(gl_VertexID & 2);
  gl_Position = vec4(u * 2.0 - 1.0, 1.0 - v * 2.0, 0.0, 1.0);
  vUv = vec2(u, v);
}
