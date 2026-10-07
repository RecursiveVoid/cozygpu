#version 300 es
// cozygpu unified graphics vertex shader, GLSL ES 3.0 twin of unified.wgsl
// vs_main (ARCHITECTURE §13.3, §27.4). The item is gl_VertexID of an indexed
// draw; records come from rgba32uint data textures (group 1), 1024 texels
// per row (core.ts DATA_TEXTURE_WIDTH).
precision highp float;
precision highp int;
precision highp usampler2D;

layout(std140) uniform G0_B0 {
  vec2 col0;
  vec2 col1;
  vec2 translate;
  vec2 resolution;
  float time;
  float dt;
  float dpr;
  float _pad;
} view;

layout(std140) uniform G3_B0 {
  vec4 ad;
  vec2 t;
  float alpha;
  float _r;
} xf;

uniform usampler2D G1_B0; // shapes, 4 texels per record
uniform usampler2D G1_B2; // node records, 2 texels per record
uniform usampler2D G1_B4; // unified vertices, 1 texel each
uniform usampler2D G1_B6; // baked sprites, 10 words per record

out vec2 v_p;
flat out vec4 v_ext;
flat out vec2 v_band;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out uint v_flags;
flat out uint v_kind;

uvec4 fetch(usampler2D t, uint i) {
  return texelFetch(t, ivec2(int(i & 1023u), int(i >> 10u)), 0);
}

vec4 unpackColor(uint c) {
  return vec4(uvec4(c, c >> 8u, c >> 16u, c >> 24u) & 255u) / 255.0;
}

vec2 unpackUv(uint w) {
  return vec2(uvec2(w, w >> 16u) & 65535u) / 65535.0;
}

void main() {
  uint item = uint(gl_VertexID);
  uint kind = item >> 30u;
  uint index = item & 0x3fffffffu;
  vec2 corner = vec2(float(index & 1u), float((index >> 1u) & 1u));
  vec2 w = vec2(0.0);
  v_p = vec2(0.0);
  v_ext = vec4(0.0);
  v_band = vec2(0.0);
  v_stroke = vec4(0.0);
  v_kind = kind;
  if (kind == 1u) {
    uint r = (index >> 2u) * 4u;
    vec4 la = uintBitsToFloat(fetch(G1_B0, r));
    uvec4 s1 = fetch(G1_B0, r + 1u);
    uvec4 s2 = fetch(G1_B0, r + 2u);
    uvec4 s3 = fetch(G1_B0, r + 3u);
    vec4 ad = vec4(
      xf.ad.xy * la.x + xf.ad.zw * la.y,
      xf.ad.xy * la.z + xf.ad.zw * la.w
    );
    vec2 lt = uintBitsToFloat(s1.xy);
    vec2 t = xf.ad.xy * lt.x + xf.ad.zw * lt.y + xf.t;
    vec4 ext = vec4(uintBitsToFloat(s1.zw), uintBitsToFloat(s2.xy));
    vec2 band = uintBitsToFloat(s2.zw);
    uint flags = s3.z;
    uint skind = flags & 15u;
    vec2 px = max(
      vec2(
        length(view.col0 * ad.x + view.col1 * ad.y),
        length(view.col0 * ad.z + view.col1 * ad.w)
      ) * view.dpr,
      vec2(1e-6)
    );
    vec2 base = ext.xy;
    vec2 reach = vec2(band.y);
    if (skind >= 2u) {
      float hw = 0.5 * (band.x + band.y);
      if (skind == 2u) {
        base.y = 0.0;
        if (hw <= 0.0) hw = ext.y;
      }
      reach = vec2(hw);
    }
    if ((flags & 64u) != 0u) reach /= px;
    vec2 p = (corner * 2.0 - 1.0) * (base + reach + 1.0 / px);
    w = ad.xy * p.x + ad.zw * p.y + t;
    v_p = p;
    v_ext = ext;
    v_band = band;
    v_fill = unpackColor(s3.x);
    v_stroke = unpackColor(s3.y);
    v_flags = flags;
  } else if (kind == 0u) {
    uvec4 v = fetch(G1_B4, index);
    vec4 n0 = uintBitsToFloat(fetch(G1_B2, v.w * 2u));
    uvec4 n1 = fetch(G1_B2, v.w * 2u + 1u);
    vec2 pos = uintBitsToFloat(v.xy);
    vec2 lw = n0.xy * pos.x + n0.zw * pos.y + uintBitsToFloat(n1.xy);
    w = xf.ad.xy * lw.x + xf.ad.zw * lw.y + xf.t;
    v_fill = unpackColor(v.z) * unpackColor(n1.z);
    v_flags = n1.w;
  } else {
    // 10 words from word r: three texels from r / 4 (r % 4 is 0 or 2).
    uint r = (index >> 2u) * 10u;
    uint q = r >> 2u;
    uvec4 a = fetch(G1_B6, q);
    uvec4 b = fetch(G1_B6, q + 1u);
    uvec4 c = fetch(G1_B6, q + 2u);
    uint s[10];
    if ((r & 3u) == 0u) {
      s[0] = a.x; s[1] = a.y; s[2] = a.z; s[3] = a.w;
      s[4] = b.x; s[5] = b.y; s[6] = b.z; s[7] = b.w;
      s[8] = c.x; s[9] = c.y;
    } else {
      s[0] = a.z; s[1] = a.w;
      s[2] = b.x; s[3] = b.y; s[4] = b.z; s[5] = b.w;
      s[6] = c.x; s[7] = c.y; s[8] = c.z; s[9] = c.w;
    }
    vec4 ad = uintBitsToFloat(uvec4(s[0], s[1], s[2], s[3]));
    vec2 lw = ad.xy * corner.x + ad.zw * corner.y +
      uintBitsToFloat(uvec2(s[4], s[5]));
    w = xf.ad.xy * lw.x + xf.ad.zw * lw.y + xf.t;
    v_fill = unpackColor(s[6]);
    v_p = mix(unpackUv(s[7]), unpackUv(s[8]), corner);
    v_flags = s[9];
  }
  v_fill.a *= xf.alpha;
  v_stroke.a *= xf.alpha;
  vec2 cs = view.col0 * w.x + view.col1 * w.y + view.translate;
  gl_Position = vec4(
    cs.x / view.resolution.x * 2.0 - 1.0,
    1.0 - cs.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );
}
