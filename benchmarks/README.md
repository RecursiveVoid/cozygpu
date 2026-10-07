# cozygpu benchmarks

This compares cozygpu with Pixi.js and Three.js. Every library runs the
same scenarios with the same inputs:

- positions and velocities from the same seed
- the same 16×16 soft-circle texture
- a 1280×720 canvas at 1x
- normal alpha blending
- a fixed simulation step of 1/60 s

Only the rendering path differs between libraries.

```bash
cd /Users/erginturk/dev/cozygpu
node benchmarks/run.mjs                      # full matrix, ~10 min
node benchmarks/run.mjs --quick              # 1 s warmup, 2 s measure
node benchmarks/run.mjs --filter 'pixi|three' --scenarios s2 --label swarm-only
node benchmarks/run.mjs --list               # print the case ids
node benchmarks/run.mjs --repeat 3 --label round-0   # 3 interleaved rounds; report per-metric medians
node benchmarks/run.mjs --scenarios s2 --counts 10000,100000 --filter cozygpu --label dbg   # debug at small counts
node benchmarks/run.mjs --scenarios a1,a2,a3 --quick --label m2-smoke   # M2 scenarios only (a1 = png + ktx2, a2 = vsync + uncapped)
node benchmarks/run.mjs --repeat 3 --label m2-base    # M2 baseline: S1–S3 + A1–A3, compared with m1-final
node benchmarks/run.mjs --scenarios t1,f1,m1m,p1 --repeat 3 --label m3   # M3 scenarios (m1m = one case set per mask path)
node benchmarks/run.mjs --report m1-quick    # regenerate latest.md from results/m1-quick.json (never rewrites the source json/md)
node benchmarks/run.mjs --quick --filter cozygpu --no-sizes --merge m1-quick   # re-run a subset into an existing result
node benchmarks/serve.mjs                    # build + serve http://127.0.0.1:4100/ (case menu) until Ctrl-C
node benchmarks/build.mjs --sizes            # bundles + bundle-size JSON only
BENCH_NO_COI=1 node benchmarks/serve.mjs     # serve without COOP/COEP (diagnostics: no SharedArrayBuffer)
```

Outputs:

- `benchmarks/results/<label>.json`: raw data for every case, plus
  machine, GPU, Chrome, flags and library versions.
- `benchmarks/results/<label>.md` and `benchmarks/results/latest.md`:
  markdown tables for the run, the per-scenario verdict (cozygpu best vs best
  competitor) and the comparison with M1 (`analysis` in the JSON).
- With `--repeat n` the matrix runs n times as interleaved rounds (whole
  matrix per round, so drift in machine load spreads over every case). Each
  case's numbers are the **median of each metric over its ok runs**; the raw
  runs stay in `results[i].runs`, and `reps.range` holds min–max of avg frame,
  p99 frame and CPU avg. The report adds an "avg range" column.
- `benchmarks/results/shots/<label>/*.png`: written with `--screenshots`
  so you can check that each case really draws (gitignored, like `dist/`).

Case status: `ok`, `not-implemented` (a cozygpu stub threw
`NOT_IMPLEMENTED`), `skipped`, `error` (exception, stack in the JSON),
`hung` (the page stopped answering CDP for 30 s, e.g. a main thread blocked
in a GPU call), `timeout` (no result within warmup + 4×duration + `--timeout`)
or `crashed` (renderer process died). A failing case never stops the run.

## Scenarios

