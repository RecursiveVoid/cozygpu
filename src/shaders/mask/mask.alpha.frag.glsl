#version 300 es
// cozygpu soft-mask coverage shader, GLSL ES 3.0 twin of mask.wgsl fs_alpha.
// Writes the mask's coverage into the alpha channel of a pooled target.
precision highp float;
precision highp int;

uniform sampler2D G1_B0;

in vec2 v_uv;
flat in float v_level;

layout(location = 0) out vec4 fragColor;

void main() {
  vec4 texel = texture(G1_B0, v_uv);
  fragColor = vec4(0.0, 0.0, 0.0, texel.a * v_level);
}
