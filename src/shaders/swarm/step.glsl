// cozygpu swarm step program (WebGL2 transform feedback).
// Reads one hot + cold record per vertex (gl_VertexID = slot) and writes the
// next hot record (h0, h1, h2 interleaved = the 40-byte SwarmHot layout).
// Same semantics as cs_step in compute.wgsl.

layout(std140) uniform G2_B2 {
  float dt;
  float time;
  uint count;
  uint substep;
} sim;

//@PARAMS

layout(location = 0) in vec4 a_h0;
layout(location = 1) in vec4 a_h1;
layout(location = 2) in vec2 a_h2;
layout(location = 3) in uint a_color;
layout(location = 4) in uint a_frame;
layout(location = 5) in uint a_flags;
layout(location = 6) in uint a_user;

out vec4 h0;
out vec4 h1;
out vec2 h2;

//@HELPERS

void swarm_step(inout SwarmHot p, SwarmCold c, uint i) {
//@BEHAVIORS
}

void main() {
  SwarmHot p = SwarmHot(a_h0.xy, a_h0.zw, a_h1.xy, a_h1.z, a_h1.w, a_h2.x, a_h2.y);
  uint i = uint(gl_VertexID);
  if (p.life > 0.0) {
    p.age += sim.dt;
    if (p.age >= p.life) {
      p.life = 0.0;
    } else {
      SwarmCold c = SwarmCold(a_color, a_frame, a_flags, a_user);
      swarm_step(p, c, i);
    }
  }
  h0 = vec4(p.pos, p.vel);
  h1 = vec4(p.scale, p.rot, p.angVel);
  h2 = vec2(p.age, p.life);
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
