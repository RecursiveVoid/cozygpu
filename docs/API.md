# cozygpu API

```ts
import * as GPU from 'cozygpu';
```

This covers the **M1** and **M2** surface (M2 items are marked **M2**),
the **M2.5** integration hooks (marked **M2.5**, see
[Integration hooks](#integration-hooks-m25)) and the **M3** visual
features — masks, filters, text and particles. All of it is implemented.
Everything exported in `src/index.ts` is listed here.

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
  events: bus, // M2.5: any { emit(name, payload) } — rare lifecycle events only
});

renderer.stage; // root Container
renderer.render(); // encode + submit one frame
renderer.resize(800, 600); // CSS px (only needed with autoResize: false)
renderer.width;
renderer.height;
renderer.resolution;
renderer.info; // { backend, fallbackReason?, worker, sharedMemory, capabilities }
renderer.stats; // { frameId, drawCalls, packetBytes, cpuMs, skippedFrames }
const hit = await renderer.pick(e.offsetX, e.offsetY); // M2: { node, instance, userId, x, y } | null
renderer.assets; // M2: asset manager (see Assets)
const interop = await renderer.interop(); // M2.5, main thread only: native device + external buffers
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

When the data already lives in your own typed arrays (an ECS, a
simulation), bind them instead of copying into the writer: see
[External columns](#external-columns-m25).

### Picking (M2)

```ts
canvas.addEventListener('pointerdown', async e => {
  const hit = await renderer.pick(e.offsetX, e.offsetY);
  if (hit) console.log(hit.node.label, hit.instance); // instance: Swarm slot, -1 for sprites
  if (hit) selectEntity(hit.userId); // M2.5: your id (node.userId, or the Swarm instance's `user`)
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
const first = units.spawn(100, { x: [0, 500], y: [0, 500], user: 42 }); // -1 when full
// M2.5: `user` is the instance user id; pick() returns it as hit.userId
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

// M3: MSDF fonts for GPU.Text (atlas JSON + its page image, cached as one asset)
const font = await assets.load<GPU.FontAsset>({
  url: 'fonts/inter.json',
  kind: 'font',
});

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

## Integration hooks (M2.5)

cozygpu is a graphics library, not an engine. It has no ECS and no event
bus, but it gives any of them (cozyECS, cozyEvent, your own) a few small,
library-neutral hooks. Each one is **registered once and committed per
frame**, allocates nothing per frame, and uses no WebGPU or WebGL types.
A full walk-through is the recipe `docs/recipes/ecs.md`.

### External columns (M2.5)

Bind your own typed arrays to a container's children; row i drives child i.

```ts
const layer = new GPU.Container();
renderer.stage.addChild(layer);
for (let i = 0; i < n; i++) layer.addChild(new GPU.Sprite({ texture: coin }));

const px = new Float32Array(cap);
const py = new Float32Array(cap);
const entity = new Uint32Array(cap);
const binding = layer.bindColumns({ x: px, y: py, userId: entity });

ticker.add(() => {
  // …your systems write px / py…
  binding.commit(n); // one tight copy, one dirty range, one upload
});

// Your storage grew and the arrays were replaced: bind again.
binding.rebind({ x: px2, y: py2, userId: entity2 });
```

- Columns: `x`, `y` (required), `rotation`, `scaleX`, `scaleY`, `alpha`
  (`Float32Array`), `tint`, `frame`, `userId` (`Uint32Array`). Units match
  the setters.
- Interleaved storage: pass `{ array, offset, stride }`, e.g.
  `{ x: { array: xy, offset: 0, stride: 2 }, y: { array: xy, offset: 1, stride: 2 } }`,
  or set `options.stride` for every plain array. `options.stride` applies
  to every column given as a plain typed array, so a mixed bind (interleaved
  `xy` plus a dense `tint`) passes the dense one as `{ array, stride: 1 }`.
- Growing, shrinking or reordering the children needs no rebind: `commit`
  follows the children list (rows map to children by index).
- `frame` picks `options.frames[k]` per child (frames of one atlas keep
  batching).
- `commit(count, first?, fields?)` behaves exactly like
  `bulkChildren().commit`: same dirty bits, same fast path for
  position-only updates. `fields` takes `GPU.BulkField` bits (`FRAME` and
  `USER_ID` are new in M2.5).
- `commit` throws `INVALID_ARGUMENT` when `first + count` exceeds the child
  count or a column is too short. `unbind()` drops the references.

### User ids (M2.5)

```ts
const hero = new GPU.Sprite({ texture, userId: 1234 }); // any u32; default 0
hero.userId = 1235; // no redraw
swarm.spawn(100, { x: [0, 800], y: 0, user: 7 }); // Swarm instances: cold.user
const hit = await renderer.pick(x, y);
hit?.userId; // 1235 for the sprite, 7 for a Swarm instance
```

`userId` never changes what is drawn. For a Swarm hit, `hit.userId` is the
instance's `user` value (it travels in the pick texel); the Swarm node's own
id is `hit.node.userId`. For a sprite, `hit.userId` is read from
`node.userId` when the answer arrives: if your code moved another entity
into that sprite while the pick was in flight (swap-remove), the hit reports
the entity that is there now. Add a generation to recycled ids if that
matters.

### Events (M2.5)

```ts
const bus = {
  emit(name: string, payload: unknown) {
    console.log(name, payload); // or forward to your own event library
  },
};
const renderer = await GPU.createRenderer({ canvas, events: bus });

// Typed: GPU.Events maps each name to its payload.
function onLost(p: GPU.Events['deviceLost']) {
  if (!p.willRestore) showFatal(p.message);
}
```

| event            | payload                                              | when                                         |
| ---------------- | ---------------------------------------------------- | -------------------------------------------- |
| `fallback`       | `{ from: 'webgpu', to: 'webgl2', reason }`           | `backend: 'auto'` fell back (before `ready`) |
| `ready`          | `{ backend, worker, sharedMemory, fallbackReason? }` | once, before `createRenderer()` resolves     |
| `deviceLost`     | `{ backend, message, willRestore }`                  | GPU device or WebGL context lost             |
| `deviceRestored` | `{ backend, generation }`                            | after a successful restore                   |
| `resize`         | `{ width, height, resolution }`                      | the css size or resolution changed           |
| `assetProgress`  | `{ key, bundle, loaded, total, ratio }`              | an asset (or bundle entry) finished loading  |
| `assetError`     | `{ key, url, code, message }`                        | an asset load failed                         |
| `error`          | `{ code, message }`                                  | a non-fatal renderer error (also logged)     |

Nothing is emitted per frame (use `renderer.stats`). `onDeviceLost` and
`onDeviceRestored` keep working; the events fire right after them. A sink
that throws is caught and logged once.

### Device interop (M2.5, main thread only)

Share the renderer's GPU device with your own GPU code, and draw a Swarm
straight from a buffer your compute pass fills: no copy, no readback.

```ts
const interop = await renderer.interop(); // rejects UNSUPPORTED with worker: true
if (interop.backend === 'webgpu') {
  const device = interop.device as GPUDevice;
  const hot = device.createBuffer({
    size: n * GPU.layouts.SWARM_HOT_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const source = interop.registerInstanceBuffer(hot, {
    layout: 'swarm-hot',
    capacity: n,
  });
  swarm.setSource({ hot: source, count: n }); // draw only: your compute moves them
  ticker.add(() => {
    runMyCompute(device, hot); // submit on device.queue before render()
    swarm.setSourceCount(n);
  });
}
```

- Records follow `GPU.layouts` (`'swarm-hot'`: 40 B, `'swarm-cold'`:
  16 B). `setSource({ hot, cold?, count, simulate? })`; `simulate: true`
  also runs the Swarm's behaviors on your buffer (WebGPU only).
  `setSource(null)` goes back to the Swarm's own buffers.
- While a source is set, `spawn`, `kill`, `write` and `clear` throw
  `INVALID_ARGUMENT`: your code owns the data.
- WebGL2: `interop.device` is the `WebGL2RenderingContext` (call
  `interop.invalidateState()` after your own GL calls), but Swarm external
  sources are WebGPU-only in M2.5: `setSource` throws `UNSUPPORTED` on
  WebGL2 (a draw-only path is planned).
- A source switch never lands after a dispatch in the same frame: spawns
  and writes queued before `setSource()` go to the Swarm's own buffers, and
  the switch takes effect the next frame. `activeCount` keeps counting the
  Swarm's own buffers.
- `readHot`, `readCold` and `aliveCount()` read the external buffers; they
  reject with `UNSUPPORTED` when a buffer lacks COPY_SRC or was released or
  lost.
- After `deviceRestored`, read `interop.device` again, recreate your
  buffers, register them and call `setSource` again. A device loss also
  drops the Swarm's source, so `onRestore` runs on the Swarm's own (empty)
  buffers and can `spawn` / `write` into them; a draw-only source still
  reads colour, frame and user id from those cold records, so refill them
  there or the swarm draws fully transparent quads. The pre-loss handles
  are invalid (`valid` is false), so a re-registration you miss throws
  instead of silently drawing nothing.

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
- M2.5: columns, user ids and events work the same in worker mode;
  `renderer.interop()` does not (the device lives in the worker).

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

## Visual features (M3)

Masks, filters, text and particles. Each one arrives as its own lazily
imported chunk the first time you use it, so a program that never touches
them bundles none of their code. Design: `docs/ARCHITECTURE.md` §21–§24;
the limits each feature still has are listed with it below.

### Group: masks and filters (M3)

Effects live on `Group`, a Container that can carry a mask and a filter
chain. They are not on every Container on purpose: a group is a batch
boundary and may cost a render target, and a program that never imports
`Group` ships none of the mask or filter code.

```ts
const panel = new GPU.Group({ x: 40, y: 40 });
panel.addChild(photo, caption);
stage.addChild(panel);

panel.mask = { x: 0, y: 0, width: 300, height: 200 }; // rect
panel.mask = shapeSprite; // any node's pixels
panel.mask = { source: shapeSprite, invert: true, mode: 'stencil' };
panel.mask = null;

await panel.ready; // the effect chunks have loaded
await GPU.loadEffects(); // or preload both up front
```

- The mask source is a `SceneNode` (its drawn pixels) or a rect in the
  group's parent space. A mask node need not be in the scene tree; if it
  is, it also draws normally.
- `mode` defaults to `'auto'`, which picks the cheapest correct
  implementation: **scissor** for an axis-aligned rect or an unrotated
  sprite, **stencil** for other shapes, **alpha** (render to texture) when
  the backend cannot clip with the stencil buffer.
- `'auto'` reads geometry, not texels, so **a soft-edged mask needs
  `mode: 'alpha'` by name** — an unrotated sprite would otherwise clip to a
  hard rectangle.
- On WebGPU, `'auto'` does not pick stencil and an explicit
  `mode: 'stencil'` falls back to alpha: a WebGPU pipeline carries its own
  stencil state, so the sprite pipelines would all have to declare one.
  WebGL2 uses stencil as described.
- `invert` keeps what is outside; `threshold` (default 0.5) decides what
  counts as opaque for the binary modes.
- Masks nest (up to 8 levels) and combine with filters on the same group.
- **Until the effect chunk is loaded the group's subtree is not drawn**, so
  a mask never flashes unclipped content. `group.ready` resolves when it is
  drawable.

```ts
const world = new GPU.Group();
world.filters = [
  GPU.filters.blur({ strength: 4, quality: 'fast' }),
  GPU.filters.colorMatrix().saturate(0.5).hue(15),
];
world.filterOptions = { resolution: 0.5, blendMode: 'normal' };
world.filters = null; // remove
```

Built-ins: `blur`, `colorMatrix`, `displacement`, `outline`, `glow`.
A chain applies to the group's whole subtree; wrap the scene in a group for
a full-screen effect.

**Cheap chains never allocate.** `colorMatrix` (and `outline` on MSDF text)
compile into the sprite batch's shader instead of a render target, so tint,
saturation, hue, contrast and grayscale cost one uniform and no extra pass.
Mixing is fine: the cheap prefix folds into the batch and the rest takes a
target. Targets are pooled by size and reused across frames and groups, so
a steady-state frame allocates nothing.

`filterOptions`: `resolution` (relative to DPR, default 1), `area` (the
captured rect, default the group's bounds plus the chain's padding),
`blendMode` of the composite, `keepTarget` for feedback effects.

A chain of only cheap filters (`colorMatrix` and its helpers) takes no
render target at all: it is folded into the sprite batch. A mixed chain
folds its cheap prefix and gives the rest a target. `outline` is not
folded even on text today, so it costs a pass. With `antialias: true`,
`keepTarget` starts each frame cleared rather than loading the previous
one.

Custom filters mirror `defineBehavior`:

```ts
const pixelate = GPU.defineFilter({
  name: 'pixelate',
  params: { size: 'f32' },
  defaults: { size: 8 },
  wgsl: `...`, // fs_main over the captured target
  glsl: `...`, // the WebGL2 variant
  padding: 0,
});
world.filters = [pixelate()];
```

A filter without a shader for the renderer's backend is skipped and
reports `UNSUPPORTED` once; the rest of the chain still runs. In the shader
body, read the source through `cozySample(uv)` (it handles the GL v-flip),
reach the pass uniform as `fpass` and your params as `$params.<name>`; a
param may not be called `texel`, `size`, `area`, `time`, `passIndex` or
`unit`. `defineFilter` throws `INVALID_ARGUMENT` for those and for a
definition with neither `wgsl` nor `glsl`.

### Text (M3)

```ts
const handle = await renderer.assets.load<GPU.FontAsset>({
  url: 'fonts/inter.json',
  kind: 'font', // MSDF atlas JSON + its page image
});

const label = new GPU.Text('Score: 0', {
  font: handle.value,
  size: 24,
  fill: 0xffffff,
  align: 'left',
  maxWidth: 320,
  wrap: 'word',
  letterSpacing: 0,
  lineHeight: 1.2,
});
stage.addChild(label);
await label.ready;

label.text = 'Score: 1'; // re-lays out from the first changed glyph only
label.setStyle({ size: 32 });
label.metrics; // { width, height, lines, firstBaseline, glyphs }
```

- MSDF is the default: one atlas page per font, crisp at any size and
  rotation.
- A `Text` **is a Container** whose children are its glyph sprites, so
  glyphs batch with the sprites around them and picking, `userId`, masks
  and filters work on text with no extra code. Do not add or remove its
  children yourself.
- For system fonts and emoji, pass a font descriptor instead; glyphs are
  rasterised on demand into an atlas page:

  ```ts
  new GPU.Text('emoji 🎉', {
    font: { family: 'Menlo', weight: 600, atlasSize: 64 },
    size: 18,
  });
  ```

- Layout runs on the front in both renderer modes and uses no DOM, so
  worker mode needs nothing extra.
- Style: `font`, `size`, `fill`, `align` (`left | center | right |
justify`), `baseline`, `lineHeight`, `letterSpacing`, `wordSpacing`,
  `maxWidth`, `wrap` (`word | char | none`), `maxLines`, `ellipsis`,
  `pixelSnap`.

### Particles (M3)

```ts
const fx = new GPU.Particles({
  capacity: 200_000,
  texture: spark,
  emitter: {
    rate: 5000,
    shape: { disc: { radius: 20 } },
    speed: [40, 120],
    life: [0.4, 1.2],
    size: [2, 6],
  },
  over: {
    color: ['#ffffff', '#ff8800', '#00000000'],
    size: [1, 0],
  },
});
stage.addChild(fx);

fx.emitter().moveTo(pointer.x, pointer.y);
fx.emitter().burst(200);
fx.pause();
fx.swarm.aliveCount().then(n => console.log(n));
```

- `Particles` owns a `Swarm` (`fx.swarm`) and compiles emitters and curves
  into spawn commands, behaviors and a small curve block. Per frame the CPU
  does work **per emitter, not per particle**, so a million particles cost
  the same as a thousand.
- Emitter shapes: `{ point: true }`, `{ disc: { radius, inner } }`,
  `{ rect: { width, height } }`, `{ line: { x2, y2 } }`. Several emitters
  per node are allowed (`emitter: [...]`, `fx.emitter('sparks')`).
- `over` curves (up to 4 stops) drive color, alpha and size in the render
  shader — no simulation cost; `rotation` and `drag` curves compile to
  behaviors.
- Presets: `GPU.particlePresets.fire()`, `.smoke()`, `.sparks()`,
  `.rain()`, `.confetti()` return full options you can spread and edit.
- WebGL2: ring allocation, finite `life`, capacity within the Swarm
  WebGL2 ceiling; everything else is identical.

---

## Later milestones (sketches)

These are **not implemented** and their API may change: a `Graphics` node
(vector shapes), a public render-to-texture API, custom blend factors, a
camera API, and bounds readback.

Known limits of the M3 features:

- Picking ignores masks and filters: a pick inside a masked group hits the
  unclipped geometry.
- `mode: 'stencil'` is WebGL2-only (see [Group](#group-masks-and-filters-m3)).
- A container mask carries one texture, so a mask built from sprites with
  different texture sources only clips with the first source's sprites.
- A filter's capture target is canvas-sized rather than area-sized;
  every group at one resolution shares two or three pooled textures.
- `TextStyle` has no `stroke`, so `SpriteInstanceFlag.SDF_OUTLINE` is not
  driven yet; `GPU.filters.outline()` covers the same ground with a pass.
- A scene holding a `Group` takes full structure rebuilds in the packer
  instead of incremental ones.
