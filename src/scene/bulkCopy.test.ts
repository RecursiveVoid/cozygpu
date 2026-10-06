/**
 * The copy-loop shapes behind `bindColumns` / `bulkChildren`
 * (ARCHITECTURE §16.1, §19.1).
 *
 * `Rows._copy` picks a different loop per source shape: a dense position pair
 * (offset 0, stride 1) takes its own loop, columns that share a store record
 * are copied two at a time, and a column with no partner goes alone. Every
 * shape has to leave the node store, the dirty bits and `touch` exactly as the
 * per-node setters do, so each one is checked against the setters here.
 */
import { Container } from './Container';
import { NodeBase } from './Node';
import { Sprite } from './Sprite';
import {
  Dirty,
  L_ALPHA,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  nodeStore,
} from './store';
import { BulkField } from './types';
import type { SpriteColumns } from './types';

const slotOf = (n: unknown) => (n as { _slot: number })._slot;

/** Everything a commit may write, plus the dirty byte it left behind. */
function snap(node: unknown): number[] {
  const s = nodeStore;
  const slot = slotOf(node);
  const lo = slot * LOCAL_STRIDE;
  return [
    s.pos[slot * POS_STRIDE],
    s.pos[slot * POS_STRIDE + 1],
    s.local[lo + L_ROT],
    s.local[lo + L_SCALE_X],
    s.local[lo + L_SCALE_Y],
    s.local[lo + L_ALPHA],
    s.tint[slot],
    s.userId[slot],
    s.dirty[slot],
  ];
}

function sprites(n: number): Container {
  const parent = new Container();
  for (let i = 0; i < n; i++) parent.addChild(new Sprite());
  for (const c of parent.children) nodeStore.dirty[slotOf(c)] = 0;
  return parent;
}

const N = 6;

/** Values row i gets, whatever shape the column has. */
const vx = (i: number) => i * 3 + 1;
const vy = (i: number) => i * 5 - 2;
const vrot = (i: number) => i * 0.25 - 0.5;
const vsx = (i: number) => 1 + i * 0.5;
const vsy = (i: number) => 2 - i * 0.25;
const valpha = (i: number) => i / N;
const vtint = (i: number) => (i * 0x010203) & 0xffffff;
const vuser = (i: number) => 1000 + i;

/** Applies the same values through the per-node setters. */
function applySetters(parent: Container, fields: number): void {
  for (let i = 0; i < parent.children.length; i++) {
    const node = parent.children[i] as NodeBase;
    if ((fields & BulkField.POSITION) !== 0) node.setPosition(vx(i), vy(i));
    if ((fields & BulkField.ROTATION) !== 0) node.rotation = vrot(i);
    if ((fields & BulkField.SCALE) !== 0) node.setScale(vsx(i), vsy(i));
    if ((fields & BulkField.ALPHA) !== 0) node.alpha = valpha(i);
    if ((fields & BulkField.TINT) !== 0) (node as Sprite).tint = vtint(i);
    if ((fields & 64) !== 0) node.userId = vuser(i);
  }
}

function dense(): SpriteColumns {
  const x = new Float32Array(N);
  const y = new Float32Array(N);
  const rotation = new Float32Array(N);
  const scaleX = new Float32Array(N);
  const scaleY = new Float32Array(N);
  const alpha = new Float32Array(N);
  const tint = new Uint32Array(N);
  const userId = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = vx(i);
    y[i] = vy(i);
    rotation[i] = vrot(i);
    scaleX[i] = vsx(i);
    scaleY[i] = vsy(i);
    alpha[i] = valpha(i);
    tint[i] = vtint(i);
    userId[i] = vuser(i);
  }
  return { x, y, rotation, scaleX, scaleY, alpha, tint, userId };
}

/** The same values, every column strided and offset inside one buffer. */
function packed(): SpriteColumns {
  const STRIDE = 7;
  const f = new Float32Array(N * STRIDE + 6);
  const u = new Uint32Array(N * STRIDE + 6);
  for (let i = 0; i < N; i++) {
    const o = 3 + i * STRIDE;
    f[o] = vx(i);
    f[o + 1] = vy(i);
    f[o + 2] = vrot(i);
    f[o + 3] = vsx(i);
    f[o + 4] = vsy(i);
    f[o + 5] = valpha(i);
    u[o + 6] = vtint(i);
    u[3 + i * STRIDE + 6] = vtint(i);
  }
  for (let i = 0; i < N; i++) u[4 + i * STRIDE] = vuser(i);
  const fcol = (offset: number) => ({ array: f, offset, stride: STRIDE });
  const ucol = (offset: number) => ({ array: u, offset, stride: STRIDE });
  return {
    x: fcol(3),
    y: fcol(4),
    rotation: fcol(5),
    scaleX: fcol(6),
    scaleY: fcol(7),
    alpha: fcol(8),
    tint: ucol(9),
    userId: ucol(4),
  };
}

