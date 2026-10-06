// GLSL ES 3.0 twin of glow.wgsl.
void main() {
  vec2 axis = fpass.passIndex == 0u ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float on = fpass.passIndex < 2u ? 1.0 : 0.0;
  vec2 d = axis * fpass.texel * (max($params.strength, 0.0) * fpass.unit.x * on * 0.25);
  vec4 blurred = cozySample(vUv) * 0.227027;
  blurred += (cozySample(vUv + d) + cozySample(vUv - d)) * 0.1945946;
  blurred += (cozySample(vUv + d * 2.0) + cozySample(vUv - d * 2.0)) * 0.1216216;
  blurred += (cozySample(vUv + d * 3.0) + cozySample(vUv - d * 3.0)) * 0.0540540;
  blurred += (cozySample(vUv + d * 4.0) + cozySample(vUv - d * 4.0)) * 0.0162162;
  vec4 base = cozySampleAux(vUv);
  float g = clamp(blurred.a, 0.0, 1.0) * $params.color.a;
  vec3 halo = $params.color.rgb * g;
  float inner = clamp($params.inner, 0.0, 1.0);
  vec4 over = vec4(base.rgb + halo * (1.0 - base.a) + halo * base.a * inner,
                   base.a + g * (1.0 - base.a));
  fragColor = fpass.passIndex == 2u ? over : blurred;
}
