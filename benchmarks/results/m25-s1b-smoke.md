# Benchmark results — m25-s1b-smoke

- Date: 2026-09-19T10:31:47.884Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Chrome: Google Chrome 153.0.8010.48 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 1s · measure 2s · one fresh browser per case
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## S1 — moving sprites (CPU-updated, bouncing)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 402.2 | 2.49 | 3.74 | 2.09 | 3.14 | 0.02 | 9121.7 | — | ok |
| 100k | cozygpu · webgl2 | Sprite | 383.8 | 2.61 | 3.79 | 2.21 | 3.22 | 0.00 | 272.4 | — | ok |

## S1b — moving sprites via bindColumns (M2.5: sim x/y bound once, one commit per frame)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + bindColumns | 435.6 | 2.30 | 3.32 | 1.94 | 2.89 | 0.02 | 5652.6 | — | ok |
| 100k | cozygpu · webgl2 | Sprite + bindColumns | 438.0 | 2.28 | 3.57 | 1.93 | 3.08 | 0.00 | 5685.7 | — | ok |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 17 | 169.4 KB | 60.4 KB |
| cozygpu · webgl2 | 17 | 173.2 KB | 62.2 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-moving/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 2.49 | 3.74 | — | — | — | — | — | — | — |
| sprites-moving-columns/100000 | frame ms | cozygpu-webgl2-columns | cozygpu-webgl2-columns | 2.28 | 3.57 | — | — | — | — | — | — | — |

Δ < 0: cozygpu faster (lower is better for every metric here).

