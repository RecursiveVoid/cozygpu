// Graphics (docs/ARCHITECTURE.md §26, docs/API.md "Graphics"). One page,
// several scenes:
//
//   ?scene=shapes      every SDF primitive: joins, alignment, caps, arcs,
//                      pixel lines, a node redrawn every frame
//   ?scene=paths       curves, arcTo, joins on polylines, holes, a texture
//                      fill and a live chart re-tessellated every frame
//   ?scene=sharing     hundreds of nodes on two shared contexts (?count=)
//   ?scene=perf        ?mode=nodes|redraw|mesh|static ?count=10000
//   ?scene=masks       Graphics as mask sources: a plain rect (scissor), a
//                      turning rounded rect (SDF) and a star (mesh), each
//                      clipping sprites and Graphics (stencil on WebGL2,
//                      alpha on WebGPU)
//   ?scene=picking     hover and click shapes: picks follow the exact
//                      geometry (stroke-only ring, alpha-0 hit area, star)
//   ?scene=deviceloss  SDF shapes, a shared mesh context, a texture fill and
//                      picking; ?lose=1 loses the device after ~1 s and the
//                      scene comes back without any help from the app
//
// Query flags (every scene):
//   ?backend=auto|webgpu|webgl2   backend preference (default auto)
//   ?worker=1                     render from a Web Worker (OffscreenCanvas)
//   ?msaa=1                       4× MSAA
//   ?debug=1                      debug core (needed by ?lose=1 on the main thread)
import * as GPU from 'cozygpu';
import { createDeviceLossScene } from './scenes/deviceLoss';
import { createMaskScene } from './scenes/masks';
import { createPathsScene } from './scenes/paths';
import { createPerfScene } from './scenes/perf';
import { createPickingScene } from './scenes/picking';
import { createShapesScene } from './scenes/shapes';
import { createSharingScene } from './scenes/sharing';
import type { SceneFactory, SceneStatus } from './scenes/types';

const SCENES: Record<string, SceneFactory> = {
  shapes: createShapesScene,
  paths: createPathsScene,
  sharing: createSharingScene,
  perf: createPerfScene,
  masks: createMaskScene,
  picking: createPickingScene,
  deviceloss: createDeviceLossScene,
};
const DEFAULT_SCENE = 'shapes';

const params = new URLSearchParams(location.search);
const backendParam = params.get('backend');
const preference: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const sceneName =
  params.get('scene') && SCENES[params.get('scene')!]
    ? params.get('scene')!
    : DEFAULT_SCENE;
const hud = document.getElementById('hud') as HTMLElement;

const status: SceneStatus = {
  scene: sceneName,
  backend: '',
  worker: params.get('worker') === '1',
  frames: 0,
  ready: false,
  errors: [],
};
(globalThis as { __graphics?: SceneStatus }).__graphics = status;

async function run(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = await GPU.createRenderer({
    canvas,
    backend: preference,
    background: 0x0f172a,
    antialias: params.get('msaa') === '1',
    debug: params.get('debug') === '1' || params.get('lose') === '1',
    worker: status.worker
      ? { url: '/build/examples/cozygpu.worker.js' }
      : false,
    events: {
      emit(name: string, payload: unknown) {
        if (name === 'error') {
          status.errors.push(JSON.stringify(payload));
          console.warn('[graphics]', payload);
        }
        if (name === 'deviceLost' || name === 'deviceRestored') {
          status[name] = ((status[name] as number) ?? 0) + 1;
        }
      },
    },
  });
  (globalThis as { __renderer?: unknown }).__renderer = renderer;
  status.backend = renderer.info.backend;
  // Preloading keeps the first frames from drawing nothing.
  await GPU.loadGraphics();
  await GPU.loadEffects('mask');
  const scene = await SCENES[sceneName](renderer, params, status);

  let hudTimer = 0;
  GPU.ticker(renderer).add((dt, time) => {
    scene.update(dt, time);
    status.frames++;
    status.ready = true;
    hudTimer += dt;
    if (hudTimer > 0.4) {
      hudTimer = 0;
      const s = renderer.stats;
      hud.textContent =
        `graphics · ${sceneName} · ${renderer.info.backend} · ` +
        `${status.worker ? 'worker' : 'main thread'} · ` +
        `${renderer.width}×${renderer.height}@${renderer.resolution}\n` +
        `${scene.hud()}\n` +
        `frame ${s.frameId} · draws ${s.drawCalls} · ${s.packetBytes} B`;
    }
  });
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  status.errors.push(message);
  hud.textContent = message;
  console.error(err);
});
