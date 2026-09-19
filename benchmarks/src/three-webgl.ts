/**
 * Three.js WebGLRenderer adapter: one InstancedMesh (Three's fastest path for
 * many identical quads). Positions are written straight into
 * `instanceMatrix.array` (translation slots) — no Matrix4/Object3D per frame.
 * S2 (swarm): no GPU simulation in WebGL Three, so CPU-stepped InstancedMesh.
 * A2 (picking): S3 + Raycaster.intersectObject(InstancedMesh) at one point
 * per frame (Three's CPU picking path; the intersection array is reused).
 */
import {
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  LinearFilter,
  MeshBasicMaterial,
  OrthographicCamera,
  type Intersection,
  PlaneGeometry,
  REVISION,
  Raycaster,
  RGBAFormat,
  Scene,
  StaticDrawUsage,
  Vector2,
  WebGLRenderer,
} from 'three';
import {
  type Adapter,
  BACKGROUND,
  type BenchContext,
  PickStats,
  SPRITE_SIZE,
  SPRITE_TEXTURE_SIZE,
  SWARM_SIZE,
  rng,
} from './common';
import { start } from './harness';

function createThreeWebGLAdapter(ctx: BenchContext): Adapter {
  const { params } = ctx;
  let renderer: WebGLRenderer;
  let mesh: InstancedMesh;
  let matrices: Float32Array;
  const scene = new Scene();
  const picks = new PickStats();
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const hits: Intersection[] = [];
  let pickOrder: Uint32Array | null = null;
  let pickCursor = 0;
  const camera = new OrthographicCamera(
    0,
    params.width,
    0,
    params.height,
    -10,
    10,
  );

  return {
    async init() {
      renderer = new WebGLRenderer({
        canvas: ctx.canvas,
        antialias: false,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(1);
      renderer.setSize(params.width, params.height, false);
      renderer.setClearColor(BACKGROUND, 1);
      renderer.sortObjects = false;
    },

    async populate() {
      const { sim, pixels } = ctx;
      const size = params.scenario === 'swarm' ? SWARM_SIZE : SPRITE_SIZE;
      const moving =
        params.scenario === 'sprites-moving' || params.scenario === 'swarm';
      const tex = new DataTexture(
        pixels,
        SPRITE_TEXTURE_SIZE,
        SPRITE_TEXTURE_SIZE,
        RGBAFormat,
      );
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearFilter;
      tex.needsUpdate = true;
      const material = new MeshBasicMaterial({
        map: tex,
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
      if (params.scenario === 'picking') {
        const r = rng(params.seed + 7);
        pickOrder = new Uint32Array(4096);
        for (let i = 0; i < pickOrder.length; i++) {
          pickOrder[i] = Math.floor(r() * sim.count);
        }
        return { cpuSim: false, tool: 'InstancedMesh + Raycaster (CPU)' };
      }
      return { cpuSim: moving, tool: 'InstancedMesh' };
    },

    frame(_ctx, cpuSim) {
      if (cpuSim) {
        const { x, y, count } = ctx.sim;
        for (let i = 0; i < count; i++) {
          const o = i * 16;
          matrices[o + 12] = x[i];
          matrices[o + 13] = y[i];
        }
        mesh.instanceMatrix.needsUpdate = true;
      } else if (pickOrder !== null) {
        const k = pickOrder[pickCursor++ & 4095];
        const t0 = performance.now();
        ndc.set(
          (ctx.sim.x[k] / params.width) * 2 - 1,
          1 - (ctx.sim.y[k] / params.height) * 2,
        );
        raycaster.setFromCamera(ndc, camera);
        hits.length = 0;
        raycaster.intersectObject(mesh, false, hits);
        picks.add(performance.now() - t0, 0, hits.length > 0);
      }
      renderer.render(scene, camera);
    },

    info() {
      return {
        backend: 'webgl2',
        version: `r${REVISION}`,
        drawCalls: renderer?.info.render.calls,
        ...(pickOrder !== null ? { pick: picks.summary() } : {}),
      };
    },

    measureStart() {
      picks.reset();
    },

    destroy() {
      renderer?.dispose();
    },
  };
}

start(createThreeWebGLAdapter);
