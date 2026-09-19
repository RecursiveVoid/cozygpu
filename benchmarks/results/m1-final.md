# Benchmark results — m1-final

- Date: 2026-09-17T12:52:24.664Z
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
| 10k | cozygpu · webgpu | Sprite | 3491.5 | 0.29 | 0.51 | 0.21 | 0.37 | 108.8 | 0.28–0.30 | ok |
| 10k | cozygpu · worker | Sprite | 56.5 | 17.71 | 18.74 | 0.12 | 0.20 | 1712.6 | 17.41–17.71 | ok |
| 10k | pixi · webgpu | Sprite | 898.5 | 1.11 | 1.38 | 0.97 | 1.17 | -1129.0 | 1.01–1.91 | ok |
| 10k | pixi · webgpu | ParticleContainer | 3760.5 | 0.27 | 0.41 | 0.18 | 0.22 | 19.7 | 0.25–0.30 | ok |
| 10k | pixi · webgl | Sprite | 746.2 | 1.34 | 2.18 | 1.23 | 2.08 | -1163.4 | 1.31–1.34 | ok |
| 10k | pixi · webgl | ParticleContainer | 795.4 | 1.26 | 2.63 | 1.22 | 2.56 | -224.8 | 1.21–1.32 | ok |
| 10k | three · webgl | InstancedMesh | 787.5 | 1.27 | 2.68 | 1.24 | 2.63 | 254.3 | 1.24–1.29 | ok |
| 10k | three · webgpu | InstancedMesh | 3102.0 | 0.32 | 0.48 | 0.26 | 0.39 | 129.8 | 0.32–0.40 | ok |
| 100k | cozygpu · webgpu | Sprite | 687.1 | 1.46 | 1.77 | 1.33 | 1.64 | 66.6 | 1.38–1.49 | ok |
| 100k | cozygpu · worker | Sprite | 57.4 | 17.43 | 18.73 | 1.00 | 1.36 | 25342.3 | 17.28–17.64 | ok |
| 100k | pixi · webgpu | Sprite | 100.1 | 9.99 | 10.49 | 9.88 | 10.34 | 521.3 | 9.90–11.06 | ok |
| 100k | pixi · webgpu | ParticleContainer | 474.2 | 2.11 | 2.49 | 1.91 | 2.22 | 87.9 | 2.00–2.21 | ok |
| 100k | pixi · webgl | Sprite | 94.3 | 10.60 | 11.77 | 10.50 | 11.68 | 14505.9 | 9.72–10.94 | ok |
| 100k | pixi · webgl | ParticleContainer | 698.0 | 1.43 | 1.81 | 1.23 | 1.58 | -564.1 | 1.34–1.50 | ok |
| 100k | three · webgl | InstancedMesh | 729.6 | 1.37 | 2.14 | 1.27 | 2.02 | 329.5 | 1.35–1.41 | ok |
| 100k | three · webgpu | InstancedMesh | 800.2 | 1.25 | 1.67 | 1.08 | 1.43 | 192.1 | 1.18–1.27 | ok |
| 1M | cozygpu · webgpu | Sprite | 65.9 | 15.18 | 16.90 | 15.01 | 16.74 | 35301.9 | 13.75–16.34 | ok |
| 1M | cozygpu · worker | Sprite | 57.1 | 17.50 | 18.73 | 11.37 | 12.82 | 17668.6 | 17.49–17.78 | ok |
| 1M | pixi · webgpu | Sprite | 9.0 | 110.89 | 112.75 | 110.67 | 112.57 | 184628.8 | 105.79–114.90 | ok |
| 1M | pixi · webgpu | ParticleContainer | 63.1 | 15.86 | 16.96 | 15.68 | 16.80 | -10912.9 | 15.14–15.98 | ok |
| 1M | pixi · webgl | Sprite | 9.4 | 106.32 | 110.24 | 106.13 | 110.09 | 60577.9 | 102.84–108.01 | ok |
| 1M | pixi · webgl | ParticleContainer | 65.7 | 15.22 | 16.69 | 15.11 | 16.58 | 31082.3 | 14.60–15.91 | ok |
| 1M | three · webgl | InstancedMesh | 44.9 | 22.29 | 23.42 | 22.17 | 23.30 | 1303.8 | 21.77–23.15 | ok |
| 1M | three · webgpu | InstancedMesh | 74.2 | 13.47 | 21.86 | 13.26 | 21.62 | 165.4 | 11.71–13.87 | ok |

