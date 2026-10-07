#version 300 es
// cozygpu graphics mesh fragment shader, GLSL ES 3.0 twin of mesh.wgsl
// fs_main; with `#define PICK` (inserted by the core) it is fs_pick.
// Textures hold premultiplied texels; output is premultiplied.
precision highp float;
precision highp int;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_flags;

#ifdef PICK
layout(location = 0) out uvec4 pick;

void main() {
  uint id = v_flags >> 8u;
  if (id == 0u) discard;
  pick = uvec4(id, 0u, 0u, 0u);
}
#else
uniform sampler2D G1_B0;

layout(location = 0) out vec4 fragColor;

void main() {
  fragColor = vec4(v_color.rgb * v_color.a, v_color.a) * texture(G1_B0, v_uv);
}
#endif
