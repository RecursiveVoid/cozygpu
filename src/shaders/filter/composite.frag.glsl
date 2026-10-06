#version 300 es
// cozygpu filter composite fragment shader, GLSL ES 3.0 twin of composite.wgsl.
precision highp float;

layout(std140) uniform G2_B0 {
  vec4 rect;
  vec4 uvRect;
  float alpha;
  vec3 _pad;
} quad;

uniform sampler2D G1_B0;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
  fragColor = texture(G1_B0, vUv) * quad.alpha;
}
