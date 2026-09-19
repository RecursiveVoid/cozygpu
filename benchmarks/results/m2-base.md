# Benchmark results — m2-base

- Date: 2026-09-18T15:14:27.379Z
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
| 10k | cozygpu · webgpu | Sprite | 3904.1 | 0.26 | 0.30 | 0.19 | 0.21 | 41.4 | 0.26–0.26 | ok |
| 10k | cozygpu · webgl2 | Sprite | 775.4 | 1.29 | 2.59 | 1.26 | 2.55 | 68.1 | 1.29–1.29 | ok |
| 10k | cozygpu · worker | Sprite | 56.5 | 17.70 | 18.80 | 0.30 | 0.38 | -2358.9 | 17.69–17.78 | ok (1 skipped) |
| 10k | pixi · webgpu | Sprite | 1034.3 | 0.97 | 1.11 | 0.88 | 0.93 | -879.0 | 0.96–0.97 | ok |
| 10k | pixi · webgpu | ParticleContainer | 4081.7 | 0.24 | 0.34 | 0.16 | 0.19 | -2.8 | 0.24–0.25 | ok |
| 10k | pixi · webgl | Sprite | 747.4 | 1.34 | 2.16 | 1.25 | 2.05 | 2780.0 | 1.33–1.34 | ok |
| 10k | pixi · webgl | ParticleContainer | 783.5 | 1.28 | 2.57 | 1.24 | 2.52 | -47.3 | 1.27–1.28 | ok |
| 10k | three · webgl | InstancedMesh | 774.2 | 1.29 | 2.64 | 1.26 | 2.60 | 254.5 | 1.29–1.30 | ok |
| 10k | three · webgpu | InstancedMesh | 3263.2 | 0.31 | 0.38 | 0.24 | 0.26 | 5.2 | 0.31–0.31 | ok |
| 100k | cozygpu · webgpu | Sprite | 938.3 | 1.07 | 1.23 | 0.96 | 1.08 | 1084.4 | 1.06–1.07 | ok |
| 100k | cozygpu · webgl2 | Sprite | 989.4 | 1.01 | 1.21 | 0.92 | 1.06 | 550.7 | 0.99–1.47 | ok |
| 100k | cozygpu · worker | Sprite | 56.2 | 17.80 | 18.84 | 2.33 | 2.70 | 165.1 | 17.77–17.85 | ok |
| 100k | pixi · webgpu | Sprite | 103.1 | 9.70 | 10.16 | 9.59 | 10.03 | 620.9 | 9.69–9.76 | ok |
| 100k | pixi · webgpu | ParticleContainer | 520.2 | 1.92 | 2.13 | 1.76 | 1.91 | 983.1 | 1.92–1.93 | ok |
| 100k | pixi · webgl | Sprite | 110.9 | 9.02 | 9.72 | 8.93 | 9.50 | 1053.0 | 8.99–9.18 | ok |
| 100k | pixi · webgl | ParticleContainer | 653.8 | 1.53 | 2.21 | 1.36 | 1.98 | 83.4 | 1.53–1.53 | ok |
| 100k | three · webgl | InstancedMesh | 767.0 | 1.30 | 2.30 | 1.23 | 2.20 | 140.6 | 1.30–1.30 | ok |
| 100k | three · webgpu | InstancedMesh | 818.9 | 1.22 | 1.78 | 1.02 | 1.43 | 197.2 | 1.22–1.23 | ok |
| 1M | cozygpu · webgpu | Sprite | 86.5 | 11.56 | 13.61 | 11.39 | 13.41 | -26761.8 | 11.54–11.80 | ok |
| 1M | cozygpu · webgl2 | Sprite | 64.5 | 15.50 | 16.06 | 15.39 | 15.96 | 26386.9 | 15.42–15.58 | ok |
| 1M | cozygpu · worker | Sprite | 58.8 | 17.01 | 18.75 | 8.29 | 8.85 | 16942.8 | 16.96–17.07 | ok |
| 1M | pixi · webgpu | Sprite | 9.5 | 105.08 | 107.40 | 104.87 | 107.25 | 77183.5 | 104.38–106.44 | ok |
| 1M | pixi · webgpu | ParticleContainer | 68.0 | 14.71 | 17.05 | 14.54 | 16.82 | 9188.7 | 14.68–14.99 | ok |
| 1M | pixi · webgl | Sprite | 9.9 | 101.00 | 103.14 | 100.91 | 105.50 | 150760.9 | 99.59–103.09 | ok |
| 1M | pixi · webgl | ParticleContainer | 68.7 | 14.55 | 15.31 | 14.46 | 15.21 | 4017.2 | 14.54–14.63 | ok |
| 1M | three · webgl | InstancedMesh | 46.3 | 21.62 | 22.38 | 21.51 | 22.24 | 969.3 | 21.24–21.87 | ok |
| 1M | three · webgpu | InstancedMesh | 85.5 | 11.69 | 17.87 | 11.53 | 17.74 | 899.1 | 11.59–11.70 | ok |

