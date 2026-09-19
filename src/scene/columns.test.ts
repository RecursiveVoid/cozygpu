/**
 * Owner: "scene-hooks" (M2.5). External columns (`Container.bindColumns`,
 * ARCHITECTURE §19.1) and `SceneNode.userId` (§19.3). A column commit must be
 * a pure fast path: the store bytes, the dirty bits and the packed instances
 * it leaves behind equal what the per-node setters produce.
 */
import { Op } from '../commands/opcodes';
import { FakeFrame } from '../sprites/fakes.testutil';
import { SpriteScenePacker } from '../sprites/front';
import type { FrontFrame } from '../types/core';
import { SI_FLAGS } from '../types/layouts';
import { Container } from './Container';
import { NodeBase } from './Node';
import { Sprite } from './Sprite';
import { Texture } from './Texture';
import {
  Dirty,
  L_ALPHA,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  UV_STRIDE,
  nodeStore,
} from './store';
import { BulkField } from './types';
import type { SpriteColumns } from './types';

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

/** A leaf that is not a Sprite (TINT and FRAME must skip it). */
class Plain extends NodeBase {
  get kind(): 'container' {
    return 'container';
  }
  _emitDraw(_f: FrontFrame): void {}
}

/** Node's v8.GCProfiler (typed locally: the project has no Node types). */
const { GCProfiler } = require('v8') as {
  GCProfiler: new () => {
    start(): void;
    stop(): { statistics: unknown[] };
  };
};

const slotOf = (n: unknown) => (n as { _slot: number })._slot;

function snap(node: unknown): number[] {
  const s = nodeStore;
  const slot = slotOf(node);
  const lo = slot * LOCAL_STRIDE;
  const uo = slot * UV_STRIDE;
  return [
    s.pos[slot * POS_STRIDE],
    s.pos[slot * POS_STRIDE + 1],
    s.local[lo + L_ROT],
    s.local[lo + L_SCALE_X],
    s.local[lo + L_SCALE_Y],
    s.local[lo + L_ALPHA],
    s.tint[slot],
    s.userId[slot],
    s.uv[uo],
    s.uv[uo + 1],
    s.uv[uo + 2],
    s.uv[uo + 3],
    s.dirty[slot],
  ];
}

function clearDirty(parent: Container): void {
  for (const c of parent.children) nodeStore.dirty[slotOf(c)] = 0;
}

const atlas = () => Texture.fromPixels(8, 8, new Uint8Array(256).fill(255));

describe('SceneNode.userId', () => {
  it('defaults to 0, takes NodeOptions.userId and coerces like >>> 0', () => {
    const a = new Sprite();
    expect(a.userId).toBe(0);
    const b = new Container({ userId: 42 });
    expect(b.userId).toBe(42);
    a.userId = -1;
    expect(a.userId).toBe(0xffffffff);
    a.userId = 2 ** 33 + 5;
    expect(a.userId).toBe(5);
    a.userId = 7.9;
    expect(a.userId).toBe(7);
  });

  it('marks nothing dirty and does not bump touch', () => {
    const s = new Sprite();
    nodeStore.dirty[slotOf(s)] = 0;
    const touch = nodeStore.touch;
    s.userId = 99;
    expect(nodeStore.dirty[slotOf(s)]).toBe(0);
    expect(nodeStore.touch).toBe(touch);
  });

  it('is reset when a slot is reused', () => {
    const s = new Sprite({ userId: 1234 });
    const slot = slotOf(s);
    s.destroy();
    const again = new Sprite();
    expect(slotOf(again)).toBe(slot);
    expect(again.userId).toBe(0);
  });
});

