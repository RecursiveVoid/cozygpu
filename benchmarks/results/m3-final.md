# Benchmark results — m3-final

- Date: 2026-10-06T20:19:15.854Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Load average (1/5/15 min): start 6.67 / 7.12 / 9.12 · end 27.85 / 33.67 / 27.76
- Chrome: Google Chrome 154.0.8037.99 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 3 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## S1 — moving sprites (CPU-updated, bouncing)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 308.2 | 3.24 | 4.67 | 2.81 | 3.86 | 0.02 | 1808.7 | 1.44–3.57 | ok |
| 100k | cozygpu · webgl2 | Sprite | 310.8 | 3.22 | 4.73 | 2.77 | 4.27 | 0.00 | 861.6 | 1.57–3.54 | ok |
| 100k | pixi · webgpu | Sprite | 47.3 | 21.15 | 28.34 | 20.83 | 27.92 | 0.03 | -60936.6 | 12.67–24.68 | ok |
| 100k | pixi · webgpu | ParticleContainer | 235.8 | 4.24 | 5.78 | 3.98 | 5.48 | 0.02 | -2130.3 | 2.35–5.35 | ok |
| 100k | pixi · webgl | Sprite | 52.4 | 19.09 | 21.20 | 18.86 | 20.87 | 0.00 | -5066.1 | 10.46–27.88 | ok |
| 100k | pixi · webgl | ParticleContainer | 314.4 | 3.18 | 5.65 | 2.97 | 5.24 | 0.00 | 4779.5 | 1.63–3.65 | ok |
| 100k | three · webgl | InstancedMesh | 337.7 | 2.96 | 4.27 | 2.63 | 3.67 | 0.00 | 645.5 | 1.76–3.10 | ok |
| 100k | three · webgpu | InstancedMesh | 278.5 | 3.59 | 8.87 | 2.99 | 6.78 | 0.03 | 2200.0 | 2.22–4.65 | ok |

## S2 — swarm (GPU-simulated where supported, else best CPU path)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 142.3 | 7.03 | 19.33 | 0.11 | 0.44 | 0.01 | 369.9 | 6.99–7.09 | ok (372 skipped, 268 while measuring) |
| 1M | cozygpu · webgl2 | Swarm (transform feedback) | 128.3 | 7.79 | 18.85 | 0.06 | 0.24 | 0.00 | 594.0 | 7.74–8.08 | ok (386 skipped, 278 while measuring) |
| 1M | pixi · webgpu | ParticleContainer | 33.6 | 29.74 | 39.92 | 29.29 | 39.51 | 0.03 | -10542.0 | 24.05–36.50 | ok |
| 1M | pixi · webgl | ParticleContainer | 33.0 | 30.32 | 41.16 | 30.01 | 40.78 | 0.00 | -13437.1 | 20.25–36.81 | ok |
| 1M | three · webgl | InstancedMesh | 22.8 | 43.83 | 58.99 | 43.28 | 58.63 | 0.00 | 2607.4 | 35.25–49.22 | ok |
| 1M | three · webgpu | InstancedMesh | 31.5 | 31.77 | 39.20 | 31.24 | 37.94 | 0.03 | 7575.9 | 21.56–32.35 | ok |
| 1M | three · webgpu | TSL compute + Sprite(count) | 73.9 | 13.52 | 80.40 | 0.80 | 2.50 | 12.46 | 1128.4 | 11.90–15.37 | ok |