## S2 — swarm (GPU-simulated where supported, else best CPU path)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 144.8 | 6.91 | 14.09 | 0.19 | 6.78 | 411.3 | 6.87–6.92 | ok |
| 1M | cozygpu · webgl2 | Swarm (transform feedback) | 164.7 | 6.07 | 8.91 | 0.01 | 0.07 | 280.4 | 6.07–6.08 | ok |
| 1M | cozygpu · worker | Swarm (GPU compute) | 56.8 | 17.61 | 18.77 | 0.08 | 0.12 | 461.0 | 17.45–17.69 | ok (1 skipped) |
| 1M | pixi · webgpu | ParticleContainer | 69.1 | 14.48 | 15.07 | 14.37 | 14.98 | -9676.3 | 14.38–14.51 | ok |
| 1M | pixi · webgl | ParticleContainer | 72.8 | 13.74 | 14.41 | 13.64 | 14.27 | 37811.9 | 13.68–13.78 | ok |
| 1M | three · webgl | InstancedMesh | 52.6 | 19.00 | 19.65 | 18.88 | 19.55 | 584.5 | 18.94–19.19 | ok |
| 1M | three · webgpu | InstancedMesh | 88.8 | 11.26 | 16.90 | 11.10 | 16.77 | 3797.4 | 11.23–11.31 | ok |
| 1M | three · webgpu | TSL compute + Sprite(count) | 124.2 | 8.05 | 15.93 | 8.02 | 15.89 | 1972.3 | 8.05–8.14 | ok |
| 2M | cozygpu · webgpu | Swarm (GPU compute) | 70.5 | 14.18 | 17.68 | 0.05 | 0.11 | 425.1 | 14.17–14.21 | ok |
| 2M | cozygpu · webgl2 | Swarm (transform feedback) | 84.0 | 11.91 | 12.83 | 0.01 | 0.09 | 282.9 | 11.89–11.91 | ok |
| 2M | cozygpu · worker | Swarm (GPU compute) | 60.0 | 16.67 | 18.74 | 0.01 | 0.02 | 477.6 | 16.66–16.82 | ok (1 skipped) |
| 2M | pixi · webgpu | ParticleContainer | 35.2 | 28.45 | 29.84 | 28.32 | 29.65 | 90316.5 | 28.33–28.50 | ok |
| 2M | pixi · webgl | ParticleContainer | 37.0 | 27.05 | 28.29 | 26.95 | 28.15 | 28278.6 | 26.96–27.35 | ok |
| 2M | three · webgl | InstancedMesh | 13.7 | 73.06 | 75.43 | 72.89 | 75.13 | 7730.7 | 72.15–73.07 | ok |
| 2M | three · webgpu | InstancedMesh | 43.4 | 23.05 | 39.74 | 22.88 | 39.62 | 4332.1 | 22.59–23.81 | ok |
| 2M | three · webgpu | TSL compute + Sprite(count) | 59.7 | 16.76 | 33.64 | 16.71 | 33.61 | 5206.4 | 16.75–16.81 | ok |

## S3 — static sprites (nothing moves)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 1869.4 | 0.53 | 1.57 | 0.11 | 1.13 | -15.6 | 0.53–0.55 | ok |
| 100k | cozygpu · webgl2 | Sprite | 778.2 | 1.28 | 2.57 | 1.22 | 2.50 | 196.6 | 1.28–1.29 | ok |
| 100k | cozygpu · worker | Sprite | 56.5 | 17.69 | 18.79 | 0.07 | 0.11 | 390.4 | 17.68–17.72 | ok (1 skipped) |
| 100k | pixi · webgpu | Sprite | 1546.8 | 0.65 | 1.65 | 0.16 | 1.36 | 2234.9 | 0.65–0.65 | ok |
| 100k | pixi · webgpu | ParticleContainer | 1505.6 | 0.66 | 1.70 | 0.23 | 1.24 | -1051.2 | 0.66–0.67 | ok |
| 100k | pixi · webgl | Sprite | 767.8 | 1.30 | 2.58 | 1.22 | 2.50 | 1126.4 | 1.29–1.30 | ok |
| 100k | pixi · webgl | ParticleContainer | 779.7 | 1.28 | 2.52 | 1.22 | 2.44 | 1165.8 | 1.28–1.29 | ok |
| 100k | three · webgl | InstancedMesh | 633.2 | 1.58 | 2.60 | 1.25 | 2.52 | 108.7 | 1.51–1.58 | ok |
| 100k | three · webgpu | InstancedMesh | 1339.2 | 0.75 | 0.98 | 0.63 | 0.80 | 94.3 | 0.75–0.75 | ok |

