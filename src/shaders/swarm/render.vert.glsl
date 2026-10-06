// cozygpu swarm vertex program (WebGL2).
// Instanced: hot (locations 0-2) and cold (3-6) are per-instance attributes;
// the 4-vertex triangle strip comes from gl_VertexID. Same math as vs_main in
// render.wgsl. The slot is gl_InstanceID (draws always start at instance 0).

//@FLAGS

layout(std140) uniform G2_B2 {
  uint count;
  uint _pad0;
  uint _pad1;
  uint _pad2;
  vec4 rects[SWARM_GL_FRAMES];
} swarmFrames;

layout(std140) uniform G2_B3 {
  vec2 col0;
  vec2 col1;
  vec2 translate;
  float alpha;
  uint flags;
} draw;

// Over-life curves (SWARM_SET_CURVES), evaluated when RF_CURVES is set.
layout(std140) uniform G2_B6 {
  vec4 stops;
  uvec4 color;
  vec4 size;
  vec4 alpha;
} curves;

// Piecewise-linear weights of the four stops at normalized age t; at most two
// are non-zero, so a value is `dot(w, stops)`.
vec4 swarm_curve_w(float t) {
  vec4 s = curves.stops;
  float u0 = clamp((t - s.x) / max(s.y - s.x, 1e-6), 0.0, 1.0);
  float u1 = clamp((t - s.y) / max(s.z - s.y, 1e-6), 0.0, 1.0);
  float u2 = clamp((t - s.z) / max(s.w - s.z, 1e-6), 0.0, 1.0);
  return vec4(1.0 - u0, u0 - u0 * u1, u1 - u1 * u2, u2);
}

layout(location = 0) in vec4 a_h0;
layout(location = 1) in vec4 a_h1;
layout(location = 2) in vec2 a_h2;
layout(location = 3) in uint a_color;
layout(location = 4) in uint a_frame;
layout(location = 5) in uint a_flags;
layout(location = 6) in uint a_user;

out vec2 v_uv;
out vec4 v_color;
flat out uint v_slot;
flat out uint v_user;

void main() {
  v_slot = uint(gl_InstanceID);
  v_user = a_user;
  v_uv = vec2(0.0);
  v_color = vec4(0.0);
  float age = a_h2.x;
  float life = a_h2.y;
  if (life <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  uint vi = uint(gl_VertexID);
  vec2 q = vec2(float(vi & 1u), float((vi >> 1u) & 1u));
  float t = 1.0 - clamp(age / life, 0.0, 1.0);

  vec4 curveTint = vec4(1.0);
  float curveSize = 1.0;
  if (RF_CURVES) {
    vec4 cw = swarm_curve_w(1.0 - t);
    curveSize = dot(cw, curves.size);
    curveTint =
      swarm_unpack(curves.color.x) * cw.x +
      swarm_unpack(curves.color.y) * cw.y +
      swarm_unpack(curves.color.z) * cw.z +
      swarm_unpack(curves.color.w) * cw.w;
    curveTint.a *= dot(cw, curves.alpha);
  }

  vec2 size = a_h1.xy * curveSize;
  if (RF_SHRINK) {
    size *= t;
  }
  float ang = a_h1.z;
  if (RF_ALIGN) {
    ang = atan(a_h0.w, a_h0.z);
  }
  float cs = cos(ang);
  float sn = sin(ang);
  vec2 corner = (q - 0.5) * size;
  vec2 local = vec2(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs) + a_h0.xy;
  vec2 stage = draw.col0 * local.x + draw.col1 * local.y + draw.translate;
  vec2 css = view.col0 * stage.x + view.col1 * stage.y + view.translate;
  gl_Position = vec4(
    css.x / view.resolution.x * 2.0 - 1.0,
    1.0 - css.y / view.resolution.y * 2.0,
    0.0,
    1.0
  );

  vec4 color = swarm_unpack(a_color) * curveTint;
  float a = color.a * draw.alpha;
  if (RF_FADE_OUT) {
    a *= t;
  }
  v_color = vec4(color.rgb * a, a);

  if (RF_CIRCLE) {
    v_uv = q * 2.0 - 1.0;
  } else {
    uint last = max(swarmFrames.count, 1u) - 1u;
    vec4 fr = swarmFrames.rects[min(a_frame, min(last, uint(SWARM_GL_FRAMES - 1)))];
    v_uv = mix(fr.xy, fr.zw, q);
  }
}
