# Benchmark results — m25-pick

- Date: 2026-09-19T09:11:06.768Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Chrome: Google Chrome 153.0.8010.48 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 2 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## A2 — picking latency at 100k static sprites (one pick in flight, vsync ON = 60 fps like a real page)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 60.0 | 16.67 | 18.55 | 0.09 | 0.12 | 29782.7 | 16.66–16.67 | ok |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 60.0 | 16.67 | 18.48 | 0.10 | 0.20 | 10040.2 | 16.67–16.67 | ok |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 60.0 | 16.66 | 18.53 | 0.03 | 0.04 | -1480.7 | 16.66–16.67 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 301 | 100% | 3.97 | 3.99 | 5.64 | 5.83 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · webgl2 | Sprite + renderer.pick() | 300 | 100% | 4.84 | 4.48 | 7.22 | 7.70 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · worker | Sprite + renderer.pick() | 301 | 100% | 3.46 | 3.21 | 5.14 | 5.52 | 1.00 | 1.0 | 16.66 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A2u — picking at 100k, frame-rate limit OFF (stress: async readbacks compete with an uncapped rAF loop)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 264.3 | 3.78 | 18.75 | 0.03 | 0.11 | 2240.9 | 3.78–3.79 | ok (368 skipped) |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 243.3 | 4.14 | 18.74 | 0.03 | 0.16 | 7803.0 | 3.77–4.52 | ok (372 skipped) |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 56.9 | 17.57 | 18.74 | 0.03 | 0.04 | -3098.5 | 17.57–17.58 | ok (1 skipped) |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 264.5 | 100% | 4.18 | 3.91 | 6.56 | 7.76 | 5.00 | 5.0 | 3.78 | ok (368 skipped) |
| cozygpu · webgl2 | Sprite + renderer.pick() | 238.5 | 100% | 15.09 | 7.67 | 11.69 | 1546.32 | 10.86 | 5.0 | 4.14 | ok (372 skipped) |
| cozygpu · worker | Sprite + renderer.pick() | 275 | 100% | 3.72 | 3.44 | 5.88 | 6.65 | 1.04 | 2.0 | 17.57 | ok (1 skipped) |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 21 | 177.9 KB | 64.6 KB |
| cozygpu · webgl2 | 21 | 183.2 KB | 67.0 KB |
| cozygpu · worker | 18 | 289.9 KB | 99.3 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| picking/100000 | pick latency ms | cozygpu-worker-auto | cozygpu-worker-auto | 3.46 | 5.14 | — | — | — | — | — | — | — |
| picking-uncapped/100000 | pick latency ms | cozygpu-worker-auto | cozygpu-worker-auto | 3.72 | 5.88 | — | — | — | — | — | — | — |

Δ < 0: cozygpu faster (lower is better for every metric here).