## A1 — load + upload 200 × 64² PNG

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 200 | cozygpu · webgpu | Assets.loadAll (png) | 10643.3 | 0.09 | 0.93 | 0.01 | 0.08 | 28.0 | 0.09–0.09 | ok |
| 200 | cozygpu · webgpu | Assets.loadAll (png, atlas off) | 7326.8 | 0.14 | 0.22 | 0.05 | 0.09 | 58.3 | 0.12–0.15 | ok |
| 200 | cozygpu · webgl2 | Assets.loadAll (png) | 806.1 | 1.24 | 2.55 | 1.08 | 2.48 | -251.3 | 1.23–1.24 | ok |
| 200 | pixi · webgpu | Assets.load (png) | 6558.9 | 0.15 | 0.70 | 0.05 | 0.46 | 80.2 | 0.15–0.15 | ok |
| 200 | pixi · webgl | Assets.load (png) | 763.4 | 1.31 | 2.64 | 0.16 | 2.48 | 136.7 | 1.31–1.31 | ok |

| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|
| cozygpu · webgpu | Assets.loadAll (png) | 63.5 | 64.5 | 5.4 | 69.8 | 16.00 MiB | 1 | rgba8unorm | 527.0 KB | 1 | ok |
| cozygpu · webgpu | Assets.loadAll (png, atlas off) | 55.4 | 56.3 | 5.5 | 61.8 | 3.13 MiB | 0 | rgba8unorm | 669.9 KB | 200 | ok |
| cozygpu · webgl2 | Assets.loadAll (png) | 51.9 | 52.9 | 4.6 | 57.5 | 16.00 MiB | 1 | rgba8unorm | 539.4 KB | 1 | ok |
| pixi · webgpu | Assets.load (png) | 60.7 | 61.7 | 7.6 | 69.3 | 3.13 MiB (est.) | — | bgra8unorm | 1193.9 KB | — | ok |
| pixi · webgl | Assets.load (png) | 68.5 | 69.5 | 11.1 | 80.6 | 3.13 MiB (est.) | — | bgra8unorm | 1114.6 KB | — | ok |

GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).

## A1 — load + upload 200 × 64² KTX2 (BC1, no supercompression)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 200 | cozygpu · webgpu | Assets.loadAll (ktx2) | 8027.9 | 0.12 | 0.19 | 0.04 | 0.08 | 26.1 | 0.12–0.14 | ok |
| 200 | cozygpu · webgl2 | Assets.loadAll (ktx2) | 657.8 | 1.52 | 2.89 | 1.45 | 2.77 | 213.9 | 1.51–1.53 | ok |
| 200 | pixi · webgpu | Assets.load (BC1 as KTX1) | 6851.5 | 0.15 | 0.66 | 0.04 | 0.44 | 14.4 | 0.14–0.15 | ok |
| 200 | pixi · webgl | Assets.load (BC1 as KTX1) | 768.0 | 1.30 | 2.64 | 0.04 | 2.45 | 142.0 | 1.30–1.30 | ok |

| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|
| cozygpu · webgpu | Assets.loadAll (ktx2) | 54.1 | 55.1 | 3.9 | 59.0 | 0.39 MiB | 0 | bc1-rgba-unorm | 1119.6 KB | 200 | ok |
| cozygpu · webgl2 | Assets.loadAll (ktx2) | 44.2 | 45.1 | 3.4 | 48.5 | 0.39 MiB | 0 | bc1-rgba-unorm | 1200.3 KB | 200 | ok |
| pixi · webgpu | Assets.load (BC1 as KTX1) | 54.3 | 55.2 | 12.1 | 67.3 | 0.39 MiB (est.) | — | bc1-rgba-unorm | 1668.4 KB | — | ok |
| pixi · webgl | Assets.load (BC1 as KTX1) | 165.3 | 166.3 | 6.5 | 172.8 | 0.39 MiB (est.) | — | bc1-rgba-unorm | 1586.4 KB | — | ok |

GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).