## S2 — swarm (GPU-simulated where supported, else best CPU path)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 143.8 | 6.95 | 13.96 | 0.23 | 6.83 | 409.1 | 6.91–7.16 | ok |
| 1M | cozygpu · worker | Swarm (GPU compute) | 56.7 | 17.63 | 18.72 | 0.01 | 0.04 | 757.1 | 17.60–17.71 | ok |
| 1M | pixi · webgpu | ParticleContainer | 65.7 | 15.23 | 16.06 | 15.10 | 15.91 | 7584.4 | 14.65–15.48 | ok |
| 1M | pixi · webgl | ParticleContainer | 69.8 | 14.32 | 15.54 | 14.22 | 15.46 | 27139.5 | 14.01–15.81 | ok |
| 1M | three · webgl | InstancedMesh | 50.4 | 19.83 | 21.03 | 19.70 | 20.89 | 980.6 | 19.20–20.28 | ok |
| 1M | three · webgpu | InstancedMesh | 82.3 | 12.15 | 19.89 | 11.92 | 17.97 | 3445.0 | 11.24–12.26 | ok |
| 1M | three · webgpu | TSL compute + Sprite(count) | 122.0 | 8.20 | 8.75 | 8.12 | 8.62 | -1223.5 | 7.94–8.56 | ok |
| 2M | cozygpu · webgpu | Swarm (GPU compute) | 69.7 | 14.34 | 28.26 | 0.19 | 13.36 | 433.6 | 13.98–14.65 | ok |
| 2M | cozygpu · worker | Swarm (GPU compute) | 59.6 | 16.77 | 18.68 | 0.03 | 0.06 | 744.6 | 16.76–17.07 | ok |
| 2M | pixi · webgpu | ParticleContainer | 30.3 | 32.97 | 35.93 | 32.83 | 35.77 | -13232.5 | 31.17–33.60 | ok |
| 2M | pixi · webgl | ParticleContainer | 33.7 | 29.71 | 32.94 | 29.58 | 32.83 | 56864.1 | 29.40–29.77 | ok |
| 2M | three · webgl | InstancedMesh | 12.9 | 77.29 | 80.92 | 77.09 | 80.63 | 4915.4 | 75.93–78.55 | ok |
| 2M | three · webgpu | InstancedMesh | 40.5 | 24.70 | 43.38 | 24.42 | 43.09 | 2488.3 | 24.51–24.78 | ok |
| 2M | three · webgpu | TSL compute + Sprite(count) | 58.5 | 17.10 | 33.28 | 16.99 | 33.17 | 5181.0 | 16.85–17.33 | ok |

