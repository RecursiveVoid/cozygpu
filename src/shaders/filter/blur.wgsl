// Separable 9-tap Gaussian, two passes (x then y). ARCHITECTURE §22.6.
// A pass whose axis is switched off by `direction` runs with d 0, i.e. it
// copies: no branch, so the texture sampling stays in uniform control flow.
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let axis = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), fpass.passIndex == 0u);
  let on = select(0.0, 1.0, dot(axis, $params.direction) > 0.0);
  let d = axis * fpass.texel * (max($params.strength, 0.0) * fpass.unit.x * on * 0.25);
  var sum = cozySample(in.uv) * 0.227027;
  sum += (cozySample(in.uv + d) + cozySample(in.uv - d)) * 0.1945946;
  sum += (cozySample(in.uv + d * 2.0) + cozySample(in.uv - d * 2.0)) * 0.1216216;
  sum += (cozySample(in.uv + d * 3.0) + cozySample(in.uv - d * 3.0)) * 0.0540540;
  sum += (cozySample(in.uv + d * 4.0) + cozySample(in.uv - d * 4.0)) * 0.0162162;
  return sum;
}
