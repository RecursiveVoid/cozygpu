#version 300 es
// cozygpu mask fragment shader (stencil shape), GLSL ES 3.0 twin of
// mask.wgsl fs_main. Color writes are disabled by the pipeline; only the
// discard matters.
precision highp float;
precision highp int;

uniform sampler2D G1_B0;

in vec2 v_uv;
flat in float v_level;

layout(location = 0) out vec4 fragColor;

void main() {
  vec4 texel = texture(G1_B0, v_uv);
  if (texel.a < v_level) {
    discard;
  }
  fragColor = vec4(1.0);
}
