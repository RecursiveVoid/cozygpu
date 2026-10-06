// 4x5 color matrix on STRAIGHT alpha, then back to premultiplied.
// The same matrix compiles into the sprite batch when the chain is cheap
// (ARCHITECTURE §22.7); this program is what runs when it does not.
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let p = cozySample(in.uv);
  let straight = vec4f(select(vec3f(0.0), p.rgb / max(p.a, 1e-5), p.a > 0.0), p.a);
  let c = clamp($params.matrix * straight + $params.offset, vec4f(0.0), vec4f(1.0));
  return vec4f(c.rgb * c.a, c.a);
}
