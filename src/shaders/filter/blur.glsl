// GLSL ES 3.0 twin of blur.wgsl (ARCHITECTURE §22.6).
void main() {
  vec2 axis = fpass.passIndex == 0u ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float on = dot(axis, $params.direction) > 0.0 ? 1.0 : 0.0;
  vec2 d = axis * fpass.texel * (max($params.strength, 0.0) * fpass.unit.x * on * 0.25);
  vec4 sum = cozySample(vUv) * 0.227027;
  sum += (cozySample(vUv + d) + cozySample(vUv - d)) * 0.1945946;
  sum += (cozySample(vUv + d * 2.0) + cozySample(vUv - d * 2.0)) * 0.1216216;
  sum += (cozySample(vUv + d * 3.0) + cozySample(vUv - d * 3.0)) * 0.0540540;
  sum += (cozySample(vUv + d * 4.0) + cozySample(vUv - d * 4.0)) * 0.0162162;
  fragColor = sum;
}
