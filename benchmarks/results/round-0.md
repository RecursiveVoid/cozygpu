# Benchmark results — round 0 (3 reps, medians)

- Date: 2026-09-17T08:08:54.728Z
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
| 10k | cozygpu · webgpu | Sprite | 1143.6 | 0.87 | 1.09 | 0.74 | 0.88 | -16.0 | 0.84–0.92 | ok |
| 10k | cozygpu · worker | Sprite | 57.4 | 17.42 | 18.72 | 0.62 | 0.66 | 1495.0 | 17.39–17.49 | ok |
| 10k | pixi · webgpu | Sprite | 570.2 | 1.75 | 2.07 | 1.61 | 1.87 | -268.5 | 1.74–1.91 | ok |
| 10k | pixi · webgpu | ParticleContainer | 1891.1 | 0.53 | 0.77 | 0.37 | 0.55 | 184.8 | 0.51–0.57 | ok |
| 10k | pixi · webgl | Sprite | 744.8 | 1.34 | 1.85 | 1.17 | 1.55 | 2012.5 | 1.24–1.76 | ok |
| 10k | pixi · webgl | ParticleContainer | 750.5 | 1.33 | 2.69 | 1.27 | 2.58 | 72.5 | 1.31–1.35 | ok |
| 10k | three · webgl | InstancedMesh | 744.6 | 1.34 | 2.76 | 1.21 | 2.58 | 322.2 | 1.33–1.35 | ok |
| 10k | three · webgpu | InstancedMesh | 1531.6 | 0.65 | 0.83 | 0.51 | 0.60 | 204.0 | 0.63–0.86 | ok |
| 100k | cozygpu · webgpu | Sprite | 123.0 | 8.13 | 8.84 | 7.94 | 8.53 | 8091.6 | 7.70–9.46 | ok |
| 100k | cozygpu · worker | Sprite | 57.1 | 17.50 | 18.72 | 5.84 | 6.13 | 8477.4 | 17.48–17.59 | ok (14 skipped) |
| 100k | pixi · webgpu | Sprite | 59.5 | 16.81 | 19.10 | 16.64 | 18.92 | -15989.0 | 14.71–18.17 | ok |
| 100k | pixi · webgpu | ParticleContainer | 230.6 | 4.34 | 5.35 | 4.12 | 5.04 | 4910.3 | 3.60–4.81 | ok |
| 100k | pixi · webgl | Sprite | 62.8 | 15.92 | 18.70 | 15.80 | 18.58 | 17067.2 | 14.17–17.06 | ok |
| 100k | pixi · webgl | ParticleContainer | 451.9 | 2.21 | 2.81 | 2.08 | 2.61 | 910.9 | 2.20–3.14 | ok |
| 100k | three · webgl | InstancedMesh | 421.9 | 2.37 | 3.38 | 1.95 | 2.87 | 395.1 | 2.30–2.42 | ok |
| 100k | three · webgpu | InstancedMesh | 416.9 | 2.40 | 3.42 | 2.02 | 2.94 | 995.1 | 2.36–2.43 | ok |
| 1M | cozygpu · webgpu | Sprite | 16.3 | 61.51 | 76.71 | 61.04 | 75.71 | -52824.2 | 57.05–67.11 | ok |
| 1M | cozygpu · worker | Sprite | 23.3 | 42.87 | 81.20 | 42.38 | 81.04 | 21402.3 | 40.45–44.14 | ok (85 skipped) |
| 1M | pixi · webgpu | Sprite | 6.1 | 163.55 | 177.15 | 163.52 | 174.23 | -82551.3 | 163.16–170.33 | ok |
| 1M | pixi · webgpu | ParticleContainer | 39.7 | 25.19 | 38.69 | 24.94 | 38.29 | -18988.3 | 24.22–25.78 | ok |
| 1M | pixi · webgl | Sprite | 6.5 | 155.01 | 166.64 | 154.79 | 166.28 | 342823.1 | 154.70–162.66 | ok |
| 1M | pixi · webgl | ParticleContainer | 40.5 | 24.68 | 37.34 | 24.47 | 37.15 | -28111.6 | 24.12–25.00 | ok |
| 1M | three · webgl | InstancedMesh | 27.2 | 36.82 | 51.05 | 36.34 | 50.08 | 127.3 | 36.66–37.62 | ok |
| 1M | three · webgpu | InstancedMesh | 38.3 | 26.10 | 33.79 | 25.83 | 33.50 | 3615.4 | 25.80–27.09 | ok |

