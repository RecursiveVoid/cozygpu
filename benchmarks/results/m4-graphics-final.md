# Benchmark results — m4-graphics-final

- Date: 2026-10-07T05:25:29.820Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Load average (1/5/15 min): start 5.74 / 5.89 / 6.24 · end 6.97 / 6.82 / 6.57
- Chrome: Google Chrome 154.0.8037.99 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 3 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## S1 — moving sprites (CPU-updated, bouncing)

| count | engine           | tool   |   fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range   | status                                |
| ----: | ---------------- | ------ | ----: | -----: | -----: | ---------: | ---------: | -----------: | ------------------: | ----------- | ------------------------------------- |
|   10k | cozygpu · webgpu | Sprite | 736.0 |   1.36 |  17.75 |       0.23 |       0.39 |         0.00 |              -122.7 | 1.31–1.39   | ok (293 skipped, 211 while measuring) |
|   10k | cozygpu · webgl2 | Sprite | 635.5 |   1.57 |  17.75 |       0.11 |       0.22 |         0.00 |               252.2 | 1.56–1.59   | ok (347 skipped, 251 while measuring) |
|   10k | pixi · webgpu    | Sprite | 775.5 |   1.29 |   1.99 |       1.12 |       1.77 |         0.01 |               204.9 | 1.26–1.41   | ok                                    |
|   10k | pixi · webgl     | Sprite | 621.0 |   1.61 |   4.52 |       1.46 |       4.33 |         0.00 |              2222.1 | 1.50–1.62   | ok                                    |
|  100k | cozygpu · webgpu | Sprite | 701.6 |   1.43 |   2.09 |       1.17 |       1.74 |         0.01 |               788.6 | 1.41–1.49   | ok (13 skipped, 9 while measuring)    |
|  100k | cozygpu · webgl2 | Sprite | 606.2 |   1.65 |   3.80 |       1.47 |       3.58 |         0.00 |              2386.9 | 1.59–1.68   | ok                                    |
|  100k | pixi · webgpu    | Sprite |  89.3 |  11.20 |  12.38 |      11.02 |      12.20 |         0.02 |             10416.3 | 11.11–12.68 | ok                                    |
|  100k | pixi · webgl     | Sprite |  86.3 |  11.59 |  17.01 |      11.44 |      16.83 |         0.00 |            -32154.1 | 10.65–11.90 | ok                                    |

## G1 — N static Graphics nodes, mixed shapes (rect, circle + stroke, round rect, star + stroke)

| count | engine           | tool                             |    fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range   | status                               |
| ----: | ---------------- | -------------------------------- | -----: | -----: | -----: | ---------: | ---------: | -----------: | ------------------: | ----------- | ------------------------------------ |
|   10k | cozygpu · webgpu | Graphics nodes, own context each |  270.7 |   3.69 |  18.49 |       2.50 |       3.83 |         0.01 |             -1839.0 | 3.53–4.06   | ok (101 skipped, 73 while measuring) |
|   10k | cozygpu · webgl2 | Graphics nodes, own context each |   85.2 |  11.74 |  13.63 |      11.60 |      13.46 |         0.00 |             -7980.1 | 11.51–12.32 | ok                                   |
|   10k | pixi · webgpu    | Graphics nodes, own context each | 1376.9 |   0.73 |   3.14 |       0.04 |       0.21 |         0.16 |              2302.0 | 0.71–0.73   | ok                                   |
|   10k | pixi · webgl     | Graphics nodes, own context each |  690.0 |   1.45 |   3.83 |       1.31 |       3.66 |         0.00 |              1187.6 | 1.37–1.50   | ok                                   |

| engine           | tool                             | draw calls | front CPU ms | mask mode | init ms | status                               |
| ---------------- | -------------------------------- | ---------: | -----------: | --------- | ------: | ------------------------------------ |
| cozygpu · webgpu | Graphics nodes, own context each |       5000 |         1.48 | —         |   115.0 | ok (101 skipped, 73 while measuring) |
| cozygpu · webgl2 | Graphics nodes, own context each |       5000 |         2.60 | —         |   110.0 | ok                                   |
| pixi · webgpu    | Graphics nodes, own context each |          — |            — | —         |   141.0 | ok                                   |
| pixi · webgl     | Graphics nodes, own context each |          — |            — | —         |   177.4 | ok                                   |

