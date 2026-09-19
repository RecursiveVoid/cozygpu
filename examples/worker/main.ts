// Owner: "worker". The same scene on the main thread or in a worker.
//
//   /examples/worker/            main-thread mode
//   /examples/worker/?worker=1   worker mode (OffscreenCanvas)
//   &swarm=1                     add a 200k-object Swarm (needs compute)
//   &busy=0                      disable the simulated 8 ms of main-thread work
//   &ring=0                      worker mode: force the transfer path instead of
//                                the SharedArrayBuffer command ring (§17)
//   &hud=0                       no HUD updates (allocation measurements)
//   &backend=webgl2              'auto' (default), 'webgpu', or 'webgl2'
//
// The ring needs a crossOriginIsolated page (COOP/COEP headers): use
// `npm run dev` (port 3002) or `node scripts/serve.mjs`. `heap` shows the
// main-thread JS heap growth per frame (Chrome only, performance.memory).
//
// With busy work on, worker mode keeps GPU submission off the main thread;
// `skipped` counts render() calls made while the worker was still busy.
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const useWorker = params.get('worker') === '1';
const withSwarm = params.get('swarm') === '1';
const busyMs = params.get('busy') === '0' ? 0 : 8;
const useRing = params.get('ring') !== '0';
const showHud = params.get('hud') !== '0';
const backendParam = params.get('backend');
const backend: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
// Read by the worker transport when it is created (diagnostics switch).
(globalThis as { __COZYGPU_RING__?: boolean }).__COZYGPU_RING__ = useRing;

interface MemoryInfo {
  usedJSHeapSize: number;
}
const memory = (performance as unknown as { memory?: MemoryInfo }).memory;

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const toggle = document.getElementById('toggle') as HTMLAnchorElement;
  const next = new URLSearchParams(params);
  if (useWorker) next.delete('worker');
  else next.set('worker', '1');
  toggle.href = `?${next.toString()}`;
  toggle.textContent = useWorker ? 'switch to main thread' : 'switch to worker';
  const ringToggle = document.getElementById(
    'ring',
  ) as HTMLAnchorElement | null;
  if (ringToggle) {
    const ringNext = new URLSearchParams(params);
    ringNext.set('worker', '1');
    if (useRing) ringNext.set('ring', '0');
    else ringNext.delete('ring');
    ringToggle.href = `?${ringNext.toString()}`;
    ringToggle.textContent = useRing ? 'ring off' : 'ring on';
  }

  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x0d0d14,
    backend,
    // Examples serve the worker bundle next to them; published builds can pass `worker: true`.
    worker: useWorker ? { url: '/build/examples/cozygpu.worker.js' } : false,
  });
  // Dev handle for the headless verification driver (examples only).
  (globalThis as { __renderer?: unknown }).__renderer = renderer;

  const texture = GPU.Texture.fromPixels(
    1,
    1,
    new Uint8Array([255, 255, 255, 255]),
  );
  const root = new GPU.Container({
    x: renderer.width / 2,
    y: renderer.height / 2,
  });
  renderer.stage.addChild(root);
  const rings = 8;
  const perRing = 500;
  for (let r = 0; r < rings; r++) {
    const radius = 60 + r * 30;
    for (let i = 0; i < perRing; i++) {
      const a = (i / perRing) * Math.PI * 2;
      root.addChild(
        new GPU.Sprite({
          texture,
          anchor: 0.5,
          width: 4,
          height: 4,
          x: Math.cos(a) * radius,
          y: Math.sin(a) * radius,
          tint: r % 2 === 0 ? 0xffcc66 : 0x66ccff,
        }),
      );
    }
  }

  let swarm: GPU.Swarm | null = null;
  if (withSwarm && renderer.info.capabilities.compute) {
    swarm = new GPU.Swarm({
      capacity: 200_000,
      shape: 'circle',
      blendMode: 'add',
      behaviors: [
        GPU.behaviors.velocity(),
        GPU.behaviors.bounds({
          x: 0,
          y: 0,
          width: renderer.width,
          height: renderer.height,
          mode: 'wrap',
        }),
      ],
    });
    renderer.stage.addChild(swarm);
    swarm.spawn(200_000, {
      x: [0, renderer.width],
      y: [0, renderer.height],
      speed: [10, 60],
      angle: [0, Math.PI * 2],
      size: [1, 2],
      color: ['#66ccff', '#ff66cc'],
      alpha: 0.5,
    });
  }

  // For scripts/worker-heap.mjs (allocation measurement over CDP).
  (globalThis as { __cozyExample?: unknown }).__cozyExample = { renderer };

  const ringActive =
    renderer.info.worker && useRing && globalThis.crossOriginIsolated === true;
  const t = GPU.ticker(renderer);
  let hudTimer = 0;
  let heapFrame = renderer.stats.frameId;
  let heapBytes = memory ? memory.usedJSHeapSize : 0;
  let heapPerFrame = 0;
  t.add(dt => {
    root.rotation += dt * 0.5;
    root.x = renderer.width / 2;
    root.y = renderer.height / 2;

    // Simulated app work that would stall a main-thread renderer.
    if (busyMs > 0) {
      const end = performance.now() + busyMs;
      while (performance.now() < end) {
        /* busy */
      }
    }

    if (!showHud) return;
    hudTimer += dt;
    if (hudTimer >= 0.25) {
      hudTimer = 0;
      const s = renderer.stats;
      if (memory && s.frameId - heapFrame >= 120) {
        // Growth between samples; a GC in between shows up as negative.
        heapPerFrame =
          (memory.usedJSHeapSize - heapBytes) / (s.frameId - heapFrame);
        heapBytes = memory.usedJSHeapSize;
        heapFrame = s.frameId;
      }
      hud.textContent =
        `${renderer.info.worker ? 'worker' : 'main thread'} · shared=${renderer.info.sharedMemory}` +
        (renderer.info.worker ? ` · ring=${ringActive}` : '') +
        (memory ? ` · heap ${heapPerFrame.toFixed(0)} B/frame` : '') +
        ` · fps ${t.fps.toFixed(0)} · frame ${s.frameId} · skipped ${s.skippedFrames}` +
        ` · packet ${s.packetBytes} B · cpu ${s.cpuMs.toFixed(2)} ms` +
        (swarm ? ` · swarm ${swarm.activeCount}` : '') +
        (busyMs ? ` · busy ${busyMs} ms/frame` : '');
    }
  });
}

main().catch(error => {
  console.error(error);
  const hud = document.getElementById('hud');
  if (hud)
    hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
});