## S3 — static sprites (nothing moves)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 1854.0 | 0.54 | 1.55 | 0.03 | 0.43 | -64.3 | 0.54–0.55 | ok |
| 100k | cozygpu · worker | Sprite | 57.5 | 17.40 | 18.72 | 0.01 | 0.04 | 615.8 | 17.02–17.57 | ok |
| 100k | pixi · webgpu | Sprite | 1503.5 | 0.67 | 1.73 | 0.17 | 1.16 | 2234.7 | 0.66–0.68 | ok |
| 100k | pixi · webgpu | ParticleContainer | 1479.2 | 0.68 | 1.78 | 0.28 | 1.33 | -1116.5 | 0.67–0.70 | ok |
| 100k | pixi · webgl | Sprite | 798.3 | 1.25 | 2.60 | 1.17 | 2.52 | 1120.5 | 1.24–1.30 | ok |
| 100k | pixi · webgl | ParticleContainer | 773.0 | 1.29 | 2.55 | 0.98 | 2.46 | 1166.1 | 1.28–1.32 | ok |
| 100k | three · webgl | InstancedMesh | 645.9 | 1.55 | 2.64 | 1.46 | 2.59 | 326.9 | 1.54–1.60 | ok |
| 100k | three · webgpu | InstancedMesh | 1310.2 | 0.76 | 1.49 | 0.61 | 0.83 | 188.8 | 0.75–0.77 | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 12.9 | 15.1 | 14.4 | 42.4 | 313.5 B | 49888.9 KB | 2.1 |
| cozygpu · worker | Sprite | 13.2 | 13.8 | 29.1 | 56.5 | 260.3 B | 44580.8 KB | 2.1 |
| pixi · webgpu | Sprite | 225.4 | 45.9 | 138.5 | 407.8 | 1298.9 B | 147609.9 KB | 25.3 |
| pixi · webgpu | ParticleContainer | 226.7 | 41.7 | 10.2 | 278.6 | 304.4 B | 50492.4 KB | 0.8 |
| pixi · webgl | Sprite | 109.5 | 47.6 | 143.1 | 299.4 | 1298.7 B | 147435.0 KB | 26.5 |
| pixi · webgl | ParticleContainer | 107.0 | 42.5 | 16.8 | 161.6 | 304.2 B | 50318.0 KB | 3.0 |
| three · webgl | InstancedMesh | 38.1 | 2.9 | 23.2 | 62.1 | 66.9 B | 26842.0 KB | 0.2 |
| three · webgpu | InstancedMesh | 227.4 | 2.9 | 15.6 | 245.1 | 73.0 B | 28754.7 KB | 0.5 |

### Init at 1M+ objects (S1/S2)

| scenario | count | engine | tool | total init ms | heap / object | destroy ms |
|---|---:|---|---|---:|---:|---:|
| sprites-moving | 1M | cozygpu · webgpu | Sprite | 190.7 | 265.8 B | 10.5 |
| sprites-moving | 1M | cozygpu · worker | Sprite | 421.0 | 223.7 B | 9.6 |
| sprites-moving | 1M | pixi · webgpu | Sprite | 1905.3 | 1298.6 B | 224.5 |
| sprites-moving | 1M | pixi · webgpu | ParticleContainer | 636.6 | 302.8 B | 0.9 |
| sprites-moving | 1M | pixi · webgl | Sprite | 1782.4 | 1298.6 B | 222.5 |
| sprites-moving | 1M | pixi · webgl | ParticleContainer | 548.1 | 302.7 B | 2.0 |
| sprites-moving | 1M | three · webgl | InstancedMesh | 93.4 | 64.3 B | 0.1 |
| sprites-moving | 1M | three · webgpu | InstancedMesh | 244.9 | 64.9 B | 0.9 |
| swarm | 1M | cozygpu · webgpu | Swarm (GPU compute) | 9.8 | 0.2 B | 0.4 |
| swarm | 1M | cozygpu · worker | Swarm (GPU compute) | 251.3 | 0.1 B | 0.2 |
| swarm | 1M | pixi · webgpu | ParticleContainer | 637.7 | 302.8 B | 0.8 |
| swarm | 1M | pixi · webgl | ParticleContainer | 572.7 | 302.7 B | 1.9 |
| swarm | 1M | three · webgl | InstancedMesh | 92.8 | 64.3 B | 0.1 |
| swarm | 1M | three · webgpu | InstancedMesh | 242.7 | 64.9 B | 3.0 |
| swarm | 1M | three · webgpu | TSL compute + Sprite(count) | 218.4 | 16.9 B | 0.5 |
| swarm | 2M | cozygpu · webgpu | Swarm (GPU compute) | 219.0 | 0.1 B | 0.4 |
| swarm | 2M | cozygpu · worker | Swarm (GPU compute) | 235.5 | 0.0 B | 0.2 |
| swarm | 2M | pixi · webgpu | ParticleContainer | 1117.8 | 303.9 B | 0.9 |
| swarm | 2M | pixi · webgl | ParticleContainer | 992.6 | 303.9 B | 2.3 |
| swarm | 2M | three · webgl | InstancedMesh | 120.7 | 64.1 B | 0.2 |
| swarm | 2M | three · webgpu | InstancedMesh | 244.3 | 64.4 B | 1.0 |
| swarm | 2M | three · webgpu | TSL compute + Sprite(count) | 37.5 | 16.5 B | 0.5 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 1 | 88.7 KB | 28.4 KB | 88.7 KB | 28.4 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 1 | 138.2 KB | 46.0 KB | 138.2 KB | 46.0 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 1 | 61.4 KB | 20.0 KB | 61.4 KB | 20.0 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 3 | 140.7 KB | 47.7 KB |
| cozygpu · worker | 4 | 202.2 KB | 67.8 KB |
| pixi · webgpu | 22 | 542.8 KB | 166.4 KB |
| pixi · webgl | 22 | 542.8 KB | 166.4 KB |
| three · webgl | 4 | 567.2 KB | 143.6 KB |
| three · webgpu | 4 | 896.2 KB | 249.3 KB |

