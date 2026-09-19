/**
 * Tester (logic, M2). `Container.bulkChildren()` (ARCHITECTURE §16.1) must be
 * a pure fast path: the store bytes and the dirty bits it leaves behind have
 * to equal what the per-node setters produce for the same values.
 */
import { Container } from './Container';
import { NodeBase } from './Node';
import { Sprite } from './Sprite';
import { Texture } from './Texture';
import { BulkField } from './types';
import type { FrontFrame } from '../types/core';
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

/** A leaf that is not a Sprite (exercises the TINT skip). */
class Plain extends NodeBase {
  get kind(): 'container' {
    return 'container';
  }
  _emitDraw(_f: FrontFrame): void {}
}

const tex = () => Texture.fromPixels(4, 4, new Uint8Array(64).fill(255));

interface Snap {
  x: number;
  y: number;
  rot: number;
  sx: number;
  sy: number;
  alpha: number;
  tint: number;
  dirty: number;
}

function snap(node: NodeBase): Snap {
  const s = nodeStore;
  const slot = (node as unknown as { _slot: number })._slot;
  const lo = slot * LOCAL_STRIDE;
  return {
    x: s.pos[slot * POS_STRIDE],
    y: s.pos[slot * POS_STRIDE + 1],
    rot: s.local[lo + L_ROT],
    sx: s.local[lo + L_SCALE_X],
    sy: s.local[lo + L_SCALE_Y],
    alpha: s.local[lo + L_ALPHA],
    tint: s.tint[slot],
    dirty: s.dirty[slot],
  };
}

const ALL =
  BulkField.POSITION |
  BulkField.ROTATION |
  BulkField.SCALE |
  BulkField.ALPHA |
  BulkField.TINT;