## T1 — text: 10k glyphs (200 labels × 50), 20 labels (10 %) replaced per frame

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Text (MSDF) | 799.2 | 1.25 | 17.75 | 0.33 | 0.61 | 0.01 | -127.8 | 1.04–1.38 | ok (197 skipped, 156 while measuring) |
| 10k | cozygpu · webgl2 | Text (MSDF) | 581.3 | 1.72 | 18.56 | 0.39 | 1.06 | 0.00 | -423.5 | 1.67–2.07 | ok (238 skipped, 165 while measuring) |
| 10k | cozygpu · webgpu | Text (canvas glyph atlas) | 933.8 | 1.07 | 17.49 | 0.54 | 1.02 | 0.01 | -3.7 | 0.98–1.39 | ok (88 skipped, 63 while measuring) |
| 10k | cozygpu · webgl2 | Text (canvas glyph atlas) | 628.0 | 1.59 | 18.63 | 0.33 | 0.53 | 0.00 | 374.9 | 1.58–1.62 | ok (249 skipped, 180 while measuring) |
| 10k | pixi · webgpu | BitmapText (MSDF .fnt) | 507.8 | 1.97 | 3.73 | 1.56 | 2.88 | 0.02 | 124.2 | 1.29–2.42 | ok |
| 10k | pixi · webgl | BitmapText (MSDF .fnt) | 489.2 | 2.04 | 4.19 | 1.76 | 3.72 | 0.00 | -1496.7 | 1.98–2.13 | ok |
| 10k | pixi · webgpu | Text (Canvas2D) | 114.8 | 8.71 | 28.85 | 8.35 | 28.57 | 0.06 | 238.7 | 8.69–51.10 | ok |
| 10k | pixi · webgl | Text (Canvas2D) | 109.6 | 9.12 | 17.01 | 8.84 | 16.55 | 0.00 | 8339.5 | 8.47–75.24 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Text (MSDF) | 1 | 0.13 | — | 96.4 | ok (197 skipped, 156 while measuring) |
| cozygpu · webgl2 | Text (MSDF) | 1 | 0.39 | — | 128.1 | ok (238 skipped, 165 while measuring) |
| cozygpu · webgpu | Text (canvas glyph atlas) | 1 | 0.14 | — | 191.9 | ok (88 skipped, 63 while measuring) |
| cozygpu · webgl2 | Text (canvas glyph atlas) | 1 | 0.16 | — | 237.7 | ok (249 skipped, 180 while measuring) |
| pixi · webgpu | BitmapText (MSDF .fnt) | — | — | — | 127.2 | ok |
| pixi · webgl | BitmapText (MSDF .fnt) | — | — | — | 179.1 | ok |
| pixi · webgpu | Text (Canvas2D) | — | — | — | 79.2 | ok |
| pixi · webgl | Text (Canvas2D) | — | — | — | 238.8 | ok |

## F1 — blur (8 px) + color matrix over a 100k static-sprite container (filter area = canvas)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Group filters [blur good, colorMatrix] | 483.1 | 2.07 | 18.82 | 0.12 | 0.34 | 0.02 | 735.4 | 2.06–2.08 | ok (294 skipped, 207 while measuring) |
| 100k | cozygpu · webgl2 | Group filters [blur good, colorMatrix] | 418.6 | 2.39 | 18.87 | 0.09 | 0.27 | 0.00 | 282.0 | 2.38–2.47 | ok (309 skipped, 222 while measuring) |
| 100k | cozygpu · webgpu | Group filters [blur fast, colorMatrix] | 462.4 | 2.16 | 18.86 | 0.14 | 0.37 | 0.02 | 848.9 | 2.14–2.31 | ok (290 skipped, 207 while measuring) |
| 100k | cozygpu · webgl2 | Group filters [blur fast, colorMatrix] | 394.7 | 2.53 | 18.84 | 0.10 | 0.28 | 0.00 | 283.6 | 2.52–2.56 | ok (308 skipped, 221 while measuring) |
| 100k | pixi · webgpu | Sprite + [BlurFilter, ColorMatrixFilter] | 365.1 | 2.74 | 7.75 | 0.45 | 0.81 | 0.46 | 3402.1 | 2.68–2.77 | ok |
| 100k | pixi · webgl | Sprite + [BlurFilter, ColorMatrixFilter] | 299.8 | 3.34 | 7.16 | 2.87 | 6.50 | 0.00 | 4783.4 | 3.33–3.73 | ok |
| 100k | pixi · webgpu | ParticleContainer + [BlurFilter, ColorMatrixFilter] | 365.1 | 2.74 | 6.02 | 0.70 | 1.17 | 0.49 | 3410.4 | 2.69–2.76 | ok |
| 100k | pixi · webgl | ParticleContainer + [BlurFilter, ColorMatrixFilter] | 293.6 | 3.41 | 7.35 | 2.92 | 6.53 | 0.00 | -4188.3 | 3.31–3.44 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Group filters [blur good, colorMatrix] | 3 | 0.02 | — | 83.0 | ok (294 skipped, 207 while measuring) |
| cozygpu · webgl2 | Group filters [blur good, colorMatrix] | 3 | 0.03 | — | 113.7 | ok (309 skipped, 222 while measuring) |
| cozygpu · webgpu | Group filters [blur fast, colorMatrix] | 3 | 0.01 | — | 93.4 | ok (290 skipped, 207 while measuring) |
| cozygpu · webgl2 | Group filters [blur fast, colorMatrix] | 3 | 0.02 | — | 108.5 | ok (308 skipped, 221 while measuring) |
| pixi · webgpu | Sprite + [BlurFilter, ColorMatrixFilter] | — | — | — | 393.5 | ok |
| pixi · webgl | Sprite + [BlurFilter, ColorMatrixFilter] | — | — | — | 571.4 | ok |
| pixi · webgpu | ParticleContainer + [BlurFilter, ColorMatrixFilter] | — | — | — | 168.0 | ok |
| pixi · webgl | ParticleContainer + [BlurFilter, ColorMatrixFilter] | — | — | — | 219.1 | ok |

