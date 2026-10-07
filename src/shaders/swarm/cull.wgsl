// cozygpu swarm culling / alive compaction.
// Appended to the compute module when the CULL render flag or allocation
// 'gpu' is set. Writes the slots of alive (and, with SWARM_CULL_OFFSCREEN,
// on-screen) objects into `visible` and their count into the indirect draw
// args; also counts every live object into swarmCounters.alive. Uses the draw
// uniform of the previous frame (the draw command is replayed after the
// compute phase), hence the margin.

struct SwarmDrawArgs {
  vertexCount: u32,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance: u32,
}

@group(2) @binding(7) var<storage, read_write> visible: array<u32>;
@group(2) @binding(8) var<storage, read_write> drawArgs: SwarmDrawArgs;
@group(2) @binding(9) var<uniform> draw: SwarmDraw;

@compute @workgroup_size(256)
fn cs_cull(@builtin(global_invocation_id) gid: vec3u) {
  let i = swarm_index(gid);
  if (i >= sim.count) { return; }
  let h = hot[i];
  if (h.life <= 0.0) { return; }
  _ = atomicAdd(&swarmCounters.alive, 1u);
  if (SWARM_CULL_OFFSCREEN) {
    let stage = draw.col0 * h.pos.x + draw.col1 * h.pos.y + draw.translate;
    let css = view.col0 * stage.x + view.col1 * stage.y + view.translate;
    let k = max(length(draw.col0), length(draw.col1)) *
      max(length(view.col0), length(view.col1));
    // half diagonal of the quad + a small margin for one frame of lag
    let r = max(abs(h.scale.x), abs(h.scale.y)) * 0.7072 * k + 8.0;
    if (css.x + r < 0.0 || css.y + r < 0.0 ||
        css.x - r > view.resolution.x || css.y - r > view.resolution.y) {
      return;
    }
  }
  let n = atomicAdd(&drawArgs.instanceCount, 1u);
  visible[n] = i;
}
