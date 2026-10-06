// Solid outline behind the opaque texels (ARCHITECTURE §22.6). On distance
// field glyphs the cheap path takes over instead (§22.7), so this program
// only runs for ordinary sprites.
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let p = cozySample(in.uv);
  let o = fpass.texel * (max($params.width, 0.0) * fpass.unit.x);
  let k = o * 0.7071;
  var m = cozySample(in.uv + vec2f(o.x, 0.0)).a;
  m = max(m, cozySample(in.uv - vec2f(o.x, 0.0)).a);
  m = max(m, cozySample(in.uv + vec2f(0.0, o.y)).a);
  m = max(m, cozySample(in.uv - vec2f(0.0, o.y)).a);
  m = max(m, cozySample(in.uv + vec2f(k.x, k.y)).a);
  m = max(m, cozySample(in.uv + vec2f(k.x, -k.y)).a);
  m = max(m, cozySample(in.uv + vec2f(-k.x, k.y)).a);
  m = max(m, cozySample(in.uv + vec2f(-k.x, -k.y)).a);
  let edge = clamp(m - p.a, 0.0, 1.0) * $params.color.a;
  // Premultiplied outline UNDER the source.
  return vec4f(p.rgb + $params.color.rgb * edge * (1.0 - p.a), p.a + edge * (1.0 - p.a));
}
