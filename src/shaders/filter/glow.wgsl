// Blur of the alpha, additively composited under (and optionally over) the
// untouched capture bound at group 3. Passes 0 and 1 blur, pass 2 composites.
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let axis = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), fpass.passIndex == 0u);
  let on = select(0.0, 1.0, fpass.passIndex < 2u);
  let d = axis * fpass.texel * (max($params.strength, 0.0) * fpass.unit.x * on * 0.25);
  var blurred = cozySample(in.uv) * 0.227027;
  blurred += (cozySample(in.uv + d) + cozySample(in.uv - d)) * 0.1945946;
  blurred += (cozySample(in.uv + d * 2.0) + cozySample(in.uv - d * 2.0)) * 0.1216216;
  blurred += (cozySample(in.uv + d * 3.0) + cozySample(in.uv - d * 3.0)) * 0.0540540;
  blurred += (cozySample(in.uv + d * 4.0) + cozySample(in.uv - d * 4.0)) * 0.0162162;
  let base = cozySampleAux(in.uv);
  let g = clamp(blurred.a, 0.0, 1.0) * $params.color.a;
  let halo = $params.color.rgb * g;
  let inner = clamp($params.inner, 0.0, 1.0);
  let over = vec4f(
    base.rgb + halo * (1.0 - base.a) + halo * base.a * inner,
    base.a + g * (1.0 - base.a),
  );
  return select(blurred, over, fpass.passIndex == 2u);
}