## G2 — the G1 nodes, every node moved and rotated each frame (transform only)

| count | engine           | tool                                   |   fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range   | status                              |
| ----: | ---------------- | -------------------------------------- | ----: | -----: | -----: | ---------: | ---------: | -----------: | ------------------: | ----------- | ----------------------------------- |
|   10k | cozygpu · webgpu | Graphics nodes, setPosition + rotation | 253.3 |   3.95 |  18.38 |       3.22 |       4.65 |         0.01 |             -3283.8 | 3.92–4.20   | ok (51 skipped, 37 while measuring) |
|   10k | cozygpu · webgl2 | Graphics nodes, setPosition + rotation |  85.0 |  11.76 |  13.58 |      11.63 |      13.41 |         0.00 |             -4580.1 | 11.69–11.81 | ok                                  |
|   10k | pixi · webgpu    | Graphics nodes, position + rotation    | 169.5 |   5.90 |   7.05 |       5.74 |       6.78 |         0.01 |              7505.4 | 5.87–5.97   | ok                                  |
|   10k | pixi · webgl     | Graphics nodes, position + rotation    | 196.1 |   5.10 |   5.95 |       4.98 |       5.83 |         0.00 |             -2205.4 | 4.97–5.15   | ok                                  |

| engine           | tool                                   | draw calls | front CPU ms | mask mode | init ms | status                              |
| ---------------- | -------------------------------------- | ---------: | -----------: | --------- | ------: | ----------------------------------- |
| cozygpu · webgpu | Graphics nodes, setPosition + rotation |       5000 |         1.62 | —         |   118.9 | ok (51 skipped, 37 while measuring) |
| cozygpu · webgl2 | Graphics nodes, setPosition + rotation |       5000 |         2.19 | —         |   119.2 | ok                                  |
| pixi · webgpu    | Graphics nodes, position + rotation    |          — |            — | —         |   133.8 | ok                                  |
| pixi · webgl     | Graphics nodes, position + rotation    |          — |            — | —         |   174.2 | ok                                  |

## G3 — N Graphics nodes cleared and redrawn every frame (shape sizes change)

| count | engine           | tool                             |   fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status                              |
| ----: | ---------------- | -------------------------------- | ----: | -----: | -----: | ---------: | ---------: | -----------: | ------------------: | --------- | ----------------------------------- |
|    1k | cozygpu · webgpu | Graphics nodes, clear() + redraw | 850.4 |   1.18 |   2.34 |       1.03 |       2.05 |         0.00 |               -35.6 | 1.14–1.37 | ok (1 skipped, 1 while measuring)   |
|    1k | cozygpu · webgl2 | Graphics nodes, clear() + redraw | 424.2 |   2.36 |  18.08 |       1.65 |       4.19 |         0.00 |              1177.2 | 2.27–2.40 | ok (94 skipped, 68 while measuring) |
|    1k | pixi · webgpu    | Graphics nodes, clear() + redraw | 233.3 |   4.29 |   5.40 |       3.80 |       4.32 |         0.01 |              9531.2 | 4.17–4.29 | ok                                  |
|    1k | pixi · webgl     | Graphics nodes, clear() + redraw | 265.7 |   3.76 |   4.89 |       3.30 |       3.76 |         0.00 |            -66248.5 | 3.72–4.21 | ok                                  |

