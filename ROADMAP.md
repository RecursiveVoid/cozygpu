# cozygpu roadmap

## M0: Restructure and contracts (done by the lead)

- [x] Rename the package to `cozygpu`. Library entry is `src/index.ts`
      (exports only, no side effects).
- [x] Move the demo into `examples/legacy` and the old code into
      `src/legacy` (frozen).
- [x] Rollup: library, CJS, and worker bundles; examples build; serve and
      livereload only when watching.
- [x] Fix `TextureLoaderEvent` export/import, the `response.ok` check, the
      `CozyGPU` error message, one canvas format, and remove the triangle
      demo.
- [x] Contracts: RHI, command stream, layouts, core and transport, scene,
      swarm, ticker, math.
- [x] Write `docs/API.md` and `docs/ARCHITECTURE.md`.

## M1: WebGPU core, sprites, Swarm, worker mode

### backend

- [x] `src/backend/webgpu`: adapter and device (`limits: 'max'`),
      canvas format, capabilities.
- [x] RHI: buffers, textures, samplers, shaders, bind groups, async
      pipelines, passes, CommandList reuse.
- [x] `readBuffer` via a staging buffer and `mapAsync`.
- [x] RenderCore:
  - [x] Opcode routing and the three-phase frame (execute, compute, draw).
  - [x] View uniform and white texture.
  - [x] Texture registry (`RETAIN_SOURCE`) and shared-memory table.
- [x] Opcodes 0x00 and 0x01 (RESIZE, SET*VIEW, clear color, TEXTURE*\_,
      SHARED\_\_, READBACK).
- [x] Device-lost restore flow (§9.1) and MSAA target on resize.
- [x] `Renderer` class:
  - [x] Frame lifecycle and skip-when-busy.
  - [x] ResizeObserver and DPR tracking.
  - [x] Stats and readback promises.
- [x] `createRenderer` (local and worker) and `createDefaultCoreSystems`.
- [x] `examples/basic`.

### worker

- [x] `createCommandEncoder` / `createCommandDecoder` (alignment,
      growth, pool), with Node tests for every opcode.
- [x] `createLocalTransport`.
- [x] `createWorkerTransport`:
  - [x] OffscreenCanvas handoff and the ready handshake with a timeout.
  - [x] Buffer ping-pong and SAB detection.
- [x] `src/worker/entry.ts` (init, frame, and destroy; error reporting).
- [x] `examples/worker` (busy main thread stays smooth).

### sprites

- [x] Math (`affine*`, color packing) with tests.
- [x] Node and instance stores (SoA, growth, SAB option).
- [x] `Container` and `Sprite` (dirty bits, tree ops, destroy).
- [x] `Texture`, `loadTexture`, `sub()` frames, `ensureTextureUploaded`.
- [x] `createScenePacker`: structure pass, transform pass, dirty
      ranges, batches, CustomDrawable split.
- [x] `createSpriteCoreSystem`: pipelines per blend mode, shared
      uploads, strip draws.
- [x] `ticker`.
- [x] `examples/sprites` (100k sprites).

### swarm

- [x] `composeSwarmShaders` (params layout, `$params` rewrite,
      validation), with Node tests.
- [x] Built-in behaviors: velocity, acceleration, drag, bounds
      (bounce, wrap, kill), attractor. Plus `defineBehavior`.
- [x] `Swarm` front: ring and manual allocation, command queue,
      params mirror, autoStep, readHot and readCold.
- [x] `createSwarmCoreSystem`: buffers, spawn, kill, and step compute
      (dynamic offsets, 2D dispatch), render pipeline (quad and circle,
      fade, shrink, align), async pipeline swap, restore.
- [x] `examples/swarm` (1M objects with a mouse attractor).

### bench

- [x] puppeteer-core harness on system Chrome (no browser downloads):
      FPS, front CPU ms, heap sampling.
- [x] JSON output and a markdown report (`benchmarks/results/`).
- [ ] Budgets from ARCHITECTURE §10 as automatic pass/fail thresholds
      (the report lists the numbers; no threshold check yet).
- [x] Scenarios:
  - [x] 100k static sprites and 100k moving sprites.
  - [x] Swarm at 1M and 2M objects (4M not in the matrix; ~23 fps on an
        integrated GPU in the swarm example).
  - [x] Worker mode (cozygpu worker variants of S1/S2; the busy
        main-thread case is covered by `examples/worker`, not the bench).
- [x] Bundle-size check (min+gzip).

### integrator (end of M1)

- [x] Wire everything and run all examples in headless system Chrome
      (basic, sprites, swarm, worker; main thread, worker, worker + COOP/COEP).
      Screenshots in `examples/_screenshots/`.
- [x] Contract fixes: `debug` option (Renderer/Core/Backend),
      `CoreSystem.readback?`, `'INTERNAL'` error code,
      `SwarmOptions.render.cull`, per-frame SWARM_DESTROY flush.
- [x] Delete `src/legacy`, `examples/legacy`, `src/handlers`, and the
      `eventemitter3` and `gl-matrix` dependencies. Zero runtime deps.
