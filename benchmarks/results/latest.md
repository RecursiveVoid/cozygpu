# Benchmark results — m4-retained-final

- Date: 2026-10-07T09:53:27.722Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Load average (1/5/15 min): start 10.26 / 96.60 / 97.89 · end 7.50 / 18.65 / 45.34
- Chrome: Google Chrome 154.0.8037.99 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 3 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## S3 — static sprites (nothing moves)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 1711.2 | 0.58 | 18.68 | 0.01 | 0.09 | 0.00 | 343.0 | 0.57–0.96 | ok (341 skipped, 245 while measuring) |
| 100k | cozygpu · webgl2 | Sprite | 494.4 | 2.02 | 18.69 | 0.01 | 0.06 | 0.00 | 266.7 | 1.25–3.43 | ok (389 skipped, 280 while measuring) |
| 100k | pixi · webgpu | Sprite | 1156.4 | 0.86 | 9.89 | 0.06 | 0.41 | 0.32 | 2282.7 | 0.75–1.44 | ok |
| 100k | pixi · webgpu | ParticleContainer | 1281.1 | 0.78 | 2.27 | 0.14 | 0.33 | 0.20 | 487.5 | 0.74–0.79 | ok |
| 100k | pixi · webgl | Sprite | 750.8 | 1.33 | 2.79 | 1.21 | 2.56 | 0.00 | 1161.3 | 1.33–1.34 | ok |
| 100k | pixi · webgl | ParticleContainer | 761.2 | 1.31 | 2.69 | 1.22 | 2.52 | 0.00 | 1204.2 | 1.31–11.35 | ok |
| 100k | three · webgl | InstancedMesh | 598.6 | 1.67 | 2.78 | 1.50 | 2.64 | 0.00 | 276.5 | 1.63–1.68 | ok |
| 100k | three · webgpu | InstancedMesh | 1270.1 | 0.79 | 1.88 | 0.47 | 1.06 | 0.01 | 58.4 | 0.76–1.20 | ok |
| 1M | cozygpu · webgpu | Sprite | 157.3 | 6.36 | 18.73 | 0.01 | 0.04 | 0.00 | 420.1 | 4.94–6.85 | ok (402 skipped, 290 while measuring) |
| 1M | cozygpu · webgl2 | Sprite | 126.3 | 7.92 | 18.70 | 0.00 | 0.02 | 0.00 | 344.4 | 5.81–8.09 | ok (407 skipped, 292 while measuring) |
| 1M | pixi · webgpu | Sprite | 119.1 | 8.40 | 26.83 | 0.18 | 0.94 | 2.71 | 2430.8 | 8.29–9.26 | ok |
| 1M | pixi · webgpu | ParticleContainer | 113.4 | 8.82 | 28.45 | 0.92 | 1.20 | 2.21 | 2658.1 | 8.55–9.15 | ok |
| 1M | pixi · webgl | Sprite | 97.8 | 10.23 | 14.86 | 9.96 | 13.99 | 0.00 | 1267.5 | 10.11–10.70 | ok |
| 1M | pixi · webgl | ParticleContainer | 202.2 | 4.95 | 11.72 | 4.87 | 11.63 | 0.00 | 1244.4 | 4.36–5.00 | ok |
| 1M | three · webgl | InstancedMesh | 76.7 | 13.04 | 15.39 | 12.95 | 15.23 | 0.00 | -276.4 | 12.85–13.41 | ok |
| 1M | three · webgpu | InstancedMesh | 122.3 | 8.18 | 19.00 | 6.89 | 10.63 | 0.04 | 318.1 | 7.64–9.35 | ok |

