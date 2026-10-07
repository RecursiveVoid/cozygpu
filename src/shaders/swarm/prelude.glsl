// cozygpu swarm GLSL ES 3.0 prelude (WebGL2).
// Mirrors prelude.wgsl; the composer puts `#version 300 es` (and defines)
// in front. Naming follows ARCHITECTURE §13.3: uniform blocks G{group}_B{binding}.
precision highp float;
precision highp int;

struct SwarmHot {
  vec2 pos;
  vec2 vel;
  vec2 scale;
  float rot;
  float angVel;
  float age;
  float life;
};

struct SwarmCold {
  uint color;
  uint frame;
  uint flags;
  uint user;
};

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

const float SWARM_IMMORTAL = 3.4e38;
const float SWARM_TAU = 6.283185307179586;

// PCG-ish integer hash (public helper for behaviors; same as WGSL).
uint hash32(uint x) {
  uint h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

// Uniform random in [0, 1] from a slot index and a salt (public helper).
float rand01(uint i, uint salt) {
  return float(hash32(i ^ hash32(salt))) / 4294967295.0;
}

// WGSL unpack4x8unorm / pack4x8unorm.
vec4 swarm_unpack(uint c) {
  return vec4(
    float(c & 255u),
    float((c >> 8u) & 255u),
    float((c >> 16u) & 255u),
    float(c >> 24u)
  ) / 255.0;
}

uint swarm_pack(vec4 v) {
  uvec4 b = uvec4(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5));
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}
