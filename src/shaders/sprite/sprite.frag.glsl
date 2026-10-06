#version 300 es
// cozygpu sprite fragment shader, GLSL ES 3.0 twin of sprite.wgsl fs_main
// Textures hold premultiplied texels; output is
// premultiplied.
precision highp float;
precision highp int;

uniform sampler2D G1_B0;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_flags;

layout(location = 0) out vec4 fragColor;

// Text (ARCHITECTURE §23.3): multi-channel distance field coverage. The
// distance scale comes from the screen-space derivative of the field itself,
// so one atlas serves every size and rotation without a per-font uniform.
// Derivatives need uniform control flow, so this runs before the flag branch.
float msdfCoverage(vec3 rgb) {
  float d = max(min(rgb.r, rgb.g), min(max(rgb.r, rgb.g), rgb.b)) - 0.5;
  return clamp(d / max(fwidth(d), 1e-4) + 0.5, 0.0, 1.0);
}

void main() {
  vec4 texel = texture(G1_B0, v_uv);
  float a = v_color.a;
  float cov = msdfCoverage(texel.rgb) * a;
  if ((v_flags & 2u) != 0u) {
    // MSDF: distance field coverage, tinted by the instance color.
    fragColor = vec4(v_color.rgb * cov, cov);
  } else if ((v_flags & 1u) != 0u) {
    // ALPHA_ONLY: tint color, texture alpha as coverage.
    fragColor = vec4(v_color.rgb * texel.a * a, texel.a * a);
  } else {
    fragColor = vec4(texel.rgb * v_color.rgb * a, texel.a * a);
  }
}
