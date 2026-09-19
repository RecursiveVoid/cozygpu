# Benchmark results — m25-final

- Date: 2026-09-19T13:11:15.528Z
- Machine: Apple M4 · 16 GB · darwin 27.0.0 arm64
- GPU: apple metal-3
- Chrome: Google Chrome 153.0.8010.48 (headless=new, vsync/frame-rate limit OFF)
- Libraries: pixi.js 8.20.1 · three 0.186.0 · puppeteer-core 25.11.0 · esbuild 0.28.2 · cozygpu 0.0.1
- Canvas 1280×720 @1x · warmup 2s · measure 5s · one fresh browser per case
- 3 repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs
- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).

## Run conditions and notes

- **Machine was not idle.** Before the run the machine was watched for
  60 min; unrelated workloads kept the 1-min load average at 7–180 on 10
  cores and did not stop. The run went ahead anyway: 1-min load during the
  run was min 4.9 / median 13.4 / max 75 (30 s samples). Chrome also moved
  from 152 (M2 final) to 153. Every unchanged Pixi / Three case got slower
  by the same amount as cozygpu (S1 1M +33–48 %, S2 +27–56 %), so read the
  "Δ adj" column below, not the raw Δ, for M2 → M2.5. Rankings **inside**
  this run (winners, S1 vs S1b) are fair: all cases ran interleaved under
  the same conditions.
- **S1b (bindColumns) is slower than S1 (setPosition) in this run** at
  100k on both backends (webgpu 2.27 vs 1.60 ms, CPU 1.97 vs 1.43 ms;
  webgl2 2.09 vs 1.50 ms) and at 1M on webgpu (20.35 vs 18.26 ms). The
  min–max ranges over the 3 runs do not overlap at 100k. At 1M on webgl2
  S1b is ahead (20.09 vs 21.48 ms). Both stay inside the front-CPU budget
  (renderer `frontCpuMs` 0.43–0.73 ms at 100k). The copy loop in
  `Rows._copy` (one pass per column, a dirty-bit write per column, strided
  reads) is the first place to profile.
- **A1 accounting moved.** `rendererMs` fell (KTX2 webgpu 239 → 16 ms)
  and `populateMs` rose (46 → 101 ms), so "load+upload" (populate + first
  frame) looks worse while init total improved (289 → 136 ms). Pixi shows
  the same shift (WebGPU total 310 → 160 ms), so most of it is the browser
  version and machine, not a cozygpu change.
- **A2 vsync:** Pixi / Three picks are synchronous and sub-millisecond, so
  their drift (-44 %) says little about the machine; the A2 "Δ adj" values
  are not meaningful. A2u (uncapped) is the stress case and improved on all
  three cozygpu renderers (webgpu 26.75 → 4.30 ms latency).
- **Worker rows** are paced near 60 fps (see README), so their frame
  times do not track machine load and their "Δ adj" is not meaningful;
  compare CPU instead.
- **Heap growth (approximate metric):** cozygpu webgl2 S1 at 100k rose from
  67 to 2208 B/frame (runs 825–2419), and S1b webgl2 100k shows 3116
  B/frame. Worth a heap-snapshot check against the 0-allocation budget.

## Milestone comparison: M2 final vs M2.5 final

cozygpu per backend: `m2-final` (2026-09-18, Chrome 152.0.7977.84) vs `m25-final` (2026-09-19, Chrome 153.0.8010.48), with the best Pixi / Three case of the M2.5 final run. Every value is the median over 3 interleaved runs; lower is better. S1b has no M2 final run, so its M2 final column is the M2 final S1 row of the same backend (per-sprite `setPosition`).

"competitor drift" is the median M2 final → M2.5 final change of the Pixi / Three cases of the same scenario that ran in both results; their code did not change, so it measures the machine and browser. "Δ adj" divides the cozygpu change by that drift, the fairer cross-run number when the two runs saw different conditions.