---

# Comparison with round 0

Round 0 = `benchmarks/results/round-0.json` (same harness, 3 interleaved reps, medians). Cells are `round 0 → final (change)`; negative change is faster.

## S1 moving sprites

| count | engine | tool | avg ms (r0 → final) | p99 ms (r0 → final) | CPU avg ms (r0 → final) |
|---:|---|---|---|---|---|
| 10k | cozygpu · webgpu | Sprite | 0.87 → **0.29** (-67%) | 1.09 → **0.51** (-53%) | 0.74 → **0.21** (-71%) |
| 10k | cozygpu · worker | Sprite | 17.42 → **17.71** (+2%) | 18.72 → **18.74** (+0%) | 0.62 → **0.12** (-80%) |
| 10k | pixi · webgpu | Sprite | 1.75 → **1.11** (-37%) | 2.07 → **1.38** (-33%) | 1.61 → **0.97** (-40%) |
| 10k | pixi · webgpu | ParticleContainer | 0.53 → **0.27** (-50%) | 0.77 → **0.41** (-46%) | 0.37 → **0.18** (-53%) |
| 10k | pixi · webgl | Sprite | 1.34 → **1.34** (-0%) | 1.85 → **2.18** (+18%) | 1.17 → **1.23** (+5%) |
| 10k | pixi · webgl | ParticleContainer | 1.33 → **1.26** (-6%) | 2.69 → **2.63** (-2%) | 1.27 → **1.22** (-4%) |
| 10k | three · webgl | InstancedMesh | 1.34 → **1.27** (-5%) | 2.76 → **2.68** (-3%) | 1.21 → **1.24** (+2%) |
| 10k | three · webgpu | InstancedMesh | 0.65 → **0.32** (-51%) | 0.83 → **0.48** (-42%) | 0.51 → **0.26** (-48%) |
| 100k | cozygpu · webgpu | Sprite | 8.13 → **1.46** (-82%) | 8.84 → **1.77** (-80%) | 7.94 → **1.33** (-83%) |
| 100k | cozygpu · worker | Sprite | 17.50 → **17.43** (-0%) | 18.72 → **18.73** (+0%) | 5.84 → **1.00** (-83%) |
| 100k | pixi · webgpu | Sprite | 16.81 → **9.99** (-41%) | 19.10 → **10.49** (-45%) | 16.64 → **9.88** (-41%) |
| 100k | pixi · webgpu | ParticleContainer | 4.34 → **2.11** (-51%) | 5.35 → **2.49** (-53%) | 4.12 → **1.91** (-54%) |
| 100k | pixi · webgl | Sprite | 15.92 → **10.60** (-33%) | 18.70 → **11.77** (-37%) | 15.80 → **10.50** (-34%) |
| 100k | pixi · webgl | ParticleContainer | 2.21 → **1.43** (-35%) | 2.81 → **1.81** (-36%) | 2.08 → **1.23** (-41%) |
| 100k | three · webgl | InstancedMesh | 2.37 → **1.37** (-42%) | 3.38 → **2.14** (-36%) | 1.95 → **1.27** (-35%) |
| 100k | three · webgpu | InstancedMesh | 2.40 → **1.25** (-48%) | 3.42 → **1.67** (-51%) | 2.02 → **1.08** (-46%) |
| 1M | cozygpu · webgpu | Sprite | 61.51 → **15.18** (-75%) | 76.71 → **16.90** (-78%) | 61.04 → **15.01** (-75%) |
| 1M | cozygpu · worker | Sprite | 42.87 → **17.50** (-59%) | 81.20 → **18.73** (-77%) | 42.38 → **11.37** (-73%) |
| 1M | pixi · webgpu | Sprite | 163.55 → **110.89** (-32%) | 177.15 → **112.75** (-36%) | 163.52 → **110.67** (-32%) |
| 1M | pixi · webgpu | ParticleContainer | 25.19 → **15.86** (-37%) | 38.69 → **16.96** (-56%) | 24.94 → **15.68** (-37%) |
| 1M | pixi · webgl | Sprite | 155.01 → **106.32** (-31%) | 166.64 → **110.24** (-34%) | 154.79 → **106.13** (-31%) |
| 1M | pixi · webgl | ParticleContainer | 24.68 → **15.22** (-38%) | 37.34 → **16.69** (-55%) | 24.47 → **15.11** (-38%) |
| 1M | three · webgl | InstancedMesh | 36.82 → **22.29** (-39%) | 51.05 → **23.42** (-54%) | 36.34 → **22.17** (-39%) |
| 1M | three · webgpu | InstancedMesh | 26.10 → **13.47** (-48%) | 33.79 → **21.86** (-35%) | 25.83 → **13.26** (-49%) |

