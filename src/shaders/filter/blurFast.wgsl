// Dual Kawase: four cheap 5-tap passes with a growing radius, far cheaper
// than a Gaussian at large radii (ARCHITECTURE §22.6, `quality: 'fast'`).
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let r = max($params.strength, 0.0) * fpass.unit.x * 0.25 * (f32(fpass.passIndex) + 0.5);
  let o = fpass.texel * r * $params.direction;
  var sum = cozySample(in.uv) * 0.5;
  sum += cozySample(in.uv + vec2f(o.x, o.y)) * 0.125;
  sum += cozySample(in.uv + vec2f(o.x, -o.y)) * 0.125;
  sum += cozySample(in.uv + vec2f(-o.x, o.y)) * 0.125;
  sum += cozySample(in.uv + vec2f(-o.x, -o.y)) * 0.125;
  return sum;
}
