// GLSL ES 3.0 twin of colorMatrix.wgsl.
void main() {
  vec4 p = cozySample(vUv);
  vec3 rgb = p.a > 0.0 ? p.rgb / max(p.a, 1e-5) : vec3(0.0);
  vec4 c = clamp($params.matrix * vec4(rgb, p.a) + $params.offset, vec4(0.0), vec4(1.0));
  fragColor = vec4(c.rgb * c.a, c.a);
}