## M1m scissor — 10k sprites sliding under a fixed rect mask (Pixi: Graphics rect, stencil)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Group mask (scissor) | 1158.4 | 0.86 | 17.13 | 0.49 | 0.77 | 0.01 | 178.7 | 0.84–0.97 | ok (65 skipped, 64 while measuring) |
| 10k | cozygpu · webgl2 | Group mask (scissor) | 668.2 | 1.50 | 18.56 | 0.23 | 0.46 | 0.00 | 253.9 | 1.46–1.63 | ok (286 skipped, 208 while measuring) |
| 10k | pixi · webgpu | Container mask (Graphics rect, stencil) | 495.1 | 2.02 | 3.45 | 1.83 | 3.05 | 0.01 | -1100.0 | 1.86–2.15 | ok |
| 10k | pixi · webgl | Container mask (Graphics rect, stencil) | 572.7 | 1.75 | 5.06 | 1.50 | 3.83 | 0.00 | 1249.7 | 1.51–1.90 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Group mask (scissor) | 3 | 0.23 | scissor | 50.0 | ok (65 skipped, 64 while measuring) |
| cozygpu · webgl2 | Group mask (scissor) | 3 | 0.20 | scissor | 74.2 | ok (286 skipped, 208 while measuring) |
| pixi · webgpu | Container mask (Graphics rect, stencil) | — | — | — | 75.8 | ok |
| pixi · webgl | Container mask (Graphics rect, stencil) | — | — | — | 146.3 | ok |

## M1m stencil — 10k sprites under a fixed circle mask (cozygpu mode 'stencil'; WebGPU resolves it to alpha; Pixi: Graphics circle, stencil)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Group mask (stencil) | 874.1 | 1.14 | 2.13 | 0.66 | 0.95 | 0.02 | 180.8 | 1.12–1.31 | ok (62 skipped, 34 while measuring) |
| 10k | cozygpu · webgl2 | Group mask (stencil) | 615.0 | 1.63 | 18.55 | 0.23 | 0.42 | 0.00 | -236.7 | 1.45–1.94 | ok (294 skipped, 213 while measuring) |
| 10k | pixi · webgpu | Container mask (Graphics circle, stencil) | 504.9 | 1.98 | 3.36 | 1.77 | 2.97 | 0.01 | -993.5 | 1.68–2.42 | ok |
| 10k | pixi · webgl | Container mask (Graphics circle, stencil) | 614.5 | 1.63 | 3.58 | 1.35 | 3.27 | 0.00 | 1250.0 | 1.50–1.69 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Group mask (stencil) | 3 | 0.32 | alpha | 55.5 | ok (62 skipped, 34 while measuring) |
| cozygpu · webgl2 | Group mask (stencil) | 3 | 0.20 | stencil | 58.2 | ok (294 skipped, 213 while measuring) |
| pixi · webgpu | Container mask (Graphics circle, stencil) | — | — | — | 90.0 | ok |
| pixi · webgl | Container mask (Graphics circle, stencil) | — | — | — | 116.0 | ok |

