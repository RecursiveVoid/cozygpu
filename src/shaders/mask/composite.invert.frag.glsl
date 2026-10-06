#version 300 es
// cozygpu soft-mask composite (inverted), twin of composite.wgsl fs_invert.
precision highp float;

uniform sampler2D G1_B0;
uniform sampler2D G1_B2;

in vec2 v_uv;
layout(location = 0) out vec4 fragColor;

void main() {
  vec4 color = texture(G1_B0, v_uv);
  float a = texture(G1_B2, v_uv).a;
  fragColor = color * (1.0 - a);
}
