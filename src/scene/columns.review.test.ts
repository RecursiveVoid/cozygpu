/**
 * M2.5 review tests for external columns (ARCHITECTURE §19.1): parity with
 * `bulkChildren`, partial commits over random windows, re-binding, and the
 * children snapshot following reorders. Complements columns.test.ts.
 */
import { Container } from './Container';
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
import type { SceneNode } from './types';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slotOf = (n: unknown) => (n as { _slot: number })._slot;

/** Every store value a column can write, plus the dirty bits. */
function state(node: SceneNode): number[] {
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

const ALL_BULK =
  BulkField.POSITION |
  BulkField.ROTATION |
  BulkField.SCALE |
  BulkField.ALPHA |
  BulkField.TINT;

describe('bindColumns parity with bulkChildren', () => {
  it.each([11, 12, 13])(
    'seed %i: the same rows leave identical store bytes and dirty bits',
    seed => {
      const rnd = rng(seed);
      const n = 5 + Math.floor(rnd() * 60);
      const viaCols = sprites(n);
      const viaBulk = sprites(n);

      // Columns packed as [x, y, rot] records (stride 3) plus dense arrays.
      const xyr = new Float32Array(n * 3);
      const sx = new Float32Array(n);
      const sy = new Float32Array(n);
      const alpha = new Float32Array(n);
      const tint = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        xyr[i * 3] = rnd() * 1000 - 500;
        xyr[i * 3 + 1] = rnd() * 1000 - 500;
        xyr[i * 3 + 2] = rnd() * 6 - 3;
        sx[i] = rnd() * 3;
        sy[i] = rnd() * 3;
        alpha[i] = rnd();
        tint[i] = (rnd() * 0xffffffff) >>> 0; // high byte must be dropped
      }
      const binding = viaCols.bindColumns({
        x: { array: xyr, offset: 0, stride: 3 },
        y: { array: xyr, offset: 1, stride: 3 },
        rotation: { array: xyr, offset: 2, stride: 3 },
        scaleX: sx,
        scaleY: sy,
        alpha,
        tint,
      });
      expect(binding.fields).toBe(ALL_BULK);

      const bulk = viaBulk.bulkChildren(ALL_BULK);
      for (let i = 0; i < n; i++) {
        bulk.position[i * 2] = xyr[i * 3];
        bulk.position[i * 2 + 1] = xyr[i * 3 + 1];
        bulk.rotation[i] = xyr[i * 3 + 2];
        bulk.scale[i * 2] = sx[i];
        bulk.scale[i * 2 + 1] = sy[i];
        bulk.alpha[i] = alpha[i];
        bulk.tint[i] = tint[i];
      }

      // The same random sequence of partial commits on both paths.
      const windows: [number, number, number][] = [];
      for (let k = 0; k < 8; k++) {
        const first = Math.floor(rnd() * n);
        const count = Math.floor(rnd() * (n - first + 1));
        const fields = 1 + Math.floor(rnd() * ALL_BULK);
        windows.push([first, count, fields]);
      }
      for (const [first, count, fields] of windows) {
        const t0 = nodeStore.touch;
        binding.commit(count, first, fields);
        const t1 = nodeStore.touch;
        bulk.commit(fields, first, count);
        const t2 = nodeStore.touch;
        // Both bump touch at most once per commit, and the same way.
        expect(t1 - t0).toBe(t2 - t1);
        for (let i = 0; i < n; i++) {
          expect([i, state(viaCols.children[i])]).toEqual([
            i,
            state(viaBulk.children[i]),
          ]);
        }
      }
    },
  );

  it('rows outside [first, first + count) and fields outside the mask are untouched', () => {
    const rnd = rng(7);
    const n = 40;
    const parent = sprites(n);
    const x = new Float32Array(n).map(() => rnd() * 100 + 1);
    const y = new Float32Array(n).map(() => rnd() * 100 + 1);
    const alpha = new Float32Array(n).fill(0.25);
    const user = new Uint32Array(n).map((_, i) => 1000 + i);
    const b = parent.bindColumns({ x, y, alpha, userId: user });
    const before = parent.children.map(state);
    for (let k = 0; k < 20; k++) {
      const first = Math.floor(rnd() * n);
      const count = Math.floor(rnd() * (n - first + 1));
      const expected = parent.children.map(state);
      b.commit(count, first, BulkField.ALPHA);
      for (let i = 0; i < n; i++) {
        if (i >= first && i < first + count) {
          expected[i][5] = 0.25;
          expected[i][8] |= Dirty.ALPHA;
        }
      }
      expect(parent.children.map(state)).toEqual(expected);
    }
    // Position and userId were never in the mask.
    const after = parent.children.map(state);
    for (let i = 0; i < n; i++) {
      expect(after[i].slice(0, 2)).toEqual(before[i].slice(0, 2));
      expect(after[i][7]).toBe(0);
    }
  });

  it('a USER_ID-only commit writes ids (u32 range intact), sets no dirty bit', () => {
    const parent = sprites(3);
    const user = new Uint32Array([0, 0x7fffffff + 1, 0xffffffff]);
    const b = parent.bindColumns({
      x: new Float32Array(3),
      y: new Float32Array(3),
      userId: user,
    });
    b.commit(3, 0, BulkField.USER_ID);
    expect(parent.children.map(c => c.userId)).toEqual([
      0, 0x80000000, 0xffffffff,
    ]);
    for (const c of parent.children) expect(nodeStore.dirty[slotOf(c)]).toBe(0);
  });

  it('a bulkChildren commit ignores FRAME and USER_ID bits', () => {
    const parent = sprites(2);
    parent.children[0].userId = 5;
    const bulk = parent.bulkChildren(BulkField.POSITION);
    bulk.position.set([1, 2, 3, 4]);
    bulk.commit(BulkField.POSITION | BulkField.FRAME | BulkField.USER_ID);
    expect(parent.children.map(c => [c.x, c.y, c.userId])).toEqual([
      [1, 2, 5],
      [3, 4, 0],
    ]);
  });

  it('a column commit and the bulk writer on one container keep separate snapshots', () => {
    const parent = sprites(3);
    const bulk = parent.bulkChildren(BulkField.ALPHA);
    const b = parent.bindColumns({
      x: new Float32Array([1, 2, 3]),
      y: new Float32Array([4, 5, 6]),
    });
    b.commit(3);
    // The column commit did not invalidate the bulk writer.
    bulk.alpha.fill(0.5);
    bulk.commit(BulkField.ALPHA);
    expect(parent.children.map(c => [c.x, c.alpha])).toEqual([
      [1, 0.5],
      [2, 0.5],
      [3, 0.5],
    ]);
  });
});

