#version 300 es
// cozygpu graphics SDF shape vertex shader, GLSL ES 3.0 twin of shape.wgsl
// vs_main (ARCHITECTURE §13.3, §26.5). Geometry from gl_VertexID
// (triangle-strip, 4 vertices); per-instance data is the 64-byte shape.
precision highp float;
precision highp int;

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

layout(location = 0) in vec4 a_ad;     // a, b, c, d
layout(location = 1) in vec2 a_t;      // tx, ty
layout(location = 2) in vec4 a_ext;    // halfW, halfH, p0, p1
layout(location = 3) in vec2 a_band;   // strokeIn, strokeOut
layout(location = 4) in vec4 a_fill;   // straight RGBA
layout(location = 5) in vec4 a_stroke; // straight RGBA
layout(location = 6) in uint a_flags;  // kind, flags, pick id

out vec2 v_p;
flat out vec4 v_ext;
flat out vec2 v_band;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out uint v_flags;

void main() {
  uint kind = a_flags & 15u;
  vec2 px = max(
    vec2(
      length(view.col0 * a_ad.x + view.col1 * a_ad.y),
      length(view.col0 * a_ad.z + view.col1 * a_ad.w)
    ) * view.dpr,
    vec2(1e-6)
  );
  // How far the paint reaches past the shape (a segment is a centre line).
  vec2 base = a_ext.xy;
  vec2 reach = vec2(a_band.y);
  if (kind >= 2u) {
    float hw = 0.5 * (a_band.x + a_band.y);
    if (kind == 2u) {
      base.y = 0.0;
      if (hw <= 0.0) hw = a_ext.y;
    }
    reach = vec2(hw);
  }
  if ((a_flags & 64u) != 0u) reach /= px;
  vec2 e = base + reach + 1.0 / px;
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vec2 p = q * e;
  vec2 w = a_ad.xy * p.x + a_ad.zw * p.y + a_t;
  vec2 c = view.col0 * w.x + view.col1 * w.y + view.translate;
  gl_Position = vec4(
    c.x / view.resolution.x * 2.0 - 1.0,
    1.0 - c.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );
  v_p = p;
  v_ext = a_ext;
  v_band = a_band;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_flags = a_flags;
}
