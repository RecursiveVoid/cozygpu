// cozygpu swarm fragment programs (WebGL2).
// MAIN is either the color output (premultiplied) or the pick output
// (uvec4(pickId, slot + 1, user, 0) into the rgba32uint pick target).

//@FLAGS

uniform sampler2D G1_B0;

in vec2 v_uv;
in vec4 v_color;
flat in uint v_slot;
flat in uint v_user;

vec4 swarm_color() {
//@COLOR
}

//@MAIN
