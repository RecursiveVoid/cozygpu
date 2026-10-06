// GLSL ES 3.0 twin of displacement.wgsl.
void main() {
  vec4 m = cozySampleAux(vUv);
  float dx = (m[int($params.channels.x)] - 0.5) * 2.0;
  float dy = (m[int($params.channels.y)] - 0.5) * 2.0;
  fragColor = cozySample(vUv + vec2(dx, dy) * ($params.scale * fpass.unit) * fpass.texel);
}
