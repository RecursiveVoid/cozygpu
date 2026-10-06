#version 300 es
// cozygpu cheap in-batch sprite effect, GLSL ES 3.0 twin of
// sprite.effect.wgsl (ARCHITECTURE §22.7). Paired with sprite.vert.glsl.
precision highp float;
precision highp int;

uniform sampler2D G1_B0;

layout(std140) uniform G2_B0 {
  mat4 matrix;
  vec4 offset;
  uint outlineColor;
  float outlineWidth;
  float glow;
  uint flags;
} effect;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_flags;

layout(location = 0) out vec4 fragColor;

void main() {
  vec4 texel = texture(G1_B0, v_uv);
  vec3 tex = (v_flags & 1u) != 0u || texel.a <= 0.0
    ? vec3(1.0)
    : texel.rgb / max(texel.a, 1e-5);
  vec4 straight = vec4(tex * v_color.rgb, texel.a * v_color.a);
  vec4 c = straight;
  if ((effect.flags & 1u) == 0u) {
    c = clamp(effect.matrix * straight + effect.offset, vec4(0.0), vec4(1.0));
  }
  fragColor = vec4(c.rgb * c.a, c.a);
}
