# Benchmark results — m4-graphics-final

- Date: 2026-10-07T09:14:38.154Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Load average (1/5/15 min): start 5.74 / 5.89 / 6.24 · end 6.97 / 6.82 / 6.57
- Chrome: Google Chrome 154.0.8037.99 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 3 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## S1 — moving sprites (CPU-updated, bouncing)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Sprite | 736.0 | 1.36 | 17.75 | 0.23 | 0.39 | 0.00 | -122.7 | 1.31–1.39 | ok (293 skipped, 211 while measuring) |
| 10k | cozygpu · webgl2 | Sprite | 635.5 | 1.57 | 17.75 | 0.11 | 0.22 | 0.00 | 252.2 | 1.56–1.59 | ok (347 skipped, 251 while measuring) |
| 10k | pixi · webgpu | Sprite | 775.5 | 1.29 | 1.99 | 1.12 | 1.77 | 0.01 | 204.9 | 1.26–1.41 | ok |
| 10k | pixi · webgl | Sprite | 621.0 | 1.61 | 4.52 | 1.46 | 4.33 | 0.00 | 2222.1 | 1.50–1.62 | ok |
| 100k | cozygpu · webgpu | Sprite | 701.6 | 1.43 | 2.09 | 1.17 | 1.74 | 0.01 | 788.6 | 1.41–1.49 | ok (13 skipped, 9 while measuring) |
| 100k | cozygpu · webgl2 | Sprite | 606.2 | 1.65 | 3.80 | 1.47 | 3.58 | 0.00 | 2386.9 | 1.59–1.68 | ok |
| 100k | pixi · webgpu | Sprite | 89.3 | 11.20 | 12.38 | 11.02 | 12.20 | 0.02 | 10416.3 | 11.11–12.68 | ok |
| 100k | pixi · webgl | Sprite | 86.3 | 11.59 | 17.01 | 11.44 | 16.83 | 0.00 | -32154.1 | 10.65–11.90 | ok |

## G1 — N static Graphics nodes, mixed shapes (rect, circle + stroke, round rect, star + stroke)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Graphics nodes, own context each | 2302.3 | 0.44 | 17.48 | 0.02 | 0.11 | 0.00 | 416.0 | 0.40–0.48 | ok (271 skipped, 191 while measuring) |
| 10k | cozygpu · webgl2 | Graphics nodes, own context each | 812.2 | 1.23 | 17.70 | 0.01 | 0.07 | 0.00 | 277.3 | 1.22–1.25 | ok (381.5 skipped, 273.5 while measuring) |
| 10k | pixi · webgpu | Graphics nodes, own context each | 1412.1 | 0.71 | 2.73 | 0.08 | 0.25 | 0.14 | 2303.4 | 0.65–0.78 | ok |
| 10k | pixi · webgl | Graphics nodes, own context each | 732.7 | 1.36 | 3.64 | 1.19 | 3.35 | 0.00 | 1185.6 | 1.36–1.37 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Graphics nodes, own context each | 1 | 0.00 | — | 116.5 | ok (271 skipped, 191 while measuring) |
| cozygpu · webgl2 | Graphics nodes, own context each | 1 | 0.00 | — | 128.5 | ok (381.5 skipped, 273.5 while measuring) |
| pixi · webgpu | Graphics nodes, own context each | — | — | — | 158.6 | ok |
| pixi · webgl | Graphics nodes, own context each | — | — | — | 174.4 | ok |

## G2 — the G1 nodes, every node moved and rotated each frame (transform only)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Graphics nodes, setPosition + rotation | 512.2 | 2.00 | 4.25 | 1.81 | 3.92 | 0.01 | 4388.4 | 1.70–2.29 | ok |
| 10k | cozygpu · webgl2 | Graphics nodes, setPosition + rotation | 467.2 | 2.15 | 3.42 | 1.97 | 3.15 | 0.00 | 242.9 | 1.99–2.31 | ok |
| 10k | pixi · webgpu | Graphics nodes, position + rotation | 185.1 | 5.42 | 6.27 | 5.24 | 6.07 | 0.01 | -15101.7 | 5.13–5.71 | ok |
| 10k | pixi · webgl | Graphics nodes, position + rotation | 201.0 | 5.03 | 6.30 | 4.85 | 6.09 | 0.00 | -2050.1 | 4.52–5.53 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Graphics nodes, setPosition + rotation | 1 | 1.34 | — | 109.7 | ok |
| cozygpu · webgl2 | Graphics nodes, setPosition + rotation | 1 | 1.54 | — | 113.2 | ok |
| pixi · webgpu | Graphics nodes, position + rotation | — | — | — | 141.9 | ok |
| pixi · webgl | Graphics nodes, position + rotation | — | — | — | 206.2 | ok |

## G3 — N Graphics nodes cleared and redrawn every frame (shape sizes change)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1k | cozygpu · webgpu | Graphics nodes, clear() + redraw | 908.0 | 1.12 | 2.12 | 0.99 | 1.89 | 0.00 | -85.0 | 0.98–1.25 | ok |
| 1k | cozygpu · webgl2 | Graphics nodes, clear() + redraw | 947.4 | 1.09 | 1.67 | 0.93 | 1.40 | 0.00 | 450.2 | 0.91–1.27 | ok (7 skipped, 3.5 while measuring) |
| 1k | pixi · webgpu | Graphics nodes, clear() + redraw | 236.7 | 4.25 | 5.69 | 3.82 | 4.85 | 0.01 | 10503.9 | 3.94–4.56 | ok |
| 1k | pixi · webgl | Graphics nodes, clear() + redraw | 279.7 | 3.60 | 6.19 | 3.21 | 4.86 | 0.00 | -5377.6 | 3.29–3.91 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Graphics nodes, clear() + redraw | 3 | 0.71 | — | 40.0 | ok |
| cozygpu · webgl2 | Graphics nodes, clear() + redraw | 3 | 0.61 | — | 46.7 | ok (7 skipped, 3.5 while measuring) |
| pixi · webgpu | Graphics nodes, clear() + redraw | — | — | — | 152.2 | ok |
| pixi · webgl | Graphics nodes, clear() + redraw | — | — | — | 103.3 | ok |

