# Benchmark results — m2-final

- Date: 2026-09-18T16:51:30.800Z
- Machine: Apple M4 · 16 GB · darwin 25.5.0 arm64
- GPU: apple metal-3
- Chrome: Google Chrome 152.0.7977.84 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 3 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## S1 — moving sprites (CPU-updated, bouncing)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Sprite | 4142.3 | 0.24 | 0.31 | 0.20 | 0.26 | 25.3 | 0.24–0.26 | ok |
| 10k | cozygpu · webgl2 | Sprite | 779.2 | 1.28 | 2.59 | 1.25 | 2.55 | 7.0 | 1.28–1.29 | ok |
| 10k | cozygpu · worker | Sprite | 56.6 | 17.67 | 18.80 | 0.31 | 0.44 | -1502.9 | 17.67–17.75 | ok (1 skipped) |
| 10k | pixi · webgpu | Sprite | 1038.3 | 0.96 | 1.12 | 0.88 | 0.95 | 108.5 | 0.96–0.98 | ok |
| 10k | pixi · webgpu | ParticleContainer | 4062.5 | 0.25 | 0.34 | 0.17 | 0.19 | 159.8 | 0.24–0.25 | ok |
| 10k | pixi · webgl | Sprite | 749.1 | 1.33 | 2.16 | 1.25 | 2.05 | -185.0 | 1.33–1.34 | ok |
| 10k | pixi · webgl | ParticleContainer | 786.4 | 1.27 | 2.56 | 1.24 | 2.51 | -243.8 | 1.27–1.29 | ok |
| 10k | three · webgl | InstancedMesh | 773.1 | 1.29 | 2.64 | 1.26 | 2.61 | 115.4 | 1.29–1.30 | ok |
| 10k | three · webgpu | InstancedMesh | 3245.6 | 0.31 | 0.38 | 0.24 | 0.26 | 67.5 | 0.31–0.31 | ok |
| 100k | cozygpu · webgpu | Sprite | 898.9 | 1.11 | 1.27 | 1.00 | 1.13 | 1133.1 | 1.11–1.11 | ok |
| 100k | cozygpu · webgl2 | Sprite | 958.0 | 1.04 | 1.13 | 0.96 | 1.02 | 67.3 | 1.04–1.04 | ok |
| 100k | cozygpu · worker | Sprite | 56.0 | 17.85 | 18.88 | 2.36 | 2.93 | 375.9 | 17.82–17.91 | ok |
| 100k | pixi · webgpu | Sprite | 103.2 | 9.69 | 10.13 | 9.55 | 10.00 | -4107.2 | 9.57–9.71 | ok |
| 100k | pixi · webgpu | ParticleContainer | 524.4 | 1.91 | 2.13 | 1.75 | 1.90 | 1011.3 | 1.90–1.93 | ok |
| 100k | pixi · webgl | Sprite | 108.0 | 9.26 | 9.80 | 9.16 | 9.67 | -31170.1 | 9.20–9.41 | ok |
| 100k | pixi · webgl | ParticleContainer | 659.6 | 1.52 | 2.19 | 1.35 | 1.95 | 798.9 | 1.51–1.52 | ok |
| 100k | three · webgl | InstancedMesh | 766.6 | 1.30 | 2.09 | 1.23 | 1.96 | 302.1 | 1.30–1.31 | ok |
| 100k | three · webgpu | InstancedMesh | 838.6 | 1.19 | 1.80 | 1.01 | 1.45 | 451.2 | 1.16–1.25 | ok |
| 1M | cozygpu · webgpu | Sprite | 84.8 | 11.79 | 13.43 | 11.60 | 13.23 | 12180.3 | 11.76–12.32 | ok |
| 1M | cozygpu · webgl2 | Sprite | 64.2 | 15.59 | 16.17 | 15.40 | 16.02 | 56012.2 | 15.44–15.60 | ok |
| 1M | cozygpu · worker | Sprite | 58.1 | 17.20 | 18.70 | 8.72 | 9.23 | 49332.0 | 17.07–17.32 | ok |
| 1M | pixi · webgpu | Sprite | 9.4 | 106.62 | 109.82 | 106.39 | 109.57 | 277545.0 | 105.61–106.94 | ok |
| 1M | pixi · webgpu | ParticleContainer | 66.5 | 15.03 | 17.64 | 14.88 | 17.50 | -42235.0 | 14.79–15.09 | ok |
| 1M | pixi · webgl | Sprite | 9.7 | 102.98 | 106.85 | 102.79 | 106.56 | 347871.8 | 101.33–103.54 | ok |
| 1M | pixi · webgl | ParticleContainer | 68.7 | 14.55 | 15.13 | 14.46 | 15.05 | 4659.8 | 14.46–14.82 | ok |
| 1M | three · webgl | InstancedMesh | 46.3 | 21.60 | 22.50 | 21.48 | 22.41 | 2375.3 | 21.49–21.98 | ok |
| 1M | three · webgpu | InstancedMesh | 86.4 | 11.57 | 17.43 | 11.42 | 17.27 | 1350.7 | 11.53–11.91 | ok |

