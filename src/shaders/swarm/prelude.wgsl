// cozygpu swarm prelude: shared structs + helpers.
// Struct layouts are normative (src/types/layouts.ts, ARCHITECTURE §4).

// @size 40
struct SwarmHot {
  pos: vec2f,
  vel: vec2f,
  scale: vec2f,
  rot: f32,
  angVel: f32,
  age: f32,
  life: f32,
}

// @size 16
struct SwarmCold {
  color: u32,
  frame: u32,
  flags: u32,
  user: u32,
}

// @size 48
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

// @size 16
struct SwarmSim {
  dt: f32,
  time: f32,
  count: u32,
  substep: u32,
}

// @size 112
struct SpawnParams {
  first: u32,
  count: u32,
  seed: u32,
  frame: u32,
  posMin: vec2f,
  posMax: vec2f,
  velMin: vec2f,
  velMax: vec2f,
  scaleMin: vec2f,
  scaleMax: vec2f,
  rotMin: f32,
  rotMax: f32,
  angVelMin: f32,
  angVelMax: f32,
  lifeMin: f32,
  lifeMax: f32,
  colorA: u32,
  colorB: u32,
  frameCount: u32,
  flags: u32,
  user: u32,
  // M2 coldFlags (SP_COLD_FLAGS): written to cold.flags (group bits 8-15).
  // Keeps its M1 name: src/types/layouts.test.ts pins it.
  _pad: u32,
}

// @size 32
struct SwarmDraw {
  col0: vec2f,
  col1: vec2f,
  translate: vec2f,
  alpha: f32,
  flags: u32,
}

// @size 16. allocation 'gpu' free-list counters; alive count for every mode.
struct SwarmCounters {
  freeTop: atomic<u32>,
  alive: atomic<u32>,
  // snapshot taken by cs_spawn_pop for the following cs_spawn dispatch
  spawnTop: u32,
  spawnTake: u32,
}

const SWARM_IMMORTAL: f32 = 3.4e38;
const SWARM_TAU: f32 = 6.283185307179586;

// PCG-ish integer hash (public helper for behaviors).
fn hash32(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

// Uniform random in [0, 1] from a slot index and a salt (public helper).
fn rand01(i: u32, salt: u32) -> f32 {
  return f32(hash32(i ^ hash32(salt))) / 4294967295.0;
}

// 2D dispatch: x covers up to 65535 workgroups of 256.
fn swarm_index(gid: vec3u) -> u32 {
  return gid.x + gid.y * 16776960u; // 65535 * 256
}
