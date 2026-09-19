// cozygpu swarm spawn programs (WebGL2 transform feedback). Owner: "swarm".
// No inputs: gl_VertexID runs over [first, first + count) and is the slot.
// Without SWARM_SPAWN_COLD it writes hot records (h0, h1, h2); with it, cold
// records (c0). Same math as cs_spawn in compute.wgsl.

layout(std140) uniform G2_B5 {
  uint first;
  uint count;
  uint seed;
  uint frame;
  vec2 posMin;
  vec2 posMax;
  vec2 velMin;
  vec2 velMax;
  vec2 scaleMin;
  vec2 scaleMax;
  float rotMin;
  float rotMax;
  float angVelMin;
  float angVelMax;
  float lifeMin;
  float lifeMax;
  uint colorA;
  uint colorB;
  uint frameCount;
  uint flags;
  uint user;
  uint coldFlags;
} op;

float swarm_spawn_rand(uint slot, uint base, uint field) {
  return rand01(slot, base + field * 2654435769u);
}

#ifdef SWARM_SPAWN_COLD
flat out uvec4 c0;
#else
out vec4 h0;
out vec4 h1;
out vec2 h2;
#endif

void main() {
  uint i = uint(gl_VertexID);
  uint base = hash32(op.seed);
#ifdef SWARM_SPAWN_COLD
  vec4 ca = swarm_unpack(op.colorA);
  vec4 cb = swarm_unpack(op.colorB);
  vec3 rgb = mix(ca.rgb, cb.rgb, swarm_spawn_rand(i, base, 10u));
  float alpha = mix(ca.a, cb.a, swarm_spawn_rand(i, base, 11u));
  uint frame = op.frame;
  if (op.frameCount > 1u) {
    frame = op.frame + hash32(i ^ (base + 12u)) % op.frameCount;
  }
  c0 = uvec4(swarm_pack(vec4(rgb, alpha)), frame, op.coldFlags, op.user);
#else
  vec2 pos;
  if ((op.flags & 4u) != 0u) {
    float r = op.posMax.x * sqrt(swarm_spawn_rand(i, base, 1u));
    float a = SWARM_TAU * swarm_spawn_rand(i, base, 2u);
    pos = op.posMin + vec2(cos(a), sin(a)) * r;
  } else {
    pos = mix(
      op.posMin,
      op.posMax,
      vec2(swarm_spawn_rand(i, base, 1u), swarm_spawn_rand(i, base, 2u))
    );
  }
  vec2 v = mix(
    op.velMin,
    op.velMax,
    vec2(swarm_spawn_rand(i, base, 3u), swarm_spawn_rand(i, base, 4u))
  );
  vec2 vel = v;
  if ((op.flags & 2u) != 0u) {
    vel = vec2(cos(v.y), sin(v.y)) * v.x;
  }
  float sx = swarm_spawn_rand(i, base, 5u);
  vec2 scale;
  if ((op.flags & 1u) != 0u) {
    float s = mix(op.scaleMin.x, op.scaleMax.x, sx);
    scale = vec2(s, s);
  } else {
    scale = mix(op.scaleMin, op.scaleMax, vec2(sx, swarm_spawn_rand(i, base, 6u)));
  }
  float rot = mix(op.rotMin, op.rotMax, swarm_spawn_rand(i, base, 7u));
  float angVel = mix(op.angVelMin, op.angVelMax, swarm_spawn_rand(i, base, 8u));
  float life = op.lifeMin;
  if (op.lifeMax > op.lifeMin) {
    life = mix(op.lifeMin, op.lifeMax, swarm_spawn_rand(i, base, 9u));
  }
  h0 = vec4(pos, vel);
  h1 = vec4(scale, rot, angVel);
  h2 = vec2(0.0, life);
#endif
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