## A2 — picking latency at 100k static sprites (one pick in flight, vsync ON = 60 fps like a real page)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 60.0 | 16.67 | 18.59 | 0.30 | 0.45 | -6240.3 | 16.67–16.67 | ok |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 60.0 | 16.67 | 18.46 | 0.20 | 0.33 | 26226.7 | 16.67–16.67 | ok |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 60.0 | 16.67 | 18.57 | 0.07 | 0.12 | -4905.6 | 16.67–16.67 | ok |
| 100k | pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 60.0 | 16.67 | 18.57 | 2.58 | 8.61 | 3688.9 | 16.67–16.67 | ok |
| 100k | three · webgl | InstancedMesh + Raycaster (CPU) | 60.0 | 16.66 | 18.61 | 6.59 | 6.91 | 1945.0 | 16.66–16.67 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 300 | 100% | 5.96 | 6.22 | 7.54 | 8.61 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · webgl2 | Sprite + renderer.pick() | 300 | 100% | 6.20 | 6.29 | 8.19 | 13.41 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · worker | Sprite + renderer.pick() | 300 | 100% | 4.88 | 4.75 | 7.33 | 7.67 | 1.00 | 1.0 | 16.67 | ok |
| pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 301 | 100% | 2.29 | 1.76 | 8.03 | 10.22 | 0.00 | 0.0 | 16.67 | ok |
| three · webgl | InstancedMesh + Raycaster (CPU) | 302 | 100% | 6.56 | 6.57 | 6.89 | 6.95 | 0.00 | 0.0 | 16.66 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A2u — picking at 100k, frame-rate limit OFF (stress: async readbacks compete with an uncapped rAF loop)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 1877.8 | 0.53 | 2.12 | 0.46 | 2.05 | 99.9 | 0.53–0.53 | ok |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 767.8 | 1.30 | 80.24 | 0.00 | 0.04 | 796.0 | 1.30–1.30 | ok |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 56.5 | 17.71 | 18.79 | 0.07 | 0.12 | 6589.6 | 17.68–17.73 | ok (1 skipped) |
| 100k | pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 1472.5 | 0.68 | 3.36 | 0.62 | 3.21 | -240.0 | 0.67–0.71 | ok |
| 100k | three · webgl | InstancedMesh + Raycaster (CPU) | 198.8 | 5.03 | 5.18 | 4.96 | 5.04 | -188.9 | 5.00–5.08 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 19 | 100% | 261.81 | 261.86 | 269.31 | 269.31 | 492.11 | 496.0 | 0.53 | ok |
| cozygpu · webgl2 | Sprite + renderer.pick() | 53 | 100% | 94.82 | 100.86 | 143.77 | 143.77 | 72.96 | 110.0 | 1.30 | ok |
| cozygpu · worker | Sprite + renderer.pick() | 273 | 100% | 5.24 | 4.96 | 7.69 | 9.16 | 1.04 | 2.0 | 17.71 | ok (1 skipped) |
| pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 7364 | 100% | 0.60 | 0.36 | 3.14 | 6.83 | 0.00 | 0.0 | 0.68 | ok |
| three · webgl | InstancedMesh + Raycaster (CPU) | 996 | 100% | 4.94 | 4.94 | 5.02 | 5.23 | 0.00 | 0.0 | 5.03 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A3 — swarm spawn/kill churn (capacity 1M, 8000 spawns/frame, life 0.5–1.5 s ⇒ ~480k alive)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm churn (allocation 'gpu') | 232.0 | 4.31 | 8.95 | 0.18 | 4.42 | -201.6 | 4.30–4.31 | ok |
| 1M | cozygpu · webgpu | Swarm churn (allocation 'ring') | 172.6 | 5.80 | 11.59 | 0.24 | 5.76 | -412.2 | 5.79–5.80 | ok |
| 1M | cozygpu · webgl2 | Swarm churn (allocation 'ring') | 210.0 | 4.76 | 5.25 | 4.73 | 5.16 | -444.8 | 4.76–4.77 | ok |
| 1M | pixi · webgpu | ParticleContainer churn (CPU pool) | 17.8 | 56.32 | 59.38 | 56.23 | 59.17 | 28060.0 | 56.31–56.33 | ok |