| scenario | count | metric | cozygpu | M2 final | M2.5 final | Δ | competitor drift | Δ adj | best competitor | value |
|---|---:|---|---|---:|---:|---:|---:|---:|---|---:|
| S1 moving sprites | 10k | frame avg ms | webgpu | 0.24 | 0.36 | +49 % | +31 % | +14 % | pixi · webgpu (particle) | 0.40 |
| S1 moving sprites | 10k | frame avg ms | webgl2 | 1.28 | 1.30 | +1 % | +31 % | -23 % | pixi · webgpu (particle) | 0.40 |
| S1 moving sprites | 10k | frame avg ms | worker | 17.67 | 16.92 | -4 % | +31 % | -27 % | pixi · webgpu (particle) | 0.40 |
| S1 moving sprites | 100k | frame avg ms | webgpu | 1.11 | 1.60 | +44 % | +21 % | +19 % | three · webgl (instanced) | 1.60 |
| S1 moving sprites | 100k | frame avg ms | webgl2 | 1.04 | 1.50 | +44 % | +21 % | +19 % | three · webgl (instanced) | 1.60 |
| S1 moving sprites | 100k | frame avg ms | worker | 17.85 | 16.96 | -5 % | +21 % | -21 % | three · webgl (instanced) | 1.60 |
| S1 moving sprites | 1M | frame avg ms | webgpu | 11.79 | 18.26 | +55 % | +35 % | +15 % | three · webgpu (instanced) | 17.17 |
| S1 moving sprites | 1M | frame avg ms | webgl2 | 15.59 | 21.48 | +38 % | +35 % | +2 % | three · webgpu (instanced) | 17.17 |
| S1 moving sprites | 1M | frame avg ms | worker | 17.20 | 17.44 | +1 % | +35 % | -25 % | three · webgpu (instanced) | 17.17 |
| S1b moving sprites, bindColumns | 100k | frame avg ms | webgpu (columns) | 1.11 | 2.27 | +104 % | +21 % | +69 % | three · webgl (instanced) | 1.60 |
| S1b moving sprites, bindColumns | 100k | frame avg ms | webgl2 (columns) | 1.04 | 2.09 | +101 % | +21 % | +66 % | three · webgl (instanced) | 1.60 |
| S1b moving sprites, bindColumns | 100k | frame avg ms | worker (columns) | 17.85 | 16.95 | -5 % | +21 % | -22 % | three · webgl (instanced) | 1.60 |
| S1b moving sprites, bindColumns | 1M | frame avg ms | webgpu (columns) | 11.79 | 20.35 | +73 % | +35 % | +28 % | three · webgpu (instanced) | 17.17 |
| S1b moving sprites, bindColumns | 1M | frame avg ms | webgl2 (columns) | 15.59 | 20.09 | +29 % | +35 % | -4 % | three · webgpu (instanced) | 17.17 |
| S1b moving sprites, bindColumns | 1M | frame avg ms | worker (columns) | 17.20 | 19.03 | +11 % | +35 % | -18 % | three · webgpu (instanced) | 17.17 |
| S2 swarm | 1M | frame avg ms | webgpu | 6.88 | 9.37 | +36 % | +35 % | +1 % | three · webgpu (compute) | 10.65 |
| S2 swarm | 1M | frame avg ms | webgl2 | 6.08 | 8.51 | +40 % | +35 % | +4 % | three · webgpu (compute) | 10.65 |
| S2 swarm | 1M | frame avg ms | worker | 17.57 | 16.88 | -4 % | +35 % | -29 % | three · webgpu (compute) | 10.65 |
| S2 swarm | 2M | frame avg ms | webgpu | 14.25 | 19.41 | +36 % | +43 % | -4 % | three · webgpu (compute) | 23.64 |
| S2 swarm | 2M | frame avg ms | webgl2 | 11.96 | 16.20 | +36 % | +43 % | -5 % | three · webgpu (compute) | 23.64 |
| S2 swarm | 2M | frame avg ms | worker | 16.65 | 16.88 | +1 % | +43 % | -29 % | three · webgpu (compute) | 23.64 |
| S3 static sprites | 100k | frame avg ms | webgpu | 0.53 | 0.63 | +19 % | +7 % | +11 % | pixi · webgpu (sprite) | 0.73 |
| S3 static sprites | 100k | frame avg ms | webgl2 | 1.28 | 1.33 | +3 % | +7 % | -3 % | pixi · webgpu (sprite) | 0.73 |
| S3 static sprites | 100k | frame avg ms | worker | 17.72 | 16.91 | -5 % | +7 % | -10 % | pixi · webgpu (sprite) | 0.73 |
| A1 PNG load+upload | 200 | load+upload ms | webgpu | 61.28 | 108.93 | +78 % | +113 % | -17 % | pixi · webgl (sprite) | 142.16 |
| A1 PNG load+upload | 200 | load+upload ms | webgpu (noatlas) | 62.51 | 105.83 | +69 % | +113 % | -21 % | pixi · webgl (sprite) | 142.16 |
| A1 PNG load+upload | 200 | load+upload ms | webgl2 | 62.77 | 121.80 | +94 % | +113 % | -9 % | pixi · webgl (sprite) | 142.16 |
| A1 KTX2 load+upload | 200 | load+upload ms | webgpu | 49.86 | 106.10 | +113 % | +13 % | +88 % | pixi · webgl (sprite) | 110.21 |
| A1 KTX2 load+upload | 200 | load+upload ms | webgl2 | 49.74 | 75.31 | +51 % | +13 % | +34 % | pixi · webgl (sprite) | 110.21 |
| A2 picking (vsync) | 100k | pick latency ms | webgpu | 4.79 | 3.73 | -22 % | -44 % | +38 % | pixi · webgpu (sprite) | 0.65 |
| A2 picking (vsync) | 100k | pick latency ms | webgl2 | 6.03 | 5.50 | -9 % | -44 % | +62 % | pixi · webgpu (sprite) | 0.65 |
| A2 picking (vsync) | 100k | pick latency ms | worker | 5.87 | 4.39 | -25 % | -44 % | +33 % | pixi · webgpu (sprite) | 0.65 |
| A2u picking (uncapped) | 100k | pick latency ms | webgpu | 26.75 | 4.30 | -84 % | +41 % | -89 % | pixi · webgpu (sprite) | 0.93 |
| A2u picking (uncapped) | 100k | pick latency ms | webgl2 | 10.80 | 7.96 | -26 % | +41 % | -48 % | pixi · webgpu (sprite) | 0.93 |
| A2u picking (uncapped) | 100k | pick latency ms | worker | 5.20 | 4.56 | -12 % | +41 % | -38 % | pixi · webgpu (sprite) | 0.93 |
| A3 swarm churn | 1M | frame avg ms | webgpu (gpu) | 4.34 | 5.65 | +30 % | +20 % | +9 % | pixi · webgpu (particle) | 67.74 |
| A3 swarm churn | 1M | frame avg ms | webgpu (ring) | 5.80 | 6.31 | +9 % | +20 % | -9 % | pixi · webgpu (particle) | 67.74 |
| A3 swarm churn | 1M | frame avg ms | webgl2 (ring) | 4.76 | 5.89 | +24 % | +20 % | +3 % | pixi · webgpu (particle) | 67.74 |
| S4 init (from S3) | 100k | init total ms | webgpu | 268.90 | 61.86 | -77 % | -38 % | -63 % | three · webgpu (instanced) | 26.99 |
| S4 init (from S3) | 100k | init total ms | webgl2 | 273.78 | 62.89 | -77 % | -38 % | -63 % | three · webgpu (instanced) | 26.99 |
| S4 init (from S3) | 100k | init total ms | worker | 270.66 | 69.85 | -74 % | -38 % | -58 % | three · webgpu (instanced) | 26.99 |

### Winner per scenario (M2.5 final)

| scenario | count | metric | winner | value | cozygpu best | value | best competitor | value |
|---|---:|---|---|---:|---|---:|---|---:|
| S1 moving sprites | 10k | frame avg ms | **cozygpu · webgpu** | 0.36 | cozygpu · webgpu | 0.36 | pixi · webgpu (particle) | 0.40 |
| S1 moving sprites | 100k | frame avg ms | **cozygpu · webgl2** | 1.50 | cozygpu · webgl2 | 1.50 | three · webgl (instanced) | 1.60 |
| S1 moving sprites | 1M | frame avg ms | **three · webgpu (instanced)** | 17.17 | cozygpu · worker | 17.44 | three · webgpu (instanced) | 17.17 |
| S1b moving sprites, bindColumns | 100k | frame avg ms | **three · webgl (instanced)** | 1.60 | cozygpu · webgl2 (columns) | 2.09 | three · webgl (instanced) | 1.60 |
| S1b moving sprites, bindColumns | 1M | frame avg ms | **three · webgpu (instanced)** | 17.17 | cozygpu · worker (columns) | 19.03 | three · webgpu (instanced) | 17.17 |
| S2 swarm | 1M | frame avg ms | **cozygpu · webgl2** | 8.51 | cozygpu · webgl2 | 8.51 | three · webgpu (compute) | 10.65 |
| S2 swarm | 2M | frame avg ms | **cozygpu · webgl2** | 16.20 | cozygpu · webgl2 | 16.20 | three · webgpu (compute) | 23.64 |
| S3 static sprites | 100k | frame avg ms | **cozygpu · webgpu** | 0.63 | cozygpu · webgpu | 0.63 | pixi · webgpu (sprite) | 0.73 |
| A1 PNG load+upload | 200 | load+upload ms | **cozygpu · webgpu (noatlas)** | 105.83 | cozygpu · webgpu (noatlas) | 105.83 | pixi · webgl (sprite) | 142.16 |
| A1 KTX2 load+upload | 200 | load+upload ms | **cozygpu · webgl2** | 75.31 | cozygpu · webgl2 | 75.31 | pixi · webgl (sprite) | 110.21 |
| A2 picking (vsync) | 100k | pick latency ms | **pixi · webgpu (sprite)** | 0.65 | cozygpu · webgpu | 3.73 | pixi · webgpu (sprite) | 0.65 |
| A2u picking (uncapped) | 100k | pick latency ms | **pixi · webgpu (sprite)** | 0.93 | cozygpu · webgpu | 4.30 | pixi · webgpu (sprite) | 0.93 |
| A3 swarm churn | 1M | frame avg ms | **cozygpu · webgpu (gpu)** | 5.65 | cozygpu · webgpu (gpu) | 5.65 | pixi · webgpu (particle) | 67.74 |
| S4 init (from S3) | 100k | init total ms | **three · webgpu (instanced)** | 26.99 | cozygpu · webgpu | 61.86 | three · webgpu (instanced) | 26.99 |

