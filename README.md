# cozygpu

Lightweight, WebGPU-first 2D graphics library: a Pixi-like scene graph plus
**Swarm**, which simulates and draws millions of objects entirely on the GPU.
It runs on the main thread or in a worker with the same API, on WebGPU or,
where that is missing, WebGL2. Graphics only, zero runtime dependencies.

**[Live demo](https://recursivevoid.github.io/cozygpu/)**

## Live demo

[recursivevoid.github.io/cozygpu](https://recursivevoid.github.io/cozygpu/)
runs Swarm (1M objects), a 100k-sprite bunnymark, particle presets, MSDF
text, filters and masking in the browser, with a WebGPU/WebGL2 switch and a
live fps / frame-time HUD. The page lives in `site/`; build it locally with
`npm run build:site` (output in `site-dist/`).

## Quick start

```ts
import * as GPU from 'cozygpu';

const renderer = await GPU.createRenderer({
  canvas: document.querySelector('canvas')!,
  background: 0x101018,
  // worker: true,      // render from a Web Worker (OffscreenCanvas)
  // limits: 'max',     // for multi-million-object Swarms
});

// Tier 1: scene graph
const texture = await GPU.loadTexture('/bunny.png');
const bunny = new GPU.Sprite({ texture, x: 100, y: 100, anchor: 0.5 });
renderer.stage.addChild(bunny);

// Tier 2: GPU-simulated Swarm (needs compute: renderer.info.capabilities.compute)
const swarm = new GPU.Swarm({
  capacity: 1_000_000,
  shape: 'circle',
  blendMode: 'add',
  behaviors: [
    GPU.behaviors.velocity(),
    GPU.behaviors.bounds({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      mode: 'bounce',
    }),
  ],
});
renderer.stage.addChild(swarm);
swarm.spawn(1_000_000, {
  x: [0, 800],
  y: [0, 600],
  speed: [10, 60],
  angle: [0, 6.28],
});

// Frame loop (or call renderer.render() yourself)
GPU.ticker(renderer).add(dt => {
  bunny.rotation += dt;
});
```

Worker mode loads `cozygpu.worker.js` next to `cozygpu.js` by default; pass
`worker: { url }` when your bundler moves it. Serve the page with COOP/COEP
headers to enable zero-copy (SharedArrayBuffer) uploads.

## Examples

```bash
EXAMPLES=1 npx rollup -c rollup.config.cjs   # build/examples/*
npm run dev                                  # watch + http://localhost:3002/examples/ (COOP/COEP)
```

`basic` (clear color + textured quad; `?worker=1`, `?msaa=1`, `?mode=rhi`),
`sprites` (bunnymark; `?count=100000&rotate=1`), `swarm` (1M objects;
`?cull=1`, `?worker=1`, `?mode=fountain`), `worker` (busy main thread;
`?worker=1&swarm=1`).

Status: pre-release (M1 complete, not yet published). See
[docs/API.md](docs/API.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
and [benchmarks/README.md](benchmarks/README.md).