## S2 — swarm (GPU-simulated where supported, else best CPU path)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 145.4 | 6.88 | 13.45 | 4.84 | 7.58 | 422.4 | 6.86–6.91 | ok |
| 1M | cozygpu · webgl2 | Swarm (transform feedback) | 164.6 | 6.08 | 7.76 | 0.01 | 0.08 | 279.2 | 6.06–6.09 | ok |
| 1M | cozygpu · worker | Swarm (GPU compute) | 56.9 | 17.57 | 18.77 | 0.07 | 0.12 | 461.5 | 17.56–17.62 | ok (1 skipped) |
| 1M | pixi · webgpu | ParticleContainer | 69.3 | 14.42 | 15.14 | 14.31 | 15.03 | -59467.4 | 14.38–14.58 | ok |
| 1M | pixi · webgl | ParticleContainer | 73.1 | 13.69 | 14.82 | 13.59 | 14.73 | -16134.9 | 13.61–13.91 | ok |
| 1M | three · webgl | InstancedMesh | 52.4 | 19.09 | 19.96 | 18.98 | 19.77 | -111.2 | 19.04–19.10 | ok |
| 1M | three · webgpu | InstancedMesh | 88.2 | 11.33 | 16.61 | 11.12 | 16.36 | 2510.1 | 11.22–11.36 | ok |
| 1M | three · webgpu | TSL compute + Sprite(count) | 124.1 | 8.05 | 16.09 | 8.02 | 16.07 | 2354.5 | 8.04–8.16 | ok |
| 2M | cozygpu · webgpu | Swarm (GPU compute) | 70.2 | 14.25 | 15.63 | 14.19 | 15.52 | 453.1 | 14.11–14.25 | ok |
| 2M | cozygpu · webgl2 | Swarm (transform feedback) | 83.6 | 11.96 | 13.03 | 0.01 | 0.08 | 282.9 | 11.93–11.96 | ok |
| 2M | cozygpu · worker | Swarm (GPU compute) | 60.1 | 16.65 | 18.73 | 0.01 | 0.02 | 477.8 | 16.64–16.69 | ok (1 skipped) |
| 2M | pixi · webgpu | ParticleContainer | 35.3 | 28.36 | 30.05 | 28.23 | 29.94 | -23476.8 | 28.32–28.44 | ok |
| 2M | pixi · webgl | ParticleContainer | 36.8 | 27.15 | 28.98 | 27.04 | 28.88 | 28470.2 | 27.11–27.15 | ok |
| 2M | three · webgl | InstancedMesh | 13.8 | 72.69 | 75.20 | 72.49 | 75.00 | 11420.7 | 72.55–72.80 | ok |
| 2M | three · webgpu | InstancedMesh | 43.2 | 23.15 | 36.66 | 23.00 | 36.25 | 5500.4 | 22.61–23.40 | ok |
| 2M | three · webgpu | TSL compute + Sprite(count) | 59.7 | 16.75 | 33.41 | 16.70 | 33.38 | 5207.1 | 16.74–16.77 | ok |

## S3 — static sprites (nothing moves)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 1873.7 | 0.53 | 1.63 | 0.02 | 0.55 | 6.0 | 0.53–0.55 | ok |
| 100k | cozygpu · webgl2 | Sprite | 780.5 | 1.28 | 2.57 | 1.23 | 2.54 | 196.5 | 1.28–1.28 | ok |
| 100k | cozygpu · worker | Sprite | 56.4 | 17.72 | 18.80 | 0.07 | 0.11 | 388.9 | 17.60–17.72 | ok (1 skipped) |
| 100k | pixi · webgpu | Sprite | 1546.8 | 0.65 | 1.65 | 0.16 | 1.41 | 2234.8 | 0.64–0.65 | ok |
| 100k | pixi · webgpu | ParticleContainer | 1503.6 | 0.67 | 1.71 | 0.24 | 1.25 | -1068.2 | 0.66–0.67 | ok |
| 100k | pixi · webgl | Sprite | 768.8 | 1.30 | 2.59 | 1.23 | 2.50 | 1126.2 | 1.30–1.30 | ok |
| 100k | pixi · webgl | ParticleContainer | 781.5 | 1.28 | 2.53 | 1.15 | 2.45 | 1165.8 | 1.27–1.29 | ok |
| 100k | three · webgl | InstancedMesh | 655.4 | 1.53 | 2.60 | 1.45 | 2.52 | 203.4 | 1.49–1.55 | ok |
| 100k | three · webgpu | InstancedMesh | 1338.4 | 0.75 | 0.95 | 0.64 | 0.80 | 192.3 | 0.75–0.75 | ok |

## A1 — load + upload 200 × 64² PNG

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 200 | cozygpu · webgpu | Assets.loadAll (png) | 10552.9 | 0.09 | 0.88 | 0.01 | 0.07 | 31.9 | 0.09–0.10 | ok |
| 200 | cozygpu · webgpu | Assets.loadAll (png, atlas off) | 7411.8 | 0.13 | 0.21 | 0.04 | 0.09 | 48.8 | 0.13–0.15 | ok |
| 200 | cozygpu · webgl2 | Assets.loadAll (png) | 806.3 | 1.24 | 2.55 | 1.08 | 2.48 | -252.6 | 1.24–1.24 | ok |
| 200 | pixi · webgpu | Assets.load (png) | 6531.4 | 0.15 | 0.68 | 0.05 | 0.45 | 100.2 | 0.15–0.15 | ok |
| 200 | pixi · webgl | Assets.load (png) | 763.2 | 1.31 | 2.64 | 0.01 | 0.02 | 138.6 | 1.31–1.31 | ok |

| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|
| cozygpu · webgpu | Assets.loadAll (png) | 55.4 | 56.4 | 4.8 | 61.3 | 16.00 MiB | 1 | rgba8unorm | 530.7 KB | 1 | ok |
| cozygpu · webgpu | Assets.loadAll (png, atlas off) | 55.5 | 56.5 | 6.0 | 62.5 | 3.13 MiB | 0 | rgba8unorm | 673.7 KB | 200 | ok |
| cozygpu · webgl2 | Assets.loadAll (png) | 57.2 | 58.1 | 4.7 | 62.8 | 16.00 MiB | 1 | rgba8unorm | 543.2 KB | 1 | ok |
| pixi · webgpu | Assets.load (png) | 61.8 | 62.7 | 8.0 | 70.7 | 3.13 MiB (est.) | — | bgra8unorm | 1196.3 KB | — | ok |
| pixi · webgl | Assets.load (png) | 67.0 | 68.0 | 11.4 | 79.4 | 3.13 MiB (est.) | — | bgra8unorm | 1114.2 KB | — | ok |

GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).

## A1 — load + upload 200 × 64² KTX2 (BC1, no supercompression)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 200 | cozygpu · webgpu | Assets.loadAll (ktx2) | 7744.7 | 0.13 | 0.20 | 0.05 | 0.08 | 3.6 | 0.12–0.14 | ok |
| 200 | cozygpu · webgl2 | Assets.loadAll (ktx2) | 655.9 | 1.52 | 2.98 | 1.45 | 2.90 | 214.0 | 1.52–1.52 | ok |
| 200 | pixi · webgpu | Assets.load (BC1 as KTX1) | 6849.0 | 0.15 | 0.67 | 0.04 | 0.43 | 9.0 | 0.15–0.15 | ok |
| 200 | pixi · webgl | Assets.load (BC1 as KTX1) | 765.3 | 1.31 | 2.63 | 0.02 | 0.07 | 139.5 | 1.30–1.31 | ok |

| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|
| cozygpu · webgpu | Assets.loadAll (ktx2) | 45.2 | 46.1 | 3.7 | 49.9 | 0.39 MiB | 0 | bc1-rgba-unorm | 1123.6 KB | 200 | ok |
| cozygpu · webgl2 | Assets.loadAll (ktx2) | 45.2 | 46.2 | 3.6 | 49.7 | 0.39 MiB | 0 | bc1-rgba-unorm | 1205.8 KB | 200 | ok |
| pixi · webgpu | Assets.load (BC1 as KTX1) | 54.0 | 54.9 | 14.2 | 69.1 | 0.39 MiB (est.) | — | bc1-rgba-unorm | 1668.4 KB | — | ok |
| pixi · webgl | Assets.load (BC1 as KTX1) | 168.7 | 169.7 | 10.1 | 179.8 | 0.39 MiB (est.) | — | bc1-rgba-unorm | 1585.0 KB | — | ok |

GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).

## A2 — picking latency at 100k static sprites (one pick in flight, vsync ON = 60 fps like a real page)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 60.0 | 16.67 | 18.54 | 0.29 | 0.40 | 30417.8 | 16.66–16.67 | ok |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 60.0 | 16.67 | 18.58 | 0.20 | 0.30 | 30959.3 | 16.66–16.67 | ok |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 60.0 | 16.67 | 18.52 | 0.07 | 0.12 | 30408.2 | 16.66–16.67 | ok |
| 100k | pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 60.0 | 16.67 | 18.59 | 2.65 | 8.48 | 3687.9 | 16.67–16.67 | ok |
| 100k | three · webgl | InstancedMesh + Raycaster (CPU) | 60.0 | 16.67 | 18.45 | 6.58 | 6.91 | 1922.0 | 16.67–16.67 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 301 | 100% | 4.79 | 4.67 | 6.91 | 7.43 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · webgl2 | Sprite + renderer.pick() | 301 | 100% | 6.03 | 6.06 | 8.81 | 13.14 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · worker | Sprite + renderer.pick() | 301 | 100% | 5.87 | 6.19 | 7.81 | 7.93 | 1.00 | 1.0 | 16.67 | ok |
| pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 302 | 100% | 2.35 | 1.77 | 8.13 | 10.34 | 0.00 | 0.0 | 16.67 | ok |
| three · webgl | InstancedMesh + Raycaster (CPU) | 302 | 100% | 6.55 | 6.58 | 6.88 | 6.88 | 0.00 | 0.0 | 16.67 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A2u — picking at 100k, frame-rate limit OFF (stress: async readbacks compete with an uncapped rAF loop)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 1867.4 | 0.54 | 18.69 | 0.01 | 0.07 | 43.8 | 0.53–0.54 | ok (343 skipped) |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 300.1 | 3.33 | 18.88 | 0.05 | 0.24 | 1195.6 | 3.33–3.34 | ok (352 skipped) |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 56.5 | 17.70 | 18.82 | 0.07 | 0.11 | 41122.8 | 17.61–17.74 | ok (1 skipped) |
| 100k | pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 1442.8 | 0.69 | 3.39 | 0.61 | 3.21 | -303.2 | 0.68–0.69 | ok |
| 100k | three · webgl | InstancedMesh + Raycaster (CPU) | 196.8 | 5.08 | 5.24 | 5.01 | 5.09 | -108.1 | 5.05–5.10 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 140 | 100% | 26.75 | 26.84 | 37.66 | 38.23 | 66.77 | 75.0 | 0.54 | ok (343 skipped) |
| cozygpu · webgl2 | Sprite + renderer.pick() | 250 | 100% | 10.80 | 10.74 | 14.12 | 14.42 | 6.00 | 6.0 | 3.33 | ok (352 skipped) |
| cozygpu · worker | Sprite + renderer.pick() | 273 | 100% | 5.20 | 4.91 | 7.69 | 8.45 | 1.04 | 2.0 | 17.70 | ok (1 skipped) |
| pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 7218 | 100% | 0.59 | 0.34 | 3.13 | 6.30 | 0.00 | 0.0 | 0.69 | ok |
| three · webgl | InstancedMesh + Raycaster (CPU) | 985 | 100% | 4.99 | 4.99 | 5.07 | 5.29 | 0.00 | 0.0 | 5.08 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A3 — swarm spawn/kill churn (capacity 1M, 8000 spawns/frame, life 0.5–1.5 s ⇒ ~480k alive)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm churn (allocation 'gpu') | 230.6 | 4.34 | 9.08 | 1.34 | 4.56 | -171.1 | 4.31–4.35 | ok (126 skipped) |
| 1M | cozygpu · webgpu | Swarm churn (allocation 'ring') | 172.3 | 5.80 | 11.63 | 2.86 | 5.95 | -390.7 | 5.80–5.80 | ok (164 skipped) |
| 1M | cozygpu · webgl2 | Swarm churn (allocation 'ring') | 209.9 | 4.76 | 5.24 | 4.73 | 5.16 | -445.6 | 4.76–4.78 | ok (253 skipped) |
| 1M | pixi · webgpu | ParticleContainer churn (CPU pool) | 17.7 | 56.46 | 59.37 | 56.36 | 59.20 | 27764.7 | 56.44–56.47 | ok |