- [x] README quick start.
- [ ] Meet every budget (ARCHITECTURE §10). Open after M1 measurements:
  - [ ] Bundle: still over after the M2 lazy-import pass — minimal
        program 41.3 KB min+gzip (budget 30 KB), all exports 93.3 KB
        (budget 45 KB), worker + one backend 31.7 KB (budget 25 KB).
        Numbers, breakdown and the remaining options are in
        ARCHITECTURE §10; `npm run size` reproduces them.
  - [ ] 100k moving sprites with rotation: ~7 ms `render()` CPU in the
        example (budget < 6 ms; ~5 ms without rotation).
  - [ ] Swarm 4M at 60 fps (measured on integrated M-series GPU only:
        ~23 fps; needs a discrete-GPU run).
  - [ ] Worker-mode fps is paced at ~58 in headless Chrome even with
        vsync off; investigate OffscreenCanvas present pacing.
- [ ] Publish `0.1.0` (user).

## M2: Reach, assets, picking, budgets

Design and frozen contracts: `docs/ARCHITECTURE.md` §11–§18,
`docs/API.md` (items marked M2). Ownership: ARCHITECTURE §11. Every feature
below exists today as a stub that throws `NOT_IMPLEMENTED` (or answers
with that code); `tsc` and `jest` pass.

### architect (done before the build)

- [x] ARCHITECTURE §5/§7/§8/§9 brought up to M1 reality (position fast
      path, offset cache, widened uploads, deferred `device.destroy`,
      frame signal, readback error codes).
- [x] Accepted `transport.ts` optional fields (`readback.code/message`,
      `init.frameSignal`) as contract; `examples/_screenshots/` gitignored.
- [x] Budgets: minimal program ≤ 30 KB (WebGPU and WebGL2), all exports
      ≤ 45 KB, worker ≤ 25 KB.
- [x] Frozen M2 contracts + stubs: RHI (caps, compressed/integer formats,
      transform feedback, `readTexture`), `createBackend` 'auto' fallback
      with dynamic imports, opcodes (PROTOCOL_VERSION 2), picking seams,
      asset API, frame hooks, bulk child API, swarm GLSL/groups/'gpu',
      command ring messages, `.glsl` imports in Jest and Rollup.

### stabilization (carry-over from M1, integrator)

- [ ] Rerun the full browser stress suite on an idle machine, including
      `--only=burst` and `--only=regress`; relaunch Chrome after a crash.
- [ ] Budget pass/fail thresholds in the bench.
- [ ] Optional main-thread pacing mode; report presented fps in the bench.

### webgl2

- [x] `WebGL2Backend.create`: context, caps (§7 table), resize, MSAA
      renderbuffer + blit, blend presets, clear.
- [x] Buffers, textures (`texStorage2D`, compressed levels), samplers,
      `copyExternalImage` with dest origin, mipmaps, `readBuffer`
      (fenceSync), `readTexture` (integer `readPixels`).
- [x] Programs from GLSL with the `G{g}_B{b}` convention, async link
      (`KHR_parallel_shader_compile`), VAOs, instanced draws,
      `firstInstance` emulation.
- [x] Transform feedback pipelines and `FeedbackPass`.
- [x] Context loss / restore (§13.6).
- [x] Sprite GLSL (`sprite.vert.glsl`, `sprite.frag.glsl`,
      `sprite.pick.frag.glsl`) matching WGSL output.
- [x] RHI parity in WebGPU: `readTexture`, compressed `writeTexture`
      (block-aware `bytesPerRow` in `utils.ts`).
- [x] `examples/basic`: `?backend=webgl2`; verify 'auto' fallback in
      Chrome without WebGPU.

### assets

- [x] `detectFormat` (pure, tests), fetch queue with concurrency + abort,
      refcounted cache, bundles with progress, `preload`.
- [x] Images via `createImageBitmap` + transfer; `keepPixels`, `hitMask`.
- [x] KTX2 parser (vkFormat → formats, levels, DFD premultiplied),
      caps-based target selection, lazily loaded `TextureTranscoder` hook.
- [x] Skyline atlas packer (pure, tests), pages with region uploads and
      per-frame mip regeneration.
- [x] GPU budget + LRU eviction + reload from URL; device-loss reload via
      `FrontFrameHook.onDeviceRestored`.
- [x] Spritesheet JSON (TexturePacker hash/array, animations).
- [x] `createAssetsProxy` (< 1 KB, dynamic import of `Assets`).
- [x] `TextureRegistry`: `uploadBitmapRegion`, `uploadCompressed`,
      `generateMipmaps`, compressed format ids, explicit mip counts.
- [x] `examples/assets` (png/webp/ktx2, atlas, bundle progress, budget).

### sprites

- [x] `Container.bulkChildren` / `BulkChildren` / `childrenVersion`
      (< 3 ms for 100k moving sprites).
- [x] Incremental structure pass with byte-for-byte property tests
      against a full rebuild.
- [x] `pickable` + pick ids in `SI_FLAGS`; sprite pick WGSL pipeline and
      `drawPick`.
