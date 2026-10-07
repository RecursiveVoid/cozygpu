#version 300 es
// cozygpu SpriteLayer fragment shader, GLSL ES 3.0 twin of layer.wgsl
// fs_main / fs_pick (ARCHITECTURE §28.3). The core inserts `#define PICK`
// for the pick program (rgba32uint target). Up to 8 texture slots: the slot
// varies per instance, so the gradients are taken first and every slot
// samples with them.
precision highp float;
precision highp int;

layout(std140) uniform G3_B0 {
  vec4 ad;
  vec2 t;
  float alpha;
  uint pick;
  uint culled;
} d;

uniform sampler2D G2_B0;
uniform sampler2D G2_B2;
uniform sampler2D G2_B4;
uniform sampler2D G2_B6;
uniform sampler2D G2_B8;
uniform sampler2D G2_B10;
uniform sampler2D G2_B12;
uniform sampler2D G2_B14;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_slot;

#ifdef PICK
flat in uvec2 v_pick;
layout(location = 0) out uvec4 o;
#else
layout(location = 0) out vec4 o;
#endif

void main() {
  vec2 dx = dFdx(v_uv);
  vec2 dy = dFdy(v_uv);
  vec4 t;
  switch (int(v_slot)) {
    case 1: t = textureGrad(G2_B2, v_uv, dx, dy); break;
    case 2: t = textureGrad(G2_B4, v_uv, dx, dy); break;
    case 3: t = textureGrad(G2_B6, v_uv, dx, dy); break;
    case 4: t = textureGrad(G2_B8, v_uv, dx, dy); break;
    case 5: t = textureGrad(G2_B10, v_uv, dx, dy); break;
    case 6: t = textureGrad(G2_B12, v_uv, dx, dy); break;
    case 7: t = textureGrad(G2_B14, v_uv, dx, dy); break;
    default: t = textureGrad(G2_B0, v_uv, dx, dy);
  }
  float a = v_color.a;
#ifdef PICK
  if (t.a * a < 0.5) discard;
  o = uvec4(d.pick, v_pick, 0u);
#else
  o = vec4(t.rgb * v_color.rgb * a, t.a * a);
#endif
}