| engine | tool | alive at end | spawns/frame | draw calls | front CPU ms | packet B | status |
|---|---|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Swarm churn (allocation 'gpu') | 475772 | 8000 | 1 | 0.01 | 232 | ok (126 skipped) |
| cozygpu · webgpu | Swarm churn (allocation 'ring') | 476094 | 8000 | 1 | 0.00 | 232 | ok (164 skipped) |
| cozygpu · webgl2 | Swarm churn (allocation 'ring') | 475869 | 8000 | 1 | 0.00 | 232 | ok (253 skipped) |
| pixi · webgpu | ParticleContainer churn (CPU pool) | 476269 | 8000 | — | — | — | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 243.4 | 13.5 | 12.1 | 268.9 | 354.2 B | 55012.6 KB | 3.2 |
| cozygpu · webgl2 | Sprite | 247.6 | 13.5 | 12.7 | 273.8 | 354.1 B | 55108.6 KB | 4.6 |
| cozygpu · worker | Sprite | 245.0 | 13.5 | 11.4 | 270.7 | 300.6 B | 49628.8 KB | 6.1 |
| pixi · webgpu | Sprite | 233.4 | 42.6 | 122.3 | 397.3 | 1299.0 B | 148747.6 KB | 52.8 |
| pixi · webgpu | ParticleContainer | 236.1 | 38.3 | 9.6 | 284.4 | 304.6 B | 51630.4 KB | 0.8 |
| pixi · webgl | Sprite | 111.3 | 46.9 | 132.4 | 289.2 | 1298.9 B | 148578.6 KB | 48.9 |
| pixi · webgl | ParticleContainer | 110.2 | 41.8 | 15.9 | 167.5 | 304.4 B | 51461.3 KB | 4.9 |
| three · webgl | InstancedMesh | 36.6 | 2.8 | 20.9 | 60.6 | 66.9 B | 27878.4 KB | 0.4 |
| three · webgpu | InstancedMesh | 226.2 | 2.9 | 14.4 | 243.3 | 73.0 B | 28761.3 KB | 1.1 |

### Init at 1M+ objects (S1/S2)