| engine | tool | alive at end | spawns/frame | draw calls | front CPU ms | packet B | status |
|---|---|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Swarm churn (allocation 'gpu') | 475526 | 8000 | 1 | 0.00 | 232 | ok |
| cozygpu · webgpu | Swarm churn (allocation 'ring') | 476168 | 8000 | 1 | 0.00 | 232 | ok |
| cozygpu · webgl2 | Swarm churn (allocation 'ring') | 476271 | 8000 | 1 | 0.00 | 232 | ok |
| pixi · webgpu | ParticleContainer churn (CPU pool) | 476269 | 8000 | — | — | — | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 243.6 | 12.8 | 12.7 | 268.7 | 354.1 B | 55008.1 KB | 2.9 |
| cozygpu · webgl2 | Sprite | 249.1 | 12.6 | 12.1 | 274.8 | 354.1 B | 55105.1 KB | 3.9 |
| cozygpu · worker | Sprite | 244.7 | 12.5 | 10.9 | 268.8 | 300.5 B | 49636.8 KB | 5.2 |
| pixi · webgpu | Sprite | 235.6 | 43.1 | 117.2 | 395.7 | 1299.0 B | 148746.1 KB | 53.1 |
| pixi · webgpu | ParticleContainer | 235.6 | 37.7 | 9.3 | 282.7 | 304.6 B | 51628.3 KB | 0.9 |
| pixi · webgl | Sprite | 110.9 | 47.5 | 132.9 | 290.2 | 1298.9 B | 148576.5 KB | 54.1 |
| pixi · webgl | ParticleContainer | 109.0 | 40.8 | 15.8 | 167.0 | 304.4 B | 51459.1 KB | 4.9 |
| three · webgl | InstancedMesh | 37.9 | 2.8 | 20.7 | 61.7 | 66.9 B | 27878.4 KB | 0.4 |
| three · webgpu | InstancedMesh | 227.7 | 2.9 | 14.5 | 245.2 | 73.0 B | 28761.4 KB | 1.0 |

### Init at 1M+ objects (S1/S2)