describe('bulkChildren commit equals the per-node setters', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', seed => {
    const rnd = rng(seed);
    const t = tex();
    const bulkParent = new Container();
    const loopParent = new Container();
    const n = 1 + Math.floor(rnd() * 24);
    const kinds: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const isSprite = rnd() < 0.7;
      kinds.push(isSprite);
      bulkParent.addChild(isSprite ? new Sprite(t) : new Plain());
      loopParent.addChild(isSprite ? new Sprite(t) : new Plain());
    }
    // Clear the dirty bits set while building.
    for (const p of [bulkParent, loopParent]) {
      for (const c of p.children as NodeBase[]) {
        nodeStore.dirty[(c as unknown as { _slot: number })._slot] = 0;
      }
    }

    const values = [];
    for (let i = 0; i < n; i++) {
      values.push({
        x: Math.round(rnd() * 2000 - 1000),
        y: Math.round(rnd() * 2000 - 1000),
        rot: rnd() * 6 - 3,
        sx: rnd() * 4 - 2,
        sy: rnd() * 4 - 2,
        alpha: rnd(),
        tint: Math.floor(rnd() * 0x1000000),
      });
    }

    // Bulk path.
    const bulk = bulkParent.bulkChildren(ALL);
    expect(bulk.count).toBe(n);
    for (let i = 0; i < n; i++) {
      bulk.position[i * 2] = values[i].x;
      bulk.position[i * 2 + 1] = values[i].y;
      bulk.rotation[i] = values[i].rot;
      bulk.scale[i * 2] = values[i].sx;
      bulk.scale[i * 2 + 1] = values[i].sy;
      bulk.alpha[i] = values[i].alpha;
      bulk.tint[i] = values[i].tint;
    }
    bulk.commit(ALL);

    // Per-node path.
    for (let i = 0; i < n; i++) {
      const node = loopParent.children[i] as NodeBase;
      node.setPosition(values[i].x, values[i].y);
      node.rotation = values[i].rot;
      node.setScale(values[i].sx, values[i].sy);
      node.alpha = values[i].alpha;
      if (kinds[i]) (node as Sprite).tint = values[i].tint;
    }

    for (let i = 0; i < n; i++) {
      const a = snap(bulkParent.children[i] as NodeBase);
      const b = snap(loopParent.children[i] as NodeBase);
      expect([i, a]).toEqual([i, b]);
    }
  });

  it('pull() round-trips the store and commit() of a sub-range touches only it', () => {
    const t = tex();
    const parent = new Container();
    for (let i = 0; i < 6; i++) parent.addChild(new Sprite(t));
    for (let i = 0; i < 6; i++) {
      const s = parent.children[i] as Sprite;
      s.setPosition(i, i * 2);
      s.rotation = i / 10;
      s.setScale(i + 1, i + 2);
      s.alpha = i / 6;
      s.tint = 0x010203 * (i + 1);
      nodeStore.dirty[(s as unknown as { _slot: number })._slot] = 0;
    }
    const bulk = parent.bulkChildren(ALL);
    bulk.pull(ALL);
    for (let i = 0; i < 6; i++) {
      expect(bulk.position[i * 2]).toBe(i);
      expect(bulk.position[i * 2 + 1]).toBe(i * 2);
      expect(bulk.rotation[i]).toBeCloseTo(i / 10);
      expect(bulk.scale[i * 2]).toBe(i + 1);
      expect(bulk.tint[i]).toBe((0x010203 * (i + 1)) & 0xffffff);
    }
    bulk.position[2 * 2] = 999;
    bulk.position[3 * 2] = 888;
    bulk.commit(BulkField.POSITION, 2, 2);
    const slot = (i: number) =>
      (parent.children[i] as unknown as { _slot: number })._slot;
    expect(nodeStore.pos[slot(2) * POS_STRIDE]).toBe(999);
    expect(nodeStore.pos[slot(3) * POS_STRIDE]).toBe(888);
    expect(nodeStore.pos[slot(1) * POS_STRIDE]).toBe(1);
    expect(nodeStore.dirty[slot(1)]).toBe(0);
    expect(nodeStore.dirty[slot(2)]).toBe(Dirty.POSITION);
    expect(nodeStore.dirty[slot(4)]).toBe(0);
  });

  it('commit throws after the children changed, and a fresh acquire re-snapshots', () => {
    const t = tex();
    const parent = new Container();
    parent.addChild(new Sprite(t));
    const bulk = parent.bulkChildren(BulkField.POSITION);
    parent.addChild(new Sprite(t));
    expect(() => bulk.commit(BulkField.POSITION)).toThrow(/children changed/);
    const again = parent.bulkChildren(BulkField.POSITION);
    expect(again.count).toBe(2);
    expect(again.position.length).toBe(4);
  });

  it('a field not requested cannot be committed', () => {
    const t = tex();
    const parent = new Container();
    parent.addChild(new Sprite(t));
    const bulk = parent.bulkChildren(BulkField.POSITION);
    expect(() => bulk.commit(BulkField.ROTATION)).toThrow(/not requested/);
    expect(bulk.rotation.length).toBe(0);
  });

  it('out-of-range commits throw', () => {
    const t = tex();
    const parent = new Container();
    for (let i = 0; i < 3; i++) parent.addChild(new Sprite(t));
    const bulk = parent.bulkChildren(BulkField.POSITION);
    expect(() => bulk.commit(BulkField.POSITION, 2, 2)).toThrow(/outside/);
    expect(() => bulk.commit(BulkField.POSITION, -1, 1)).toThrow(/outside/);
    expect(() => bulk.commit(BulkField.POSITION, 0.5, 1)).toThrow(/outside/);
    bulk.commit(BulkField.POSITION, 3, 0);
  });

  it('TINT is ignored for non-sprite children in both paths', () => {
    const parent = new Container();
    const plain = new Plain();
    parent.addChild(plain);
    const slot = (plain as unknown as { _slot: number })._slot;
    nodeStore.tint[slot] = 0x123456;
    nodeStore.dirty[slot] = 0;
    const bulk = parent.bulkChildren(BulkField.TINT);
    bulk.tint[0] = 0xabcdef;
    bulk.commit(BulkField.TINT);
    expect(nodeStore.tint[slot]).toBe(0x123456);
    expect(nodeStore.dirty[slot]).toBe(0);
  });

  it('arrays stay sized once a field was requested (no realloc on alternating calls)', () => {
    const t = tex();
    const parent = new Container();
    for (let i = 0; i < 4; i++) parent.addChild(new Sprite(t));
    const a = parent.bulkChildren(BulkField.POSITION);
    const posBefore = a.position;
    const b = parent.bulkChildren(BulkField.ROTATION);
    expect(b).toBe(a);
    expect(b.position.length).toBe(8);
    expect(b.rotation.length).toBe(4);
    const c = parent.bulkChildren(BulkField.POSITION);
    expect(c.position).toBe(posBefore);
  });
});