- [x] `createPickClient` (front) and `createCorePicking` (1×1 rg32uint
      target, pick View uniforms, readback).
- [x] `Texture.fromProvider` + provider path in `ensureTextureUploaded`.
- [x] `examples/sprites`: `?bulk=1`, click-to-pick.

### swarm

- [x] GLSL composer (`language: 'glsl300es'`, std140 params equal to the
      WGSL layout, tests) and GLSL for every built-in behavior.
- [x] WebGL2 core path: ping-pong hot buffers, spawn/step via transform
      feedback, kills, instanced draw, readbacks, `aliveCount`.
- [x] Capacity ceiling and UNSUPPORTED reporting on WebGL2.
- [x] Behavior groups (`groups`, `SpawnOptions.group` → `SP_COLD_FLAGS`).
- [x] `allocation: 'gpu'`: free list, alive compaction, drawIndirect,
      READBACK srcKind 3.
- [x] Swarm picking: `SWARM_SET_PICK`, pick render pipeline, `drawPick`.
- [x] `examples/swarm`: `?backend=webgl2`, `?alloc=gpu`, groups.
- [ ] Shared swarm render-pipeline cache keyed by WGSL + blend mode;
      investigate first-frame pipeline compile variance. (Not started; no
      user-visible symptom measured in M2.)

### worker+build

- [x] SharedArrayBuffer command ring (§17), zero allocations per frame in
      worker mode; transfer path kept.
- [x] Decoder view caching per buffer (SAB slots).
- [x] Dynamic import of `WorkerTransport` in `createRenderer`.
- [x] Async core-system loaders + `isCoreSystemReady` (swarm core as a
      chunk in local mode).
- [x] ESM code splitting (`output.dir`, chunk names); CJS/worker inline.
- [x] Shader minification plugin keeping `//@` lines, with a test.
- [x] `scripts/size.mjs` with the four budgets, non-zero exit on failure.
- [x] Debug inbound message to simulate device loss in worker mode
      (`WorkerInboundMessage {type:'debug'}` + `Transport.debug`; drives
      `examples/basic/?lose=1&debug=1&worker=1`).
- [ ] Inline worker (Blob URL) option. **Deferred to M3** (integrator
      decision): the worker is code-split now (§18.1), and a `blob:` worker
      cannot resolve its sibling chunks, so an inline build would have to
      re-inline both backends and undo the split. Users who need it can pass
      their own Blob URL as `worker: { url }` today.
- [x] `examples/worker`: ring on/off comparison, allocation readout.

### integrator (end of M2)

- [x] Async loaders wired: `systems.ts` hands out a `LazyCoreSystem` for the
      swarm range in both modes, `src/worker/entry.ts` registers the real
      factory eagerly, and `Swarm.ts` registers the loader. No stubs left.
- [x] Every example in both backends and both modes in headless Chrome
      (35 URL variants, screenshots in `examples/_screenshots/`).
- [x] Cross-owner defects fixed: block-aligned compressed `writeTexture`
      on WebGPU, `SWARM_CREATE` shader decode from a command-ring slot,
      `?backend`/`?worker` flags on `examples/sprites` and `examples/worker`,
      `benchmarks/build.mjs` `.glsl` loader.
- [x] Additive contracts: `renderer.info.fallbackReason`,
      `Transport.debug('loseDevice')`, exported `SWARM_GL_*` limits.
- [x] Repo-wide Prettier pass + `npm run prettier:check`,
      `scripts/check-sources.mjs` (no raw control characters),
      `npm run size`, all wired into `prepublishOnly`.
- [x] Size script run and reported (ARCHITECTURE §10).
- [ ] **Bundle budgets are not met** — 41.3 / 43.2 / 93.3 / 31.7 / 33.6 KB
      against 30 / 30 / 45 / 25 / 25 KB. The lazy-import work that was
      available has been done (assets out of the barrel, swarm core split,
      worker code-split: minimal-webgpu 52.0 → 41.3 KB, worker 39.0 →
      31.7 KB). What is left is front code volume, not packaging, so this
      needs an M3 decision: shrink `sprites/front.ts` + `RenderCore.ts`, or
      move the budgets to ~45 KB minimal / ~95 KB all exports.
- [ ] Bench matrix for M2 (WebGL2 and bulk variants, pick latency, asset
      load stall). `benchmarks/build.mjs` builds again and
      `benchmarks/results/latest.md` was regenerated from the full M1 run,
      but no M2 matrix has been measured; the M2 sprite-path numbers are in
      `benchmarks/results/m2-sprites-opt3.json`.
- [ ] Browser stress suite rerun (carried over from M1 stabilization).
- [ ] Per-renderer dirty tracking decision (moved to M3; nothing in M2
      needed it).
- [ ] `docs/reports/M2.md`.

## M3: Visual features

- [ ] Masking (stencil and scissor).
- [ ] Filters and effects (render-target pool, blur, color matrix, bloom).
- [ ] MSDF text.
- [ ] Particles on Swarm (emitters, over-life curves).
- [ ] Custom blend factors and render-to-texture API.
