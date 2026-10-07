// Using cozygpu with an ECS (docs/recipes/ecs.md).
//
// The "ECS" is plain typed arrays (./world.ts): 100k entities, one column
// per component field, moved by a plain index loop. cozygpu draws them
// through ONE container whose children are interchangeable sprite slots:
// row i of the columns drives child i.
//
//   bindColumns  once (and rebind after the ECS grew its arrays)
//   commit       once per frame, after the systems ran (zero allocations)
//   userId       = entity id, so a click resolves straight to an entity
//   events       a tiny { emit } sink forwarding to the app's own bus
//
//   ?count=100000   initial entities (default 100k)
//   ?add=5000       entities added per space press / removed per backspace
//   ?backend=webgl2 force a backend ('auto' by default, 'webgpu' also valid)
//   ?worker=1       run the core in a worker (needs the worker bundle built)
//
// Click an entity to despawn it (swap-remove); click empty space to spawn a
// burst there. The per-frame loop allocates nothing; the HUD text is
// refreshed twice a second.
import * as GPU from 'cozygpu';
import { createWorld, despawn, moveSystem, reserve, spawn } from './world';
import type { World } from './world';

const params = new URLSearchParams(location.search);
const INITIAL = Math.max(0, Number(params.get('count') ?? 100_000) | 0);
const ADD = Math.max(1, Number(params.get('add') ?? 5_000) | 0);
const BURST = 500;
const backendParam = params.get('backend');
const backend: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const WORKER = params.get('worker') === '1';

// ─── The app's own event bus (stand-in for cozyEvent or any other) ───────────

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler[]>();

/** Typed subscription: GPU.Events maps every event name to its payload. */
function on<K extends GPU.EventName>(
  name: K,
  fn: (payload: GPU.Events[K]) => void,
): void {
  let list = handlers.get(name);
  if (list === undefined) handlers.set(name, (list = []));
  list.push(fn as Handler);
}

/**
 * The sink handed to cozygpu. Anything with `emit(name, payload)` works;
 * cozygpu calls nothing else on it, and only for rare lifecycle events.
 */
const sink: GPU.EventSink = {
  emit(name, payload) {
    const list = handlers.get(name);
    if (list !== undefined)
      for (let i = 0; i < list.length; i++) list[i](payload);
  },
};

let lastEvent = 'none yet';
on('fallback', p => {
  lastEvent = `fallback ${p.from}→${p.to}`;
  console.log('[events] fallback:', p.reason);
});
on('ready', p => {
  lastEvent = `ready (${p.backend}${p.worker ? ', worker' : ''})`;
  console.log('[events] ready', p);
});
on('resize', p => {
  lastEvent = `resize ${p.width}×${p.height}@${p.resolution}`;
});
on('deviceLost', p => {
  lastEvent = `deviceLost (willRestore ${p.willRestore})`;
  console.warn('[events] deviceLost:', p.message);
});
on('deviceRestored', p => {
  lastEvent = `deviceRestored #${p.generation}`;
});
on('error', p => {
  lastEvent = `error ${p.code}`;
});

// ─── Art: four white shapes in one atlas (one texture → one draw call) ───────

const CELL = 16;
const SHAPES = 4;

function atlasPixels(): Uint8Array {
  const w = CELL * SHAPES;
  const px = new Uint8Array(w * CELL * 4);
  for (let f = 0; f < SHAPES; f++) {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const cx = Math.abs(x + 0.5 - CELL / 2);
        const cy = Math.abs(y + 0.5 - CELL / 2);
        const inside =
          f === 0
            ? cx * cx + cy * cy < 49 // circle
            : f === 1
              ? cx < 6 && cy < 6 // square
              : f === 2
                ? cx + cy < 7.5 // diamond
                : y > 2 && cx < (y - 2) * 0.5; // triangle
        if (!inside) continue;
        const i = (y * w + f * CELL + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 255;
      }
    }
  }
  return px;
}

function randomTint(): number {
  const h = Math.random() * 6;
  const k = (n: number) => {
    const t = (n + h) % 6;
    const v = Math.max(0, Math.min(1, Math.min(t, 4 - t)));
    return (0.35 + 0.65 * v) * 255;
  };
  return (k(5) << 16) | (k(3) << 8) | k(1);
}