| scenario | count | engine | tool | total init ms | heap / object | destroy ms |
|---|---:|---|---|---:|---:|---:|
| sprites-moving | 1M | cozygpu · webgpu | Sprite | 409.2 | 295.7 B | 16.6 |
| sprites-moving | 1M | cozygpu · webgl2 | Sprite | 421.3 | 295.7 B | 17.8 |
| sprites-moving | 1M | cozygpu · worker | Sprite | 404.7 | 253.7 B | 12.7 |
| sprites-moving | 1M | pixi · webgpu | Sprite | 1838.0 | 1298.6 B | 266.6 |
| sprites-moving | 1M | pixi · webgpu | ParticleContainer | 623.3 | 302.8 B | 0.8 |
| sprites-moving | 1M | pixi · webgl | Sprite | 1722.4 | 1298.6 B | 262.6 |
| sprites-moving | 1M | pixi · webgl | ParticleContainer | 526.2 | 302.8 B | 2.0 |
| sprites-moving | 1M | three · webgl | InstancedMesh | 89.4 | 64.3 B | 0.2 |
| sprites-moving | 1M | three · webgpu | InstancedMesh | 243.6 | 64.9 B | 1.0 |
| swarm | 1M | cozygpu · webgpu | Swarm (GPU compute) | 229.9 | 0.1 B | 0.5 |
| swarm | 1M | cozygpu · webgl2 | Swarm (transform feedback) | 235.8 | 0.1 B | 1.0 |
| swarm | 1M | cozygpu · worker | Swarm (GPU compute) | 229.9 | 0.1 B | 0.6 |
| swarm | 1M | pixi · webgpu | ParticleContainer | 622.1 | 302.8 B | 0.8 |
| swarm | 1M | pixi · webgl | ParticleContainer | 527.3 | 302.8 B | 1.8 |
| swarm | 1M | three · webgl | InstancedMesh | 88.8 | 64.3 B | 0.2 |
| swarm | 1M | three · webgpu | InstancedMesh | 244.2 | 64.9 B | 2.6 |
| swarm | 1M | three · webgpu | TSL compute + Sprite(count) | 229.3 | 16.9 B | 1.0 |
| swarm | 2M | cozygpu · webgpu | Swarm (GPU compute) | 217.7 | 0.1 B | 0.5 |
| swarm | 2M | cozygpu · webgl2 | Swarm (transform feedback) | 222.6 | 0.1 B | 0.6 |
| swarm | 2M | cozygpu · worker | Swarm (GPU compute) | 207.0 | 0.0 B | 0.6 |
| swarm | 2M | pixi · webgpu | ParticleContainer | 994.6 | 303.9 B | 2.2 |
| swarm | 2M | pixi · webgl | ParticleContainer | 976.9 | 303.9 B | 2.3 |
| swarm | 2M | three · webgl | InstancedMesh | 114.7 | 64.1 B | 0.4 |
| swarm | 2M | three · webgpu | InstancedMesh | 245.3 | 64.4 B | 2.1 |
| swarm | 2M | three · webgpu | TSL compute + Sprite(count) | 222.0 | 16.5 B | 0.7 |
| swarm-churn | 1M | cozygpu · webgpu | Swarm churn (allocation 'gpu') | 235.1 | 0.1 B | 1.1 |
| swarm-churn | 1M | cozygpu · webgpu | Swarm churn (allocation 'ring') | 236.2 | 0.1 B | 1.0 |
| swarm-churn | 1M | cozygpu · webgl2 | Swarm churn (allocation 'ring') | 237.2 | 0.1 B | 0.9 |
| swarm-churn | 1M | pixi · webgpu | ParticleContainer churn (CPU pool) | 543.1 | 150.9 B | 1.1 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 15 | 219.4 KB | 73.6 KB | 229.2 KB | 78.4 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 16 | 241.1 KB | 80.5 KB | 274.5 KB | 94.3 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 4 | 124.4 KB | 40.7 KB | 125.7 KB | 41.4 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 12 | 173.0 KB | 60.5 KB |
| cozygpu · webgl2 | 12 | 176.6 KB | 62.4 KB |
| cozygpu · worker | 13 | 281.5 KB | 94.2 KB |
| pixi · webgpu | 22 | 581.0 KB | 179.3 KB |
| pixi · webgl | 22 | 580.9 KB | 179.2 KB |
| three · webgl | 4 | 570.0 KB | 144.7 KB |
| three · webgpu | 4 | 898.5 KB | 250.2 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-moving/10000 | frame ms | pixi-webgpu-particle | cozygpu-webgpu-auto | 0.26 | 0.30 | pixi-webgpu-particle (ParticleContainer) | 0.24 | 0.34 | +5% | -10% | +5% | +426% |
| sprites-moving/100000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 1.01 | 1.21 | three-webgpu-instanced (InstancedMesh) | 1.22 | 1.78 | -17% | -32% | -13% | -17% |
| sprites-moving/1000000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 11.56 | 13.61 | three-webgpu-instanced (InstancedMesh) | 11.69 | 17.87 | -1% | -24% | -1% | +33% |
| swarm/1000000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 6.07 | 8.91 | three-webgpu-compute (TSL compute + Sprite(count)) | 8.05 | 15.93 | -25% | -44% | -14% | -25% |
| swarm/2000000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 11.91 | 12.83 | three-webgpu-compute (TSL compute + Sprite(count)) | 16.76 | 33.64 | -29% | -62% | -15% | -29% |
| sprites-static/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.53 | 1.57 | pixi-webgpu-sprite (Sprite) | 0.65 | 1.65 | -17% | -5% | -17% | +99% |
| assets-png/200 | load+upload ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 57.46 | — | pixi-webgpu-sprite (Assets.load (png)) | 69.29 | — | -17% | — | -11% | -17% |
| assets-ktx2/200 | load+upload ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 48.48 | — | pixi-webgpu-sprite (Assets.load (BC1 as KTX1)) | 67.29 | — | -28% | — | -12% | -28% |
| picking/100000 | pick latency ms | pixi-webgpu-sprite | cozygpu-worker-auto | 4.88 | 7.33 | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 2.29 | 8.03 | +113% | -9% | +160% | +170% |
| picking-uncapped/100000 | pick latency ms | pixi-webgpu-sprite | cozygpu-worker-auto | 5.24 | 7.69 | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.60 | 3.14 | +776% | +145% | +43648% | +15745% |
| swarm-churn/1000000 | frame ms | cozygpu-webgpu-gpu | cozygpu-webgpu-gpu | 4.31 | 8.95 | pixi-webgpu-particle (ParticleContainer churn (CPU pool)) | 56.32 | 59.38 | -92% | -85% | -92% | -92% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m1-final (same case ids)

| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sprites-moving/10000/cozygpu-webgpu-auto | 0.29 | 0.26 | -11% | 0.51 | 0.30 | -41% | 0.21 | 0.19 | -9% | 256.0 | 250.0 | no |
| sprites-moving/10000/cozygpu-worker-auto | 17.71 | 17.70 | -0% | 18.74 | 18.80 | +0% | 0.12 | 0.30 | +138% | 258.5 | 254.2 | **yes** |
| sprites-moving/100000/cozygpu-webgpu-auto | 1.46 | 1.07 | -27% | 1.77 | 1.23 | -31% | 1.33 | 0.96 | -28% | 92.7 | 269.2 | no |
| sprites-moving/100000/cozygpu-worker-auto | 17.43 | 17.80 | +2% | 18.73 | 18.84 | +1% | 1.00 | 2.33 | +134% | 286.3 | 271.5 | **yes** |
| sprites-moving/1000000/cozygpu-webgpu-auto | 15.18 | 11.56 | -24% | 16.90 | 13.61 | -19% | 15.01 | 11.39 | -24% | 190.7 | 409.2 | no |
| sprites-moving/1000000/cozygpu-worker-auto | 17.50 | 17.01 | -3% | 18.73 | 18.75 | +0% | 11.37 | 8.29 | -27% | 421.0 | 404.7 | no |
| swarm/1000000/cozygpu-webgpu-auto | 6.95 | 6.91 | -1% | 13.96 | 14.09 | +1% | 0.23 | 0.19 | -18% | 9.8 | 229.9 | no |
| swarm/1000000/cozygpu-worker-auto | 17.63 | 17.61 | -0% | 18.72 | 18.77 | +0% | 0.01 | 0.08 | +601% | 251.3 | 229.9 | **yes** |
| swarm/2000000/cozygpu-webgpu-auto | 14.34 | 14.18 | -1% | 28.26 | 17.68 | -37% | 0.19 | 0.05 | -71% | 219.0 | 217.7 | no |
| swarm/2000000/cozygpu-worker-auto | 16.77 | 16.67 | -1% | 18.68 | 18.74 | +0% | 0.03 | 0.01 | -68% | 235.5 | 207.0 | no |
| sprites-static/100000/cozygpu-webgpu-auto | 0.54 | 0.53 | -1% | 1.55 | 1.57 | +1% | 0.03 | 0.11 | +298% | 42.4 | 268.7 | **yes** |
| sprites-static/100000/cozygpu-worker-auto | 17.40 | 17.69 | +2% | 18.72 | 18.79 | +0% | 0.01 | 0.07 | +419% | 56.5 | 268.8 | **yes** |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

Machine drift control: median Δavg of the 34 unchanged Pixi/Three cases = -4%.


## M2 baseline verdict (benchmarker)

Conditions: 75 cases × 3 interleaved rounds, a fresh Chrome per case, all 225 runs ok. The only heavy background process was iCloud `bird` (about 100 % of one core, a system daemon that was not stopped). The drift control is the median Δavg of the 34 unchanged Pixi/Three cases vs M1: −4 %. A2 runs with vsync ON (a real page). A2u repeats it uncapped as a stress test.

### Winners (avg / p99, cozygpu best vs best competitor)

| scenario | winner | cozygpu best | best competitor | Δavg / Δp99 |
|---|---|---|---|---|
| S1 10k moving | Pixi webgpu ParticleContainer | webgpu 0.26 / 0.30 ms | 0.24 / 0.34 ms | +5 % / −10 % (loss, within noise) |
| S1 100k moving | **cozygpu webgl2** | webgl2 1.01 / 1.21 (webgpu 1.07 / 1.23) | Three webgpu Instanced 1.22 / 1.78 | −17 % / −32 % |
| S1 1M moving | **cozygpu webgpu** | 11.56 / 13.61 | Three webgpu Instanced 11.69 / 17.87 | −1 % / −24 % (tie on avg) |
| S2 swarm 1M | **cozygpu webgl2** (TF) | webgl2 6.07 / 8.91 (webgpu 6.91 / 14.09) | Three TSL compute 8.05 / 15.93 | −25 % / −44 % |
| S2 swarm 2M | **cozygpu webgl2** (TF) | webgl2 11.91 / 12.83 (webgpu 14.18 / 17.68) | Three TSL compute 16.76 / 33.64 | −29 % / −62 % |
| S3 100k static | **cozygpu webgpu** | 0.53 / 1.57 | Pixi webgpu Sprite 0.65 / 1.65 | −17 % / −5 % |
| A1 200 PNG, load+upload | **cozygpu webgl2** 57.5 ms | webgpu 69.8 ms (atlas off 61.8) | Pixi webgpu 69.3 ms | −17 % (webgpu: +1 %, a tie) |
| A1 200 BC1 KTX2, load+upload | **cozygpu webgl2** 48.5 ms | webgpu 59.0 ms | Pixi webgpu (KTX1) 67.3 ms | −28 % (webgpu −12 %) |
| A2 pick latency, vsync | Pixi hitTest 2.29 / 8.03 ms | worker 4.88 / 7.33 (webgpu 5.96 / 7.54, webgl2 6.20 / 8.19) | Pixi | +113 % / −9 %. cozygpu resolves in exactly 1 frame and costs 0.30 ms of frame CPU; Pixi costs 2.58 ms and Three 6.59 ms of frame CPU |
| A2u pick latency, uncapped | Pixi 0.60 / 3.14 ms | worker 5.24 / 7.69; **webgpu 262 ms (≈ 492 frames)**, **webgl2 95 ms (≈ 73 frames), frame p99 80 ms** | Pixi | large loss (see L1) |
| A3 churn 1M cap, about 476k alive | **cozygpu webgpu `gpu`** 4.31 / 8.95 ms | `ring` 5.80 / 11.59, webgl2 `ring` 4.76 / 5.25 | Pixi CPU pool 56.3 / 59.4 ms | −92 % / −85 % |