## S2 — swarm (GPU-simulated where supported, else best CPU path)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 116.6 | 8.58 | 17.61 | 0.31 | 8.46 | 494.5 | 8.51–8.91 | ok |
| 1M | cozygpu · worker | Swarm (GPU compute) | 57.6 | 17.36 | 18.74 | 0.03 | 0.08 | 827.3 | 17.35–17.39 | ok |
| 1M | pixi · webgpu | ParticleContainer | 44.6 | 22.43 | 26.13 | 22.23 | 25.95 | -54262.6 | 21.69–23.32 | ok |
| 1M | pixi · webgl | ParticleContainer | 41.3 | 24.20 | 25.26 | 24.01 | 24.98 | -79659.6 | 22.83–24.82 | ok |
| 1M | three · webgl | InstancedMesh | 32.6 | 30.69 | 35.39 | 30.48 | 34.95 | 1111.7 | 29.86–33.43 | ok |
| 1M | three · webgpu | InstancedMesh | 44.6 | 22.43 | 29.46 | 22.14 | 29.13 | -210.6 | 22.36–22.76 | ok |
| 1M | three · webgpu | TSL compute + Sprite(count) | 99.9 | 10.01 | 10.50 | 9.65 | 10.08 | -667.8 | 9.92–10.70 | ok |
| 2M | cozygpu · webgpu | Swarm (GPU compute) | 55.9 | 17.88 | 34.36 | 0.26 | 0.53 | 523.8 | 17.81–22.44 | ok |
| 2M | cozygpu · worker | Swarm (GPU compute) | 57.5 | 17.39 | 18.78 | 0.10 | 0.15 | 819.8 | 16.93–17.45 | ok |
| 2M | pixi · webgpu | ParticleContainer | 18.3 | 54.76 | 85.89 | 54.70 | 85.41 | -9706.0 | 53.81–68.50 | ok |
| 2M | pixi · webgl | ParticleContainer | 20.7 | 48.35 | 51.22 | 48.10 | 51.02 | 31215.0 | 47.53–69.00 | ok |
| 2M | three · webgl | InstancedMesh | 8.3 | 120.64 | 132.16 | 120.06 | 131.93 | 17548.5 | 119.15–158.89 | ok |
| 2M | three · webgpu | InstancedMesh | 21.2 | 47.22 | 60.20 | 46.82 | 59.93 | 4491.7 | 46.54–57.24 | ok |
| 2M | three · webgpu | TSL compute + Sprite(count) | 49.8 | 20.08 | 23.99 | 19.73 | 23.64 | -3835.7 | 20.06–26.16 | ok |

## S3 — static sprites (nothing moves)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 1208.8 | 0.83 | 2.19 | 0.08 | 0.52 | 378.0 | 0.81–1.05 | ok |
| 100k | cozygpu · worker | Sprite | 57.7 | 17.32 | 18.72 | 0.02 | 0.05 | 688.5 | 16.92–17.44 | ok |
| 100k | pixi · webgpu | Sprite | 1064.9 | 0.94 | 2.15 | 0.35 | 1.38 | 2244.1 | 0.93–1.06 | ok |
| 100k | pixi · webgpu | ParticleContainer | 1065.6 | 0.94 | 2.09 | 0.50 | 1.50 | -151.3 | 0.93–1.06 | ok |
| 100k | pixi · webgl | Sprite | 560.2 | 1.79 | 2.91 | 1.62 | 2.72 | 1141.1 | 1.79–1.79 | ok |
| 100k | pixi · webgl | ParticleContainer | 571.0 | 1.75 | 2.90 | 1.14 | 2.66 | 1174.4 | 1.58–1.78 | ok |
| 100k | three · webgl | InstancedMesh | 528.5 | 1.89 | 3.26 | 1.66 | 2.92 | 217.8 | 1.89–1.98 | ok |
| 100k | three · webgpu | InstancedMesh | 870.9 | 1.15 | 1.67 | 0.73 | 1.05 | 55.1 | 1.13–1.24 | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 8.8 | 24.6 | 22.6 | 55.4 | 310.9 B | 49594.8 KB | 86.0 |
| cozygpu · worker | Sprite | 20.4 | 27.1 | 38.5 | 86.1 | 257.6 B | 44288.9 KB | 3.3 |
| pixi · webgpu | Sprite | 208.3 | 73.3 | 211.7 | 507.5 | 1298.9 B | 147606.2 KB | 39.3 |
| pixi · webgpu | ParticleContainer | 31.3 | 77.3 | 19.5 | 147.2 | 304.4 B | 50488.1 KB | 1.8 |
| pixi · webgl | Sprite | 114.4 | 82.1 | 229.8 | 424.2 | 1298.7 B | 147435.3 KB | 39.1 |
| pixi · webgl | ParticleContainer | 114.5 | 71.2 | 24.1 | 209.4 | 304.2 B | 50318.6 KB | 3.4 |
| three · webgl | InstancedMesh | 13.7 | 5.7 | 24.2 | 43.9 | 66.9 B | 26842.0 KB | 0.2 |
| three · webgpu | InstancedMesh | 5.1 | 6.6 | 32.9 | 45.5 | 73.0 B | 28754.7 KB | 0.8 |

