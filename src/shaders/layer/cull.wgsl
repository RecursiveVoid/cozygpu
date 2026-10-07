// cozygpu SpriteLayer GPU culling (ARCHITECTURE §28.3, LAYER_CULL).
// Three dispatches of LAYER_CULL_WORKGROUP threads keep painter's order:
//   cs_count:   each workgroup counts its visible instances → counts[g]
//   cs_scan:    one workgroup turns counts[] into exclusive offsets and
//               writes the indirect draw arguments (4, total, 0, 0)
//   cs_scatter: each workgroup writes its visible indices, in order, at
//               its offset → vis[]
// An instance is visible when its conservative bounding circle (largest
// frame radius × largest |scale|, through the layer affine and the View)
// touches the viewport grown by `margin` css px, and its COLOR alpha is not
// 0. The core prepends `const STREAMS = <LayerStreamBit mask>u;`.

struct View {
  col0: vec2f,
  col1: vec2f,
  translate: vec2f,
  resolution: vec2f,
  time: f32,
  dt: f32,
  dpr: f32,
  _pad: f32,
}

struct Cull {
  ad: vec4f,
  t: vec2f,
  margin: f32,
  count: u32,
  radius: f32,
  // workgroups per dispatch row (dispatches are 2D past 65535 groups)
  row: u32,
}

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var<storage, read> pos: array<vec2f>;
@group(1) @binding(1) var<storage, read> xf: array<vec2u>;
@group(1) @binding(2) var<storage, read> col: array<u32>;
@group(1) @binding(3) var<storage, read_write> vis: array<u32>;
@group(1) @binding(4) var<storage, read_write> counts: array<u32>;
@group(1) @binding(5) var<storage, read_write> args: array<u32>;
@group(2) @binding(0) var<uniform> c: Cull;

const WG: u32 = 256u;
var<workgroup> sums: array<u32, 256>;

fn visible(i: u32) -> bool {
  if (i >= c.count) {
    return false;
  }
  var r = c.radius;
  if ((STREAMS & 2u) != 0u) {
    let s = abs(unpack2x16float(xf[i].x));
    r *= max(s.x, s.y);
  }
  if ((STREAMS & 4u) != 0u && (col[i] >> 24u) == 0u) {
    return false;
  }
  let q = pos[i];
  let p = c.ad.xy * q.x + c.ad.zw * q.y + c.t;
  let s = view.col0 * p.x + view.col1 * p.y + view.translate;
  // Upper bound of the layer → css px stretch: Frobenius norm of View ∘ affine.
  let m0 = view.col0 * c.ad.x + view.col1 * c.ad.y;
  let m1 = view.col0 * c.ad.z + view.col1 * c.ad.w;
  let e = r * sqrt(dot(m0, m0) + dot(m1, m1)) + c.margin;
  return all(s > vec2f(-e)) && all(s < view.resolution + e);
}

fn groups() -> u32 {
  return (c.count + WG - 1u) / WG;
}

// Inclusive scan of sums[] (Hillis–Steele).
fn scan(l: u32) {
  for (var o = 1u; o < WG; o <<= 1u) {
    let v = select(0u, sums[l - min(o, l)], l >= o);
    workgroupBarrier();
    sums[l] += v;
    workgroupBarrier();
  }
}

@compute @workgroup_size(256)
fn cs_count(
  @builtin(workgroup_id) w: vec3u,
  @builtin(local_invocation_index) l: u32,
) {
  let g = w.y * c.row + w.x;
  if (g >= groups()) {
    return;
  }
  sums[l] = select(0u, 1u, visible(g * WG + l));
  workgroupBarrier();
  for (var o = WG >> 1u; o > 0u; o >>= 1u) {
    if (l < o) {
      sums[l] += sums[l + o];
    }
    workgroupBarrier();
  }
  if (l == 0u) {
    counts[g] = sums[0];
  }
}

@compute @workgroup_size(256)
fn cs_scan(@builtin(local_invocation_index) l: u32) {
  let n = groups();
  let per = (n + WG - 1u) / WG;
  let a = l * per;
  let b = min(a + per, n);
  var sum = 0u;
  for (var k = a; k < b; k++) {
    sum += counts[k];
  }
  sums[l] = sum;
  workgroupBarrier();
  scan(l);
  var off = sums[l] - sum;
  for (var k = a; k < b; k++) {
    let v = counts[k];
    counts[k] = off;
    off += v;
  }
  if (l == WG - 1u) {
    args[0] = 4u;
    args[1] = sums[l];
    args[2] = 0u;
    args[3] = 0u;
  }
}

@compute @workgroup_size(256)
fn cs_scatter(
  @builtin(workgroup_id) w: vec3u,
  @builtin(local_invocation_index) l: u32,
) {
  let g = w.y * c.row + w.x;
  if (g >= groups()) {
    return;
  }
  let i = g * WG + l;
  let v = select(0u, 1u, visible(i));
  sums[l] = v;
  workgroupBarrier();
  scan(l);
  if (v == 1u) {
    vis[counts[g] + sums[l] - 1u] = i;
  }
}