| engine           | tool                             | draw calls | front CPU ms | mask mode | init ms | status                              |
| ---------------- | -------------------------------- | ---------: | -----------: | --------- | ------: | ----------------------------------- |
| cozygpu · webgpu | Graphics nodes, clear() + redraw |        500 |         0.74 | —         |    45.9 | ok (1 skipped, 1 while measuring)   |
| cozygpu · webgl2 | Graphics nodes, clear() + redraw |        500 |         0.56 | —         |    47.2 | ok (94 skipped, 68 while measuring) |
| pixi · webgpu    | Graphics nodes, clear() + redraw |          — |            — | —         |    43.6 | ok                                  |
| pixi · webgl     | Graphics nodes, clear() + redraw |          — |            — | —         |    55.9 | ok                                  |

## G4 — one curved path (96 quadratic segments, fill + stroke) with N holes via cut(), rebuilt every frame

| count | engine           | tool                        |   fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status                            |
| ----: | ---------------- | --------------------------- | ----: | -----: | -----: | ---------: | ---------: | -----------: | ------------------: | --------- | --------------------------------- |
|   100 | cozygpu · webgpu | Graphics path + cut() holes | 785.1 |   1.27 |   1.57 |       1.14 |       1.32 |         0.00 |                 4.5 | 1.24–1.29 | ok (1 skipped, 1 while measuring) |
|   100 | cozygpu · webgl2 | Graphics path + cut() holes | 835.3 |   1.20 |   1.45 |       1.09 |       1.25 |         0.00 |               -19.0 | 1.19–1.21 | ok                                |
|   100 | pixi · webgpu    | Graphics path + cut() holes | 536.8 |   1.86 |   2.40 |       1.70 |       2.01 |         0.00 |             23509.7 | 1.84–1.94 | ok                                |
|   100 | pixi · webgl     | Graphics path + cut() holes | 536.4 |   1.86 |   2.42 |       1.69 |       2.11 |         0.00 |             -3832.9 | 1.80–1.90 | ok                                |

| engine           | tool                        | draw calls | front CPU ms | mask mode | init ms | status                            |
| ---------------- | --------------------------- | ---------: | -----------: | --------- | ------: | --------------------------------- |
| cozygpu · webgpu | Graphics path + cut() holes |          1 |         1.03 | —         |    34.4 | ok (1 skipped, 1 while measuring) |
| cozygpu · webgl2 | Graphics path + cut() holes |          1 |         1.13 | —         |    50.6 | ok                                |
| pixi · webgpu    | Graphics path + cut() holes |          — |            — | —         |    49.9 | ok                                |
| pixi · webgl     | Graphics path + cut() holes |          — |            — | —         |    48.4 | ok                                |

## Bundle size (esbuild, minified, gzip -9)