## M1m alpha — 10k sprites under a fixed soft circle sprite mask (cozygpu mode 'alpha'; Pixi: Sprite mask)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Group mask (alpha) | 825.2 | 1.21 | 17.78 | 0.55 | 0.92 | 0.01 | 379.9 | 1.17–1.31 | ok (131 skipped, 91 while measuring) |
| 10k | cozygpu · webgl2 | Group mask (alpha) | 556.3 | 1.80 | 18.56 | 0.29 | 0.67 | 0.00 | 278.4 | 1.64–1.81 | ok (276 skipped, 200 while measuring) |
| 10k | pixi · webgpu | Container mask (Sprite, alpha) | 379.4 | 2.64 | 4.22 | 2.26 | 3.62 | 0.02 | -2042.2 | 2.31–2.84 | ok |
| 10k | pixi · webgl | Container mask (Sprite, alpha) | 503.0 | 1.99 | 5.48 | 1.83 | 5.15 | 0.00 | 2096.0 | 1.83–2.50 | ok |

| engine | tool | draw calls | front CPU ms | mask mode | init ms | status |
|---|---|---:|---:|---|---:|---|
| cozygpu · webgpu | Group mask (alpha) | 3 | 0.39 | alpha | 56.4 | ok (131 skipped, 91 while measuring) |
| cozygpu · webgl2 | Group mask (alpha) | 3 | 0.26 | alpha | 66.8 | ok (276 skipped, 200 while measuring) |
| pixi · webgpu | Container mask (Sprite, alpha) | — | — | — | 101.4 | ok |
| pixi · webgl | Container mask (Sprite, alpha) | — | — | — | 152.0 | ok |

## P1 — particles: ~500k alive (disc emitter, life 1–2 s, alpha + size over life, fixed 1/60 s step)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 500k | cozygpu · webgpu | Particles (ring) | 182.7 | 5.47 | 18.97 | 0.11 | 0.35 | 0.01 | 672.8 | 5.41–5.48 | ok (364 skipped, 262 while measuring) |
| 500k | cozygpu · webgl2 | Particles (ring) | 166.8 | 6.00 | 18.84 | 0.08 | 0.30 | 0.00 | 594.1 | 5.84–6.05 | ok (377 skipped, 268 while measuring) |
| 500k | pixi · webgpu | ParticleContainer + CPU emitter | 11.7 | 85.34 | 128.76 | 86.15 | 128.38 | 0.03 | 460087.9 | 80.79–152.76 | ok |
| 500k | pixi · webgl | ParticleContainer + CPU emitter | 12.4 | 80.41 | 110.95 | 81.02 | 110.70 | 0.00 | 403102.1 | 77.21–96.97 | ok |

