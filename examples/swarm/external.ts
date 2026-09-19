// Owner: "swarm-hooks". ?external=1 mode of the swarm example (ARCHITECTURE
// §19.4): outside WebGPU code owns the hot records and moves them with its
// own compute pass on the renderer's device; the Swarm only draws them.
// Colors, frames and user ids come from the swarm's own cold buffer, filled
// by one spawn() before the source is set. WebGPU, main thread only.
import type * as GPU from 'cozygpu';

/** SwarmHot, 40 B (ARCHITECTURE §4.2). */
const HOT_FLOATS = 10;

const MOVE_WGSL = /* wgsl */ `
struct Hot {
  pos: vec2f, vel: vec2f, scale: vec2f,
  rot: f32, angVel: f32, age: f32, life: f32,
}
struct Sim { dt: f32, width: f32, height: f32, count: u32 }
@group(0) @binding(0) var<storage, read_write> hot: array<Hot>;
@group(0) @binding(1) var<uniform> sim: Sim;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * 65535u * 256u;
  if (i >= sim.count) { return; }
  var p = hot[i];
  p.pos += p.vel * sim.dt;
  if (p.pos.x < 0.0 || p.pos.x > sim.width) { p.vel.x = -p.vel.x; }
  if (p.pos.y < 0.0 || p.pos.y > sim.height) { p.vel.y = -p.vel.y; }
  p.pos = clamp(p.pos, vec2f(0.0), vec2f(sim.width, sim.height));
  hot[i] = p;
}
`;

export interface ExternalMover {
  /** Records and submits the outside compute pass (before render()). */
  step(dt: number, width: number, height: number): void;
}

/**
 * Creates the external hot buffer, registers it and points `swarm` at it.
 * The swarm must have spawned `count` objects already (their cold records
 * are kept and drawn with the external hot records).
 */
export async function useExternalSource(
  renderer: GPU.Renderer,
  swarm: GPU.SwarmNode,
  count: number,
  width: number,
  height: number,
): Promise<ExternalMover> {
  const interop = await renderer.interop();
  if (interop.backend !== 'webgpu') {
    throw new Error('?external=1 needs the WebGPU backend');
  }
  const device = interop.device as GPUDevice;

  // Initial records, written once from the CPU.
  const init = new Float32Array(count * HOT_FLOATS);
  for (let i = 0; i < count; i++) {
    const o = i * HOT_FLOATS;
    const speed = 20 + Math.random() * 80;
    const angle = Math.random() * Math.PI * 2;
    const size = 1 + Math.random() * 2;
    init[o] = Math.random() * width;
    init[o + 1] = Math.random() * height;
    init[o + 2] = Math.cos(angle) * speed;
    init[o + 3] = Math.sin(angle) * speed;
    init[o + 4] = size;
    init[o + 5] = size;
    init[o + 9] = 1e30; // life: immortal
  }
  const hot = device.createBuffer({
    label: 'external.hot',
    size: init.byteLength,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(hot, 0, init);

  const simBytes = new ArrayBuffer(16);
  const simF32 = new Float32Array(simBytes);
  const simU32 = new Uint32Array(simBytes);
  const sim = device.createBuffer({
    label: 'external.sim',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const pipeline = await device.createComputePipelineAsync({
    label: 'external.move',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: MOVE_WGSL }),
      entryPoint: 'main',
    },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: hot } },
      { binding: 1, resource: { buffer: sim } },
    ],
  });

  const ext = interop.registerInstanceBuffer(hot, {
    layout: 'swarm-hot',
    capacity: count,
    label: 'external.hot',
  });
  swarm.setSource({ hot: ext, count });

  const groups = Math.ceil(count / 256);
  const x = Math.min(groups, 65535);
  const y = Math.ceil(groups / 65535);
  return {
    step(dt, w, h) {
      if (!ext.valid) return; // device lost: the swarm draws nothing
      simF32[0] = dt;
      simF32[1] = w;
      simF32[2] = h;
      simU32[3] = count;
      device.queue.writeBuffer(sim, 0, simBytes);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y);
      pass.end();
      // Same queue as cozygpu, submitted before render(): the frame sees it.
      device.queue.submit([encoder.finish()]);
    },
  };
}