describe('ColumnBinding re-bind', () => {
  it('reads only the new arrays after rebind; unbound columns stop being written', () => {
    const parent = sprites(2);
    const oldX = new Float32Array([1, 2]);
    const oldY = new Float32Array([3, 4]);
    const oldTint = new Uint32Array([0x112233, 0x445566]);
    const b = parent.bindColumns({ x: oldX, y: oldY, tint: oldTint });
    b.commit(2);
    const tints = parent.children.map(c => (c as Sprite).tint);
    expect(tints).toEqual([0x112233, 0x445566]);

    const x = new Float32Array([10, 20]);
    const y = new Float32Array([30, 40]);
    b.rebind({ x, y });
    expect(b.fields).toBe(BulkField.POSITION);
    // Writes to the dropped arrays are not seen.
    oldX.fill(99);
    oldTint.fill(0xabcdef);
    b.commit(2);
    expect(parent.children.map(c => [c.x, c.y])).toEqual([
      [10, 30],
      [20, 40],
    ]);
    expect(parent.children.map(c => (c as Sprite).tint)).toEqual(tints);
    // Asking for TINT now is a no-op (not bound), not an error.
    b.commit(2, 0, BulkField.TINT);
    expect(parent.children.map(c => (c as Sprite).tint)).toEqual(tints);
  });

  it('bindColumns on the container re-binds the same object and keeps no stale stride', () => {
    const parent = sprites(2);
    const xy = new Float32Array([1, 2, 3, 4]);
    const b = parent.bindColumns(
      { x: xy, y: { array: xy, offset: 1 } },
      {
        stride: 2,
      },
    );
    b.commit(2);
    expect(parent.children.map(c => [c.x, c.y])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    // Dense arrays again, without options: stride falls back to 1.
    const again = parent.bindColumns({
      x: new Float32Array([7, 8]),
      y: new Float32Array([9, 10]),
    });
    expect(again).toBe(b);
    b.commit(2);
    expect(parent.children.map(c => [c.x, c.y])).toEqual([
      [7, 9],
      [8, 10],
    ]);
  });

  it('frames are replaced by rebind (old frames list no longer used)', () => {
    const t = new Sprite().texture; // the default (empty) texture handle
    const parent = new Container();
    parent.addChild(new Sprite());
    const frame = new Uint32Array([1]);
    const b = parent.bindColumns(
      { x: new Float32Array(1), y: new Float32Array(1), frame },
      { frames: [t, t] },
    );
    b.commit(1);
    b.rebind(
      { x: new Float32Array(1), y: new Float32Array(1), frame },
      { frames: [t] },
    );
    expect(() => b.commit(1)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('ColumnBinding children snapshot', () => {
  it('follows setChildIndex, addChildAt and removals without a re-bind', () => {
    const parent = sprites(3);
    const [a, b, c] = parent.children;
    const x = new Float32Array([1, 2, 3, 4]);
    const y = new Float32Array(4);
    const binding = parent.bindColumns({ x, y });
    binding.commit(3);
    expect([a.x, b.x, c.x]).toEqual([1, 2, 3]);

    parent.setChildIndex(c, 0); // children: c, a, b
    binding.commit(3);
    expect([c.x, a.x, b.x]).toEqual([1, 2, 3]);

    const d = parent.addChildAt(new Sprite(), 1); // c, d, a, b
    binding.commit(4);
    expect([c.x, d.x, a.x, b.x]).toEqual([1, 2, 3, 4]);

    parent.removeChild(c); // d, a, b
    x.set([5, 6, 7]);
    binding.commit(3);
    expect([d.x, a.x, b.x]).toEqual([5, 6, 7]);
    expect(() => binding.commit(4)).toThrow(/outside/);
  });
});