| engine | tool | alive at end | spawns/frame | draw calls | front CPU ms | packet B | status |
|---|---|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Particles (ring) | 494067 | 5556 | 1 | 0.02 | 232 | ok (364 skipped, 262 while measuring) |
| cozygpu · webgl2 | Particles (ring) | 498218 | 5556 | 1 | 0.02 | 232 | ok (377 skipped, 268 while measuring) |
| pixi · webgpu | ParticleContainer + CPU emitter | 497161 | 5556 | — | — | — | ok |
| pixi · webgl | ParticleContainer + CPU emitter | 497124 | 5556 | — | — | — | ok |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 47 | 302.2 KB | 108.0 KB | 342.8 KB | 125.4 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 50 | 337.3 KB | 119.2 KB | 407.7 KB | 148.2 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 24 | 182.7 KB | 64.0 KB | 189.3 KB | 67.5 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 22 | 193.8 KB | 70.4 KB |
| cozygpu · webgl2 | 22 | 199.2 KB | 72.7 KB |
| pixi · webgpu | 22 | 624.8 KB | 192.7 KB |
| pixi · webgl | 22 | 624.7 KB | 192.7 KB |
| three · webgl | 4 | 571.0 KB | 145.1 KB |
| three · webgpu | 4 | 899.5 KB | 250.6 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-moving/100000 | frame ms | three-webgl-instanced | cozygpu-webgl2-auto | 3.22 | 4.73 | three-webgl-instanced (InstancedMesh) | 2.96 | 4.27 | +9% | +11% | +10% | +9% |
| swarm/1000000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 7.03 | 19.33 | three-webgpu-compute (TSL compute + Sprite(count)) | 13.52 | 80.40 | -48% | -76% | -48% | -42% |
| text/10000 | frame ms | cozygpu-webgpu-canvas | cozygpu-webgpu-canvas | 1.07 | 17.49 | pixi-webgpu-msdf (BitmapText (MSDF .fnt)) | 1.97 | 3.73 | -46% | +369% | -46% | -19% |
| filtered/100000 | frame ms | cozygpu-webgpu-good | cozygpu-webgpu-good | 2.07 | 18.82 | pixi-webgpu-sprite (Sprite + [BlurFilter, ColorMatrixFilter]) | 2.74 | 7.75 | -24% | +143% | -24% | -13% |
| masked-moving-scissor/10000 | frame ms | cozygpu-webgpu-scissor | cozygpu-webgpu-scissor | 0.86 | 17.13 | pixi-webgl-rect (Container mask (Graphics rect, stencil)) | 1.75 | 5.06 | -51% | +238% | -51% | -14% |
| masked-moving-stencil/10000 | frame ms | cozygpu-webgpu-stencil | cozygpu-webgpu-stencil | 1.14 | 2.13 | pixi-webgl-circle (Container mask (Graphics circle, stencil)) | 1.63 | 3.58 | -30% | -41% | -30% | -0% |
| masked-moving-alpha/10000 | frame ms | cozygpu-webgpu-alpha | cozygpu-webgpu-alpha | 1.21 | 17.78 | pixi-webgl-sprite (Container mask (Sprite, alpha)) | 1.99 | 5.48 | -39% | +224% | -39% | -10% |
| particles/500000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 5.47 | 18.97 | pixi-webgl-particle (ParticleContainer + CPU emitter) | 80.41 | 110.95 | -93% | -83% | -93% | -93% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m3-perf-after (same case ids)

| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sprites-moving/100000/cozygpu-webgpu-auto | 1.58 | 3.24 | +106% | 2.49 | 4.67 | +88% | 1.32 | 2.81 | +114% | 59.1 | 125.4 | **yes** |
| sprites-moving/100000/cozygpu-webgl2-auto | 1.84 | 3.22 | +75% | 3.53 | 4.73 | +34% | 1.56 | 2.77 | +78% | 61.5 | 107.2 | **yes** |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

## Notes on this run

- **Machine load.** The load average rose from about 7 to about 28 during
  the run (other processes on the machine). Round 1 ran at the lower load,
  rounds 2–3 at the higher one, so CPU-bound cases slowed down by 50–115 %
  in the later rounds for every library (Pixi/Three S1/S2 rows vs
  m25-final: +27 % to +114 %). Medians include two loaded rounds.
- **S1 100k.** In round 1 cozygpu webgpu was fastest (1.44 ms vs Three
  WebGL 1.76 ms); the median flips to Three (+9 %) because of the loaded
  rounds. Treat it as a tie within load noise, not a regression.
- **p99 ≈ 17–19 ms on cozygpu rows** in GPU-light uncapped loops (T1, F1,
  M1m, S2, P1): this is the WebGPU/WebGL2 queue-depth pacing
  (`QUEUE_FRAMES` in the backends). When the GPU is more than 16 submits
  behind, a frame is held and Chrome fires the next rAF on its ~16.7 ms
  timer. Those frames would never have been displayed; with vsync on there
  is no hold. Pixi has no pacing, so its p99 stays low while it queues
  deeper.
- **Three r186** has no built-in counterpart for text, filter chains,
  container masks or particle emitters, so T1/F1/M1m/P1 compare with Pixi
  only.
- **T1 Pixi `msdf`** draws from the same atlas (converted to BMFont `.fnt`
  by `build.mjs`). Pixi's MSDF shader leaves a dark backdrop on the glyph
  quads with this atlas. Draw cost is unaffected.
- **M1m stencil on WebGPU** resolves to alpha (`maskMode` column), as
  documented; WebGL2 uses the stencil buffer.