## S1 — moving sprites (CPU-updated, bouncing)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 10k | cozygpu · webgpu | Sprite | 2777.7 | 0.36 | 0.76 | 0.28 | 0.48 | 0.00 | 115.3 | 0.31–0.44 | ok |
| 10k | cozygpu · webgl2 | Sprite | 768.3 | 1.30 | 2.84 | 1.26 | 2.66 | 0.00 | 417.5 | 1.28–1.55 | ok |
| 10k | cozygpu · worker | Sprite | 59.1 | 16.92 | 17.81 | 0.13 | 0.23 | 0.00 | 4173.2 | 16.90–17.42 | ok (1 skipped, 0 while measuring) |
| 10k | pixi · webgpu | Sprite | 672.7 | 1.49 | 2.43 | 1.28 | 2.16 | 0.01 | 464.5 | 1.22–1.91 | ok |
| 10k | pixi · webgpu | ParticleContainer | 2476.9 | 0.40 | 1.06 | 0.24 | 0.74 | 0.00 | 143.5 | 0.31–0.49 | ok |
| 10k | pixi · webgl | Sprite | 696.5 | 1.44 | 3.63 | 1.26 | 3.31 | 0.00 | 945.0 | 1.36–1.53 | ok |
| 10k | pixi · webgl | ParticleContainer | 772.3 | 1.29 | 2.66 | 1.25 | 2.58 | 0.00 | -252.8 | 1.22–1.42 | ok |
| 10k | three · webgl | InstancedMesh | 763.3 | 1.31 | 2.78 | 1.27 | 2.70 | 0.00 | 254.0 | 1.27–1.45 | ok |
| 10k | three · webgpu | InstancedMesh | 1823.9 | 0.55 | 1.04 | 0.38 | 0.73 | 0.00 | 143.7 | 0.35–0.62 | ok |
| 100k | cozygpu · webgpu | Sprite | 623.4 | 1.60 | 2.28 | 1.43 | 1.93 | 0.01 | 277.7 | 1.25–1.89 | ok |
| 100k | cozygpu · webgl2 | Sprite | 667.0 | 1.50 | 2.45 | 1.32 | 2.16 | 0.00 | 2207.5 | 1.47–1.74 | ok |
| 100k | cozygpu · worker | Sprite | 59.0 | 16.96 | 17.77 | 0.97 | 1.20 | 0.00 | 16369.6 | 16.92–17.51 | ok |
| 100k | pixi · webgpu | Sprite | 91.7 | 10.90 | 12.84 | 10.74 | 12.67 | 0.01 | -148.1 | 10.78–11.39 | ok |
| 100k | pixi · webgpu | ParticleContainer | 413.5 | 2.42 | 3.73 | 2.18 | 3.41 | 0.01 | 3572.5 | 2.40–2.82 | ok |
| 100k | pixi · webgl | Sprite | 90.2 | 11.08 | 13.40 | 10.95 | 13.25 | 0.00 | 46100.0 | 10.07–11.89 | ok |
| 100k | pixi · webgl | ParticleContainer | 561.8 | 1.78 | 2.86 | 1.55 | 2.51 | 0.00 | 2256.8 | 1.61–2.24 | ok |
| 100k | three · webgl | InstancedMesh | 626.7 | 1.60 | 3.40 | 1.40 | 3.17 | 0.00 | 36.1 | 1.59–1.66 | ok |
| 100k | three · webgpu | InstancedMesh | 596.1 | 1.68 | 2.97 | 1.41 | 2.52 | 0.01 | 366.2 | 1.65–1.76 | ok |
| 1M | cozygpu · webgpu | Sprite | 54.8 | 18.26 | 21.11 | 18.03 | 20.87 | 0.02 | -12686.0 | 16.40–20.05 | ok |
| 1M | cozygpu · webgl2 | Sprite | 46.5 | 21.48 | 26.83 | 21.30 | 26.63 | 0.00 | 59303.2 | 18.23–22.69 | ok |
| 1M | cozygpu · worker | Sprite | 57.3 | 17.44 | 21.02 | 16.41 | 20.84 | 0.00 | 50536.2 | 17.26–17.45 | ok (2 skipped, 0 while measuring) |
| 1M | pixi · webgpu | Sprite | 8.1 | 122.85 | 148.76 | 121.77 | 147.95 | 0.02 | 73092.2 | 118.88–131.44 | ok |
| 1M | pixi · webgpu | ParticleContainer | 49.0 | 20.39 | 26.29 | 20.12 | 26.02 | 0.03 | -11138.8 | 20.16–24.89 | ok |
| 1M | pixi · webgl | Sprite | 7.7 | 129.15 | 147.87 | 128.81 | 147.66 | 0.00 | -303055.7 | 122.48–135.92 | ok |
| 1M | pixi · webgl | ParticleContainer | 51.5 | 19.41 | 22.93 | 19.24 | 22.75 | 0.00 | -74298.8 | 16.63–20.58 | ok |
| 1M | three · webgl | InstancedMesh | 34.1 | 29.31 | 32.48 | 29.14 | 32.33 | 0.00 | -93.6 | 26.06–30.22 | ok |
| 1M | three · webgpu | InstancedMesh | 58.2 | 17.17 | 30.32 | 16.92 | 30.07 | 0.02 | -2131.0 | 15.59–19.47 | ok |