function spawnAt(w: World, x: number, y: number): number {
  const a = Math.random() * Math.PI * 2;
  const speed = 40 + Math.random() * 160;
  return spawn(
    w,
    x,
    y,
    Math.cos(a) * speed,
    Math.sin(a) * speed,
    (Math.random() - 0.5) * 4,
    randomTint(),
    (Math.random() * SHAPES) | 0,
  );
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x0d0d14,
    backend,
    worker: WORKER ? { url: '/build/examples/cozygpu.worker.js' } : false,
    events: sink, // fallback → ready arrive before this promise resolves
  });

  const atlas = GPU.Texture.fromPixels(CELL * SHAPES, CELL, atlasPixels(), {
    nearest: true,
  });
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < SHAPES; f++) {
    frames.push(atlas.sub(f * CELL, 0, CELL, CELL));
  }

  // ── The ECS side: nothing here knows about cozygpu ──
  const world = createWorld(INITIAL);
  for (let i = 0; i < INITIAL; i++) {
    spawnAt(
      world,
      Math.random() * renderer.width,
      Math.random() * renderer.height,
    );
  }

  // ── The renderer side: one layer of interchangeable sprite slots ──
  const layer = new GPU.Container();
  renderer.stage.addChild(layer);

  /** Adds or removes slots at the END so there is one child per live row. */
  function syncSlots(): void {
    const n = layer.children.length;
    if (n < world.count) {
      for (let i = n; i < world.count; i++) {
        // Texture only fixes the batch; position, frame, tint and the rest
        // come from the columns on the next commit.
        layer.addChild(new GPU.Sprite({ texture: frames[0], anchor: 0.5 }));
      }
    } else if (n > world.count) {
      const removed = layer.removeChildren(world.count, n);
      for (let i = 0; i < removed.length; i++) removed[i].destroy();
    }
  }

  /** Column set for bindColumns / rebind. Called at setup and after growth. */
  function columns(): GPU.SpriteColumns {
    return {
      x: world.x,
      y: world.y,
      rotation: world.rotation,
      tint: world.tint,
      frame: world.frame,
      userId: world.entity, // picking answers with the entity id
    };
  }

  syncSlots();
  const binding = layer.bindColumns(columns(), { frames });
  let boundVersion = world.arraysVersion;

  /** Call after anything that may have grown or shrunk the table. */
  function afterStructuralChange(): void {
    if (world.arraysVersion !== boundVersion) {
      // The ECS replaced its arrays: the binding still points at the old
      // ones, and nothing would tell it. Rebind (not a per-frame path).
      binding.rebind(columns(), { frames });
      boundVersion = world.arraysVersion;
    }
    syncSlots();
  }

  function addEntities(n: number): void {
    reserve(world, n); // grow once, not once per spawn
    for (let i = 0; i < n; i++) {
      spawnAt(
        world,
        Math.random() * renderer.width,
        Math.random() * renderer.height,
      );
    }
    afterStructuralChange();
  }

  function removeEntities(n: number): void {
    for (let i = 0; i < n && world.count > 0; i++) {
      const row = (Math.random() * world.count) | 0;
      despawn(world, world.entity[row]);
    }
    afterStructuralChange();
  }

  let pickInfo = '';
  canvas.addEventListener('pointerdown', e => {
    const x = e.clientX;
    const y = e.clientY;
    renderer
      .pick(x, y)
      .then(hit => {
        // userId IS the entity id: no child-index → row → entity lookup.
        // (For sprites it is read from the slot when the answer arrives.)
        const id = hit !== null ? hit.userId : 0;
        if (id !== 0 && despawn(world, id) >= 0) {
          pickInfo = ` · despawned entity ${id}`;
        } else {
          reserve(world, BURST);
          for (let i = 0; i < BURST; i++) spawnAt(world, x, y);
          pickInfo = ` · spawned ${BURST} at ${x.toFixed(0)},${y.toFixed(0)}`;
        }
        afterStructuralChange();
        console.log('pick', pickInfo);
      })
      .catch((err: Error) => {
        pickInfo = ` · pick failed: ${err.message}`;
        console.log('pick', pickInfo);
      });
  });
  window.addEventListener('keydown', e => {
    if (e.key === ' ') addEntities(ADD);
    else if (e.key === 'Backspace') removeEntities(ADD);
  });

  // Dev handles for the headless verification driver (examples only).
  const g = globalThis as { __renderer?: unknown; __world?: unknown };
  g.__renderer = renderer;
  g.__world = world;

  const ticker = GPU.ticker(renderer);
  let hudTimer = 0;
  let systemsMsAvg = 0;
  let commitMsAvg = 0;

  ticker.add(dt => {
    const t0 = performance.now();
    moveSystem(world, dt, renderer.width, renderer.height); // the ECS systems
    const t1 = performance.now();
    binding.commit(world.count); // rows [0, count) → children [0, count)
    const t2 = performance.now();
    const k = 0.05;
    systemsMsAvg += (t1 - t0 - systemsMsAvg) * k;
    commitMsAvg += (t2 - t1 - commitMsAvg) * k;

    hudTimer += dt;
    if (hudTimer >= 0.5) {
      hudTimer = 0;
      const st = renderer.stats;
      hud.textContent =
        `entities ${world.count} · fps ${ticker.fps.toFixed(0)}` +
        ` · systems ${systemsMsAvg.toFixed(2)} ms · commit ${commitMsAvg.toFixed(2)} ms` +
        ` · render cpu ${st.cpuMs.toFixed(2)} ms · draws ${st.drawCalls}` +
        ` · last event: ${lastEvent}` +
        pickInfo +
        ` — click: despawn/spawn, space: +${ADD}, backspace: −${ADD}`;
    }
  });
}

main().catch(err => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = String(err);
});
