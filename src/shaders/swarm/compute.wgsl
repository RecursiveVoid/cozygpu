// cozygpu swarm compute template. Owner: "swarm".
// The composer (src/swarm/composer.ts) prepends prelude.wgsl and replaces the
// `//@...` marker lines. Entries: cs_step, cs_spawn, cs_spawn_pop, cs_kill,
// cs_count, cs_free_init (+ cs_cull when culling or allocation 'gpu').
//
// Bindings (group 2). Every entry point uses its own bind group layout, so
// binding numbers are unique across the module:
//   0  hot  rw                               step, spawn, kill, count, cull, init
//   1  cold r                                step
//   2  sim  uniform (dynamic offset)         step, count, cull, init
//   3  params uniform                        step
//   4  cold rw                               spawn
//   5  op   uniform (dynamic offset)         spawn, kill
//   6  kill list r                           kill
//   7  visible rw                            cull
//   8  draw args rw (indirect)               cull
//   9  draw uniform                          cull
//   10 free list rw (allocation 'gpu'; a 4-byte dummy otherwise)
//   11 counters rw (SwarmCounters)
//
// SWARM_GPU_ALLOC (allocation 'gpu', ARCHITECTURE §14.3): deaths push their
// slot on the free list (atomicAdd returns the old top, so every invocation
// writes a distinct entry), spawns pop slots, kills push only live slots.

//@PARAMS

//@CONSTS

@group(0) @binding(0) var<uniform> view: View;
@group(2) @binding(0) var<storage, read_write> hot: array<SwarmHot>;
@group(2) @binding(1) var<storage, read> cold: array<SwarmCold>;
@group(2) @binding(2) var<uniform> sim: SwarmSim;
@group(2) @binding(3) var<uniform> params: Params;
@group(2) @binding(4) var<storage, read_write> coldW: array<SwarmCold>;
@group(2) @binding(5) var<uniform> op: SpawnParams;
@group(2) @binding(6) var<storage, read> killList: array<u32>;
@group(2) @binding(10) var<storage, read_write> swarmFree: array<u32>;
@group(2) @binding(11) var<storage, read_write> swarmCounters: SwarmCounters;

//@HELPERS

// Pushes a slot that just died onto the GPU free list.
fn swarm_release(i: u32) {
  let k = atomicAdd(&swarmCounters.freeTop, 1u);
  if (k < arrayLength(&swarmFree)) {
    swarmFree[k] = i;
  }
}

@compute @workgroup_size(256)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let i = swarm_index(gid);
  if (i >= sim.count) { return; }
  var p = hot[i];
  if (p.life <= 0.0) { return; }
  p.age += sim.dt;
  if (p.age >= p.life) {
    p.life = 0.0;
    hot[i] = p;
    if (SWARM_GPU_ALLOC) { swarm_release(i); }
    return;
  }
  let c = cold[i];
//@BEHAVIORS
  if (SWARM_GPU_ALLOC && p.life <= 0.0) { swarm_release(i); }
  hot[i] = p;
}

fn swarm_spawn_rand(slot: u32, base: u32, field: u32) -> f32 {
  return rand01(slot, base + field * 2654435769u);
}

// allocation 'gpu': one invocation before cs_spawn. Pops min(count, freeTop)
// slots at once; cs_spawn initialises swarmFree[spawnTop - 1 - k].
@compute @workgroup_size(256)
fn cs_spawn_pop(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u || gid.y != 0u) { return; }
  let top = atomicLoad(&swarmCounters.freeTop);
  let take = min(op.count, top);
  swarmCounters.spawnTop = top;
  swarmCounters.spawnTake = take;
  atomicStore(&swarmCounters.freeTop, top - take);
}

