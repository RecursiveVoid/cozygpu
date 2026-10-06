#version 300 es
// cozygpu sprite pick fragment shader (ARCHITECTURE §4.7,
// §16.3). Pairs with sprite.vert.glsl; target rgba32uint. Writes
// (pickId, 0, 0, 0): instance decodes to -1 for sprites. Texels whose
// premultiplied coverage is below PICK_ALPHA_THRESHOLD (0.5) are discarded,
// and so is pick id 0 (a sprite that is not pickable), which would otherwise
// overwrite a pickable sprite drawn earlier in the same batch.
precision highp float;
precision highp int;

uniform sampler2D G1_B0;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_flags;

layout(location = 0) out uvec4 pick;

void main() {
  uint id = v_flags >> 8u;
  vec4 texel = texture(G1_B0, v_uv);
  // MSDF: a distance-field page is opaque, so glyphs pick by coverage. The
  // derivative needs uniform control flow, so it runs before the branch.
  float d = max(min(texel.r, texel.g), min(max(texel.r, texel.g), texel.b)) - 0.5;
  float sdf = clamp(d / max(fwidth(d), 1e-4) + 0.5, 0.0, 1.0);
  float cov = (v_flags & 2u) != 0u ? sdf : texel.a;
  if (id == 0u || cov * v_color.a < 0.5) discard;
  pick = uvec4(id, 0u, 0u, 0u);
}