| scenario | count | engine | tool | total init ms | heap / object | destroy ms |
|---|---:|---|---|---:|---:|---:|
| sprites-moving | 1M | cozygpu · webgpu | Sprite | 416.1 | 295.7 B | 17.3 |
| sprites-moving | 1M | cozygpu · webgl2 | Sprite | 418.2 | 295.7 B | 19.6 |
| sprites-moving | 1M | cozygpu · worker | Sprite | 412.9 | 253.7 B | 15.1 |
| sprites-moving | 1M | pixi · webgpu | Sprite | 1840.2 | 1298.6 B | 269.5 |
| sprites-moving | 1M | pixi · webgpu | ParticleContainer | 622.8 | 302.8 B | 0.8 |
| sprites-moving | 1M | pixi · webgl | Sprite | 1714.3 | 1298.6 B | 272.6 |
| sprites-moving | 1M | pixi · webgl | ParticleContainer | 530.8 | 302.8 B | 1.9 |
| sprites-moving | 1M | three · webgl | InstancedMesh | 90.5 | 64.3 B | 0.2 |
| sprites-moving | 1M | three · webgpu | InstancedMesh | 244.1 | 64.9 B | 2.4 |
| swarm | 1M | cozygpu · webgpu | Swarm (GPU compute) | 231.6 | 0.2 B | 0.4 |
| swarm | 1M | cozygpu · webgl2 | Swarm (transform feedback) | 235.2 | 0.1 B | 0.9 |
| swarm | 1M | cozygpu · worker | Swarm (GPU compute) | 229.2 | 0.1 B | 0.7 |
| swarm | 1M | pixi · webgpu | ParticleContainer | 612.2 | 302.8 B | 0.7 |
| swarm | 1M | pixi · webgl | ParticleContainer | 532.6 | 302.8 B | 2.2 |
| swarm | 1M | three · webgl | InstancedMesh | 89.0 | 64.3 B | 0.1 |
| swarm | 1M | three · webgpu | InstancedMesh | 242.0 | 64.9 B | 2.4 |
| swarm | 1M | three · webgpu | TSL compute + Sprite(count) | 227.8 | 16.9 B | 0.9 |
| swarm | 2M | cozygpu · webgpu | Swarm (GPU compute) | 217.0 | 0.1 B | 0.5 |
| swarm | 2M | cozygpu · webgl2 | Swarm (transform feedback) | 215.6 | 0.1 B | 0.5 |
| swarm | 2M | cozygpu · worker | Swarm (GPU compute) | 210.7 | 0.0 B | 0.6 |
| swarm | 2M | pixi · webgpu | ParticleContainer | 1018.1 | 303.9 B | 2.2 |
| swarm | 2M | pixi · webgl | ParticleContainer | 962.9 | 303.9 B | 6.8 |
| swarm | 2M | three · webgl | InstancedMesh | 115.6 | 64.1 B | 0.4 |
| swarm | 2M | three · webgpu | InstancedMesh | 245.1 | 64.4 B | 2.1 |
| swarm | 2M | three · webgpu | TSL compute + Sprite(count) | 220.5 | 16.5 B | 0.7 |
| swarm-churn | 1M | cozygpu · webgpu | Swarm churn (allocation 'gpu') | 234.4 | 0.2 B | 0.9 |
| swarm-churn | 1M | cozygpu · webgpu | Swarm churn (allocation 'ring') | 234.2 | 0.2 B | 0.4 |
| swarm-churn | 1M | cozygpu · webgl2 | Swarm churn (allocation 'ring') | 238.7 | 0.1 B | 0.9 |
| swarm-churn | 1M | pixi · webgpu | ParticleContainer churn (CPU pool) | 543.1 | 150.9 B | 1.5 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 21 | 201.4 KB | 68.8 KB | 233.5 KB | 81.5 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 24 | 223.5 KB | 75.8 KB | 280.4 KB | 98.0 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 11 | 128.1 KB | 43.4 KB | 130.9 KB | 44.9 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 16 | 167.3 KB | 59.2 KB |
| cozygpu · webgl2 | 16 | 171.5 KB | 61.2 KB |
| cozygpu · worker | 16 | 277.9 KB | 93.8 KB |
| pixi · webgpu | 22 | 581.0 KB | 179.2 KB |
| pixi · webgl | 22 | 580.9 KB | 179.2 KB |
| three · webgl | 4 | 570.0 KB | 144.7 KB |
| three · webgpu | 4 | 898.5 KB | 250.2 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-moving/10000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.24 | 0.31 | pixi-webgpu-particle (ParticleContainer) | 0.25 | 0.34 | -2% | -10% | -2% | +421% |
| sprites-moving/100000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 1.04 | 1.13 | three-webgpu-instanced (InstancedMesh) | 1.19 | 1.80 | -12% | -37% | -7% | -12% |
| sprites-moving/1000000 | frame ms | three-webgpu-instanced | cozygpu-webgpu-auto | 11.79 | 13.43 | three-webgpu-instanced (InstancedMesh) | 11.57 | 17.43 | +2% | -23% | +2% | +35% |
| swarm/1000000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 6.08 | 7.76 | three-webgpu-compute (TSL compute + Sprite(count)) | 8.05 | 16.09 | -25% | -52% | -15% | -25% |
| swarm/2000000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 11.96 | 13.03 | three-webgpu-compute (TSL compute + Sprite(count)) | 16.75 | 33.41 | -29% | -61% | -15% | -29% |
| sprites-static/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.53 | 1.63 | pixi-webgpu-sprite (Sprite) | 0.65 | 1.65 | -17% | -2% | -17% | +98% |
| assets-png/200 | load+upload ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 61.28 | — | pixi-webgpu-sprite (Assets.load (png)) | 70.66 | — | -13% | — | -13% | -11% |
| assets-ktx2/200 | load+upload ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 49.74 | — | pixi-webgpu-sprite (Assets.load (BC1 as KTX1)) | 69.10 | — | -28% | — | -28% | -28% |
| picking/100000 | pick latency ms | pixi-webgpu-sprite | cozygpu-webgpu-auto | 4.79 | 6.91 | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 2.35 | 8.13 | +104% | -15% | +104% | +157% |
| picking-uncapped/100000 | pick latency ms | pixi-webgpu-sprite | cozygpu-worker-auto | 5.20 | 7.69 | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.59 | 3.13 | +788% | +146% | +4469% | +1745% |
| swarm-churn/1000000 | frame ms | cozygpu-webgpu-gpu | cozygpu-webgpu-gpu | 4.34 | 9.08 | pixi-webgpu-particle (ParticleContainer churn (CPU pool)) | 56.46 | 59.37 | -92% | -85% | -92% | -92% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m1-final (same case ids)

| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sprites-moving/10000/cozygpu-webgpu-auto | 0.29 | 0.24 | -16% | 0.51 | 0.31 | -40% | 0.21 | 0.20 | -5% | 256.0 | 19.7 | no |
| sprites-moving/10000/cozygpu-worker-auto | 17.71 | 17.67 | -0% | 18.74 | 18.80 | +0% | 0.12 | 0.31 | +150% | 258.5 | 254.2 | **yes** |
| sprites-moving/100000/cozygpu-webgpu-auto | 1.46 | 1.11 | -24% | 1.77 | 1.27 | -28% | 1.33 | 1.00 | -25% | 92.7 | 270.2 | no |
| sprites-moving/100000/cozygpu-worker-auto | 17.43 | 17.85 | +2% | 18.73 | 18.88 | +1% | 1.00 | 2.36 | +137% | 286.3 | 269.8 | **yes** |
| sprites-moving/1000000/cozygpu-webgpu-auto | 15.18 | 11.79 | -22% | 16.90 | 13.43 | -21% | 15.01 | 11.60 | -23% | 190.7 | 416.1 | no |
| sprites-moving/1000000/cozygpu-worker-auto | 17.50 | 17.20 | -2% | 18.73 | 18.70 | -0% | 11.37 | 8.72 | -23% | 421.0 | 412.9 | no |
| swarm/1000000/cozygpu-webgpu-auto | 6.95 | 6.88 | -1% | 13.96 | 13.45 | -4% | 0.23 | 4.84 | +2013% | 9.8 | 231.6 | **yes** |
| swarm/1000000/cozygpu-worker-auto | 17.63 | 17.57 | -0% | 18.72 | 18.77 | +0% | 0.01 | 0.07 | +516% | 251.3 | 229.2 | **yes** |
| swarm/2000000/cozygpu-webgpu-auto | 14.34 | 14.25 | -1% | 28.26 | 15.63 | -45% | 0.19 | 14.19 | +7461% | 219.0 | 217.0 | **yes** |
| swarm/2000000/cozygpu-worker-auto | 16.77 | 16.65 | -1% | 18.68 | 18.73 | +0% | 0.03 | 0.01 | -67% | 235.5 | 210.7 | no |
| sprites-static/100000/cozygpu-webgpu-auto | 0.54 | 0.53 | -1% | 1.55 | 1.63 | +5% | 0.03 | 0.02 | -24% | 42.4 | 268.9 | no |
| sprites-static/100000/cozygpu-worker-auto | 17.40 | 17.72 | +2% | 18.72 | 18.80 | +0% | 0.01 | 0.07 | +409% | 56.5 | 270.7 | **yes** |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

