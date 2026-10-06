#version 300 es
// cozygpu soft-mask composite vertex shader, GLSL ES 3.0 twin of
// composite.wgsl vs_main. WebGL2 render targets hold rows bottom-up, so the
// sampled v is not flipped here (the GL twin samples in target space).
precision highp float;

out vec2 v_uv;

void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_uv = vec2((x + 1.0) * 0.5, (y + 1.0) * 0.5);
}
