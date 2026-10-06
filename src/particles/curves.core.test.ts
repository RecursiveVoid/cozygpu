/**
 * SWARM_SET_CURVES reaches the per-swarm curve uniform in both cores
 * (ARCHITECTURE §24.4). The front side is covered by ./Particles.test.ts.
 */
import {
  FakeBackend,
  FakeBuffer,
  FAKE_CAPS,
} from '../renderer/testing/fakeBackend';
import type { Capabilities } from '../backend/types';
import { Op } from '../commands/opcodes';
import type { CoreContext, CoreFrameState } from '../types/core';
import { SCV_COLOR, SCV_SIZE, SWARM_CURVE_BYTES } from '../types/layouts';
import { FakeEncoder, FakeReader } from '../swarm/__fakes__/commands';
import { createSwarmCoreSystem } from '../swarm/core';
import { composeSwarmShaders } from '../swarm/composer';
import { installGlslComposer } from '../swarm/glsl';
import { identityCurves } from './emitter';

installGlslComposer();

const GL_CAPS: Capabilities = {
  ...FAKE_CAPS,
  backend: 'webgl2',
  shaderLanguage: 'glsl300es',
  compute: false,
  storageBuffers: false,
  vertexStorage: false,
  transformFeedback: true,
};

function harness(caps: Capabilities) {
  const backend = new FakeBackend(800, 600);
  backend.caps = { ...caps };
  const res = { label: 'r', destroy() {} };
  const ctx = {
    backend,
    viewLayout: res,
    viewBindGroup: res,
    textureLayout: res,
    whiteTexture: { bindGroup: res },
    getTexture: () => ({ bindGroup: res }),
    getShared: () => undefined,
    getExternalBuffer: () => undefined,
    sampleCount: 1,
    post: () => {},
  } as unknown as CoreContext;
  return { backend, ctx, system: createSwarmCoreSystem() };
}

/** SWARM_CREATE followed by SWARM_SET_CURVES, run through the core. */
async function run(caps: Capabilities): Promise<FakeBuffer | undefined> {
  const h = harness(caps);
  await h.system.init(h.ctx);
  const composed = composeSwarmShaders(
    [],
    0,
    caps.compute ? 'wgsl' : 'glsl300es',
  );
  const encoder = new FakeEncoder();
  const utf8 = new TextEncoder();
  const compute = utf8.encode(composed.compute);
  const render = utf8.encode(composed.render);
  encoder.begin(
    Op.SWARM_CREATE,
    32 + ((compute.byteLength + 3) & ~3) + ((render.byteLength + 3) & ~3),
  );
  encoder.u32(1); // swarmId
  encoder.u32(64); // capacity
  encoder.u32(0); // texId
  encoder.u32(0); // blend
  encoder.u32(0); // renderFlags
  encoder.u32(composed.paramsBytes);
  encoder.u32(compute.byteLength);
  encoder.u32(render.byteLength);
  encoder.bytes(compute);
  encoder.bytes(render);
  encoder.end();

  const curves = identityCurves();
  curves[SCV_SIZE / 4] = 3.5;
  new Uint32Array(curves.buffer)[SCV_COLOR / 4] = 0x11223344;
  encoder.begin(Op.SWARM_SET_CURVES, 4 + SWARM_CURVE_BYTES);
  encoder.u32(1);
  encoder.bytes(new Uint8Array(curves.buffer));
  encoder.end();

  const reader = new FakeReader(encoder.finish(1));
  const frame = { frameId: 1, time: 0, dt: 1 / 60 } as CoreFrameState;
  for (const command of reader.list()) {
    reader.seek(command.commandOffset);
    h.system.execute(reader, frame);
  }
  return h.backend.buffers.find(b => b.label === 'swarm1.curves');
}

describe('SWARM_SET_CURVES', () => {
  test('WebGPU core: the payload lands in the curve uniform', async () => {
    const buffer = await run(FAKE_CAPS);
    expect(buffer).toBeDefined();
    expect(buffer!.size).toBe(SWARM_CURVE_BYTES);
    const f32 = new Float32Array(buffer!.bytes.buffer);
    const u32 = new Uint32Array(buffer!.bytes.buffer);
    expect(f32[SCV_SIZE / 4]).toBeCloseTo(3.5, 5);
    expect(u32[SCV_COLOR / 4]).toBe(0x11223344);
  });

  test('WebGL2 core: the payload lands in the curve uniform', async () => {
    const buffer = await run(GL_CAPS);
    expect(buffer).toBeDefined();
    const f32 = new Float32Array(buffer!.bytes.buffer);
    expect(f32[SCV_SIZE / 4]).toBeCloseTo(3.5, 5);
  });
});