GPU memory (A1): the atlas page costs 16.0 MiB for 3.13 MiB of PNG texels (Pixi est. 3.13 MiB; cozygpu with `atlas: false` is 3.13 MiB). BC1: 0.39 MiB for both libraries. JS heap after load: cozygpu PNG 527 KB vs Pixi 1194 KB, cozygpu KTX2 1120 KB vs Pixi 1668 KB.

### Since M1 (same case ids)

- **Faster:** S1 100k webgpu (−27 % avg, −28 % CPU), S1 1M webgpu (−24 %), S1 1M worker CPU (−27 %), swarm 2M webgpu p99 (−37 %). Worker S1 100k heap growth fell from 25 KB/frame to about 0.2 KB/frame (the SAB ring works).
- **Flagged regressions:**
  1. Worker S1 100k CPU went from 1.00 to 2.33 ms (front CPU 0.41 → 0.88 ms), and worker S1 10k from 0.12 to 0.30 ms. The frame rate is unchanged (capped at 60).
  2. Main-thread S3 static CPU went from 0.03 to 0.11 ms, and worker static and swarm CPU from 0.01 to 0.07–0.08 ms. These are small absolute costs added to every idle frame.
- **Not a regression:** renderer init went from about 13 ms to about 244 ms in the medians. The per-run init is bimodal in M1 **and** M2: about 10 ms or about 240 ms per fresh browser, and it is always about 10 ms in vsync cases. This is Chrome GPU-process cold start under `--disable-gpu-vsync`/`--disable-frame-rate-limit`, and whichever case lands in the slow mode takes the hit. The same library code measures 7–14 ms in a cold probe without those flags. A median of 3 cannot resolve a bimodal metric, so compare init with the min over runs.

### Losses, prioritized, with likely causes

1. **L1: WebGPU/WebGL2 pick latency collapses under an uncapped loop** (262 ms / 492 frames on WebGPU; 95 ms with 80 ms frame stalls on WebGL2). `WebGPUBackend.readTexture` creates a staging buffer, an encoder and a submit per pick, then waits on `mapAsync`. That callback is a task Chrome starves while rAF runs back to back. On WebGL2 the PBO/fence path also stalls frames, which is where the 80 ms p99 comes from. Worker mode is unaffected (4.9–5.2 ms). Fix: a persistent staging ring for readbacks; poll the map or fence at the next `render()`; never block in `getBufferSubData`.
2. **L2: the A1 atlas page is reserved in full.** One 2048² RGBA page (16 MiB) holds 200 × 64² images (3.1 MiB), 5× Pixi's GPU memory. Fix: start pages small (512² or 1024²) and grow, or size the page to its content.
3. **L3: WebGPU swarm is slower than the WebGL2 transform-feedback swarm** (1M: 6.91 vs 6.07 ms, p99 14.09 vs 8.91; 2M: 14.18 vs 11.91). WebGPU p99 is 2× its avg, which points to pacing: a compute pass plus a render pass per frame, possibly a second submit, or `getCurrentTexture` backpressure. Profile the compute dispatch (workgroup size, one pass for step + draw).
4. **L4: the worker CPU regression at 100k sprites** (1.00 → 2.33 ms CPU, front 0.41 → 0.88 ms). Likely the SAB ring copy of the full transform stream plus the ring-slot wait replacing the transfer. At 1M it is a net win (11.4 → 8.3 ms).
5. **L5: WebGL2 has a CPU floor of about 1.1–1.3 ms per frame at small counts** (S1 10k, S3, A1: ≈ 800 fps cap). This is shared by Pixi WebGL (1.2 ms), so it is mostly Chrome/ANGLE present cost, but it makes webgl2 +99 % to +426 % in S1 10k and S3.
6. **L6: KTX2 textures are never atlas-packed**, so 200 KTX2 sprites cost 200 draw calls on WebGPU (1 with packed PNG). JS heap after the KTX2 load (1120 KB) is 2× the PNG load, so check that parsed levels (`unit.levels`) are not retained after upload (GPU-only principle).
7. **L7: pick latency vs Pixi at vsync** (5.96 vs 2.29 ms avg). This is by design (one frame of async wait vs a synchronous CPU test), and cozygpu costs 8× less frame CPU. A synchronous CPU fast path for sprites (the M2 `hitMask`, or bounds) could answer in 0 frames.
8. **L8: S1 10k vs Pixi ParticleContainer** is +5 % avg (0.26 vs 0.24 ms), within noise but still the one frame-time loss on WebGPU.
