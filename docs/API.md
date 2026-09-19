# cozygpu API

```ts
import * as GPU from 'cozygpu';
```

This covers the **M1** surface (implemented) and the **M2** surface
(contracts frozen, being built; marked **M2**). Everything exported in
`src/index.ts` is listed here. The sketches under
[Later](#later-milestones-sketches) are M3 and may change.

Everything is in stage pixels (CSS pixels, origin top-left, y down),
angles are radians, time is in seconds, and colors are `0xRRGGBB` numbers
or `'#rrggbb[aa]'` strings.

---

## Renderer

```ts
const renderer = await GPU.createRenderer({
  canvas: document.querySelector('canvas')!,
  // all optional:
  backend: 'auto', // 'auto' (WebGPU, else WebGL2) | 'webgpu' | 'webgl2' (M2: WebGL2)
  worker: false, // true | { url } — render from a Web Worker
  resolution: 'device', // number | 'device' (tracks devicePixelRatio)
  autoResize: true, // ResizeObserver on the canvas' CSS box
  background: 0x101018,
  backgroundAlpha: 1,
  antialias: false, // 4× MSAA
  powerPreference: 'high-performance',
  limits: 'default', // 'max' for multi-million-object Swarms
  debug: false, // WebGPU error scopes + shader warnings (development only)
  onDeviceLost: ({ willRestore }) => console.warn('GPU lost', willRestore),
  onDeviceRestored: () => console.info('GPU restored'),
  assets: { gpuBudgetMB: 256 }, // M2: options for renderer.assets
});

renderer.stage; // root Container
renderer.render(); // encode + submit one frame
renderer.resize(800, 600); // CSS px (only needed with autoResize: false)
renderer.width;
renderer.height;
renderer.resolution;
renderer.info; // { backend, fallbackReason?, worker, sharedMemory, capabilities }
renderer.stats; // { frameId, drawCalls, packetBytes, cpuMs, skippedFrames }
const hit = await renderer.pick(e.offsetX, e.offsetY); // M2: { node, instance, x, y } | null
renderer.assets; // M2: asset manager (see Assets)
renderer.destroy();
```

`createRenderer` rejects with `GPU.CozyGPUError` (`code: 'UNSUPPORTED'`)
when no backend is available. With `backend: 'auto'` (M2) it tries WebGPU
first and falls back to WebGL2 when WebGPU is missing or fails to
initialise; `renderer.info.backend` tells you which one you got, and
`renderer.info.fallbackReason` says why WebGPU was not used when `'auto'`
fell back (undefined otherwise — it is a diagnostic string, do not branch
on it). A node
tree should be drawn by one renderer at a time: dirty flags are shared, so
a second renderer drawing the same nodes can miss updates.

Capabilities are plain data. Check them instead of the backend name:

```ts
const caps = renderer.info.capabilities;
caps.backend; // 'webgpu' | 'webgl2'
caps.compute; // WebGPU: true. WebGL2: false (Swarm uses transform feedback)
caps.transformFeedback; // WebGL2: true
caps.textureCompression; // { bc, bc7, etc2, astc }
caps.maxTextureSize;
```

### WebGL2 (M2)

```ts
const renderer = await GPU.createRenderer({ canvas, backend: 'webgl2' });
```

Sprites, textures, MSAA, picking, assets and worker mode work the same.
The ceiling is lower for Swarm: custom behaviors need a `glsl` variant,
`allocation: 'gpu'` and `render.cull` are WebGPU-only, and capacity is
limited to `GPU.SWARM_GL_MAX_CAPACITY` (4M; a warning above
`GPU.SWARM_GL_WARN_CAPACITY` = 1M — plan for ~250k at 60 fps on integrated
GPUs). Both constants are exported so you can size a swarm against the
ceiling instead of hard-coding it.

## Ticker (optional)

```ts
const ticker = GPU.ticker(renderer); // autoStart, autoRender: true by default
const off = ticker.add((dt, time) => {
  hero.rotation += dt;
});
ticker.maxFPS = 30;
ticker.fps; // smoothed
off(); // remove the callback
ticker.stop();
```

Without a ticker, call `renderer.render()` from your own loop.

## Scene graph: Container and Sprite

```ts
const texture = await GPU.loadTexture('/img/hero.png'); // url | Blob | ImageBitmap | <img> | canvas
const atlas = await GPU.loadTexture('/img/atlas.png', { nearest: true });
const coin = atlas.sub(0, 0, 16, 16); // frame; batches with the atlas
const white = GPU.Texture.WHITE;
const dot = GPU.Texture.fromPixels(1, 1, new Uint8Array([255, 255, 255, 255]));

const world = new GPU.Container({ x: 100, y: 50 });
renderer.stage.addChild(world);

const hero = new GPU.Sprite({
  texture,
  anchor: 0.5,
  x: 200,
  y: 150,
  tint: 0xffcc88,
});
world.addChild(hero);

hero.setPosition(250, 150).setScale(2);
hero.rotation = Math.PI / 4;
hero.alpha = 0.8;
hero.visible = true;
hero.blendMode = 'add'; // 'normal' | 'add' | 'multiply' | 'screen'
hero.width = 64; // sets scaleX from the texture frame width
hero.texture = coin;

world.removeChild(hero);
hero.destroy();
```

Setters write straight into shared typed arrays and set dirty bits. They
never allocate, so updating 100k sprites per frame is fine. Moving a
sprite (`x`, `y`, `setPosition`) takes a fast path that skips the rotation
and scale math. Draw order is tree order. Consecutive sprites with the
same texture source and blend mode share one draw call.

```ts
// 100k moving sprites, zero allocation per frame
const sprites: GPU.Sprite[] = [];
for (let i = 0; i < 100_000; i++) {
  sprites.push(world.addChild(new GPU.Sprite({ texture: coin })));
}
const vx = new Float32Array(sprites.length);
ticker.add(dt => {
  for (let i = 0; i < sprites.length; i++) {
    sprites[i].x += vx[i] * dt;
  }
});
```

### Bulk child transforms (M2)

For many children of one container, write typed arrays instead of calling
setters. The writer is reused and allocation-free.

```ts
const bulk = world.bulkChildren(
  GPU.BulkField.POSITION | GPU.BulkField.ROTATION,
);
bulk.pull(GPU.BulkField.POSITION); // optional: start from current values
ticker.add(dt => {
  const p = bulk.position; // [x0, y0, x1, y1, …] by child index
  for (let i = 0; i < bulk.count; i++) {
    p[i * 2] += vx[i] * dt;
    bulk.rotation[i] += dt;
  }
  bulk.commit(GPU.BulkField.POSITION | GPU.BulkField.ROTATION);
});
// After adding or removing children, acquire again:
if (bulk.version !== world.childrenVersion) {
  /* world.bulkChildren(...) */
}
```

Fields: `POSITION` (x, y), `ROTATION`, `SCALE` (sx, sy), `ALPHA`, `TINT`
(sprites). `commit(fields, first?, count?)` updates only that range.

### Picking (M2)

```ts
canvas.addEventListener('pointerdown', async e => {
  const hit = await renderer.pick(e.offsetX, e.offsetY);
  if (hit) console.log(hit.node.label, hit.instance); // instance: Swarm slot, -1 for sprites
});
hero.pickable = false; // Sprites are pickable by default
swarm.pickable = true; // Swarms are not (opt in)
```

Picking renders one pixel on the GPU and reads it back, so it resolves
after the next `render()` (1–2 frames) and costs nothing in frames
without picks. It returns the topmost pickable node whose texture alpha is
at least 0.5 at that point. Containers have no pixels and are never
returned. It is not an event system: call it from your own handlers.

## Swarm: millions of GPU-simulated objects

A Swarm is a scene node whose objects live **only on the GPU**. Behaviors
are small WGSL snippets compiled into one compute shader (WebGPU), or GLSL
snippets compiled into a transform-feedback program (WebGL2, M2). The CPU
sends a few bytes per frame, however many objects there are.

```ts
const swarm = new GPU.Swarm({
  capacity: 1_000_000,
  shape: 'circle', // or texture + frames
  blendMode: 'add',
  render: { fadeOut: true }, // alpha follows remaining life
  // also: shrink, alignToVelocity, cull (GPU-cull into an indirect draw; needs caps.indirectDraw)
  behaviors: [
    GPU.behaviors.velocity(),
    GPU.behaviors.acceleration({ name: 'gravity', y: 300 }),
    GPU.behaviors.drag({ k: 0.2 }),
    GPU.behaviors.bounds({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      mode: 'bounce',
      restitution: 0.7,
    }),
    GPU.behaviors.attractor({ x: 960, y: 540, strength: 0, radius: 400 }),
  ],
});
renderer.stage.addChild(swarm);

// One command spawns them all. Ranges are [min, max], sampled on the GPU.
swarm.spawn(1_000_000, {
  x: [0, 1920],
  y: [0, 1080],
  speed: [20, 120],
  angle: [0, Math.PI * 2],
  size: [1, 3],
  life: [2, 6], // or 'immortal' (default)
  // A [from, to] pair picks a random point on the A→B gradient for rgb;
  // alpha gets its own random t (it is not a per-channel lerp).
  color: ['#66ccff', '#ff66cc'],
  alpha: [0.4, 0.9],
});

// Tweak behavior params at runtime (uniform update, no recompilation)
const gravity = swarm.behavior<{ value: 'vec2f' }>('gravity');
gravity.set('value', [0, -300]);

const attractor = swarm.behavior<{
  point: 'vec2f';
  strength: 'f32';
  radius: 'f32';
}>('attractor');
canvas.addEventListener('pointermove', e =>
  attractor.set('point', [e.offsetX, e.offsetY]),
);

swarm.timeScale = 0.5; // slow motion
swarm.autoStep = false; // then call swarm.step(dt) yourself
swarm.kill(0, 1000); // slots [0, 1000)
swarm.clear();
swarm.activeCount; // slots in use (dispatch/draw range)
```

### Custom behaviors

```ts
const swirl = GPU.defineBehavior({
  name: 'swirl',
  params: { center: 'vec2f', strength: 'f32' },
  defaults: { center: [960, 540], strength: 2 },
  // in scope: var p: SwarmHot, let c: SwarmCold, let i: u32, sim, view, $params, rand01(), hash32()
  update: /* wgsl */ `
    let d = p.pos - $params.center;
    p.vel += vec2f(-d.y, d.x) * $params.strength * sim.dt;
    if (length(d) < 4.0) { p.life = 0.0; }    // kill
  `,
});

swarm.setBehaviors([GPU.behaviors.velocity(), swirl]); // async recompile; keeps running meanwhile
```

**M2, WebGL2:** add a GLSL twin so the behavior also runs without compute.
Built-in behaviors ship both. Without `glsl`, a Swarm using the behavior
draws nothing on WebGL2 and logs one `UNSUPPORTED` error.

```ts
const swirl = GPU.defineBehavior({
  name: 'swirl',
  params: { center: 'vec2f', strength: 'f32' },
  defaults: { center: [960, 540], strength: 2 },
  update: /* wgsl */ `let d = p.pos - $params.center; p.vel += vec2f(-d.y, d.x) * $params.strength * sim.dt;`,
  glsl: {
    update: /* glsl */ `vec2 d = p.pos - $params.center; p.vel += vec2(-d.y, d.x) * $params.strength * sim.dt;`,
  },
});
```

### Behavior groups (M2)

```ts
const fx = new GPU.Swarm({
  capacity: 100_000,
  behaviors: [
    GPU.behaviors.velocity(), // everyone
    {
      ...GPU.behaviors.acceleration({ name: 'gravity', y: 400 }),
      groups: 0b01,
    }, // group 0 only
    { ...GPU.behaviors.drag({ k: 2 }), groups: 0b10 }, // group 1 only
  ],
});
fx.spawn(5000, { x: [0, 800], y: 0, group: 0b01 }); // falls
fx.spawn(5000, { x: [0, 800], y: 300, group: 0b10 }); // slows down
```

### GPU allocation (M2, WebGPU)

```ts
const sparks = new GPU.Swarm({
  capacity: 500_000,
  allocation: 'gpu',
  behaviors: [GPU.behaviors.velocity()],
});
ticker.add(() =>
  sparks.spawn(2000, {
    x: 400,
    y: 300,
    speed: [50, 200],
    angle: [0, 6.28],
    life: [0.5, 1.5],
  }),
);
console.log(await sparks.aliveCount()); // debug readback, never per frame
```

Dead objects (life, bounds, kill) go back to a free list on the GPU and are
reused by later spawns, so mortal objects never overwrite live ones.
`spawn` returns 0 and drops spawns beyond the free slots; drawing covers
only alive objects.

### Exact data and allocation

```ts
// Bulk write exact records (layouts: 40-byte hot, 16-byte cold)
const {
  SWARM_HOT_BYTES,
  SH_POS_X,
  SH_POS_Y,
  SH_SCALE_X,
  SH_SCALE_Y,
  SH_LIFE,
  SWARM_IMMORTAL,
} = GPU.layouts;
const n = 1000;
const hot = new Float32Array(n * (SWARM_HOT_BYTES / 4));
for (let i = 0; i < n; i++) {
  const o = i * 10;
  hot[o + SH_POS_X / 4] = i;
  hot[o + SH_POS_Y / 4] = 100;
  hot[o + SH_SCALE_X / 4] = 4;
  hot[o + SH_SCALE_Y / 4] = 4;
  hot[o + SH_LIFE / 4] = SWARM_IMMORTAL;
}
const cold = new Uint32Array(n * 4).fill(GPU.packHex(0xffffff, 1));
swarm.write(0, hot, cold);

// Manual allocation for persistent entities (immortal objects)
const units = new GPU.Swarm({
  capacity: 50_000,
  allocation: 'manual',
  behaviors: [GPU.behaviors.velocity()],
});
const first = units.spawn(100, { x: [0, 500], y: [0, 500] }); // -1 when full
units.kill(first, 100); // frees the slots

// Debug readback (async, never per frame)
const sample = await swarm.readHot(0, 10); // Float32Array
const alive = await swarm.aliveCount(); // M2
```

Readbacks see GPU memory as of the last submitted frame. Spawns issued
before the Swarm's pipelines finish compiling are still pending, so an
early readback returns zeros.

After a GPU device loss, Swarm contents are gone. Handle it with
`new GPU.Swarm({ …, onRestore: s => s.spawn(…) })`. Readbacks reject with a
`CozyGPUError` whose code says why: `DEVICE_LOST` (the device was lost
before or while reading), `OUT_OF_CAPACITY` (the swarm was refused), or
`DESTROYED`.

## Assets (M2)

`renderer.assets` loads, caches and reference-counts textures,
spritesheets and data. Textures are **GPU-only**: pixels are decoded off
the main thread, handed to the GPU, and dropped from JS memory unless you
ask for them.

```ts
// The only entry point: configure it with RendererOptions.assets
// ({ gpuBudgetMB: 256, baseUrl, … }). The implementation is a lazily
// imported chunk, so it costs nothing until you use it.
const assets = renderer.assets;

// One asset. Format comes from the extension and the file's magic bytes.
const hero = await assets.load<GPU.TextureAsset>('img/hero.png');
world.addChild(new GPU.Sprite({ texture: hero.value.texture }));

// Options per asset
const tiles = await assets.load<GPU.TextureAsset>({
  url: 'img/tiles.ktx2', // KTX2: BC / ETC2 / ASTC chosen by capabilities
  alias: 'tiles',
  texture: { nearest: true, mipmaps: true },
});
const mask = await assets.load<GPU.TextureAsset>({
  url: 'img/button.png',
  texture: { hitMask: true },
});
mask.value.hitTest(12, 30); // CPU alpha test, 1 bit per texel

// Spritesheets (TexturePacker JSON) and data
const ui = await assets.load<GPU.SpritesheetAsset>('ui/ui.json');
new GPU.Sprite({ texture: ui.value.frames['button_up.png'] });
const level = await assets.load<{ spawns: number[] }>('data/level1.json');

// Bundles with progress and cancellation
assets.addBundle('level1', {
  bg: 'img/bg.webp',
  enemies: 'img/enemies.json',
  music: { url: 'sfx/theme.bin', kind: 'binary' },
});
const controller = new AbortController();
const bundle = await assets.loadBundle('level1', {
  signal: controller.signal,
  onProgress: p => (bar.style.width = `${p.ratio * 100}%`),
});
bundle.get<GPU.TextureAsset>('bg').value.texture;

// Release when done: textures stay cached until the GPU budget needs the memory
hero.release();
bundle.release();
assets.stats; // { entries, referenced, inFlight, queued, gpuBytes, gpuBudgetBytes, atlasPages, evictions }
```

- **Atlas packing.** Small images (≤ 256 px by default) are packed into
  shared 2048² pages, so sprites using them batch into one draw call.
  Disable with `atlas: false`, per asset with `texture: { atlas: false }`.
- **GPU budget.** Above `gpuBudgetMB` (default 512), released textures are
  evicted least-recently-used first and reloaded from their URL if you
  load them again. Referenced textures are never evicted.
- **Basis / UASTC.** `.basis` files and supercompressed KTX2 need a
  transcoder you provide; cozygpu bundles no WASM:

  ```ts
  const renderer = await GPU.createRenderer({
    canvas,
    assets: {
      transcoder: () => import('./my-basis-transcoder').then(m => m.create()),
    },
  });
  ```

- **Device loss.** Referenced textures are reloaded from their URLs
  automatically; sprites keep their textures and draw white until the
  reload lands.
- **Concurrency.** At most `concurrency` (default 6) downloads at once;
  `load` of an already cached asset resolves immediately.
- Errors: `LOAD_FAILED` (network, HTTP status, decode or parse), `ABORTED`
  (signal), `UNSUPPORTED` (format not supported by this GPU and no
  transcoder).

## Worker mode

Same API, with rendering on a worker thread through OffscreenCanvas.
Heavy main-thread work no longer stalls GPU submission.

```ts
const renderer = await GPU.createRenderer({
  canvas,
  worker: true, // default url: new URL('./cozygpu.worker.js', import.meta.url)
  // worker: { url: '/assets/cozygpu.worker.js' }, // when your bundler moves the file
});
renderer.info.worker; // true
renderer.info.sharedMemory; // true when crossOriginIsolated (COOP/COEP headers): zero-copy uploads,
// and (M2) a shared command ring with no per-frame allocations
```

Notes:

- The canvas must not have a context yet. After creation, never set
  `canvas.width` or `canvas.height` yourself; use `renderer.resize()` or
  `autoResize`.
- `render()` never blocks. If the worker hasn't finished the previous
  frame, the call is skipped (`stats.skippedFrames`) and the next frame
  carries the latest state.
- Readbacks (`swarm.readHot`, `swarm.aliveCount`, `renderer.pick`) are
  async in both modes.
- Assets load on the main thread in both modes and the decoded images are
  transferred to the worker, so there is nothing extra to configure.
- `worker: true` loads the worker transport on demand, so programs that
  don't use it don't ship it.

## Utilities

```ts
GPU.packRGBA8(255, 128, 0, 255); // → packed u32 (r | g<<8 | b<<16 | a<<24)
GPU.packHex(0xff8800, 0.5);
GPU.toPackedColor('#ff8800cc');
GPU.layouts; // all byte offsets (see docs/ARCHITECTURE.md §4)
GPU.VERSION;
try {
  /* … */
} catch (e) {
  if (e instanceof GPU.CozyGPUError && e.code === 'UNSUPPORTED') {
    /* … */
  }
}
```

Error codes: `NOT_IMPLEMENTED`, `UNSUPPORTED`, `DEVICE_LOST`,
`INVALID_ARGUMENT`, `OUT_OF_CAPACITY`, `SHADER_COMPILE`, `DESTROYED`,
`INTERNAL` (an unexpected exception inside the core or worker; please
report it), and M2's `ABORTED` and `LOAD_FAILED` (assets).

---

## Later milestones (sketches)

These are **not implemented** (M3) and their API may change.

### Masks and filters (M3)

```ts
panel.mask = new GPU.Graphics().rect(0, 0, 300, 200);
world.filters = [
  GPU.filters.blur({ strength: 4 }),
  GPU.filters.colorMatrix().saturate(0.5),
];
```

### MSDF text (M3)

```ts
const label = new GPU.Text({
  text: 'Score: 0',
  font: assets.font('font'),
  size: 24,
  tint: 0xffffff,
});
```

### Particles on Swarm (M3)

```ts
const fx = new GPU.Particles({
  capacity: 200_000,
  emitter: { rate: 5000, shape: { disc: 20 } },
  over: { color: ['#fff', '#f80', '#0000'], size: [4, 0] },
});
fx.emitter.moveTo(x, y);
```
