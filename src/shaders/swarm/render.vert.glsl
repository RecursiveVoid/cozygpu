// cozygpu swarm vertex program (WebGL2). Owner: "swarm".
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

void main() {
  v_slot = uint(gl_InstanceID);
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

  vec2 size = a_h1.xy;
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

  vec4 color = swarm_unpack(a_color);
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