## S2 swarm

| count | engine | tool | avg ms (r0 → final) | p99 ms (r0 → final) | CPU avg ms (r0 → final) |
|---:|---|---|---|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 8.58 → **6.95** (-19%) | 17.61 → **13.96** (-21%) | 0.31 → **0.23** (-26%) |
| 1M | cozygpu · worker | Swarm (GPU compute) | 17.36 → **17.63** (+2%) | 18.74 → **18.72** (-0%) | 0.03 → **0.01** (-58%) |
| 1M | pixi · webgpu | ParticleContainer | 22.43 → **15.23** (-32%) | 26.13 → **16.06** (-39%) | 22.23 → **15.10** (-32%) |
| 1M | pixi · webgl | ParticleContainer | 24.20 → **14.32** (-41%) | 25.26 → **15.54** (-38%) | 24.01 → **14.22** (-41%) |
| 1M | three · webgl | InstancedMesh | 30.69 → **19.83** (-35%) | 35.39 → **21.03** (-41%) | 30.48 → **19.70** (-35%) |
| 1M | three · webgpu | InstancedMesh | 22.43 → **12.15** (-46%) | 29.46 → **19.89** (-32%) | 22.14 → **11.92** (-46%) |
| 1M | three · webgpu | TSL compute + Sprite(count) | 10.01 → **8.20** (-18%) | 10.50 → **8.75** (-17%) | 9.65 → **8.12** (-16%) |
| 2M | cozygpu · webgpu | Swarm (GPU compute) | 17.88 → **14.34** (-20%) | 34.36 → **28.26** (-18%) | 0.26 → **0.19** (-27%) |
| 2M | cozygpu · worker | Swarm (GPU compute) | 17.39 → **16.77** (-4%) | 18.78 → **18.68** (-1%) | 0.10 → **0.03** (-69%) |
| 2M | pixi · webgpu | ParticleContainer | 54.76 → **32.97** (-40%) | 85.89 → **35.93** (-58%) | 54.70 → **32.83** (-40%) |
| 2M | pixi · webgl | ParticleContainer | 48.35 → **29.71** (-39%) | 51.22 → **32.94** (-36%) | 48.10 → **29.58** (-39%) |
| 2M | three · webgl | InstancedMesh | 120.64 → **77.29** (-36%) | 132.16 → **80.92** (-39%) | 120.06 → **77.09** (-36%) |
| 2M | three · webgpu | InstancedMesh | 47.22 → **24.70** (-48%) | 60.20 → **43.38** (-28%) | 46.82 → **24.42** (-48%) |
| 2M | three · webgpu | TSL compute + Sprite(count) | 20.08 → **17.10** (-15%) | 23.99 → **33.28** (+39%) | 19.73 → **16.99** (-14%) |

