// A deliberately tiny "ECS": one table of entities
// stored as typed-array columns (structure of arrays). It stands in for any
// column-based ECS (cozyECS or another archetype/table store); cozygpu
// never sees this module, only the arrays it exposes.
//
//   row r      → one live entity; rows [0, count) are dense
//   entity[r]  → the entity id in row r (ids start at 1; 0 means "none")
//   rowOf[id]  → the row of entity `id`, or -1 when it is dead
//
// Removal is swap-remove: the last row moves into the hole, so the table
// stays dense and a renderer can always draw rows [0, count). Growth
// replaces every column with a bigger array and bumps `arraysVersion`, which
// tells the renderer side to `rebind`.

export interface World {
  /** Live entities (dense rows [0, count)). */
  count: number;
  /** Rows the current arrays can hold. */
  capacity: number;
  /** Bumped whenever the column arrays are replaced (growth). */
  arraysVersion: number;

  // Components, one column per field.
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  rotation: Float32Array;
  spin: Float32Array;
  tint: Uint32Array;
  frame: Uint32Array;
  /** Entity id per row. */
  entity: Uint32Array;

  /** Sparse index: entity id → row, -1 when dead. */
  rowOf: Int32Array;
  /** Next entity id to hand out (ids are not reused in this example). */
  nextId: number;
}

export function createWorld(capacity: number): World {
  const cap = Math.max(16, capacity | 0);
  const rowOf = new Int32Array(cap * 2).fill(-1);
  return {
    count: 0,
    capacity: cap,
    arraysVersion: 0,
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    rotation: new Float32Array(cap),
    spin: new Float32Array(cap),
    tint: new Uint32Array(cap),
    frame: new Uint32Array(cap),
    entity: new Uint32Array(cap),
    rowOf,
    nextId: 1,
  };
}

function growF32(a: Float32Array, cap: number): Float32Array {
  const b = new Float32Array(cap);
  b.set(a);
  return b;
}

function growU32(a: Uint32Array, cap: number): Uint32Array {
  const b = new Uint32Array(cap);
  b.set(a);
  return b;
}

/**
 * Makes room for `extra` more rows. Replaces the column arrays (new
 * objects!) when they are too small, which the renderer side must answer
 * with `binding.rebind(...)`. Not a per-frame path.
 */
export function reserve(w: World, extra: number): void {
  const need = w.count + extra;
  if (need <= w.capacity) return;
  let cap = w.capacity;
  while (cap < need) cap *= 2;
  w.x = growF32(w.x, cap);
  w.y = growF32(w.y, cap);
  w.vx = growF32(w.vx, cap);
  w.vy = growF32(w.vy, cap);
  w.rotation = growF32(w.rotation, cap);
  w.spin = growF32(w.spin, cap);
  w.tint = growU32(w.tint, cap);
  w.frame = growU32(w.frame, cap);
  w.entity = growU32(w.entity, cap);
  w.capacity = cap;
  w.arraysVersion++;
}

/** Adds one entity at the end of the table and returns its id. */
export function spawn(
  w: World,
  x: number,
  y: number,
  vx: number,
  vy: number,
  spin: number,
  tint: number,
  frame: number,
): number {
  reserve(w, 1);
  const id = w.nextId++;
  if (id >= w.rowOf.length) {
    const next = new Int32Array(w.rowOf.length * 2).fill(-1);
    next.set(w.rowOf);
    w.rowOf = next;
  }
  const r = w.count++;
  w.x[r] = x;
  w.y[r] = y;
  w.vx[r] = vx;
  w.vy[r] = vy;
  w.rotation[r] = 0;
  w.spin[r] = spin;
  w.tint[r] = tint;
  w.frame[r] = frame;
  w.entity[r] = id;
  w.rowOf[id] = r;
  return id;
}

/**
 * Swap-remove: moves the last row into the removed entity's row. Returns
 * the row that was filled (or -1 when `id` was not alive). The caller then
 * has one row less to draw; the moved row's new values reach the GPU with
 * the next `commit`.
 */
export function despawn(w: World, id: number): number {
  if (id <= 0 || id >= w.rowOf.length) return -1;
  const r = w.rowOf[id];
  if (r < 0) return -1;
  const last = --w.count;
  if (r !== last) {
    w.x[r] = w.x[last];
    w.y[r] = w.y[last];
    w.vx[r] = w.vx[last];
    w.vy[r] = w.vy[last];
    w.rotation[r] = w.rotation[last];
    w.spin[r] = w.spin[last];
    w.tint[r] = w.tint[last];
    w.frame[r] = w.frame[last];
    const moved = w.entity[last];
    w.entity[r] = moved;
    w.rowOf[moved] = r;
  }
  w.entity[last] = 0;
  w.rowOf[id] = -1;
  return r;
}

/**
 * The movement "system": a plain index loop over the columns. Bounces off
 * the [0, width] × [0, height] box and spins. Allocates nothing.
 */
export function moveSystem(
  w: World,
  dt: number,
  width: number,
  height: number,
): void {
  const n = w.count;
  const x = w.x;
  const y = w.y;
  const vx = w.vx;
  const vy = w.vy;
  const rot = w.rotation;
  const spin = w.spin;
  for (let i = 0; i < n; i++) {
    let px = x[i] + vx[i] * dt;
    let py = y[i] + vy[i] * dt;
    if (px < 0) {
      px = 0;
      vx[i] = Math.abs(vx[i]);
    } else if (px > width) {
      px = width;
      vx[i] = -Math.abs(vx[i]);
    }
    if (py < 0) {
      py = 0;
      vy[i] = Math.abs(vy[i]);
    } else if (py > height) {
      py = height;
      vy[i] = -Math.abs(vy[i]);
    }
    x[i] = px;
    y[i] = py;
    rot[i] += spin[i] * dt;
  }
}