@compute @workgroup_size(256)
fn cs_spawn(@builtin(global_invocation_id) gid: vec3u) {
  let k = swarm_index(gid);
  var i = op.first + k;
  if (SWARM_GPU_ALLOC) {
    if (k >= swarmCounters.spawnTake) { return; }
    i = swarmFree[swarmCounters.spawnTop - 1u - k];
  } else if (k >= op.count) {
    return;
  }
  if (i >= arrayLength(&hot)) { return; }
  let base = hash32(op.seed);

  var p: SwarmHot;
  // position
  if ((op.flags & 4u) != 0u) {
    let r = op.posMax.x * sqrt(swarm_spawn_rand(i, base, 1u));
    let a = SWARM_TAU * swarm_spawn_rand(i, base, 2u);
    p.pos = op.posMin + vec2f(cos(a), sin(a)) * r;
  } else {
    p.pos = mix(
      op.posMin,
      op.posMax,
      vec2f(swarm_spawn_rand(i, base, 1u), swarm_spawn_rand(i, base, 2u)),
    );
  }
  // velocity
  let v = mix(
    op.velMin,
    op.velMax,
    vec2f(swarm_spawn_rand(i, base, 3u), swarm_spawn_rand(i, base, 4u)),
  );
  if ((op.flags & 2u) != 0u) {
    p.vel = vec2f(cos(v.y), sin(v.y)) * v.x;
  } else {
    p.vel = v;
  }
  // scale
  let sx = swarm_spawn_rand(i, base, 5u);
  if ((op.flags & 1u) != 0u) {
    let s = mix(op.scaleMin.x, op.scaleMax.x, sx);
    p.scale = vec2f(s, s);
  } else {
    p.scale = mix(
      op.scaleMin,
      op.scaleMax,
      vec2f(sx, swarm_spawn_rand(i, base, 6u)),
    );
  }
  p.rot = mix(op.rotMin, op.rotMax, swarm_spawn_rand(i, base, 7u));
  p.angVel = mix(op.angVelMin, op.angVelMax, swarm_spawn_rand(i, base, 8u));
  p.age = 0.0;
  if (op.lifeMax <= op.lifeMin) {
    p.life = op.lifeMin;
  } else {
    p.life = mix(op.lifeMin, op.lifeMax, swarm_spawn_rand(i, base, 9u));
  }
  hot[i] = p;

  // color: one t for rgb (gradient A→B), an independent t for alpha
  let ca = unpack4x8unorm(op.colorA);
  let cb = unpack4x8unorm(op.colorB);
  let rgb = mix(ca.rgb, cb.rgb, swarm_spawn_rand(i, base, 10u));
  let alpha = mix(ca.a, cb.a, swarm_spawn_rand(i, base, 11u));
  var c: SwarmCold;
  c.color = pack4x8unorm(vec4f(rgb, alpha));
  c.frame = op.frame;
  if (op.frameCount > 1u) {
    c.frame = op.frame + hash32(i ^ (base + 12u)) % op.frameCount;
  }
  // SpawnParams._pad is SP_COLD_FLAGS (behavior groups)
  c.flags = op._pad;
  c.user = op.user;
  coldW[i] = c;
}

// Kill reuses the op uniform: first, count, seed = mode (0 range, 1 list),
// frame = offset into killList. Lists are de-duplicated by the core for
// allocation 'gpu', so a live slot is pushed at most once.
@compute @workgroup_size(256)
fn cs_kill(@builtin(global_invocation_id) gid: vec3u) {
  let k = swarm_index(gid);
  if (k >= op.count) { return; }
  var i = op.first + k;
  if (op.seed == 1u) {
    i = killList[op.frame + k];
  }
  if (i >= arrayLength(&hot)) { return; }
  if (SWARM_GPU_ALLOC && hot[i].life > 0.0) { swarm_release(i); }
  hot[i].life = 0.0;
}

// Counts live objects in [0, sim.count) into swarmCounters.alive (the core
// zeroes it first). aliveCount() for 'ring' / 'manual'.
@compute @workgroup_size(256)
fn cs_count(@builtin(global_invocation_id) gid: vec3u) {
  let i = swarm_index(gid);
  if (i >= sim.count) { return; }
  if (hot[i].life > 0.0) {
    _ = atomicAdd(&swarmCounters.alive, 1u);
  }
}

// allocation 'gpu': free list = [capacity - 1 … 0] (the core sets freeTop).
@compute @workgroup_size(256)
fn cs_free_init(@builtin(global_invocation_id) gid: vec3u) {
  let i = swarm_index(gid);
  let n = arrayLength(&swarmFree);
  if (i >= n || i >= sim.count) { return; }
  swarmFree[i] = n - 1u - i;
  hot[i].life = 0.0;
}

//@CULL