## S3 static sprites

| count | engine | tool | avg ms (r0 → final) | p99 ms (r0 → final) | CPU avg ms (r0 → final) |
|---:|---|---|---|---|---|
| 100k | cozygpu · webgpu | Sprite | 0.83 → **0.54** (-35%) | 2.19 → **1.55** (-29%) | 0.08 → **0.03** (-68%) |
| 100k | cozygpu · worker | Sprite | 17.32 → **17.40** (+0%) | 18.72 → **18.72** (0%) | 0.02 → **0.01** (-28%) |
| 100k | pixi · webgpu | Sprite | 0.94 → **0.67** (-29%) | 2.15 → **1.73** (-20%) | 0.35 → **0.17** (-53%) |
| 100k | pixi · webgpu | ParticleContainer | 0.94 → **0.68** (-28%) | 2.09 → **1.78** (-15%) | 0.50 → **0.28** (-44%) |
| 100k | pixi · webgl | Sprite | 1.79 → **1.25** (-30%) | 2.91 → **2.60** (-11%) | 1.62 → **1.17** (-28%) |
| 100k | pixi · webgl | ParticleContainer | 1.75 → **1.29** (-26%) | 2.90 → **2.55** (-12%) | 1.14 → **0.98** (-14%) |
| 100k | three · webgl | InstancedMesh | 1.89 → **1.55** (-18%) | 3.26 → **2.64** (-19%) | 1.66 → **1.46** (-12%) |
| 100k | three · webgpu | InstancedMesh | 1.15 → **0.76** (-34%) | 1.67 → **1.49** (-11%) | 0.73 → **0.61** (-17%) |

## Verdict per scenario (final)

Win rule (strict): a cozygpu engine must beat the **lowest avg and the lowest p99 over all competitor engines** (these may come from different competitor engines); a competitor wins if one of its engines beats every cozygpu engine on both. Anything else is a split. "ratio" = cozygpu best avg / best competitor avg (lower is better), shown for round 0 and final so the machine-wide speed-up between the two runs cancels out.

| scenario | cozygpu best: avg / p99 ms | best competitor avg · best competitor p99 | winner (final) | winner (r0) | avg ratio r0 → final | p99 ratio r0 → final |
|---|---|---|---|---|---|---|
| S1 moving sprites 10k | cozygpu webgpu Sprite 0.29 / 0.51 | avg pixi webgpu ParticleContainer 0.27 · p99 pixi webgpu ParticleContainer 0.41 | **pixi (webgpu ParticleContainer)** | pixi (webgpu ParticleContainer) | 1.65 → 1.08 | 1.41 → 1.24 |
| S1 moving sprites 100k | cozygpu webgpu Sprite 1.46 / 1.77 | avg three webgpu InstancedMesh 1.25 · p99 three webgpu InstancedMesh 1.67 | **three (webgpu InstancedMesh)** | pixi (webgl ParticleContainer) | 3.67 → 1.16 | 3.15 → 1.05 |
| S1 moving sprites 1M | cozygpu webgpu Sprite 15.18 / 16.90 | avg three webgpu InstancedMesh 13.47 · p99 pixi webgl ParticleContainer 16.69 | **split (avg: three, p99: pixi)** | pixi (webgl ParticleContainer) | 1.74 → 1.13 | 2.27 → 1.01 |
| S2 swarm 1M | cozygpu webgpu Swarm (GPU compute) 6.95 / 13.96 | avg three webgpu TSL compute + Sprite(count) 8.20 · p99 three webgpu TSL compute + Sprite(count) 8.75 | **split (avg: cozygpu, p99: three)** | split (avg: cozygpu, p99: three) | 0.86 → 0.85 | 1.68 → 1.60 |
| S2 swarm 2M | cozygpu webgpu Swarm (GPU compute) 14.34 / 28.26 | avg three webgpu TSL compute + Sprite(count) 17.10 · p99 pixi webgl ParticleContainer 32.94 | **cozygpu** | cozygpu | 0.87 → 0.84 | 0.78 → 0.57 |
| S3 static sprites 100k | cozygpu webgpu Sprite 0.54 / 1.55 | avg pixi webgpu Sprite 0.67 · p99 three webgpu InstancedMesh 1.49 | **split (avg: cozygpu, p99: three)** | split (avg: cozygpu, p99: three) | 0.88 → 0.81 | 1.31 → 1.04 |