describe('every column shape commits what the setters write', () => {
  const ALL = 1 | 2 | 4 | 8 | 16 | 64;
  const cases: [string, number][] = [
    ['all fields', ALL],
    ['position only', BulkField.POSITION],
    ['rotation only', BulkField.ROTATION],
    ['scale only', BulkField.SCALE],
    ['alpha only', BulkField.ALPHA],
    // The pairing walks the four `local` columns in order, so a gap in the
    // middle has to pair across it.
    ['rotation + alpha (paired across a gap)', 2 | 8],
    ['scale + alpha (a pair then a lone column)', 4 | 8],
    ['rotation + scale + alpha (two pairs)', 2 | 4 | 8],
    ['position + tint + userId', 1 | 16 | 64],
  ];

  it.each(cases)('dense sources, %s', (_name, fields) => {
    const columns = sprites(N);
    const loops = sprites(N);
    columns.bindColumns(dense()).commit(N, 0, fields);
    applySetters(loops, fields);
    for (let i = 0; i < N; i++) {
      expect([i, snap(columns.children[i])]).toEqual([
        i,
        snap(loops.children[i]),
      ]);
    }
  });

  it.each(cases)('strided sources, %s', (_name, fields) => {
    const columns = sprites(N);
    const loops = sprites(N);
    columns.bindColumns(packed()).commit(N, 0, fields);
    applySetters(loops, fields);
    for (let i = 0; i < N; i++) {
      expect([i, snap(columns.children[i])]).toEqual([
        i,
        snap(loops.children[i]),
      ]);
    }
  });

  it('a dense x with a strided y does not take the dense position loop', () => {
    const columns = sprites(N);
    const loops = sprites(N);
    const x = new Float32Array(N);
    const interleaved = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      x[i] = vx(i);
      interleaved[i * 2 + 1] = vy(i);
    }
    columns
      .bindColumns({ x, y: { array: interleaved, offset: 1, stride: 2 } })
      .commit(N, 0, BulkField.POSITION);
    applySetters(loops, BulkField.POSITION);
    for (let i = 0; i < N; i++) {
      expect([i, snap(columns.children[i])]).toEqual([
        i,
        snap(loops.children[i]),
      ]);
    }
  });

  it('x and y are both required, so a position group is never half bound', () => {
    const parent = sprites(N);
    const x = new Float32Array(N);
    expect(() => parent.bindColumns({ x } as unknown as SpriteColumns)).toThrow(
      /bad y/,
    );
  });

  it('a partial range leaves the rows outside it untouched', () => {
    const parent = sprites(N);
    const before = parent.children.map(snap);
    parent.bindColumns(dense()).commit(2, 2);
    for (let i = 0; i < N; i++) {
      const now = snap(parent.children[i]);
      if (i >= 2 && i < 4) expect(now).not.toEqual(before[i]);
      else expect(now).toEqual(before[i]);
    }
  });

  it('a dense partial range starts at `first`, not at row 0', () => {
    const columns = sprites(N);
    const loops = sprites(N);
    columns.bindColumns(dense()).commit(3, 1, BulkField.POSITION);
    for (let i = 1; i < 4; i++) {
      (loops.children[i] as NodeBase).setPosition(vx(i), vy(i));
    }
    for (let i = 0; i < N; i++) {
      expect([i, snap(columns.children[i])]).toEqual([
        i,
        snap(loops.children[i]),
      ]);
    }
  });

  it('ORs the dirty bits of both columns of a pair, and nothing else', () => {
    const parent = sprites(N);
    parent.bindColumns(dense()).commit(N, 0, BulkField.ROTATION | 8);
    for (const c of parent.children) {
      expect(nodeStore.dirty[slotOf(c)]).toBe(Dirty.LOCAL | Dirty.ALPHA);
    }
  });

  it('userId needs no dirty bit and tint only marks SPRITE', () => {
    const parent = sprites(N);
    parent.bindColumns(dense()).commit(N, 0, 64);
    for (const c of parent.children) {
      expect(nodeStore.dirty[slotOf(c)]).toBe(0);
      expect(c.userId).toBe(vuser(parent.children.indexOf(c)));
    }
    parent.bindColumns(dense()).commit(N, 0, BulkField.TINT);
    for (const c of parent.children) {
      expect(nodeStore.dirty[slotOf(c)]).toBe(Dirty.SPRITE);
    }
  });
});