## G1 — N static Graphics nodes, mixed shapes (rect, circle + stroke, round rect, star + stroke)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Graphics nodes, own context each | 2592.5 | 0.39 | 18.02 | 0.01 | 0.06 | 0.00 | 354.1 | 0.37–0.41 | ok (311 skipped, 226 while measuring) |
| 10k | cozygpu · webgl2 | Graphics nodes, own context each | 807.6 | 1.24 | 18.42 | 0.00 | 0.03 | 0.00 | 254.6 | 1.21–1.26 | ok (382 skipped, 275 while measuring) |
| 10k | pixi · webgpu | Graphics nodes, own context each | 1604.9 | 0.62 | 1.94 | 0.02 | 0.20 | 0.18 | 2296.4 | 0.62–0.62 | ok |
| 10k | pixi · webgl | Graphics nodes, own context each | 750.6 | 1.33 | 3.22 | 1.24 | 2.77 | 0.00 | 1184.6 | 1.32–1.80 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Graphics nodes, own context each | 1 | 0.00 | — | 317.0 | ok (311 skipped, 226 while measuring) |
| cozygpu · webgl2 | Graphics nodes, own context each | 1 | 0.00 | — | 115.8 | ok (382 skipped, 275 while measuring) |
| pixi · webgpu | Graphics nodes, own context each | — | — | — | 324.8 | ok |
| pixi · webgl | Graphics nodes, own context each | — | — | — | 244.6 | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 15.8 | 16.8 | 15.7 | 48.2 | 359.7 B | 63870.6 KB | 4.0 |
| cozygpu · webgl2 | Sprite | 42.3 | 21.3 | 21.2 | 83.4 | 359.6 B | 63983.9 KB | 3.5 |
| pixi · webgpu | Sprite | 183.3 | 54.8 | 171.7 | 386.2 | 1299.3 B | 157076.5 KB | 34.4 |
| pixi · webgpu | ParticleContainer | 23.7 | 50.2 | 13.7 | 89.8 | 304.9 B | 59961.9 KB | 1.1 |
| pixi · webgl | Sprite | 87.7 | 51.0 | 171.7 | 281.2 | 1299.2 B | 156908.7 KB | 23.2 |
| pixi · webgl | ParticleContainer | 119.2 | 47.0 | 17.4 | 188.0 | 304.7 B | 59793.7 KB | 1.9 |
| three · webgl | InstancedMesh | 37.9 | 3.0 | 27.5 | 64.9 | 66.3 B | 36014.3 KB | 0.5 |
| three · webgpu | InstancedMesh | 222.5 | 3.0 | 19.3 | 244.8 | 72.9 B | 36957.7 KB | 0.7 |
| cozygpu · webgpu | Sprite | 196.3 | 137.5 | 98.4 | 454.1 | 300.0 B | 335733.4 KB | 17.6 |
| cozygpu · webgl2 | Sprite | 226.9 | 135.3 | 91.7 | 453.9 | 299.9 B | 335836.5 KB | 22.7 |
| pixi · webgpu | Sprite | 211.5 | 461.6 | 1250.1 | 1930.1 | 1298.6 B | 1312450.2 KB | 356.9 |
| pixi · webgpu | ParticleContainer | 86.8 | 413.4 | 50.3 | 545.2 | 302.8 B | 339959.8 KB | 1.0 |
| pixi · webgl | Sprite | 118.8 | 457.8 | 1317.5 | 1892.5 | 1298.6 B | 1312281.7 KB | 306.1 |
| pixi · webgl | ParticleContainer | 145.4 | 377.8 | 63.5 | 615.9 | 302.8 B | 339791.6 KB | 1.8 |
| three · webgl | InstancedMesh | 41.0 | 15.2 | 48.9 | 100.3 | 64.2 B | 106326.8 KB | 1.3 |
| three · webgpu | InstancedMesh | 193.1 | 16.3 | 24.0 | 236.6 | 64.9 B | 107270.2 KB | 0.7 |

### Init at 1M+ objects (S1/S2)

| scenario | count | engine | tool | total init ms | heap / object | destroy ms |
|---|---:|---|---|---:|---:|---:|
| sprites-static | 1M | cozygpu · webgpu | Sprite | 454.1 | 300.0 B | 17.6 |
| sprites-static | 1M | cozygpu · webgl2 | Sprite | 453.9 | 299.9 B | 22.7 |
| sprites-static | 1M | pixi · webgpu | Sprite | 1930.1 | 1298.6 B | 356.9 |
| sprites-static | 1M | pixi · webgpu | ParticleContainer | 545.2 | 302.8 B | 1.0 |
| sprites-static | 1M | pixi · webgl | Sprite | 1892.5 | 1298.6 B | 306.1 |
| sprites-static | 1M | pixi · webgl | ParticleContainer | 615.9 | 302.8 B | 1.8 |
| sprites-static | 1M | three · webgl | InstancedMesh | 100.3 | 64.2 B | 1.3 |
| sprites-static | 1M | three · webgpu | InstancedMesh | 236.6 | 64.9 B | 0.7 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 67 | 438.2 KB | 158.2 KB | 486.0 KB | 179.5 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 70 | 489.5 KB | 174.9 KB | 566.9 KB | 207.7 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 33 | 267.9 KB | 92.6 KB | 274.8 KB | 96.2 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 22 | 206.8 KB | 74.7 KB |
| cozygpu · webgl2 | 22 | 212.2 KB | 76.9 KB |
| pixi · webgpu | 22 | 626.7 KB | 193.6 KB |
| pixi · webgl | 22 | 626.6 KB | 193.5 KB |
| three · webgl | 4 | 572.1 KB | 145.7 KB |
| three · webgpu | 4 | 900.6 KB | 251.2 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-static/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.58 | 18.68 | pixi-webgpu-particle (ParticleContainer) | 0.78 | 2.27 | -25% | +723% | -25% | +159% |
| sprites-static/1000000 | frame ms | pixi-webgl-particle | cozygpu-webgpu-auto | 6.36 | 18.73 | pixi-webgl-particle (ParticleContainer) | 4.95 | 11.72 | +29% | +60% | +29% | +60% |
| graphics-static/10000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.39 | 18.02 | pixi-webgpu-graphics (Graphics nodes, own context each) | 0.62 | 1.94 | -38% | +829% | -38% | +99% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m1-final (same case ids)

| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sprites-static/100000/cozygpu-webgpu-auto | 0.54 | 0.58 | +8% | 1.55 | 18.68 | +1101% | 0.03 | 0.01 | -45% | 42.4 | 48.2 | no |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

Machine drift control: median Δavg of the 6 unchanged Pixi/Three cases = +7%.