| library                       | minimal program                                                   | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
| ----------------------------- | ----------------------------------------------------------------- | -----: | --------: | -------------: | -------------: | ------------------: |
| cozygpu                       | createRenderer + Texture + Sprite                                 |     54 |  353.3 KB |       128.1 KB |       399.2 KB |            148.3 KB |
| cozygpu (all exports)         | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB)              |     57 |  397.1 KB |       141.9 KB |       472.7 KB |            173.7 KB |
| cozygpu worker                | worker bundle (budget ≤ 25 KB)                                    |     27 |  211.3 KB |        74.1 KB |       218.1 KB |             77.6 KB |
| pixi.js                       | Application + Sprite + Texture (renderer chunks loaded on demand) |     24 |    6.3 KB |         2.8 KB |       520.4 KB |            158.4 KB |
| three (WebGLRenderer)         | WebGLRenderer + Mesh + MeshBasicMaterial                          |      1 |  516.7 KB |       129.5 KB |       516.7 KB |            129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial                     |      1 |  769.3 KB |       210.6 KB |       769.3 KB |            210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine           | files |      min | min+gzip |
| ---------------- | ----: | -------: | -------: |
| cozygpu · webgpu |    22 | 204.5 KB |  73.9 KB |
| cozygpu · webgl2 |    22 | 209.9 KB |  76.2 KB |
| pixi · webgpu    |    22 | 626.7 KB | 193.6 KB |
| pixi · webgl     |    22 | 626.6 KB | 193.5 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario                | metric   | winner               | cozygpu best        |  avg |   p99 | best competitor                                           |   avg |   p99 |  Δavg |  Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
| ----------------------- | -------- | -------------------- | ------------------- | ---: | ----: | --------------------------------------------------------- | ----: | ----: | ----: | ----: | ---------------: | ---------------: |
| sprites-moving/10000    | frame ms | pixi-webgpu-sprite   | cozygpu-webgpu-auto | 1.36 | 17.75 | pixi-webgpu-sprite (Sprite)                               |  1.29 |  1.99 |   +5% | +792% |              +5% |             +22% |
| sprites-moving/100000   | frame ms | cozygpu-webgpu-auto  | cozygpu-webgpu-auto | 1.43 |  2.09 | pixi-webgpu-sprite (Sprite)                               | 11.20 | 12.38 |  -87% |  -83% |             -87% |             -85% |
| graphics-static/10000   | frame ms | pixi-webgpu-graphics | cozygpu-webgpu-auto | 3.69 | 18.49 | pixi-webgpu-graphics (Graphics nodes, own context each)   |  0.73 |  3.14 | +409% | +488% |            +409% |           +1516% |
| graphics-animated/10000 | frame ms | cozygpu-webgpu-auto  | cozygpu-webgpu-auto | 3.95 | 18.38 | pixi-webgl-graphics (Graphics nodes, position + rotation) |  5.10 |  5.95 |  -23% | +209% |             -23% |            +131% |
| graphics-redraw/1000    | frame ms | cozygpu-webgpu-auto  | cozygpu-webgpu-auto | 1.18 |  2.34 | pixi-webgl-graphics (Graphics nodes, clear() + redraw)    |  3.76 |  4.89 |  -69% |  -52% |             -69% |             -37% |
| graphics-path/100       | frame ms | cozygpu-webgl2-auto  | cozygpu-webgl2-auto | 1.20 |  1.45 | pixi-webgpu-graphics (Graphics path + cut() holes)        |  1.86 |  2.40 |  -36% |  -39% |             -32% |             -36% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m1-final (same case ids)

| case                                      | M1 avg ms | M2 avg ms |  Δavg | M1 p99 | M2 p99 |   Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
| ----------------------------------------- | --------: | --------: | ----: | -----: | -----: | -----: | -----: | -----: | ---: | ---------: | ---------: | ---------- |
| sprites-moving/10000/cozygpu-webgpu-auto  |      0.29 |      1.36 | +374% |   0.51 |  17.75 | +3348% |   0.21 |   0.23 |  +7% |      256.0 |       26.7 | **yes**    |
| sprites-moving/100000/cozygpu-webgpu-auto |      1.46 |      1.43 |   -2% |   1.77 |   2.09 |   +18% |   1.33 |   1.17 | -13% |       92.7 |       50.3 | no         |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

Machine drift control: median Δavg of the 4 unchanged Pixi/Three cases = +14%.

## Notes

- Load average was 5.7–7.0 for the whole run (another headless Chrome
  session was active on the machine); the 3 interleaved rounds spread it
  over every case, and the avg ranges stay within about ±10 %.
- G1/G2: cozygpu issues 5000 draw calls for 10k nodes. The shape cycle puts
  a star (mesh path) after every three SDF shapes, so tree order alternates
  SDF and mesh pipelines and breaks the batch twice per four nodes. Pixi
  tessellates every shape into one batch. In G1 Pixi also reuses its render
  group instructions when nothing changed (0.04 ms CPU), while cozygpu
  re-emits every draw command each frame (240 KB packet) even though the
  node records are unchanged. WebGL2 pays ~2.3 µs per draw call (11.6 ms).
- The cozygpu WebGPU p99 of ~18 ms in light scenes (S1 10k, G1, G2) comes
  from frames held back behind the GPU queue (`skippedFrames`), not from CPU
  spikes.
- G4: Pixi's `cut()` after `fill().stroke()` attaches the first hole to the
  stroke only, so its fill misses one hole (visible in the screenshots);
  cozygpu cuts every hole from both paints.