## S1b — moving sprites via bindColumns (M2.5: sim x/y bound once, one commit per frame)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + bindColumns | 439.7 | 2.27 | 3.42 | 1.97 | 2.97 | 0.01 | -916.1 | 2.13–2.28 | ok |
| 100k | cozygpu · webgl2 | Sprite + bindColumns | 477.7 | 2.09 | 3.15 | 1.85 | 2.80 | 0.00 | 3116.0 | 1.90–2.50 | ok |
| 100k | cozygpu · worker | Sprite + bindColumns | 59.0 | 16.95 | 17.81 | 1.07 | 2.30 | 0.00 | 16445.2 | 16.94–17.55 | ok |
| 1M | cozygpu · webgpu | Sprite + bindColumns | 49.1 | 20.35 | 25.65 | 20.13 | 25.30 | 0.02 | -14708.6 | 18.25–24.76 | ok |
| 1M | cozygpu · webgl2 | Sprite + bindColumns | 49.8 | 20.09 | 25.45 | 19.91 | 25.23 | 0.00 | -18905.1 | 19.39–21.33 | ok |
| 1M | cozygpu · worker | Sprite + bindColumns | 52.5 | 19.03 | 24.00 | 18.84 | 23.82 | 0.00 | 73463.7 | 17.86–25.00 | ok |

## S2 — swarm (GPU-simulated where supported, else best CPU path)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm (GPU compute) | 106.8 | 9.37 | 15.51 | 0.18 | 0.25 | 8.92 | 496.8 | 9.13–9.62 | ok |
| 1M | cozygpu · webgl2 | Swarm (transform feedback) | 117.5 | 8.51 | 13.17 | 0.10 | 0.23 | 0.00 | 315.2 | 7.09–9.81 | ok |
| 1M | cozygpu · worker | Swarm (GPU compute) | 59.2 | 16.88 | 17.80 | 0.03 | 0.07 | 0.00 | 532.9 | 16.86–17.56 | ok (1 skipped, 0 while measuring) |
| 1M | pixi · webgpu | ParticleContainer | 50.2 | 19.90 | 23.57 | 19.68 | 23.33 | 0.03 | 27946.5 | 18.85–25.26 | ok |
| 1M | pixi · webgl | ParticleContainer | 57.5 | 17.40 | 20.13 | 17.25 | 19.86 | 0.00 | -6620.0 | 15.29–18.70 | ok |
| 1M | three · webgl | InstancedMesh | 38.8 | 25.77 | 32.21 | 25.61 | 31.84 | 0.00 | 1095.7 | 25.65–27.54 | ok |
| 1M | three · webgpu | InstancedMesh | 65.2 | 15.34 | 23.32 | 15.08 | 22.98 | 0.02 | 2587.7 | 15.26–16.30 | ok |
| 1M | three · webgpu | TSL compute + Sprite(count) | 93.9 | 10.65 | 13.38 | 0.53 | 0.53 | 10.25 | -966.0 | 10.25–11.12 | ok |
| 2M | cozygpu · webgpu | Swarm (GPU compute) | 51.5 | 19.41 | 22.65 | 0.13 | 0.24 | 18.95 | 521.9 | 19.05–19.68 | ok |
| 2M | cozygpu · webgl2 | Swarm (transform feedback) | 61.7 | 16.20 | 25.52 | 0.10 | 0.26 | 0.00 | 340.4 | 6.22–16.51 | ok |
| 2M | cozygpu · worker | Swarm (GPU compute) | 59.2 | 16.88 | 17.83 | 0.05 | 0.10 | 0.00 | 533.2 | 16.88–17.42 | ok (1 skipped, 0 while measuring) |
| 2M | pixi · webgpu | ParticleContainer | 24.3 | 41.13 | 48.59 | 40.79 | 47.43 | 0.03 | 25798.6 | 38.75–44.51 | ok |
| 2M | pixi · webgl | ParticleContainer | 27.7 | 36.12 | 42.60 | 35.95 | 42.44 | 0.00 | 90285.4 | 34.68–49.05 | ok |
| 2M | three · webgl | InstancedMesh | 9.6 | 103.67 | 118.96 | 103.56 | 113.82 | 0.00 | 20043.6 | 92.83–111.32 | ok |
| 2M | three · webgpu | InstancedMesh | 27.7 | 36.05 | 67.77 | 35.86 | 67.49 | 0.02 | 8370.3 | 32.27–37.96 | ok |
| 2M | three · webgpu | TSL compute + Sprite(count) | 42.3 | 23.64 | 33.13 | 0.26 | 0.56 | 23.05 | -5273.1 | 22.13–26.78 | ok |

## S3 — static sprites (nothing moves)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite | 1578.8 | 0.63 | 2.15 | 0.07 | 0.82 | 0.02 | 333.1 | 0.58–0.69 | ok |
| 100k | cozygpu · webgl2 | Sprite | 754.4 | 1.33 | 3.38 | 1.21 | 3.20 | 0.00 | 237.0 | 1.25–1.54 | ok |
| 100k | cozygpu · worker | Sprite | 59.1 | 16.91 | 17.79 | 0.03 | 0.06 | 0.00 | 1313.7 | 16.91–17.56 | ok (1 skipped, 0 while measuring) |
| 100k | pixi · webgpu | Sprite | 1366.0 | 0.73 | 2.11 | 0.10 | 0.32 | 0.14 | 2309.9 | 0.72–1.77 | ok |
| 100k | pixi · webgpu | ParticleContainer | 1348.3 | 0.74 | 1.86 | 0.30 | 0.42 | 0.10 | 549.5 | 0.74–0.81 | ok |
| 100k | pixi · webgl | Sprite | 746.5 | 1.34 | 2.83 | 1.12 | 2.58 | 0.00 | 1161.1 | 1.28–1.36 | ok |
| 100k | pixi · webgl | ParticleContainer | 759.6 | 1.32 | 2.78 | 0.91 | 2.59 | 0.00 | 1204.3 | 1.28–1.91 | ok |
| 100k | three · webgl | InstancedMesh | 622.8 | 1.61 | 2.88 | 1.48 | 2.69 | 0.00 | 192.3 | 1.60–1.79 | ok |
| 100k | three · webgpu | InstancedMesh | 1239.2 | 0.81 | 1.92 | 0.34 | 1.02 | 0.07 | 294.5 | 0.76–0.89 | ok |

## A1 — load + upload 200 × 64² PNG

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 200 | cozygpu · webgpu | Assets.loadAll (png) | 6984.8 | 0.14 | 0.43 | 0.02 | 0.11 | 0.00 | 37.6 | 0.14–0.16 | ok |
| 200 | cozygpu · webgpu | Assets.loadAll (png, atlas off) | 4546.5 | 0.22 | 0.50 | 0.08 | 0.22 | 0.01 | 56.5 | 0.19–0.30 | ok |
| 200 | cozygpu · webgl2 | Assets.loadAll (png) | 771.7 | 1.30 | 4.54 | 1.23 | 4.48 | 0.00 | -225.3 | 1.25–1.61 | ok |
| 200 | pixi · webgpu | Assets.load (png) | 3763.0 | 0.27 | 0.86 | 0.08 | 0.27 | 0.02 | 105.6 | 0.25–0.38 | ok |
| 200 | pixi · webgl | Assets.load (png) | 743.5 | 1.35 | 3.39 | 0.07 | 0.25 | 0.00 | 92.2 | 1.25–1.43 | ok |

| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|
| cozygpu · webgpu | Assets.loadAll (png) | 100.8 | 102.0 | 6.9 | 108.9 | 16.00 MiB | 1 | rgba8unorm | 536.6 KB | 1 | ok |
| cozygpu · webgpu | Assets.loadAll (png, atlas off) | 96.9 | 98.0 | 7.8 | 105.8 | 3.13 MiB | 0 | rgba8unorm | 680.0 KB | 200 | ok |
| cozygpu · webgl2 | Assets.loadAll (png) | 114.4 | 115.6 | 6.2 | 121.8 | 16.00 MiB | 1 | rgba8unorm | 540.9 KB | 1 | ok |
| pixi · webgpu | Assets.load (png) | 162.9 | 164.0 | 11.1 | 175.0 | 3.13 MiB (est.) | — | bgra8unorm | 1196.9 KB | — | ok |
| pixi · webgl | Assets.load (png) | 129.0 | 131.0 | 11.2 | 142.2 | 3.13 MiB (est.) | — | bgra8unorm | 1118.4 KB | — | ok |

GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).

## A1 — load + upload 200 × 64² KTX2 (BC1, no supercompression)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 200 | cozygpu · webgpu | Assets.loadAll (ktx2) | 4964.1 | 0.20 | 0.45 | 0.07 | 0.20 | 0.00 | -86.6 | 0.15–0.30 | ok |
| 200 | cozygpu · webgl2 | Assets.loadAll (ktx2) | 614.9 | 1.63 | 5.18 | 1.51 | 4.94 | 0.00 | 260.9 | 1.62–1.84 | ok |
| 200 | pixi · webgpu | Assets.load (BC1 as KTX1) | 3693.9 | 0.27 | 0.79 | 0.07 | 0.23 | 0.01 | -18.6 | 0.24–0.35 | ok |
| 200 | pixi · webgl | Assets.load (BC1 as KTX1) | 743.3 | 1.35 | 2.72 | 0.10 | 0.41 | 0.00 | 17.8 | 1.21–1.52 | ok |

| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|
| cozygpu · webgpu | Assets.loadAll (ktx2) | 99.5 | 100.6 | 5.5 | 106.1 | 0.39 MiB | 0 | bc1-rgba-unorm | 1128.6 KB | 200 | ok |
| cozygpu · webgl2 | Assets.loadAll (ktx2) | 69.5 | 70.7 | 4.6 | 75.3 | 0.39 MiB | 0 | bc1-rgba-unorm | 1198.6 KB | 200 | ok |
| pixi · webgpu | Assets.load (BC1 as KTX1) | 96.1 | 97.3 | 16.4 | 113.7 | 0.39 MiB (est.) | — | bc1-rgba-unorm | 1669.1 KB | — | ok |
| pixi · webgl | Assets.load (BC1 as KTX1) | 97.4 | 98.5 | 11.7 | 110.2 | 0.39 MiB (est.) | — | bc1-rgba-unorm | 1581.9 KB | — | ok |

GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).

## A2 — picking latency at 100k static sprites (one pick in flight, vsync ON = 60 fps like a real page)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 60.0 | 16.67 | 17.52 | 0.09 | 0.13 | 0.01 | 2123.5 | 16.66–16.67 | ok |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 60.0 | 16.67 | 17.63 | 0.11 | 0.19 | 0.00 | 1812.2 | 16.66–16.67 | ok |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 60.0 | 16.67 | 17.46 | 0.03 | 0.05 | 0.00 | 1353.5 | 16.66–16.67 | ok |
| 100k | pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 60.0 | 16.67 | 17.43 | 0.77 | 2.65 | 0.01 | 3798.0 | 16.66–16.67 | ok |
| 100k | three · webgl | InstancedMesh + Raycaster (CPU) | 60.0 | 16.67 | 17.48 | 5.65 | 6.14 | 0.00 | 1951.1 | 16.66–16.67 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 301 | 100% | 3.73 | 3.75 | 6.11 | 6.17 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · webgl2 | Sprite + renderer.pick() | 301 | 100% | 5.50 | 5.69 | 7.55 | 7.77 | 1.00 | 1.0 | 16.67 | ok |
| cozygpu · worker | Sprite + renderer.pick() | 301 | 100% | 4.39 | 3.70 | 6.93 | 7.41 | 1.00 | 1.0 | 16.67 | ok |
| pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 302 | 100% | 0.65 | 0.45 | 2.54 | 3.31 | 0.00 | 0.0 | 16.67 | ok |
| three · webgl | InstancedMesh + Raycaster (CPU) | 302 | 100% | 5.55 | 5.51 | 6.06 | 11.08 | 0.00 | 0.0 | 16.67 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A2u — picking at 100k, frame-rate limit OFF (stress: async readbacks compete with an uncapped rAF loop)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 100k | cozygpu · webgpu | Sprite + renderer.pick() | 270.5 | 3.70 | 17.80 | 0.03 | 0.11 | 0.01 | 696.6 | 3.65–3.78 | ok (378 skipped, 271 while measuring) |
| 100k | cozygpu · webgl2 | Sprite + renderer.pick() | 268.3 | 3.73 | 17.82 | 0.04 | 0.19 | 0.00 | 570.0 | 3.67–3.79 | ok (379 skipped, 269 while measuring) |
| 100k | cozygpu · worker | Sprite + renderer.pick() | 59.1 | 16.92 | 17.80 | 0.03 | 0.06 | 0.00 | 1329.5 | 16.91–17.64 | ok (1 skipped, 0 while measuring) |
| 100k | pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 940.1 | 1.06 | 4.55 | 0.97 | 4.38 | 0.01 | 2628.7 | 0.98–1.50 | ok |
| 100k | three · webgl | InstancedMesh + Raycaster (CPU) | 158.6 | 6.31 | 8.46 | 6.15 | 8.09 | 0.00 | 362.9 | 5.22–7.15 | ok |

| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Sprite + renderer.pick() | 271 | 100% | 4.30 | 3.98 | 6.35 | 7.29 | 5.00 | 5.0 | 3.70 | ok (378 skipped, 271 while measuring) |
| cozygpu · webgl2 | Sprite + renderer.pick() | 269 | 100% | 7.96 | 7.68 | 11.07 | 11.50 | 5.00 | 5.0 | 3.73 | ok (379 skipped, 269 while measuring) |
| cozygpu · worker | Sprite + renderer.pick() | 286 | 100% | 4.56 | 4.82 | 7.21 | 7.57 | 1.03 | 2.0 | 16.92 | ok (1 skipped, 0 while measuring) |
| pixi · webgpu | Sprite + EventBoundary.hitTest (CPU) | 4702 | 100% | 0.93 | 0.58 | 4.30 | 10.89 | 0.00 | 0.0 | 1.06 | ok |
| three · webgl | InstancedMesh + Raycaster (CPU) | 794 | 100% | 6.11 | 6.00 | 8.04 | 10.87 | 0.00 | 0.0 | 6.31 | ok |

Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).

## A3 — swarm spawn/kill churn (capacity 1M, 8000 spawns/frame, life 0.5–1.5 s ⇒ ~480k alive)

| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1M | cozygpu · webgpu | Swarm churn (allocation 'gpu') | 176.9 | 5.65 | 11.95 | 0.10 | 0.18 | 2.42 | -308.3 | 4.97–5.95 | ok (141 skipped, 0 while measuring) |
| 1M | cozygpu · webgpu | Swarm churn (allocation 'ring') | 158.5 | 6.31 | 12.82 | 0.09 | 0.14 | 3.38 | -493.4 | 6.18–6.52 | ok (187 skipped, 0 while measuring) |
| 1M | cozygpu · webgl2 | Swarm churn (allocation 'ring') | 169.6 | 5.89 | 8.58 | 5.74 | 8.34 | 0.00 | -572.0 | 5.07–6.41 | ok (297 skipped, 0 while measuring) |
| 1M | pixi · webgpu | ParticleContainer churn (CPU pool) | 14.8 | 67.74 | 75.12 | 67.69 | 74.91 | 0.02 | -35166.4 | 66.44–72.24 | ok |

| engine | tool | alive at end | spawns/frame | draw calls | front CPU ms | packet B | status |
|---|---|---:|---:|---:|---:|---:|---|
| cozygpu · webgpu | Swarm churn (allocation 'gpu') | 476088 | 8000 | 1 | 0.01 | 232 | ok (141 skipped, 0 while measuring) |
| cozygpu · webgpu | Swarm churn (allocation 'ring') | 476200 | 8000 | 1 | 0.01 | 232 | ok (187 skipped, 0 while measuring) |
| cozygpu · webgl2 | Swarm churn (allocation 'ring') | — | 8000 | 1 | 0.01 | 232 | ok (297 skipped, 0 while measuring) |
| pixi · webgpu | ParticleContainer churn (CPU pool) | 475821 | 8000 | — | — | — | ok |

## S4 — init time and JS heap per object (from S3, 100k static sprites)

| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cozygpu · webgpu | Sprite | 18.8 | 21.6 | 20.1 | 61.9 | 359.5 B | 63741.0 KB | 4.1 |
| cozygpu · webgl2 | Sprite | 25.3 | 19.9 | 17.7 | 62.9 | 359.4 B | 63849.4 KB | 4.1 |
| cozygpu · worker | Sprite | 34.8 | 19.4 | 15.9 | 69.9 | 305.9 B | 58358.1 KB | 3.3 |
| pixi · webgpu | Sprite | 29.8 | 52.4 | 152.3 | 234.5 | 1299.0 B | 156943.4 KB | 34.2 |
| pixi · webgpu | ParticleContainer | 25.2 | 53.6 | 14.1 | 92.6 | 304.5 B | 59828.5 KB | 1.7 |
| pixi · webgl | Sprite | 44.9 | 51.4 | 156.4 | 251.6 | 1298.8 B | 156774.4 KB | 30.2 |
| pixi · webgl | ParticleContainer | 33.5 | 52.6 | 18.5 | 107.3 | 304.4 B | 59660.7 KB | 2.4 |
| three · webgl | InstancedMesh | 13.6 | 4.0 | 25.0 | 42.3 | 66.3 B | 36012.9 KB | 0.2 |
| three · webgpu | InstancedMesh | 4.4 | 3.8 | 19.5 | 27.0 | 72.9 B | 36958.2 KB | 0.6 |

### Init at 1M+ objects (S1/S2)

| scenario | count | engine | tool | total init ms | heap / object | destroy ms |
|---|---:|---|---|---:|---:|---:|
| sprites-moving | 1M | cozygpu · webgpu | Sprite | 352.5 | 299.9 B | 17.3 |
| sprites-moving | 1M | cozygpu · webgl2 | Sprite | 310.2 | 299.9 B | 17.6 |
| sprites-moving | 1M | cozygpu · worker | Sprite | 310.8 | 257.9 B | 15.3 |
| sprites-moving | 1M | pixi · webgpu | Sprite | 2084.3 | 1298.6 B | 272.6 |
| sprites-moving | 1M | pixi · webgpu | ParticleContainer | 554.1 | 302.8 B | 1.2 |
| sprites-moving | 1M | pixi · webgl | Sprite | 2125.4 | 1298.6 B | 296.0 |
| sprites-moving | 1M | pixi · webgl | ParticleContainer | 549.7 | 302.8 B | 4.1 |
| sprites-moving | 1M | three · webgl | InstancedMesh | 82.8 | 64.2 B | 0.2 |
| sprites-moving | 1M | three · webgpu | InstancedMesh | 71.3 | 64.9 B | 1.3 |
| sprites-moving | 1M | cozygpu · webgpu | Sprite + bindColumns | 281.4 | 304.9 B | 17.1 |
| sprites-moving | 1M | cozygpu · webgl2 | Sprite + bindColumns | 314.4 | 304.9 B | 22.3 |
| sprites-moving | 1M | cozygpu · worker | Sprite + bindColumns | 325.2 | 262.9 B | 19.6 |
| swarm | 1M | cozygpu · webgpu | Swarm (GPU compute) | 22.9 | 0.2 B | 0.7 |
| swarm | 1M | cozygpu · webgl2 | Swarm (transform feedback) | 28.9 | 0.1 B | 0.6 |
| swarm | 1M | cozygpu · worker | Swarm (GPU compute) | 42.5 | 0.1 B | 0.3 |
| swarm | 1M | pixi · webgpu | ParticleContainer | 591.5 | 302.8 B | 1.3 |
| swarm | 1M | pixi · webgl | ParticleContainer | 637.0 | 302.8 B | 5.1 |
| swarm | 1M | three · webgl | InstancedMesh | 76.5 | 64.2 B | 0.2 |
| swarm | 1M | three · webgpu | InstancedMesh | 54.4 | 64.9 B | 0.6 |
| swarm | 1M | three · webgpu | TSL compute + Sprite(count) | 41.5 | 16.9 B | 0.6 |
| swarm | 2M | cozygpu · webgpu | Swarm (GPU compute) | 20.8 | 0.1 B | 0.8 |
| swarm | 2M | cozygpu · webgl2 | Swarm (transform feedback) | 37.7 | 0.1 B | 2.9 |
| swarm | 2M | cozygpu · worker | Swarm (GPU compute) | 79.9 | 0.0 B | 0.4 |
| swarm | 2M | pixi · webgpu | ParticleContainer | 1191.1 | 303.9 B | 1.2 |
| swarm | 2M | pixi · webgl | ParticleContainer | 1115.1 | 303.9 B | 13.3 |
| swarm | 2M | three · webgl | InstancedMesh | 111.8 | 64.1 B | 0.2 |
| swarm | 2M | three · webgpu | InstancedMesh | 73.4 | 64.4 B | 0.7 |
| swarm | 2M | three · webgpu | TSL compute + Sprite(count) | 43.4 | 16.5 B | 0.7 |
| swarm-churn | 1M | cozygpu · webgpu | Swarm churn (allocation 'gpu') | 20.1 | 0.2 B | 0.7 |
| swarm-churn | 1M | cozygpu · webgpu | Swarm churn (allocation 'ring') | 20.4 | 0.2 B | 0.6 |
| swarm-churn | 1M | cozygpu · webgl2 | Swarm churn (allocation 'ring') | 27.6 | 0.1 B | 0.5 |
| swarm-churn | 1M | pixi · webgpu | ParticleContainer churn (CPU pool) | 391.3 | 150.9 B | 1.0 |