## G4 — one curved path (96 quadratic segments, fill + stroke) with N holes via cut(), rebuilt every frame

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100 | cozygpu · webgpu | Graphics path + cut() holes | 785.1 | 1.27 | 1.57 | 1.14 | 1.32 | 0.00 | 4.5 | 1.24–1.29 | ok (1 skipped, 1 while measuring) |
| 100 | cozygpu · webgl2 | Graphics path + cut() holes | 835.3 | 1.20 | 1.45 | 1.09 | 1.25 | 0.00 | -19.0 | 1.19–1.21 | ok |
| 100 | pixi · webgpu | Graphics path + cut() holes | 536.8 | 1.86 | 2.40 | 1.70 | 2.01 | 0.00 | 23509.7 | 1.84–1.94 | ok |
| 100 | pixi · webgl | Graphics path + cut() holes | 536.4 | 1.86 | 2.42 | 1.69 | 2.11 | 0.00 | -3832.9 | 1.80–1.90 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Graphics path + cut() holes | 1 | 1.03 | — | 34.4 | ok (1 skipped, 1 while measuring) |
| cozygpu · webgl2 | Graphics path + cut() holes | 1 | 1.13 | — | 50.6 | ok |
| pixi · webgpu | Graphics path + cut() holes | — | — | — | 49.9 | ok |
| pixi · webgl | Graphics path + cut() holes | — | — | — | 48.4 | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 15.2 | 17.9 | 16.3 | 49.4 | 359.7 B | 63870.3 KB | 2.7 |
| cozygpu · webgl2 | Sprite | 135.7 | 17.8 | 17.1 | 170.6 | 359.6 B | 63978.8 KB | 3.0 |
| pixi · webgpu | Sprite | 120.8 | 45.3 | 141.8 | 307.9 | 1299.3 B | 157079.8 KB | 30.0 |
| pixi · webgpu | ParticleContainer | 125.1 | 48.9 | 14.6 | 188.7 | 304.9 B | 59961.7 KB | 1.0 |
| pixi · webgl | Sprite | 153.7 | 56.2 | 169.1 | 378.9 | 1299.2 B | 156909.3 KB | 30.0 |
| pixi · webgl | ParticleContainer | 63.7 | 47.4 | 17.3 | 128.5 | 304.7 B | 59793.3 KB | 2.3 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 54 | 353.3 KB | 128.1 KB | 399.2 KB | 148.3 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 57 | 397.1 KB | 141.9 KB | 472.7 KB | 173.7 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 27 | 211.3 KB | 74.1 KB | 218.1 KB | 77.6 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 22 | 204.5 KB | 73.9 KB |
| cozygpu · webgl2 | 22 | 209.9 KB | 76.2 KB |
| pixi · webgpu | 22 | 626.7 KB | 193.6 KB |
| pixi · webgl | 22 | 626.6 KB | 193.5 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-moving/10000 | frame ms | pixi-webgpu-sprite | cozygpu-webgpu-auto | 1.36 | 17.75 | pixi-webgpu-sprite (Sprite) | 1.29 | 1.99 | +5% | +792% | +5% | +22% |
| sprites-moving/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 1.43 | 2.09 | pixi-webgpu-sprite (Sprite) | 11.20 | 12.38 | -87% | -83% | -87% | -85% |
| graphics-static/10000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.44 | 17.48 | pixi-webgpu-graphics (Graphics nodes, own context each) | 0.71 | 2.73 | -39% | +540% | -39% | +72% |
| graphics-animated/10000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 2.00 | 4.25 | pixi-webgl-graphics (Graphics nodes, position + rotation) | 5.03 | 6.30 | -60% | -33% | -60% | -57% |
| graphics-redraw/1000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 1.09 | 1.67 | pixi-webgl-graphics (Graphics nodes, clear() + redraw) | 3.60 | 6.19 | -70% | -73% | -69% | -70% |
| graphics-path/100 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 1.20 | 1.45 | pixi-webgpu-graphics (Graphics path + cut() holes) | 1.86 | 2.40 | -36% | -39% | -32% | -36% |
| sprites-static/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.58 | 18.19 | pixi-webgpu-sprite (Sprite) | 0.71 | 2.16 | -17% | +744% | -17% | +70% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m1-final (same case ids)

| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sprites-moving/10000/cozygpu-webgpu-auto | 0.29 | 1.36 | +374% | 0.51 | 17.75 | +3348% | 0.21 | 0.23 | +7% | 256.0 | 26.7 | **yes** |
| sprites-moving/100000/cozygpu-webgpu-auto | 1.46 | 1.43 | -2% | 1.77 | 2.09 | +18% | 1.33 | 1.17 | -13% | 92.7 | 50.3 | no |
| sprites-static/100000/cozygpu-webgpu-auto | 0.54 | 0.58 | +8% | 1.55 | 18.19 | +1070% | 0.03 | 0.02 | -26% | 42.4 | 49.4 | no |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

Machine drift control: median Δavg of the 8 unchanged Pixi/Three cases = +14%.

