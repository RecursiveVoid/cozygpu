#version 300 es
// cozygpu sprite fragment shader, GLSL ES 3.0 twin of sprite.wgsl fs_main
// (owner "webgl2"). Textures hold premultiplied texels; output is
// premultiplied.
precision highp float;
precision highp int;

uniform sampler2D G1_B0;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_flags;

layout(location = 0) out vec4 fragColor;

void main() {
  vec4 texel = texture(G1_B0, v_uv);
  float a = v_color.a;
  if ((v_flags & 1u) != 0u) {
    // ALPHA_ONLY: tint color, texture alpha as coverage.
    fragColor = vec4(v_color.rgb * texel.a * a, texel.a * a);
  } else {
    fragColor = vec4(texel.rgb * v_color.rgb * a, texel.a * a);
  }
}
