// GLSL ES 3.0 twin of blurFast.wgsl.
void main() {
  float r = max($params.strength, 0.0) * fpass.unit.x * 0.25 * (float(fpass.passIndex) + 0.5);
  vec2 o = fpass.texel * r * $params.direction;
  vec4 sum = cozySample(vUv) * 0.5;
  sum += cozySample(vUv + vec2(o.x, o.y)) * 0.125;
  sum += cozySample(vUv + vec2(o.x, -o.y)) * 0.125;
  sum += cozySample(vUv + vec2(-o.x, o.y)) * 0.125;
  sum += cozySample(vUv + vec2(-o.x, -o.y)) * 0.125;
  fragColor = sum;
}