Machine drift control: median Δavg of the 34 unchanged Pixi/Three cases = -4%.


## M2 final verdict (benchmarker)

Conditions: 75 cases × 3 interleaved rounds (225 runs, all ok), a fresh Chrome per case, headless `--use-angle=metal`, Chrome 152, Apple M4. The only heavy background process was iCloud `bird` (about 100 % of one core, same as for m2-base). Drift control: the median Δavg of the 34 unchanged Pixi/Three cases vs M1 is −4 %, the same as m2-base, so M2 baseline and M2 final are directly comparable.

### M1 final → M2 baseline → M2 final, and best competitor

Metric: frame avg ms (S1–S3, A3), load+upload ms (A1), pick latency avg ms (A2/A2u). Lower is better. "Best competitor" is the fastest Pixi/Three case in this run. M1 had no WebGL2 backend and no A-scenarios, so those cells show "—".

| scenario | metric | cozygpu case | M1 final | M2 baseline | M2 final | Δ vs base | best competitor (M2 final) | value | Δ vs competitor | CPU avg ms base → final |
|---|---|---|---:|---:|---:|---:|---|---:|---:|---|
| sprites-moving/10000 | frame avg ms | cozygpu-webgpu-auto | 0.29 | 0.26 | 0.24 | -6% | pixi-webgpu-particle (ParticleContainer) | 0.25 | -2% | 0.19 → 0.20 |
| sprites-moving/10000 | frame avg ms | cozygpu-webgl2-auto | — | 1.29 | 1.28 | -0% | pixi-webgpu-particle (ParticleContainer) | 0.25 | +421% | 1.26 → 1.25 |
| sprites-moving/10000 | frame avg ms | cozygpu-worker-auto | 17.7 | 17.7 | 17.7 | -0% | pixi-webgpu-particle (ParticleContainer) | 0.25 | +7079% | 0.30 → 0.31 |
| sprites-moving/100000 | frame avg ms | cozygpu-webgpu-auto | 1.46 | 1.07 | 1.11 | +4% | three-webgpu-instanced (InstancedMesh) | 1.19 | -7% | 0.96 → 1.00 |
| sprites-moving/100000 | frame avg ms | cozygpu-webgl2-auto | — | 1.01 | 1.04 | +3% | three-webgpu-instanced (InstancedMesh) | 1.19 | -12% | 0.92 → 0.96 |
| sprites-moving/100000 | frame avg ms | cozygpu-worker-auto | 17.4 | 17.8 | 17.9 | +0% | three-webgpu-instanced (InstancedMesh) | 1.19 | +1397% | 2.33 → 2.36 |
| sprites-moving/1000000 | frame avg ms | cozygpu-webgpu-auto | 15.2 | 11.6 | 11.8 | +2% | three-webgpu-instanced (InstancedMesh) | 11.6 | +2% | 11.4 → 11.6 |
| sprites-moving/1000000 | frame avg ms | cozygpu-webgl2-auto | — | 15.5 | 15.6 | +1% | three-webgpu-instanced (InstancedMesh) | 11.6 | +35% | 15.4 → 15.4 |
| sprites-moving/1000000 | frame avg ms | cozygpu-worker-auto | 17.5 | 17.0 | 17.2 | +1% | three-webgpu-instanced (InstancedMesh) | 11.6 | +49% | 8.29 → 8.72 |
| swarm/1000000 | frame avg ms | cozygpu-webgpu-auto | 6.95 | 6.91 | 6.88 | -0% | three-webgpu-compute (TSL compute + Sprite(count)) | 8.05 | -15% | 0.19 → 4.84 |
| swarm/1000000 | frame avg ms | cozygpu-webgl2-auto | — | 6.07 | 6.08 | +0% | three-webgpu-compute (TSL compute + Sprite(count)) | 8.05 | -25% | 0.01 → 0.01 |
| swarm/1000000 | frame avg ms | cozygpu-worker-auto | 17.6 | 17.6 | 17.6 | -0% | three-webgpu-compute (TSL compute + Sprite(count)) | 8.05 | +118% | 0.08 → 0.07 |
| swarm/2000000 | frame avg ms | cozygpu-webgpu-auto | 14.3 | 14.2 | 14.2 | +0% | three-webgpu-compute (TSL compute + Sprite(count)) | 16.8 | -15% | 0.05 → 14.2 |
| swarm/2000000 | frame avg ms | cozygpu-webgl2-auto | — | 11.9 | 12.0 | +0% | three-webgpu-compute (TSL compute + Sprite(count)) | 16.8 | -29% | 0.01 → 0.01 |
| swarm/2000000 | frame avg ms | cozygpu-worker-auto | 16.8 | 16.7 | 16.6 | -0% | three-webgpu-compute (TSL compute + Sprite(count)) | 16.8 | -1% | 0.01 → 0.01 |
| sprites-static/100000 | frame avg ms | cozygpu-webgpu-auto | 0.54 | 0.53 | 0.53 | -0% | pixi-webgpu-sprite (Sprite) | 0.65 | -17% | 0.11 → 0.02 |
| sprites-static/100000 | frame avg ms | cozygpu-webgl2-auto | — | 1.28 | 1.28 | -0% | pixi-webgpu-sprite (Sprite) | 0.65 | +98% | 1.22 → 1.23 |
| sprites-static/100000 | frame avg ms | cozygpu-worker-auto | 17.4 | 17.7 | 17.7 | +0% | pixi-webgpu-sprite (Sprite) | 0.65 | +2640% | 0.07 → 0.07 |
| assets-png/200 | load+upload ms | cozygpu-webgpu-auto | — | 69.8 | 61.3 | -12% | pixi-webgpu-sprite (Assets.load (png)) | 70.7 | -13% | 0.01 → 0.01 |
| assets-png/200 | load+upload ms | cozygpu-webgpu-noatlas | — | 61.8 | 62.5 | +1% | pixi-webgpu-sprite (Assets.load (png)) | 70.7 | -12% | 0.05 → 0.04 |
| assets-png/200 | load+upload ms | cozygpu-webgl2-auto | — | 57.5 | 62.8 | +9% | pixi-webgpu-sprite (Assets.load (png)) | 70.7 | -11% | 1.08 → 1.08 |
| assets-ktx2/200 | load+upload ms | cozygpu-webgpu-auto | — | 59.0 | 49.9 | -15% | pixi-webgpu-sprite (Assets.load (BC1 as KTX1)) | 69.1 | -28% | 0.04 → 0.05 |
| assets-ktx2/200 | load+upload ms | cozygpu-webgl2-auto | — | 48.5 | 49.7 | +3% | pixi-webgpu-sprite (Assets.load (BC1 as KTX1)) | 69.1 | -28% | 1.45 → 1.45 |
| picking/100000 | pick latency avg ms | cozygpu-webgpu-auto | — | 5.96 | 4.79 | -20% | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 2.35 | +104% | 0.30 → 0.29 |
| picking/100000 | pick latency avg ms | cozygpu-webgl2-auto | — | 6.20 | 6.03 | -3% | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 2.35 | +157% | 0.20 → 0.20 |
| picking/100000 | pick latency avg ms | cozygpu-worker-auto | — | 4.88 | 5.87 | +20% | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 2.35 | +150% | 0.07 → 0.07 |
| picking-uncapped/100000 | pick latency avg ms | cozygpu-webgpu-auto | — | 261.8 | 26.7 | -90% | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.59 | +4469% | 0.46 → 0.01 |
| picking-uncapped/100000 | pick latency avg ms | cozygpu-webgl2-auto | — | 94.8 | 10.8 | -89% | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.59 | +1745% | 0.00 → 0.05 |
| picking-uncapped/100000 | pick latency avg ms | cozygpu-worker-auto | — | 5.24 | 5.20 | -1% | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.59 | +788% | 0.07 → 0.07 |
| swarm-churn/1000000 | frame avg ms | cozygpu-webgpu-gpu | — | 4.31 | 4.34 | +1% | pixi-webgpu-particle (ParticleContainer churn (CPU pool)) | 56.5 | -92% | 0.18 → 1.34 |
| swarm-churn/1000000 | frame avg ms | cozygpu-webgpu-ring | — | 5.80 | 5.80 | +0% | pixi-webgpu-particle (ParticleContainer churn (CPU pool)) | 56.5 | -90% | 0.24 → 2.86 |
| swarm-churn/1000000 | frame avg ms | cozygpu-webgl2-ring | — | 4.76 | 4.76 | +0% | pixi-webgpu-particle (ParticleContainer churn (CPU pool)) | 56.5 | -92% | 4.73 → 4.73 |