### Init at 1M+ objects (S1/S2)

| scenario | count | engine | tool | total init ms | heap / object | destroy ms |
|---|---:|---|---|---:|---:|---:|
| sprites-moving | 1M | cozygpu · webgpu | Sprite | 387.6 | 262.8 B | 16.0 |
| sprites-moving | 1M | cozygpu · worker | Sprite | 530.0 | 220.8 B | 16.2 |
| sprites-moving | 1M | pixi · webgpu | Sprite | 2934.2 | 1298.6 B | 328.9 |
| sprites-moving | 1M | pixi · webgpu | ParticleContainer | 894.0 | 302.8 B | 1.4 |
| sprites-moving | 1M | pixi · webgl | Sprite | 2915.2 | 1298.6 B | 329.5 |
| sprites-moving | 1M | pixi · webgl | ParticleContainer | 905.2 | 302.7 B | 4.1 |
| sprites-moving | 1M | three · webgl | InstancedMesh | 128.7 | 64.3 B | 0.2 |
| sprites-moving | 1M | three · webgpu | InstancedMesh | 68.9 | 64.9 B | 0.7 |
| swarm | 1M | cozygpu · webgpu | Swarm (GPU compute) | 16.0 | 0.1 B | 1.2 |
| swarm | 1M | cozygpu · worker | Swarm (GPU compute) | 39.3 | 0.1 B | 0.3 |
| swarm | 1M | pixi · webgpu | ParticleContainer | 863.7 | 302.8 B | 1.5 |
| swarm | 1M | pixi · webgl | ParticleContainer | 876.4 | 302.7 B | 3.4 |
| swarm | 1M | three · webgl | InstancedMesh | 110.2 | 64.3 B | 0.3 |
| swarm | 1M | three · webgpu | InstancedMesh | 67.1 | 64.9 B | 0.7 |
| swarm | 1M | three · webgpu | TSL compute + Sprite(count) | 42.0 | 16.9 B | 1.0 |
| swarm | 2M | cozygpu · webgpu | Swarm (GPU compute) | 16.3 | 0.1 B | 1.3 |
| swarm | 2M | cozygpu · worker | Swarm (GPU compute) | 61.1 | 0.0 B | 0.6 |
| swarm | 2M | pixi · webgpu | ParticleContainer | 1699.2 | 303.9 B | 1.9 |
| swarm | 2M | pixi · webgl | ParticleContainer | 1618.7 | 303.9 B | 3.3 |
| swarm | 2M | three · webgl | InstancedMesh | 165.9 | 64.1 B | 0.2 |
| swarm | 2M | three · webgpu | InstancedMesh | 115.0 | 64.4 B | 0.7 |
| swarm | 2M | three · webgpu | TSL compute + Sprite(count) | 182.6 | 16.5 B | 1.5 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 1 | 96.5 KB | 31.0 KB | 96.5 KB | 31.0 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 1 | 129.4 KB | 42.5 KB | 129.4 KB | 42.5 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 1 | 58.3 KB | 18.8 KB | 58.3 KB | 18.8 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 3 | 132.1 KB | 44.3 KB |
| cozygpu · worker | 4 | 190.5 KB | 63.2 KB |
| pixi · webgpu | 22 | 542.8 KB | 166.4 KB |
| pixi · webgl | 22 | 542.8 KB | 166.4 KB |
| three · webgl | 4 | 567.2 KB | 143.6 KB |
| three · webgpu | 4 | 896.2 KB | 249.3 KB |


---

# Round 0 verdict (benchmarker)

