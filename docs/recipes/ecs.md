# Using cozygpu with an ECS

cozygpu is a graphics library. It has no entity-component system, no game
loop and no event bus, and it never will: those belong to the application
(or to the cozyJS suite, which wires libraries together). What cozygpu
offers instead is three small, library-neutral hooks that fit the way an
ECS already stores its data:

| hook                                | what it does                                                       | cost per frame                           |
| ----------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `container.bindColumns(columns)`    | binds your typed arrays to a container's children: row i → child i | one `commit(count)` call, no allocations |
| `userId` (sprites, Swarm instances) | a u32 you choose, returned by `renderer.pick()` as `hit.userId`    | none (not drawn)                         |
| `createRenderer({ events })`        | forwards rare lifecycle events to any `{ emit(name, payload) }`    | none (nothing is emitted per frame)      |

Every hook follows the same rule: **register once, commit per frame**.
Setup calls may allocate and validate; the per-frame call takes numbers
only.

The runnable version of this recipe is `examples/ecs-columns/`. It uses
plain typed arrays as its "ECS", so it has no dependency. Any column-based
ECS works the same way; cozyECS is one option, and the section
[Plugging in a real ECS](#plugging-in-a-real-ecs) shows where its columns
go.

## 1. Entities are rows, sprites are slots

Store each component field as its own typed array (structure of arrays),
with the live entities packed densely in rows `[0, count)`:

```ts
const cap = 131_072;
const x = new Float32Array(cap);
const y = new Float32Array(cap);
const vx = new Float32Array(cap);
const vy = new Float32Array(cap);
const rotation = new Float32Array(cap);
const tint = new Uint32Array(cap); // 0xRRGGBB
const frame = new Uint32Array(cap); // index into an array of textures
const entity = new Uint32Array(cap); // entity id per row; 0 = none
let count = 0;
```

On the cozygpu side, put **one container** in the scene whose children are
interchangeable sprite slots. A slot has no identity of its own: child i
simply shows whatever row i holds this frame.

```ts
import * as GPU from 'cozygpu';

const layer = new GPU.Container();
renderer.stage.addChild(layer);
for (let i = 0; i < count; i++) {
  layer.addChild(new GPU.Sprite({ texture: frames[0], anchor: 0.5 }));
}
```

Keep the slot container for slots only: every direct child is driven by a
row, so do not mix other nodes into it. Put UI, backgrounds and other
layers in sibling containers.

## 2. Bind once, commit per frame

```ts
const binding = layer.bindColumns(
  { x, y, rotation, tint, frame, userId: entity },
  { frames }, // the textures that `frame` indexes (one atlas keeps one batch)
);

ticker.add(dt => {
  moveSystem(dt); // your systems write x, y, rotation, …
  binding.commit(count); // rows [0, count) → children [0, count)
});
```

- `bindColumns` keeps references to your arrays; it copies nothing at bind
  time. Omitted columns (here `scaleX`, `scaleY`, `alpha`) are never
  touched, so the node values you set yourself stay.
- `commit(count)` copies each bound column into the node store in one
  tight loop, marks the same dirty bits as `bulkChildren().commit` and
  bumps the scene once. The next `render()` sends one dirty range and one
  upload. When only `x` and `y` are bound, the packer keeps its
  translation fast path.
- To commit fewer fields on a frame, pass `GPU.BulkField` bits:
  `binding.commit(count, 0, GPU.BulkField.POSITION)`.
- `commit` throws `INVALID_ARGUMENT` when `first + count` is larger than
  the number of children or a column is too short. That is almost always a
  missing slot (section 3) or a missing `rebind` (section 4).
- Interleaved storage works too, as `{ array, offset, stride }`:

  ```ts
  layer.bindColumns({
    x: { array: xy, offset: 0, stride: 2 },
    y: { array: xy, offset: 1, stride: 2 },
  });
  ```

  `options.stride` sets the stride of every column passed as a plain typed
  array, so a mixed bind (interleaved `xy` plus a dense `tint`) passes the
  dense column as `{ array: tint, stride: 1 }`.

Units match the node setters: stage pixels, radians, alpha 0..1, tint
0xRRGGBB. `tint` and `frame` apply to sprite children only.

## 3. Removing entities: swap-remove

A dense table removes an entity by moving the **last** row into the hole.
The renderer side mirrors that with one rule: slots are only ever added or
removed **at the end**.

```ts
function despawn(id: number): void {
  const r = rowOf[id];
  const last = --count;
  if (r !== last) {
    x[r] = x[last];
    y[r] = y[last];
    // …every other column…
    entity[r] = entity[last];
    rowOf[entity[r]] = r;
  }
  rowOf[id] = -1;
}

despawn(id);
layer.removeChild(layer.children[layer.children.length - 1]).destroy();
// the next binding.commit(count) rewrites the moved row into child r
```

Nothing else is needed: the slot that used to show the removed entity now
shows the moved one after the next commit.

One side effect to know about: children draw in order, so moving the last
row into a hole also moves that entity down in the stacking order inside
the layer. For entities that must keep a strict order, sort the rows
yourself (the commit follows row order) or use separate layers.

## 4. Growing: new arrays, `rebind`, more slots

When the table is full, the ECS allocates bigger arrays and copies the old
data. The binding still points at the **old** array objects and has no way
to notice, so bind again:

```ts
function reserve(extra: number): void {
  if (count + extra <= cap) return;
  cap *= 2;
  x = grow(x, cap);
  y = grow(y, cap);
  // …every column…
  binding.rebind({ x, y, rotation, tint, frame, userId: entity }, { frames });
}

reserve(n);
for (let i = 0; i < n; i++) spawnOne();
while (layer.children.length < count) {
  layer.addChild(new GPU.Sprite({ texture: frames[0], anchor: 0.5 }));
}
```

- Rebind whenever an array **object** is replaced, not when its contents
  change. A version counter on the table makes that easy to check (the
  example's `world.arraysVersion`).
- Adding children needs no rebind: the binding checks the child count at
  every commit.
- Grow in steps (doubling), and reserve once before a batch of spawns, so
  rebinds stay rare. `binding.unbind()` releases the arrays when the layer
  is no longer used.

## 5. Picking by entity id

Write the entity id into the `userId` column. `renderer.pick()` then
answers with the id directly:

```ts
canvas.addEventListener('pointerdown', async e => {
  const hit = await renderer.pick(e.clientX, e.clientY);
  if (hit !== null && hit.userId !== 0) {
    despawn(hit.userId); // or select it, damage it, …
  }
});
```

Prefer `hit.userId` over the child index or `hit.node`: it names the
entity without a slot → row → entity lookup. Two details:

- A pick is answered a frame or two later. For a sprite, `hit.userId` is
  read from the slot when the answer arrives, so if a swap-remove moved a
  different row into that slot in between, you get the entity that is in
  the slot now. When that matters, check that the entity still covers the
  point before acting. (A Swarm hit carries the id drawn in the picked
  pixel, so it has no such window.)
- When ids are recycled, pack a generation into the u32 (for example 20
  bits of index and 12 bits of generation) and check it before acting, so
  a late answer never reaches a reused id.

`userId` never changes what is drawn and marks nothing dirty. For single
sprites outside a binding, set it directly: `new GPU.Sprite({ userId: 42 })`
or `sprite.userId = 42`.

Swarm instances carry their own id in `cold.user`, set by
`swarm.spawn(n, { user: id })` or `swarm.write()`. A hit on a Swarm
instance returns that value as `hit.userId` (the Swarm node's own id is
`hit.node.userId`), so a Swarm of projectiles or particles can be picked
by entity id in the same way.

## 6. Lifecycle events into your own bus

cozygpu does not have an event system. `createRenderer` takes any object
with an `emit(name, payload)` method and calls it for a handful of rare
lifecycle events. A tiny adapter is enough to forward them into the
application's bus (cozyEvent, an `EventEmitter`, a logger):

```ts
const sink: GPU.EventSink = {
  emit(name, payload) {
    appBus.emit(`gpu:${name}`, payload);
  },
};
const renderer = await GPU.createRenderer({ canvas, events: sink });
```

`GPU.Events` maps every name to its payload type, so a typed bus can be
declared once:

```ts
function on<K extends GPU.EventName>(
  name: K,
  fn: (payload: GPU.Events[K]) => void,
): void {
  /* store fn under name */
}

on('deviceLost', p => {
  if (!p.willRestore) showFatalError(p.message);
});
on('deviceRestored', () => rebuildGpuOnlyState());
```

| event                          | when                                           |
| ------------------------------ | ---------------------------------------------- |
| `fallback`, then `ready`       | before `createRenderer()` resolves             |
| `deviceLost`, `deviceRestored` | GPU device or WebGL context lost / restored    |
| `resize`                       | the canvas size or resolution changed          |
| `assetProgress`, `assetError`  | `renderer.assets` finished or failed a load    |
| `error`                        | a non-fatal renderer error (it is also logged) |

Nothing is emitted per frame: frame timings stay in `renderer.stats`. A
sink that throws is caught and logged once per event name. Sprite and
column data survive a device loss (the scene lives on the CPU); Swarm
contents do not.

## Plugging in a real ECS

Any ECS that stores components as typed-array columns fits, whatever its
query API. What the binding needs from it:

1. **Dense rows.** A table (archetype) whose live entities occupy rows
   `[0, count)`, with removal by swap-remove. Most archetype stores already
   work this way.
2. **One typed array per field** (`Float32Array` for x, y, rotation, scale,
   alpha; `Uint32Array` for tint, frame and the entity id), or one
   interleaved array with a stride, e.g. a `Position` component stored as
   `[x0, y0, x1, y1, …]`.
3. **A way to notice that arrays were replaced**, such as a version
   counter, a resize callback or comparing the array objects once per
   frame (a reference comparison allocates nothing).
4. **Structural changes you can mirror** (spawns append rows, removals
   shrink from the end) so the slot count follows the row count.

With cozyECS, or any similar library, the adapter is the only code that
knows both sides: at setup it reads the column arrays of the table that
holds renderable entities and calls `bindColumns`; per frame, after the
systems ran, it calls `commit(count)`; when the table grows it calls
`rebind` and adds slots. One container per table keeps each binding
simple. If renderable entities are spread over several tables, give each
its own layer.

## Zero allocations per frame

The per-frame path is the systems loop plus `binding.commit(count)`. Both
are index loops over typed arrays, so the frame allocates nothing. To
check it in Chrome:

1. Open DevTools, **Performance**, tick **Memory**, and record a few
   seconds without clicking. The JS heap line should stay flat (no
   sawtooth of minor garbage collections).
2. Or use **Memory**, **Allocation instrumentation on timeline**, and
   confirm that nothing is attributed to the ticker callback. The example's
   HUD builds a string twice a second on purpose; ignore it, or remove the
   HUD while measuring.

Common ways to break it: building the column object (`{ x, y, … }`) every
frame instead of once, closures or `for…of` in the systems loop, and
creating or destroying sprites every frame instead of only on structural
changes.

## Worker mode and backends

The hooks work the same with `createRenderer({ worker: true })`: columns
are copied on the main thread and reach the worker through the normal
command stream, picks answer through the same promise, and events are
emitted on the main thread. They also behave the same on WebGPU and
WebGL2. (Device interop, `renderer.interop()`, is the one hook that needs
the main thread; this recipe does not use it.)

## Running the example

```bash
EXAMPLES=1 npx rollup -c rollup.config.cjs
node scripts/serve.mjs 3017
# http://127.0.0.1:3017/examples/ecs-columns/
```

Query parameters: `?count=100000` (initial entities), `?add=5000`,
`?backend=auto|webgpu|webgl2`, `?worker=1`. Click an entity to despawn it
(swap-remove), click empty space to spawn a burst there, press space to
add entities (which grows the arrays and triggers a `rebind`) and
backspace to remove random ones.
