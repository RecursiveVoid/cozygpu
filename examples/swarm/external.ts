// ?external=1 mode of the swarm example (ARCHITECTURE §19.4): outside WebGPU
// code owns the hot records and moves them with its own compute pass on the
// renderer's device; the Swarm only draws them. Colors, frames and user ids
// come from the swarm's own cold buffer, filled by one spawn() before the
// source is set. WebGPU, main thread only.
//
// Device loss is part of the contract here: every GPU object below belongs to
// the lost device and the core drops the registration with it, so `arm()` runs
// again on the new device and points the swarm at a fresh buffer. The swarm's
// own cold records are emptied by the same loss; the example refills them from
// its `onRestore` (one spawn), which is what makes the re-armed draw visible.
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
  /** False while the source is being re-armed after a device loss. */
  readonly live: boolean;
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

  // Initial records, written once from the CPU and reused by every arm().
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
  const simBytes = new ArrayBuffer(16);
  const simF32 = new Float32Array(simBytes);
  const simU32 = new Uint32Array(simBytes);
  const groups = Math.ceil(count / 256);
  const dispatchX = Math.min(groups, 65535);
  const dispatchY = Math.ceil(groups / 65535);

  // Everything below belongs to one device generation; arm() replaces it all.
  let device: GPUDevice | null = null;
  let sim: GPUBuffer;
  let pipeline: GPUComputePipeline;
  let group: GPUBindGroup;
  let ext: GPU.ExternalInstanceBuffer | null = null;
  let arming = false;

  async function arm(): Promise<void> {
    const gpu = interop.device as GPUDevice;
    const hot = gpu.createBuffer({
      label: 'external.hot',
      size: init.byteLength,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    try {
      gpu.queue.writeBuffer(hot, 0, init);
      sim = gpu.createBuffer({
        label: 'external.sim',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      pipeline = await gpu.createComputePipelineAsync({
        label: 'external.move',
        layout: 'auto',
        compute: {
          module: gpu.createShaderModule({ code: MOVE_WGSL }),
          entryPoint: 'main',
        },
      });
      group = gpu.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: hot } },
          { binding: 1, resource: { buffer: sim } },
        ],
      });
      const registered = interop.registerInstanceBuffer(hot, {
        layout: 'swarm-hot',
        capacity: count,
        label: 'external.hot',
      });
      // Last, so a swarm that is mid-restore never points at a half-built
      // source: setSource takes effect on the next frame either way.
      swarm.setSource({ hot: registered, count });
      device = gpu;
      ext = registered;
    } catch (err) {
      // The renderer may still be swapping devices, which makes the
      // registration reject with DEVICE_LOST; `device` is left as it was, so
      // the next step() tries again. Anything else is a real bug.
      hot.destroy();
      if ((err as { code?: string }).code !== 'DEVICE_LOST') throw err;
    }
  }

  await arm();

  return {
    get live(): boolean {
      return ext !== null && ext.valid;
    },
    step(dt, w, h) {
      if (ext === null || !ext.valid) {
        // Device lost. The renderer restores it and bumps the interop loss
        // epoch, which is when `interop.device` starts handing out the new
        // device; re-arm then, once. Until it lands the swarm draws its own
        // records, which the example's onRestore has already refilled.
        const next = interop.device as GPUDevice | null;
        if (!arming && next !== null && next !== device) {
          arming = true;
          ext = null;
          arm()
            .catch((err: unknown) => {
              console.error('external: re-arm after device loss failed', err);
            })
            .finally(() => {
              arming = false;
            });
        }
        return;
      }
      const gpu = device!;
      simF32[0] = dt;
      simF32[1] = w;
      simF32[2] = h;
      simU32[3] = count;
      gpu.queue.writeBuffer(sim, 0, simBytes);
      const encoder = gpu.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(dispatchX, dispatchY);
      pass.end();
      // Same queue as cozygpu, submitted before render(): the frame sees it.
      gpu.queue.submit([encoder.finish()]);
    },
  };
}