| id                                           | what                                                                                                                                                              | cozygpu                                                                                                   | Pixi                                                                                                                              | Three                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **S1** `sprites-moving` 10k / 100k / 1M      | Bouncing 8 px textured sprites. The position is updated on the CPU every frame (`BounceSim`, SoA typed arrays) and then copied into the library.                  | `Sprite` in a `Container`, `setPosition`                                                                  | `Sprite` **and** `ParticleContainer` (dynamic `position` only)                                                                    | `InstancedMesh`, with translation written straight into `instanceMatrix.array`                                  |
| **S2** `swarm` 1M / 2M                       | 2 px objects bouncing inside the stage                                                                                                                            | `Swarm` (GPU compute: `velocity` + `bounds` bounce)                                                       | No GPU simulation, so the best CPU path: `ParticleContainer`                                                                      | WebGL: CPU `InstancedMesh`. WebGPU: CPU `InstancedMesh` **and** TSL compute (`instancedArray` + `Sprite.count`) |
| **S3** `sprites-static` 100k                 | Same as S1, but nothing moves; `render()` still runs every frame                                                                                                  | `Sprite`                                                                                                  | `Sprite` and `ParticleContainer` (all properties static)                                                                          | `InstancedMesh` (`StaticDrawUsage`)                                                                             |
| **S4** init + heap                           | Taken from S3 (100k): renderer init, populate, first frame, JS heap per object. The report also lists init at 1M+ from S1/S2.                                     |                                                                                                           |                                                                                                                                   |                                                                                                                 |
| **Bundle**                                   | min+gzip of each library's minimal "one textured sprite" program, built with esbuild, plus the JS each bench page actually loaded                                 |                                                                                                           |                                                                                                                                   |                                                                                                                 |
| **A1** `assets-png` / `assets-ktx2` 200 (M2) | Load + upload 200 distinct 64×64 images, one sprite each. Files are generated by `assets.mjs` into `dist/a1/` (PNG, BC1 KTX2, and the same BC1 blocks as KTX 1.1) | `renderer.assets.loadAll` (variant `noatlas`: `atlas: false`)                                             | `Assets.load`; compressed case loads **KTX 1.1** (Pixi's KTX2 loader only reads RGBA8 or Basis KTX2: "Unsupported VkFormat: 131") | —                                                                                                               |
| **A2** `picking` 100k (M2)                   | S3 plus one pick in flight at a random sprite centre. Runs with vsync ON (60 fps, like a real page); `picking-uncapped` repeats it with the frame-rate limit off  | `renderer.pick()` (GPU pick pass + async readback)                                                        | `EventBoundary.hitTest` (CPU)                                                                                                     | WebGL: `Raycaster.intersectObject(InstancedMesh)` (CPU)                                                         |
| **A3** `swarm-churn` 1M (M2)                 | Capacity 1M, 8000 spawns per frame with life 0.5–1.5 s, stepped with the fixed 1/60 s ⇒ ~480k alive in steady state                                               | `Swarm` `allocation: 'gpu'` (variant `gpu`) and `'ring'` (variant `ring`; WebGL2 has no `'gpu'`)          | `ParticleContainer` + CPU pool (spawn, age, bounce, swap-remove)                                                                  | —                                                                                                               |
| **T1** `text` 10k (M3)                       | 200 labels × 50 glyphs; 20 labels (10 %) get a new string every frame                                                                                             | `Text` (variant `msdf`: the example MSDF font via `kind: 'font'`; `canvas`: system-font glyph atlas)      | `BitmapText` on the same MSDF atlas (`dist/fonts/cozy.fnt`, written by `build.mjs`) **and** `Text` (Canvas2D)                     | —                                                                                                               |
| **F1** `filtered` 100k (M3)                  | 100k static sprites under blur (8 px) + color matrix, filter area = the canvas                                                                                    | `Group.filters` (variant `good`: Gaussian; `fast`: dual Kawase)                                           | `BlurFilter` (default quality) + `ColorMatrixFilter` on a `Container` of Sprites **and** a `ParticleContainer`                    | —                                                                                                               |
| **M1m** `masked-moving` 10k (M3)             | 10k sprites in a container sliding along x under a fixed mask; one scenario per mask path (`-scissor`, `-stencil`, `-alpha`)                                      | `Group.mask`: rect (scissor), circle sprite `mode: 'stencil'` (WebGPU resolves to alpha), `mode: 'alpha'` | `Graphics` rect / circle (stencil), `Sprite` (alpha)                                                                              | —                                                                                                               |
| **P1** `particles` 500k (M3)                 | Disc emitter, life 1–2 s, ~333k spawns/s ⇒ ~500k alive, alpha 1→0 and size ×1→0.25 over life, fixed 1/60 s step                                                   | `Particles` (`autoStep: false`, `step(SIM_DT)`)                                                           | `ParticleContainer` + CPU emitter (pool, age, move, alpha/scale, swap-remove)                                                     | —                                                                                                               |

Renderers per library:

- **cozygpu**: `webgpu` (main thread), `webgl2` (main thread, M2) and
  `worker` (worker mode on WebGPU; the page is `crossOriginIsolated`, so
  SharedArrayBuffer uploads are exercised). The backend is requested
  explicitly; a silent fallback fails the run.
- **Pixi**: `webgpu` and `webgl`. The run fails if Pixi silently falls
  back to another renderer.
- **Three**: `WebGLRenderer` and `WebGPURenderer`. The run fails if
  `WebGPURenderer` falls back to its WebGL2 backend.

cozygpu scenarios are written against `docs/API.md`. Until the M1 stubs
are implemented they report `not-implemented`
(`CozyGPUError('NOT_IMPLEMENTED')`) instead of failing the run.

## Metrics

- **Frame time / fps**: the interval between consecutive
  `requestAnimationFrame` callbacks during the measure window. With the
  frame-rate limit off, this is bounded by real CPU work plus GPU
  backpressure. The report gives avg, p50, p95, p99 and max. Slow cases
  keep measuring until they have at least 20 frames, up to 4× the
  duration.
- **CPU**: time inside the frame callback (sim step, library update and
  the render call). On WebGPU this _includes_ time blocked in
  `getCurrentTexture()` when the GPU is behind. On WebGL it includes
  driver syncs. So high CPU with low JS self-time means the GPU is the
  bottleneck; profile with CDP to tell the two apart.
- **Init**:
  - `rendererMs`: `createRenderer` / `app.init` / `new WebGLRenderer` /
    `await renderer.init()`
  - `populateMs`: texture and object creation
  - `firstFrameMs`: the first render plus 2 rAFs, which includes lazy
    pipeline/shader compilation
- **Heap**: `performance.memory.usedJSHeapSize` (precise flag) after a
  forced `gc()`.
  - `perObjectBytes` = (after populate − after init) / count.
  - `growthPerFrameBytes` is the heap growth across the measure window
    without GC, divided by the frame count. It is approximate (a minor
    GC can hide growth), but ≈ 0 means no steady-state allocation. That
    is the cozygpu budget in ARCHITECTURE §10.
  - GPU memory is not measured.
- **Destroy**: after the result is read, the runner calls
  `window.__benchDestroy()` (the adapter's `destroy()`) with a 10 s limit
  and records `destroyMs` (`> 10 s` in the report when it times out). The
  harness never destroys on its own, so a slow teardown can't hide a
  result.
- **A1**: `loadMs` = the `loadAll` / `Assets.load` call (fetch + decode),
  `load+upload` = populate + first frame (textures are uploaded at the first
  render). GPU bytes: cozygpu reports `assets.stats.gpuBytes` (an atlas page
  counts in full); Pixi has no GPU-memory stat, so it is estimated from each
  `TextureSource` (format × size × mips).
- **A2**: latency = pick call → result in hand, and frames rendered in
  between. Pixi and Three are synchronous (frames = 0; the cost is inside
  the frame). Stats are in `info.pick` (median over runs per field).
- **A3**: `info.aliveAtEnd` (cozygpu: `swarm.aliveCount()` after the
  measure window; the churn keeps running until the readback lands).
- **Since M1**: every run compares cozygpu case ids with
  `results/m1-final.json` (`--compare <label>`, `none` to skip) and flags a
  regression when avg frame is > 10 % slower and above the M1 max run, or
  CPU is > 25 % higher. The unchanged Pixi/Three cases give a drift control.
- cozygpu extra info comes from `renderer.stats`: `drawCalls`,
  `packetBytes`, `frontCpuMs` (the budget number) and `skippedFrames`
  (worker mode: skipped frames are not presented, so compare fps with
  that in mind).

Observed caveat (Chrome 152, headless, M4): worker mode runs at about
60 fps even with the frame-rate limit off (worker-side present pacing), so `cozygpu · worker` fps is
capped near 60 at small counts (compare `CPU` and `skippedFrames`
instead). Main-thread canvases are uncapped.

Each case runs in a **fresh Chrome process**, so no GPU state, JIT state
or heap carries over between cases.

## Chrome setup

The runner uses system Chrome
(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, or pass
`--chrome <path>`) through `puppeteer-core`. No browser is downloaded. It
runs in `headless=new` by default: on macOS, headless with
`--use-angle=metal` gives working WebGPU **and** uncapped rAF. `--headful`
opens a real window instead.

| flag                                                                                                                    | why                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `--enable-unsafe-webgpu`                                                                                                | WebGPU without blocklist/origin checks            |
| `--use-angle=metal`                                                                                                     | macOS: hardware WebGPU/WebGL on Metal in headless |
| `--ignore-gpu-blocklist`                                                                                                | never fall back to SwiftShader                    |
| `--disable-gpu-vsync`                                                                                                   | presents don't wait for display refresh           |
| `--disable-frame-rate-limit`                                                                                            | rAF not capped at 60 fps (omit with `--vsync`)    |
| `--enable-precise-memory-info`                                                                                          | unquantized `performance.memory`                  |
| `--js-flags=--expose-gc`                                                                                                | `window.gc()` for heap baselines                  |
| `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` | keep rAF at full speed                            |

The page is served by `benchmarks/serve.mjs` on **port 4100** with
COOP/COEP headers. It has no caching and does no compression, since
transfer size doesn't matter locally.

## Files

| file                                                                         | role                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `run.mjs`                                                                    | runner: case matrix, Chrome per case, JSON + markdown report                     |
| `build.mjs`                                                                  | esbuild bundles (`dist/`, gitignored) and bundle-size measurement                |
| `serve.mjs`                                                                  | static server on port 4100 (COOP/COEP)                                           |
| `assets.mjs`                                                                 | A1 asset set (PNG, BC1 KTX2, BC1 KTX 1.1) written into `dist/a1/` by `build.mjs` |
| `index.html`                                                                 | loads `dist/<lib>.js` for `?lib=…`, or shows a case menu                         |
| `src/harness.ts`                                                             | in-page phases, rAF measure loop, heap, result object                            |
| `src/common.ts`                                                              | params, seeded `BounceSim`, texture, `Adapter` interface                         |
| `src/cozygpu.ts`, `src/pixi.ts`, `src/three-webgl.ts`, `src/three-webgpu.ts` | one adapter per library/renderer family                                          |
| `size/*.ts`                                                                  | minimal programs for bundle-size measurement                                     |

Adding a library: implement `Adapter` (`init`, `populate`, `frame`,
`info`) in `src/<lib>.ts`, call `start(factory)`, then add an entry
point in `build.mjs`, a loader line in `index.html` and engines in
`run.mjs`.

## Library versions

The runner also records these in every result JSON (`meta.versions`).

| package                  | version        |
| ------------------------ | -------------- |
| pixi.js                  | 8.20.1         |
| three (and @types/three) | 0.186.0 (r186) |
| puppeteer-core           | 25.11.0        |
| esbuild                  | 0.28.2         |
| Chrome                   | 152.0.7977.84  |