## S4 init / heap / destroy (100k static), r0 → final

| engine | tool | total init ms | populate ms | first frame ms | heap / object B | destroy ms |
|---|---|---|---|---|---|---|
| cozygpu · webgpu | Sprite | 55.4 → 42.4 | 24.6 → 15.1 | 22.6 → 14.4 | 310.9 → 313.5 | 86.0 → 2.1 |
| cozygpu · worker | Sprite | 86.1 → 56.5 | 27.1 → 13.8 | 38.5 → 29.1 | 257.6 → 260.3 | 3.3 → 2.1 |
| pixi · webgpu | Sprite | 507.5 → 407.8 | 73.3 → 45.9 | 211.7 → 138.5 | 1298.9 → 1298.9 | 39.3 → 25.3 |
| pixi · webgpu | ParticleContainer | 147.2 → 278.6 | 77.3 → 41.7 | 19.5 → 10.2 | 304.4 → 304.4 | 1.8 → 0.8 |
| pixi · webgl | Sprite | 424.2 → 299.4 | 82.1 → 47.6 | 229.8 → 143.1 | 1298.7 → 1298.7 | 39.1 → 26.5 |
| pixi · webgl | ParticleContainer | 209.4 → 161.6 | 71.2 → 42.5 | 24.1 → 16.8 | 304.2 → 304.2 | 3.4 → 3.0 |
| three · webgl | InstancedMesh | 43.9 → 62.1 | 5.7 → 2.9 | 24.2 → 23.2 | 66.9 → 66.9 | 0.2 → 0.2 |
| three · webgpu | InstancedMesh | 45.5 → 245.1 | 6.6 → 2.9 | 32.9 → 15.6 | 73.0 → 73.0 | 0.8 → 0.5 |

## Bundle (min+gzip KB), r0 → final

| library | program | r0 | final |
|---|---|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 31.0 | 28.4 |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 42.5 | 46.0 |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 18.8 | 20.0 |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 158.4 | 158.4 |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 129.5 | 129.5 |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 210.6 | 210.6 |

## M1 final verdict and remaining losses (benchmarker)

Run: `node benchmarks/run.mjs --repeat 3 --label m1-final`. All 46 cases × 3 interleaved reps came back `ok`, with no hung, timeout or crashed runs. Raw data is in `benchmarks/results/m1-final.json`.

**Noise and comparability.** Unrelated processes were running during the run, including a CozyEvent node benchmark and a headless Godot. Load average was about 7–9 on 10 cores. Every library, competitors included, is 15–50% faster than in round 0, so the machine state differed between the two runs. Compare cozygpu's gains to round 0 using the **ratio** columns (cozygpu ÷ best competitor), not the raw ms. Worker-mode rows are paced near 60 fps (see the README caveat), so they never win on frame time; compare their CPU instead.

