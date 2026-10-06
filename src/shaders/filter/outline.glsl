// GLSL ES 3.0 twin of outline.wgsl.
void main() {
  vec4 p = cozySample(vUv);
  vec2 o = fpass.texel * (max($params.width, 0.0) * fpass.unit.x);
  vec2 k = o * 0.7071;
  float m = cozySample(vUv + vec2(o.x, 0.0)).a;
  m = max(m, cozySample(vUv - vec2(o.x, 0.0)).a);
  m = max(m, cozySample(vUv + vec2(0.0, o.y)).a);
  m = max(m, cozySample(vUv - vec2(0.0, o.y)).a);
  m = max(m, cozySample(vUv + vec2(k.x, k.y)).a);
  m = max(m, cozySample(vUv + vec2(k.x, -k.y)).a);
  m = max(m, cozySample(vUv + vec2(-k.x, k.y)).a);
  m = max(m, cozySample(vUv + vec2(-k.x, -k.y)).a);
  float edge = clamp(m - p.a, 0.0, 1.0) * $params.color.a;
  fragColor = vec4(p.rgb + $params.color.rgb * edge * (1.0 - p.a),
                   p.a + edge * (1.0 - p.a));
}