## Bundle size (esbuild, minified, gzip -9)

| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |
|---|---|---:|---:|---:|---:|---:|
| cozygpu | createRenderer + Texture + Sprite | 28 | 213.2 KB | 74.9 KB | 246.2 KB | 88.2 KB |
| cozygpu (all exports) | whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB) | 31 | 237.4 KB | 82.6 KB | 295.4 KB | 105.5 KB |
| cozygpu worker | worker bundle (budget ≤ 25 KB) | 16 | 136.0 KB | 47.2 KB | 139.4 KB | 49.1 KB |
| pixi.js | Application + Sprite + Texture (renderer chunks loaded on demand) | 24 | 6.3 KB | 2.8 KB | 520.4 KB | 158.4 KB |
| three (WebGLRenderer) | WebGLRenderer + Mesh + MeshBasicMaterial | 1 | 516.7 KB | 129.5 KB | 516.7 KB | 129.5 KB |
| three/webgpu (WebGPURenderer) | WebGPURenderer + Mesh + MeshBasicNodeMaterial | 1 | 769.3 KB | 210.6 KB | 769.3 KB | 210.6 KB |

### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)

| engine | files | min | min+gzip |
|---|---:|---:|---:|
| cozygpu · webgpu | 17 | 169.4 KB | 60.4 KB |
| cozygpu · webgl2 | 17 | 173.2 KB | 62.2 KB |
| cozygpu · worker | 17 | 289.1 KB | 98.8 KB |
| pixi · webgpu | 22 | 581.3 KB | 179.4 KB |
| pixi · webgl | 22 | 581.2 KB | 179.4 KB |
| three · webgl | 4 | 570.3 KB | 144.8 KB |
| three · webgpu | 4 | 898.8 KB | 250.3 KB |

## Verdict per scenario (cozygpu best vs best competitor)

| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sprites-moving/10000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.36 | 0.76 | pixi-webgpu-particle (ParticleContainer) | 0.40 | 1.06 | -11% | -28% | -11% | +222% |
| sprites-moving/100000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 1.50 | 2.45 | three-webgl-instanced (InstancedMesh) | 1.60 | 3.40 | -6% | -28% | +1% | -6% |
| sprites-moving/1000000 | frame ms | three-webgpu-instanced | cozygpu-worker-auto | 17.44 | 21.02 | three-webgpu-instanced (InstancedMesh) | 17.17 | 30.32 | +2% | -31% | +6% | +25% |
| sprites-moving-columns/100000 | frame ms | cozygpu-webgl2-columns | cozygpu-webgl2-columns | 2.09 | 3.15 | — | — | — | — | — | — | — |
| sprites-moving-columns/1000000 | frame ms | cozygpu-worker-columns | cozygpu-worker-columns | 19.03 | 24.00 | — | — | — | — | — | — | — |
| swarm/1000000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 8.51 | 13.17 | three-webgpu-compute (TSL compute + Sprite(count)) | 10.65 | 13.38 | -20% | -2% | -12% | -20% |
| swarm/2000000 | frame ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 16.20 | 25.52 | three-webgpu-compute (TSL compute + Sprite(count)) | 23.64 | 33.13 | -31% | -23% | -18% | -31% |
| sprites-static/100000 | frame ms | cozygpu-webgpu-auto | cozygpu-webgpu-auto | 0.63 | 2.15 | pixi-webgpu-sprite (Sprite) | 0.73 | 2.11 | -13% | +2% | -13% | +81% |
| assets-png/200 | load+upload ms | cozygpu-webgpu-noatlas | cozygpu-webgpu-noatlas | 105.83 | — | pixi-webgl-sprite (Assets.load (png)) | 142.16 | — | -26% | — | -26% | -14% |
| assets-ktx2/200 | load+upload ms | cozygpu-webgl2-auto | cozygpu-webgl2-auto | 75.31 | — | pixi-webgl-sprite (Assets.load (BC1 as KTX1)) | 110.21 | — | -32% | — | -4% | -32% |
| picking/100000 | pick latency ms | pixi-webgpu-sprite | cozygpu-webgpu-auto | 3.73 | 6.11 | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.65 | 2.54 | +472% | +141% | +472% | +744% |
| picking-uncapped/100000 | pick latency ms | pixi-webgpu-sprite | cozygpu-webgpu-auto | 4.30 | 6.35 | pixi-webgpu-sprite (Sprite + EventBoundary.hitTest (CPU)) | 0.93 | 4.30 | +363% | +48% | +363% | +756% |
| swarm-churn/1000000 | frame ms | cozygpu-webgpu-gpu | cozygpu-webgpu-gpu | 5.65 | 11.95 | pixi-webgpu-particle (ParticleContainer churn (CPU pool)) | 67.74 | 75.12 | -92% | -84% | -92% | -91% |

Δ < 0: cozygpu faster (lower is better for every metric here).

## Since m2-final (same case ids)

| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| sprites-moving/10000/cozygpu-webgpu-auto | 0.24 | 0.36 | +49% | 0.31 | 0.76 | +145% | 0.20 | 0.28 | +37% | 19.7 | 40.8 | **yes** |
| sprites-moving/10000/cozygpu-webgl2-auto | 1.28 | 1.30 | +1% | 2.59 | 2.84 | +10% | 1.25 | 1.26 | +1% | 254.2 | 38.6 | no |
| sprites-moving/10000/cozygpu-worker-auto | 17.67 | 16.92 | -4% | 18.80 | 17.81 | -5% | 0.31 | 0.13 | -57% | 254.2 | 69.4 | no |
| sprites-moving/100000/cozygpu-webgpu-auto | 1.11 | 1.60 | +44% | 1.27 | 2.28 | +79% | 1.00 | 1.43 | +42% | 270.2 | 45.8 | **yes** |
| sprites-moving/100000/cozygpu-webgl2-auto | 1.04 | 1.50 | +44% | 1.13 | 2.45 | +116% | 0.96 | 1.32 | +38% | 271.8 | 56.3 | **yes** |
| sprites-moving/100000/cozygpu-worker-auto | 17.85 | 16.96 | -5% | 18.88 | 17.77 | -6% | 2.36 | 0.97 | -59% | 269.8 | 83.1 | no |
| sprites-moving/1000000/cozygpu-webgpu-auto | 11.79 | 18.26 | +55% | 13.43 | 21.11 | +57% | 11.60 | 18.03 | +55% | 416.1 | 352.5 | **yes** |
| sprites-moving/1000000/cozygpu-webgl2-auto | 15.59 | 21.48 | +38% | 16.17 | 26.83 | +66% | 15.40 | 21.30 | +38% | 418.2 | 310.2 | **yes** |
| sprites-moving/1000000/cozygpu-worker-auto | 17.20 | 17.44 | +1% | 18.70 | 21.02 | +12% | 8.72 | 16.41 | +88% | 412.9 | 310.8 | **yes** |
| swarm/1000000/cozygpu-webgpu-auto | 6.88 | 9.37 | +36% | 13.45 | 15.51 | +15% | 4.84 | 0.18 | -96% | 231.6 | 22.9 | **yes** |
| swarm/1000000/cozygpu-webgl2-auto | 6.08 | 8.51 | +40% | 7.76 | 13.17 | +70% | 0.01 | 0.10 | +887% | 235.2 | 28.9 | **yes** |
| swarm/1000000/cozygpu-worker-auto | 17.57 | 16.88 | -4% | 18.77 | 17.80 | -5% | 0.07 | 0.03 | -52% | 229.2 | 42.5 | no |
| swarm/2000000/cozygpu-webgpu-auto | 14.25 | 19.41 | +36% | 15.63 | 22.65 | +45% | 14.19 | 0.13 | -99% | 217.0 | 20.8 | **yes** |
| swarm/2000000/cozygpu-webgl2-auto | 11.96 | 16.20 | +36% | 13.03 | 25.52 | +96% | 0.01 | 0.10 | +845% | 215.6 | 37.7 | **yes** |
| swarm/2000000/cozygpu-worker-auto | 16.65 | 16.88 | +1% | 18.73 | 17.83 | -5% | 0.01 | 0.05 | +354% | 210.7 | 79.9 | **yes** |
| sprites-static/100000/cozygpu-webgpu-auto | 0.53 | 0.63 | +19% | 1.63 | 2.15 | +32% | 0.02 | 0.07 | +263% | 268.9 | 61.9 | **yes** |
| sprites-static/100000/cozygpu-webgl2-auto | 1.28 | 1.33 | +3% | 2.57 | 3.38 | +32% | 1.23 | 1.21 | -2% | 273.8 | 62.9 | no |
| sprites-static/100000/cozygpu-worker-auto | 17.72 | 16.91 | -5% | 18.80 | 17.79 | -5% | 0.07 | 0.03 | -57% | 270.7 | 69.9 | no |
| assets-png/200/cozygpu-webgpu-auto | 0.09 | 0.14 | +51% | 0.88 | 0.43 | -51% | 0.01 | 0.02 | +60% | 78.0 | 133.0 | **yes** |
| assets-png/200/cozygpu-webgpu-noatlas | 0.13 | 0.22 | +63% | 0.21 | 0.50 | +136% | 0.04 | 0.08 | +89% | 73.8 | 129.1 | **yes** |
| assets-png/200/cozygpu-webgl2-auto | 1.24 | 1.30 | +4% | 2.55 | 4.54 | +78% | 1.08 | 1.23 | +13% | 310.6 | 145.8 | no |
| assets-ktx2/200/cozygpu-webgpu-auto | 0.13 | 0.20 | +56% | 0.20 | 0.45 | +122% | 0.05 | 0.07 | +58% | 289.2 | 136.2 | **yes** |
| assets-ktx2/200/cozygpu-webgl2-auto | 1.52 | 1.63 | +7% | 2.98 | 5.18 | +74% | 1.45 | 1.51 | +4% | 298.6 | 93.9 | no |
| picking/100000/cozygpu-webgpu-auto | 16.67 | 16.67 | -0% | 18.54 | 17.52 | -6% | 0.29 | 0.09 | -70% | 58.0 | 65.7 | no |
| picking/100000/cozygpu-webgl2-auto | 16.67 | 16.67 | -0% | 18.58 | 17.63 | -5% | 0.20 | 0.11 | -46% | 59.2 | 62.7 | no |
| picking/100000/cozygpu-worker-auto | 16.67 | 16.67 | -0% | 18.52 | 17.46 | -6% | 0.07 | 0.03 | -58% | 58.1 | 73.6 | no |
| picking-uncapped/100000/cozygpu-webgpu-auto | 0.54 | 3.70 | +590% | 18.69 | 17.80 | -5% | 0.01 | 0.03 | +286% | 39.2 | 63.8 | **yes** |
| picking-uncapped/100000/cozygpu-webgl2-auto | 3.33 | 3.73 | +12% | 18.88 | 17.82 | -6% | 0.05 | 0.04 | -16% | 272.8 | 56.7 | **yes** |
| picking-uncapped/100000/cozygpu-worker-auto | 17.70 | 16.92 | -4% | 18.82 | 17.80 | -5% | 0.07 | 0.03 | -50% | 268.7 | 65.2 | no |
| swarm-churn/1000000/cozygpu-webgpu-gpu | 4.34 | 5.65 | +30% | 9.08 | 11.95 | +32% | 1.34 | 0.10 | -93% | 234.4 | 20.1 | **yes** |
| swarm-churn/1000000/cozygpu-webgpu-ring | 5.80 | 6.31 | +9% | 11.63 | 12.82 | +10% | 2.86 | 0.09 | -97% | 234.2 | 20.4 | no |
| swarm-churn/1000000/cozygpu-webgl2-ring | 4.76 | 5.89 | +24% | 5.24 | 8.58 | +63% | 4.73 | 5.74 | +21% | 238.7 | 27.6 | **yes** |

Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.

Machine drift control: median Δavg of the 43 unchanged Pixi/Three cases = +27%.