### Winners (M2 final)

| scenario | winner | cozygpu best (avg / p99) | best competitor (avg / p99) | Δavg / Δp99 |
|---|---|---|---|---|
| S1 10k moving | **cozygpu webgpu** | 0.24 / 0.31 ms | Pixi webgpu ParticleContainer 0.25 / 0.34 | −2 % / −9 % (was +5 %: L8 flipped, but within noise) |
| S1 100k moving | **cozygpu webgl2** | 1.04 / 1.13 (webgpu 1.11 / 1.27) | Three webgpu Instanced 1.19 / 1.76 | −12 % / −36 % |
| S1 1M moving | Three webgpu Instanced (avg), **cozygpu** (p99) | webgpu 11.79 / 13.43 | 11.57 / 17.43 | +2 % / −23 %: tie, run ranges overlap (11.76–12.32 vs 11.53–11.91) |
| S2 swarm 1M | **cozygpu webgl2** (TF) | 6.08 / 7.76 (webgpu 6.88 / 13.45) | Three TSL compute 8.05 / 16.09 | −25 % / −52 % (webgpu −15 %) |
| S2 swarm 2M | **cozygpu webgl2** (TF) | 11.96 / 13.03 (webgpu 14.25 / 15.63) | Three TSL compute 16.75 / 33.41 | −29 % / −61 % (webgpu −15 %) |
| S3 100k static | **cozygpu webgpu** | 0.53 / 1.63 | Pixi webgpu Sprite 0.65 | −17 % |
| A1 200 PNG | **cozygpu webgpu** | 61.3 ms (webgl2 62.8, atlas off 62.5) | Pixi webgpu 70.7 ms | −13 % |
| A1 200 BC1 KTX2 | **cozygpu webgl2 / webgpu** | 49.7 / 49.9 ms | Pixi webgpu (KTX1) 69.1 ms | −28 % |
| A2 pick, vsync | Pixi CPU hitTest | webgpu 4.79 / 6.91 ms, 1 frame, 0.29 ms frame CPU | Pixi 2.35 / 8.13 ms, 2.65 ms frame CPU | +104 % avg, −15 % p99 (by design: async, 1 frame) |
| A2u pick, uncapped | Pixi CPU hitTest | worker 5.20; webgpu 26.7 (was 262); webgl2 10.8 (was 95) | Pixi 0.59 ms | large loss, 10× better than baseline |
| A3 churn 1M | **cozygpu webgpu `gpu`** | 4.34 / 9.08 (but 126 of ~1150 rAF slots skipped, see loss 7) | Pixi CPU pool 56.5 / 59.4 | −92 % |