| scenario | winner | cozygpu best avg / p99 | best competitor avg / p99 | avg ratio r0 → final |
|---|---|---|---|---|
| S1 10k | pixi (webgpu ParticleContainer) | 0.29 / 0.51 | 0.27 / 0.41 | 1.65 → 1.08 |
| S1 100k | three (webgpu InstancedMesh) | 1.46 / 1.77 | 1.25 / 1.67 | 3.67 → 1.16 |
| S1 1M | split: three avg, pixi p99 (p99 is within noise: 16.90 vs 16.69, cozygpu range 15.9–17.7) | 15.18 / 16.90 | three webgpu 13.47 / 21.86 · pixi webgl PC 15.22 / 16.69 | 1.74 → 1.13 |
| S2 1M | split: cozygpu avg, three TSL compute p99 | 6.95 / 13.96 | 8.20 / 8.75 | 0.86 → 0.85 |
| S2 2M | **cozygpu** (main thread and worker both win) | main 14.34 / 28.26 · worker 16.77 / 18.68 | TSL 17.10 / 33.28 · pixi webgl PC 29.71 / 32.94 | 0.87 → 0.84 |
| S3 100k | split: cozygpu avg and CPU (0.03 vs 0.17 ms), three webgpu p99 (1.55 vs 1.49, within noise) | 0.54 / 1.55 | pixi webgpu 0.67 / 1.73 · three webgpu 0.76 / 1.49 | 0.88 → 0.81 |
| S4 (100k) | three on populate and heap per object; cozygpu on total init this run (Three's WebGPU adapter init was noisy) | init 42.4 ms, 313 B/object, destroy 2.1 ms | three webgl 62.1 ms, 67 B/object, destroy 0.2 ms | — |
| Bundle | cozygpu (28.4 KB minimal vs pixi 158 KB / three 130 KB) | all exports 46.0 KB, over the 30 KB budget | | |

### Remaining losses and likely causes

1. **S1 10k and 100k: moving sprites cost more CPU.** At 100k, cozygpu uses 1.33 ms CPU against 1.08 ms for Three webgpu; both include the bench's own BounceSim at about 0.6 ms. Three writes translations straight into one `instanceMatrix` Float32Array. cozygpu goes through 100k `Sprite.setPosition` calls (about 0.5 ms `frontCpuMs` at 100k), then the transform pass, which touches several SoA arrays per sprite, then a 4 MiB `writeBuffer`. The gap is now 16% (it was 3.7×). Closing it likely needs a bulk position API (typed-array writer on Container/ParticleContainer-style) or fewer per-sprite arrays. At 10k the gap is 0.02 ms avg and 0.1 ms p99, where Pixi ParticleContainer's minimal update loop wins.
2. **S1 1M: Three wins on avg** (13.5 vs 15.2 ms, but Three's p99 is 21.9). The cause is the same CPU path as item 1: front CPU is 5.2 ms and total CPU 15.0 ms, against Three's 13.3 ms. The main-thread p99 is now at parity with Pixi.
3. **S2 1M p99, and S3 p99: main-thread frame pacing.** cozygpu returns from `render()` in about 0.2 ms, much earlier than the GPU finishes, so rAF intervals alternate between short and long. At S2 1M, p50 is 6.8 ms but p99 is 14.0 ms (about 2 × p50, one missed present). At S3, p50 is 0.37 ms and p95 is 1.17 ms. Three's TSL path blocks inside its frame callback, so its intervals are even (p99 8.75 ms). Periodic GPU-process stalls are also still present on the main thread: max 253 ms at 1M and 487 ms at 2M. Three TSL shows them too (82 / 159 ms). The worker path is smooth (p99 18.7 ms) because the busy gate throttles submission. The `onSubmittedWorkDone` gate tried in fix-perf-r1 made this worse. Options: an optional main-thread pacing mode, or report presented fps.
4. **S4 heap and populate.** cozygpu uses 313 B per object against 67–73 B for Three InstancedMesh, and populate takes 15 ms against 2.9 ms. This is inherent to one JS `Sprite` object per instance, versus Three's single typed array. It is on par with Pixi ParticleContainer (304 B) and 4× better than Pixi Sprite (1299 B).
5. **Budgets still missed:**
   - `cozygpu (all exports)` is 46.0 KB min+gzip (42.5 KB in round 0), over the 30 KB budget.
   - Heap growth is not 0 in several cases. Worker S1 100k grows about 25 KB/frame and 1M worker about 18 KB/frame (packet transfer and structured clone; the fix is the M2 SAB ring). Main-thread S1 1M grows about 35 KB/frame, which is a noisy metric. Swarm grows about 400–750 B/frame.
   - Swarm at 1M meets its budget: 0.23 ms main-thread CPU, 0.00–0.01 ms front CPU, 108 B packet, and ≥ 60 fps (144 fps main thread).
