/**
 * Three.js WebGPURenderer adapter (`three/webgpu`).
 *   variant instanced → InstancedMesh, CPU-updated translations (S1/S3, and
 *                       S2 as a CPU fallback)
 *   variant compute   → S2 only: positions/velocities in storage buffers,
 *                       TSL compute shader does the bounce simulation, a
 *                       Sprite with `count = N` reads positions as an
 *                       instanced attribute (the pattern of Three's
 *                       webgpu_compute_particles example).
 * A silent fallback to the WebGL2 backend fails the run.
 */
import {
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  LinearFilter,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  REVISION,
  RGBAFormat,
  Scene,
  Sprite,
  SpriteNodeMaterial,
  StaticDrawUsage,
  WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  instancedArray,
  uniform,
} from 'three/tsl';
import {
  type Adapter,
  BACKGROUND,
  type BenchContext,
  SIM_DT,
  SPRITE_SIZE,
  SPRITE_TEXTURE_SIZE,
  SWARM_SIZE,
} from './common';
import { start } from './harness';

type ComputeNode = Parameters<WebGPURenderer['compute']>[0];

function createThreeWebGPUAdapter(ctx: BenchContext): Adapter {
  const { params } = ctx;
  let renderer: WebGPURenderer;
  let mesh: InstancedMesh | null = null;
  let matrices: Float32Array;
  let computeNode: ComputeNode | null = null;
  const scene = new Scene();
  const camera = new OrthographicCamera(
    0,
    params.width,
    0,
    params.height,
    -10,
    10,
  );

  function makeTexture(): DataTexture {
    const tex = new DataTexture(
      ctx.pixels,
      SPRITE_TEXTURE_SIZE,
      SPRITE_TEXTURE_SIZE,
      RGBAFormat,
    );
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  return {
    async init() {
      renderer = new WebGPURenderer({
        canvas: ctx.canvas,
        antialias: false,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(1);
      renderer.setSize(params.width, params.height, false);
      renderer.setClearColor(BACKGROUND, 1);
      renderer.sortObjects = false;
      await renderer.init();
      const backend = renderer.backend as { isWebGPUBackend?: boolean };
      if (!backend.isWebGPUBackend) {
        throw new Error('three WebGPURenderer fell back to its WebGL2 backend');
      }
    },

    async populate() {
      const { sim } = ctx;
      const swarm = params.scenario === 'swarm';
      const size = swarm ? SWARM_SIZE : SPRITE_SIZE;
      const moving = params.scenario !== 'sprites-static';

      if (params.variant === 'compute') {
        const n = sim.count;
        const pos = new Float32Array(n * 2);
        const vel = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          pos[i * 2] = sim.x[i];
          pos[i * 2 + 1] = sim.y[i];
          vel[i * 2] = sim.vx[i];
          vel[i * 2 + 1] = sim.vy[i];
        }
        const posBuf = instancedArray(pos, 'vec2');
        const velBuf = instancedArray(vel, 'vec2');
        const dt = uniform(SIM_DT);
        const w = uniform(params.width);
        const h = uniform(params.height);

        computeNode = Fn(() => {
          const p = posBuf.element(instanceIndex);
          const v = velBuf.element(instanceIndex);
          const np = p.add(v.mul(dt)).toVar();
          const nv = v.toVar();
          If(np.x.lessThan(0), () => {
            np.x.assign(0);
            nv.x.assign(nv.x.negate());
          }).ElseIf(np.x.greaterThan(w), () => {
            np.x.assign(w);
            nv.x.assign(nv.x.negate());
          });
          If(np.y.lessThan(0), () => {
            np.y.assign(0);
            nv.y.assign(nv.y.negate());
          }).ElseIf(np.y.greaterThan(h), () => {
            np.y.assign(h);
            nv.y.assign(nv.y.negate());
          });
          p.assign(np);
          v.assign(nv);
        })().compute(n);

        const material = new SpriteNodeMaterial({
          transparent: true,
          depthTest: false,
          depthWrite: false,
          side: DoubleSide,
        });
        material.map = makeTexture();
        material.positionNode = posBuf.toAttribute();
        material.scaleNode = float(size);
        const sprite = new Sprite(material);
        sprite.count = n;
        sprite.frustumCulled = false;
        scene.add(sprite);
        await renderer.computeAsync(computeNode);
        return { cpuSim: false, tool: 'TSL compute + Sprite(count)' };
      }

      const material = new MeshBasicNodeMaterial({
        map: makeTexture(),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      });
      mesh = new InstancedMesh(
        new PlaneGeometry(size, size),
        material,
        sim.count,
      );
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(moving ? DynamicDrawUsage : StaticDrawUsage);
      matrices = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < sim.count; i++) {
        const o = i * 16;
        matrices[o] = 1;
        matrices[o + 5] = 1;
        matrices[o + 10] = 1;
        matrices[o + 15] = 1;
        matrices[o + 12] = sim.x[i];
        matrices[o + 13] = sim.y[i];
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      return { cpuSim: moving, tool: 'InstancedMesh' };
    },

    frame(_ctx, cpuSim) {
      if (computeNode) {
        renderer.compute(computeNode);
      } else if (cpuSim && mesh) {
        const { x, y, count } = ctx.sim;
        for (let i = 0; i < count; i++) {
          const o = i * 16;
          matrices[o + 12] = x[i];
          matrices[o + 13] = y[i];
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
      renderer.render(scene, camera);
    },

    info() {
      return {
        backend: 'webgpu',
        version: `r${REVISION}`,
        drawCalls: renderer?.info.render.drawCalls,
      };
    },

    destroy() {
      renderer?.dispose();
    },
  };
}

start(createThreeWebGPUAdapter);