describe('bindColumns commit equals the per-sprite setters', () => {
  it.each([1, 2, 3, 4, 5, 6])('seed %i (dense and interleaved)', seed => {
    const rnd = rng(seed);
    const tex = atlas();
    const frames = [tex.sub(0, 0, 4, 4), tex.sub(4, 0, 4, 4), tex];
    const colParent = new Container();
    const loopParent = new Container();
    const n = 1 + Math.floor(rnd() * 40);
    const kinds: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const isSprite = rnd() < 0.75;
      kinds.push(isSprite);
      colParent.addChild(isSprite ? new Sprite(frames[0]) : new Plain());
      loopParent.addChild(isSprite ? new Sprite(frames[0]) : new Plain());
    }
    clearDirty(colParent);
    clearDirty(loopParent);

    const interleaved = seed % 2 === 0;
    const xy = new Float32Array(n * 2);
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const rot = new Float32Array(n);
    const sx = new Float32Array(n);
    const sy = new Float32Array(n);
    const alpha = new Float32Array(n);
    const tint = new Uint32Array(n);
    const frame = new Uint32Array(n);
    const user = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const vx = Math.round(rnd() * 2000 - 1000);
      const vy = Math.round(rnd() * 2000 - 1000);
      xy[i * 2] = x[i] = vx;
      xy[i * 2 + 1] = y[i] = vy;
      rot[i] = rnd() * 6 - 3;
      sx[i] = rnd() * 4 - 2;
      sy[i] = rnd() * 4 - 2;
      alpha[i] = rnd();
      tint[i] = Math.floor(rnd() * 0x1000000) | 0x01000000; // high bits dropped
      frame[i] = Math.floor(rnd() * frames.length);
      user[i] = Math.floor(rnd() * 0xffffffff);
    }
    const columns: SpriteColumns = {
      x: interleaved ? { array: xy, offset: 0, stride: 2 } : x,
      y: interleaved ? { array: xy, offset: 1, stride: 2 } : y,
      rotation: rot,
      scaleX: sx,
      scaleY: sy,
      alpha,
      tint,
      frame,
      userId: user,
    };
    const binding = colParent.bindColumns(columns, { frames });
    expect(binding.fields).toBe(127);
    const touch = nodeStore.touch;
    binding.commit(n);
    expect(nodeStore.touch).not.toBe(touch);

    for (let i = 0; i < n; i++) {
      const node = loopParent.children[i] as NodeBase;
      node.setPosition(x[i], y[i]);
      node.rotation = rot[i];
      node.setScale(sx[i], sy[i]);
      node.alpha = alpha[i];
      node.userId = user[i];
      if (kinds[i]) {
        (node as Sprite).tint = tint[i];
        (node as Sprite).texture = frames[frame[i]];
      }
    }
    for (let i = 0; i < n; i++) {
      const a = snap(colParent.children[i]);
      const b = snap(loopParent.children[i]);
      expect([i, a]).toEqual([i, b]);
      if (kinds[i]) {
        expect((colParent.children[i] as Sprite).texture).toBe(
          frames[frame[i]],
        );
      }
    }
  });

  it('x/y only sets just Dirty.POSITION (translation fast path) and bumps touch once', () => {
    const parent = new Container();
    for (let i = 0; i < 5; i++) parent.addChild(new Sprite());
    clearDirty(parent);
    const x = new Float32Array([1, 2, 3, 4, 5]);
    const y = new Float32Array([6, 7, 8, 9, 10]);
    const b = parent.bindColumns({ x, y, userId: new Uint32Array(5).fill(3) });
    const touch = nodeStore.touch;
    b.commit(5);
    expect(nodeStore.touch).toBe(touch + 1);
    for (const c of parent.children) {
      expect(nodeStore.dirty[slotOf(c)]).toBe(Dirty.POSITION);
      expect(c.userId).toBe(3);
    }
  });

  it('packs the same instances as the setters and uploads one dirty range', () => {
    const t = atlas();
    const build = () => {
      const stage = new Container();
      for (let i = 0; i < 300; i++) stage.addChild(new Sprite(t));
      return stage;
    };
    const colStage = build();
    const loopStage = build();
    const pa = new SpriteScenePacker();
    const pb = new SpriteScenePacker();
    const fa = new FakeFrame();
    const fb = new FakeFrame();
    pa.pack(colStage, fa);
    pb.pack(loopStage, fb);
    pa.pack(colStage, fa.next());

    const xy = new Float32Array(600);
    const tint = new Uint32Array(300);
    for (let i = 0; i < 300; i++) {
      xy[i * 2] = i * 3;
      xy[i * 2 + 1] = i * 5;
      tint[i] = i * 0x010101;
    }
    const b = colStage.bindColumns(
      // options.stride is the default for x and y; tint overrides it.
      { x: xy, y: { array: xy, offset: 1 }, tint: { array: tint, stride: 1 } },
      { stride: 2 },
    );
    b.commit(100, 100);
    for (let i = 100; i < 200; i++) {
      const s = loopStage.children[i] as Sprite;
      s.setPosition(xy[i * 2], xy[i * 2 + 1]);
      s.tint = tint[i] & 0xffffff;
    }
    pa.pack(colStage, fa.next());
    pb.pack(loopStage, fb.next());
    const cmds = fa.encoder.commands();
    expect(cmds.map(c => c.opcode)).toEqual([Op.SPRITE_UPLOAD, Op.SPRITE_DRAW]);
    expect(cmds[0].words.slice(1, 3)).toEqual([100, 100]);
    // Every word but SI_FLAGS (it carries the node's own pick id).
    const words = (p: SpriteScenePacker) =>
      Array.from(p.instances.u32.subarray(0, 3000)).filter(
        (_, k) => k % 10 !== SI_FLAGS / 4,
      );
    expect(words(pa)).toEqual(words(pb));
  });
});