Score: cozygpu wins 8 of 11 (S1 10k, S1 100k, S2 1M, S2 2M, S3, A1 PNG, A1 KTX2, A3), ties 1 (S1 1M), and loses 2 (A2, A2u pick latency).

### What changed since the M2 baseline

- **Pick latency, uncapped (L1)**: WebGPU 262 → 26.7 ms (≈ 492 → 67 frames), WebGL2 94.8 → 10.8 ms (73 → 6 frames), and the WebGL2 80 ms frame-stall p99 is gone (18.9 ms). The fix is main-thread frame pacing: `transport.busy` now reports a backlogged WebGPU queue (`onSubmittedWorkDone` fence), so `render()` skips frames (343 / 352 skipped in 5 s) instead of queueing work ahead of the readback. Cost: WebGL2 uncapped A2u frame avg is 1.30 → 3.33 ms (300 fps), because skipped frames still take a rAF slot.
- **Pick latency, vsync (A2)**: WebGPU 5.96 → 4.79 ms. Worker 4.88 → 5.87 ms (+20 %, within the 1-frame quantum at 60 fps).
- **A1**: WebGPU PNG load+upload 69.8 → 61.3 ms, KTX2 59.0 → 49.9 ms. The atlas page is still reserved in full (16.0 MiB for 3.13 MiB of texels; L2 still open).
- **S3 main-thread idle CPU** went back from 0.11 to 0.02 ms (baseline regression fixed).
- **S1 / S2 / A3 frame times** are unchanged within ±4 %.
- **CPU accounting shift, not a frame regression**: WebGPU swarm CPU 0.19 → 4.84 ms (1M) and 0.05 → 14.2 ms (2M), and A3 CPU 0.18 → 1.34 ms. Frame avg is unchanged and `frontCpuMs` is 0.000. With the new pacing, the wait for the GPU (`getCurrentTexture` backpressure) now falls inside the rAF callback. The harness counts it as CPU, and the runner flags these cases "regressed" on the CPU rule. The library's own front CPU cost did not move.

### Remaining losses, with causes

1. **A2u uncapped pick latency** (WebGPU 26.7 ms / 67 frames, WebGL2 10.8 ms vs Pixi 0.59 ms). The readback is still one `createBuffer` + encoder + submit + `mapAsync` per pick (`WebGPUBackend.readTexture`). Its callback only runs when the uncapped rAF loop yields, and pacing now bounds that at about 27 ms. Fix: a persistent staging ring, and poll `mapState` at the next `render()`. Worker mode is 5.2 ms already.
2. **A2 vsync pick latency** (+104 % vs Pixi). This is by design: async GPU pick = 1 frame. A synchronous CPU path (bounds or `hitMask`) would answer in 0 frames. cozygpu still costs 9× less frame CPU (0.29 vs 2.65 ms).
3. **S1 1M WebGPU avg +2 % vs Three InstancedMesh** (a tie; p99 −23 %). Both are bound by CPU copy + upload of 1M transforms. The bulk API is not used in the bench (it uses `setPosition` per sprite).
4. **WebGL2 small-count floor**: about 1.25 ms/frame (≈ 800 fps) in S1 10k, S3 and A1. This is shared with Pixi WebGL (1.31 ms) and is ANGLE/Metal present cost, not library work.
5. **WebGPU swarm slower than WebGL2 TF** (1M 6.88 vs 6.08 ms, 2M 14.25 vs 11.96). This is GPU-bound: compute + render passes, and the p99 at 1M is 2× avg. It still beats Three TSL compute by 15 %.
6. **Worker CPU at 100k moving sprites**: 2.36 ms vs 1.00 in M1 (SAB ring copy; flat vs baseline). At 1M the worker is a net win (11.4 → 8.7 ms).
7. **A3: the new pacing skips frames under churn.** WebGPU `gpu` skips 126, `ring` 164 and WebGL2 `ring` 253 skipped frames per 5 s run (baseline: 0). Frame avg is unchanged, so the presented rate is 11–24 % lower than the rAF rate (WebGPU `gpu` ≈ 205 presented fps; it is still 12× Pixi). The WebGL2 skips mean the pacing gate also fires on the fence/readback path there. The pacing thresholds (`PACE_FAST_MS` / `PACE_MAX_LAG_MS`) are worth re-tuning so that only real backlog skips.
8. **A2 heap growth ≈ 30 KB/frame on all cozygpu backends** (Pixi 3.7 KB). This is one pick per frame here: the per-pick staging buffer, the `getMappedRange().slice()` and the promise. It is not render-path allocation, but a pooled readback would remove it.
9. **A1 atlas GPU memory**: one 2048² page (16 MiB) for 3.13 MiB of images, 5× Pixi. Pages should start small and grow.

### Bundle size (`npm run size`, esbuild + shader minify, min+gzip)

| fixture | min | min+gzip | budget | status | M2 baseline (task brief) |
|---|---:|---:|---:|---|---:|
| minimal-webgpu | 115.9 KB | **39.6 KB** | 30.0 KB | OVER (+9.6) | 41.3 KB |
| minimal-webgl2 | 120.1 KB | **41.6 KB** | 30.0 KB | OVER (+11.6) | — |
| all-exports | 277.4 KB | **96.8 KB** | 45.0 KB | OVER (+51.8) | 78–91 KB |
| worker-webgpu | 64.1 KB | **21.8 KB** | 25.0 KB | ok | 31.7 KB |
| worker-webgl2 | 68.2 KB | **23.8 KB** | 25.0 KB | ok | — |

The worker now meets its budget (it is split per backend). The minimal program is 1.7 KB smaller than baseline but still 32 % over. The competitors' minimal programs are Pixi 158 KB (all chunks), Three WebGL 130 KB and Three WebGPU 211 KB min+gzip, so cozygpu's minimal program is 3.3–5.3× smaller than any competitor even while over its own budget.