Win rule: cozygpu's best engine must beat the best competitor engine on **both** avg frame ms and p99 frame ms. If both are capped, it must win on CPU/heap instead. The tables above report the median of 3 runs. Noise: other, unrelated node benchmark processes (CozyECS/CozyEvent) were running on the machine during this round, with a load average of about 5–6 on 10 cores. The per-case "avg range" column shows how much the runs spread.

| scenario | cozygpu best (avg / p99 ms) | best competitor (avg / p99 ms) | winner |
|---|---|---|---|
| S1 10k moving | webgpu Sprite 0.87 / 1.09 | pixi webgpu ParticleContainer 0.53 / 0.77 | **pixi** |
| S1 100k moving | webgpu Sprite 8.13 / 8.84 | pixi webgl ParticleContainer 2.21 / 2.81 (three webgl 2.37 / 3.38) | **pixi** |
| S1 1M moving | worker Sprite 42.87 / 81.20 (main thread 61.51 / 76.71) | pixi webgl ParticleContainer 24.68 / 37.34 · three webgpu 26.10 / 33.79 | **pixi/three** |
| S2 1M swarm | webgpu Swarm 8.58 / **17.61** | three webgpu TSL compute 10.01 / 10.50 | **three** (cozygpu wins avg and CPU, loses p99) |
| S2 2M swarm | worker Swarm 17.39 / 18.78 (main thread 17.88 / 34.36) | three webgpu TSL compute 20.08 / 23.99 | **cozygpu** |
| S3 100k static | webgpu Sprite 0.83 / 2.19 | pixi webgpu ParticleContainer 0.94 / 2.09 · three webgpu 1.15 / 1.67 | **pixi/three** on p99 (cozygpu has the best avg and CPU: 0.08 vs 0.50 ms) |
| S4 init + heap (100k) | total 55.4 ms · 310.9 B/object · destroy 86 ms | three webgpu 45.5 ms · 73 B/object · destroy 0.8 ms | **three** |
| Bundle | 31.0 KB minimal · 42.5 KB all exports | pixi 158 KB · three 130 KB | cozygpu (but over its own 30 KB budget) |

## Profiling findings

1. **`SpriteScenePacker.transformPass` costs about 51 ns per moving sprite.** It is 56% of main-thread time at 100k and 75% at 1M. I reproduced it in Node with the real `src/sprites/front.ts` and a FakeFrame: 51 ns/sprite at 1k, 10k and 100k alike. Since the cost does not grow with count, cache misses are not the cause; the loop does too much work per sprite. Breakdown with a translation-only update:
   - local affine plus world multiply: about 26 ns
   - instance matrix write: about 15 ns
   - color, uv and flags repack: about 10 ns

   TurboFan does optimize the function; it deopts once early, then stays stable. For comparison, Pixi ParticleContainer's update is about 7 ns per particle.
2. **`queue.writeBuffer` has a size cliff in Chrome 152 on Metal.** Writes under 4 MiB (4 194 304 B) cost about 0.5 ms/MB, while writes of 4 MiB or more cost about 0.03 ms/MB (paced microbenchmark):

   | write size | time |
   |---|---|
   | 4 194 296 B | 2.02 ms |
   | 4 194 304 B | 0.13 ms |
   | 6.4 MB | 0.18 ms |
   | 16 MB | 0.52 ms |

   This happens with ArrayBuffer, Uint8Array, Float32Array and SAB sources alike. S1 at 100k uploads exactly 4.0 MB (100k × 40 B), so cozygpu pays 2.25 ms/frame. Three uploads 6.4 MB for 0.45 ms/frame.
3. **Main-thread frame pacing is uneven when CPU is far below GPU time.** In S2 at 1M, p50 is 8.8 ms but p99 is 17.7 ms (a skipped present) and max is 249 ms (at 2M: 487 ms). In S3, p50 is 0.40 ms but p95 is 1.9 ms. cozygpu returns from `render()` in 0.02–0.3 ms, so rAF outruns the GPU and Chrome has to catch up in bursts. Three blocks inside its frame callback, so its pacing stays even. Worker mode is already smooth (p99 18.7 ms), because `busy` gates submission.
4. **Worker mode still allocates.** Heap growth is about 800 B/frame for swarm and 8 KB/frame for S1 at 100k (as does main thread at 100k), which misses the 0 B budget. At 10k on the main thread it is about 0, so part of this scales with upload size (the growth numbers are approximate).