describe('ColumnBinding', () => {
  it('partial commits touch only [first, first + count) and only `fields`', () => {
    const parent = new Container();
    for (let i = 0; i < 6; i++) parent.addChild(new Sprite());
    clearDirty(parent);
    const x = new Float32Array([10, 11, 12, 13, 14, 15]);
    const y = new Float32Array(6).fill(1);
    const rotation = new Float32Array(6).fill(0.5);
    const b = parent.bindColumns({ x, y, rotation });
    expect(b.fields).toBe(BulkField.POSITION | BulkField.ROTATION);
    b.commit(2, 3, BulkField.POSITION);
    const kids = parent.children;
    expect(kids.map(c => c.x)).toEqual([0, 0, 0, 13, 14, 0]);
    expect(kids.map(c => c.rotation)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(nodeStore.dirty[slotOf(kids[2])]).toBe(0);
    expect(nodeStore.dirty[slotOf(kids[3])]).toBe(Dirty.POSITION);
    expect(nodeStore.dirty[slotOf(kids[5])]).toBe(0);
    // Unbound fields are ignored; count 0 is a no-op.
    b.commit(1, 5, BulkField.TINT);
    expect(nodeStore.dirty[slotOf(kids[5])]).toBe(0);
    b.commit(0, 6);
    b.commit(1, 0, BulkField.ROTATION);
    expect(kids[0].rotation).toBe(0.5);
    expect(kids[0].x).toBe(0);
  });

  it('rebind after the arrays were replaced (archetype growth), and growth of children needs none', () => {
    const parent = new Container();
    parent.addChild(new Sprite());
    parent.addChild(new Sprite());
    let x = new Float32Array([1, 2]);
    let y = new Float32Array([3, 4]);
    const b = parent.bindColumns({ x, y });
    b.commit(2);
    // Children grow; old arrays too short for the new row.
    parent.addChild(new Sprite());
    expect(() => b.commit(3)).toThrow(/column x < 3 rows/);
    b.commit(2); // still fine: the snapshot follows the children
    x = new Float32Array([5, 6, 7]);
    y = new Float32Array([8, 9, 10]);
    b.rebind({ x, y });
    b.commit(3);
    expect(parent.children.map(c => [c.x, c.y])).toEqual([
      [5, 8],
      [6, 9],
      [7, 10],
    ]);
    // Same object from bindColumns.
    expect(parent.bindColumns({ x, y })).toBe(b);
    // Removing a child: rows map to the new children order.
    parent.removeChildren(0, 1);
    b.commit(2);
    expect(parent.children.map(c => c.x)).toEqual([5, 6]);
  });

  it('validates at bind time', () => {
    const parent = new Container();
    parent.addChild(new Sprite());
    const f = new Float32Array(1);
    const u = new Uint32Array(1);
    const bad = (cols: unknown, opts?: unknown) => () =>
      parent.bindColumns(cols as SpriteColumns, opts as undefined);
    expect(bad({ x: f })).toThrow(/bad y/);
    expect(bad({ x: u, y: f })).toThrow(/bad x/);
    expect(bad({ x: f, y: f, tint: f })).toThrow(/bad tint/);
    expect(bad({ x: f, y: f, rotation: [1] })).toThrow(/bad rotation/);
    expect(bad({ x: { array: f, stride: 0 }, y: f })).toThrow(/bad x/);
    expect(bad({ x: { array: f, offset: -1 }, y: f })).toThrow(/bad x/);
    expect(bad({ x: f, y: f }, { stride: 1.5 })).toThrow(/bad x/);
    expect(bad({ x: f, y: f, frame: u })).toThrow(/bad frame/);
    // A failed bind leaves nothing bound.
    const b = parent.bindColumns({ x: f, y: f });
    expect(bad({ x: f, y: u })).toThrow(/INVALID_ARGUMENT|bad y/);
    expect(b.fields).toBe(0);
  });

  it('validates at commit time', () => {
    const parent = new Container();
    for (let i = 0; i < 3; i++) parent.addChild(new Sprite());
    const t = atlas();
    const b = parent.bindColumns(
      {
        x: new Float32Array(3),
        y: { array: new Float32Array(5), offset: 1, stride: 2 },
        frame: new Uint32Array([0, 1, 0]),
      },
      { frames: [t] },
    );
    expect(() => b.commit(4)).toThrow(/outside/);
    expect(() => b.commit(1, -1)).toThrow(/outside/);
    expect(() => b.commit(1.5)).toThrow(/outside/);
    // y holds rows 0..1 only (offset 1 + 2 × 2 = 5 is out of bounds).
    expect(() => b.commit(3)).toThrow(/column y < 3 rows/);
    b.commit(2, 0, BulkField.POSITION);
    // frame 1 does not exist in `frames`.
    expect(() => b.commit(2, 0, BulkField.FRAME)).toThrow(/frame, row 1/);
  });

  it('a bad frame index throws before any row is written (atomic commit)', () => {
    const parent = new Container();
    const a = parent.addChild(new Sprite());
    const c = parent.addChild(new Sprite());
    const t = atlas();
    const x = new Float32Array([5, 6]);
    const frame = new Uint32Array([9, 0]);
    const b = parent.bindColumns(
      { x, y: new Float32Array(2), frame },
      { frames: [t] },
    );
    const before = [snap(a), snap(c)];
    const touch = nodeStore.touch;
    expect(() => b.commit(2)).toThrow(/frame, row 0/);
    // Nothing written, no dirty bits, touch unchanged: no half-applied rows.
    expect([snap(a), snap(c)]).toEqual(before);
    expect(a.x).toBe(0);
    expect(nodeStore.touch).toBe(touch);
    // Non-sprite rows are not checked (FRAME skips them).
    frame[0] = 0;
    b.commit(2);
    expect([a.x, c.x]).toEqual([5, 6]);
    expect(nodeStore.touch).not.toBe(touch);
    parent.destroy();
  });

  it('bumps touch even when a foreign setter throws part-way', () => {
    const parent = new Container();
    parent.addChild(new Sprite());
    const foreign = {
      id: -1,
      kind: 'container',
      set x(_v: number) {
        throw new Error('boom');
      },
      y: 0,
    };
    (parent as unknown as { _children: unknown[] })._children.push(foreign);
    (parent as unknown as { _childrenVersion: number })._childrenVersion++;
    const b = parent.bindColumns({
      x: new Float32Array([1, 2]),
      y: new Float32Array([3, 4]),
    });
    const touch = nodeStore.touch;
    expect(() => b.commit(2)).toThrow(/boom/);
    // Row 0 was written: the packer must see the change.
    expect(parent.children[0].x).toBe(1);
    expect(nodeStore.touch).not.toBe(touch);
    (parent as unknown as { _children: unknown[] })._children.pop();
    parent.destroy();
  });

  it('unbind drops the references; destroy rejects further use', () => {
    const parent = new Container();
    parent.addChild(new Sprite());
    const b = parent.bindColumns({
      x: new Float32Array([4]),
      y: new Float32Array([4]),
    });
    b.unbind();
    expect(b.fields).toBe(0);
    b.commit(1); // nothing bound: no-op
    expect(parent.children[0].x).toBe(0);
    b.rebind({ x: new Float32Array([4]), y: new Float32Array([4]) });
    parent.destroy();
    expect(b.fields).toBe(0);
    expect(() => b.commit(0)).toThrow(/destroyed/);
    expect(() =>
      parent.bindColumns({ x: new Float32Array(1), y: new Float32Array(1) }),
    ).toThrow(/destroyed/);
  });

  it('frame changes within one source keep the structure; another source bumps it', () => {
    const t = atlas();
    const other = atlas();
    const parent = new Container();
    parent.addChild(new Sprite(t));
    const frame = new Uint32Array([1]);
    const b = parent.bindColumns(
      { x: new Float32Array(1), y: new Float32Array(1), frame },
      { frames: [t, t.sub(0, 0, 2, 2), other] },
    );
    const v = nodeStore.structureVersion;
    b.commit(1);
    expect(nodeStore.structureVersion).toBe(v);
    expect(nodeStore.dirty[slotOf(parent.children[0])] & Dirty.SPRITE).toBe(
      Dirty.SPRITE,
    );
    frame[0] = 2;
    b.commit(1);
    expect(nodeStore.structureVersion).toBe(v + 1);
    expect((parent.children[0] as Sprite).texture).toBe(other);
  });

  it('allocates nothing per commit', () => {
    const t = atlas();
    const parent = new Container();
    const n = 64;
    for (let i = 0; i < n; i++) parent.addChild(new Sprite(t));
    const xy = new Float32Array(n * 2);
    const rot = new Float32Array(n);
    const tint = new Uint32Array(n);
    const user = new Uint32Array(n);
    const frame = new Uint32Array(n);
    const b = parent.bindColumns(
      {
        x: { array: xy, stride: 2 },
        y: { array: xy, offset: 1, stride: 2 },
        rotation: rot,
        tint,
        userId: user,
        frame,
      },
      { frames: [t] },
    );
    const bulk = parent.bulkChildren(BulkField.POSITION | BulkField.ALPHA);
    const run = (iterations: number) => {
      for (let k = 0; k < iterations; k++) {
        xy[(k % n) * 2] = k;
        rot[k % n] = k * 0.001;
        user[k % n] = k;
        b.commit(n);
        b.commit(n >> 1, n >> 2, BulkField.POSITION);
        bulk.commit(BulkField.POSITION | BulkField.ALPHA);
      }
    };
    // Warm up long enough for the optimizing compiler: interpreted code
    // boxes the doubles of this loop itself (a loaded machine delays
    // concurrent compilation, so the first attempts may still see that).
    run(200_000);
    // A per-child allocation collects hundreds of times per attempt: fail at
    // once. Otherwise pass as soon as one attempt sees no collection at all
    // (a real per-commit allocation of even 16 B fills a 16 MB semi-space
    // in each 1M-iteration attempt).
    let collections = -1;
    for (let attempt = 0; attempt < 5 && collections !== 0; attempt++) {
      const profiler = new GCProfiler();
      profiler.start();
      run(1_000_000);
      collections = profiler.stop().statistics.length;
      expect(collections).toBeLessThan(10);
    }
    expect(collections).toBe(0);
  }, 30_000);
});
