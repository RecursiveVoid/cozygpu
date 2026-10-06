// Offsets each texel by two channels of the map bound at group 3
// (ARCHITECTURE §22.6). `channels` holds the channel indices (r=0..a=3),
// `scale` the displacement in physical px.
@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  var m = cozySampleAux(in.uv);
  let dx = (m[i32($params.channels.x)] - 0.5) * 2.0;
  let dy = (m[i32($params.channels.y)] - 0.5) * 2.0;
  return cozySample(in.uv + vec2f(dx, dy) * ($params.scale * fpass.unit) * fpass.texel);
}
