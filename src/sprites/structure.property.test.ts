/**
 * Incremental structure pass (ARCHITECTURE §16.2) against a full rebuild.
 *
 * Two identical scenes are built and edited with the same seeded random
 * sequence. Scene A is packed incrementally, scene B with `incremental =
 * false`. After every frame the simulated GPU vertex buffers (fed only by the
 * command stream) must be equal byte for byte over the drawn instances (pick
 * ids are compared through the node pairing, because node ids differ), the
 * draw command lists must match, and so must the packers' flat lists.
 */
import { Op, CommandFlag } from '../commands/opcodes';
import { Container } from '../scene/Container';
import { NodeBase } from '../scene/Node';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { BulkField } from '../scene/types';
import type { BlendMode } from '../backend/types';
import type { SceneNode } from '../scene/types';
import type { FrontFrame } from '../types/core';
import { SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { FakeFrame } from './fakes.testutil';
import { loadPatcher, SpriteScenePacker } from './front';

// The incremental pass loads lazily; these tests exercise it directly.
beforeAll(() => loadPatcher());

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

const CUSTOM_OP = 0x03ff;

/** A CustomDrawable leaf that draws its creation index. */
class Custom extends NodeBase {
  constructor(readonly index: number) {
    super();
  }
  get kind(): 'swarm' {
    return 'swarm';
  }
  _emitDraw(f: FrontFrame): void {
    f.encoder.begin(CUSTOM_OP, 4, CommandFlag.DRAW);
    f.encoder.u32(this.index);
    f.encoder.end();
  }
}

const BLENDS: BlendMode[] = ['normal', 'add', 'multiply'];

interface Scene {
  stage: Container;
  /** Every node ever created, by creation index (destroyed ones included). */
  nodes: SceneNode[];
  packer: SpriteScenePacker;
  frame: FakeFrame;
  gpu: Uint8Array;
}

function pixels(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h * 4).fill(v);
}

function runPair(seed: number, frames: number, maxEdits: number): void {
  const atlas = Texture.fromPixels(64, 32, pixels(64, 32, 200));
  const other = Texture.fromPixels(8, 8, pixels(8, 8, 90));
  const textures = [atlas, atlas.sub(0, 0, 16, 16), other, Texture.WHITE];

  const make = (incremental: boolean): Scene => {
    const packer = new SpriteScenePacker();
    packer.incremental = incremental;
    return {
      stage: new Container(),
      nodes: [],
      packer,
      frame: new FakeFrame(),
      gpu: new Uint8Array(0),
    };
  };
  const A = make(true);
  const B = make(false);

  const live = (sc: Scene): SceneNode[] => sc.nodes.filter(n => !n.destroyed);
  const containers = (sc: Scene): Container[] =>
    live(sc).filter((n): n is Container => n instanceof Container);

  function newNode(sc: Scene, r: () => number, depth: number): SceneNode {
    const pick = r();
    let node: SceneNode;
    if (pick < 0.7 || depth > 2) {
      node = new Sprite({
        texture: textures[Math.floor(r() * textures.length)],
        x: r() * 300,
        y: r() * 300,
        anchor: r(),
        tint: Math.floor(r() * 0xffffff),
        rotation: r() < 0.3 ? r() * 6 : 0,
        blendMode: r() < 0.15 ? BLENDS[Math.floor(r() * 3)] : 'normal',
        visible: r() > 0.1,
      });
      sc.nodes.push(node);
    } else if (pick < 0.8) {
      node = new Custom(sc.nodes.length);
      node.x = r() * 50;
      sc.nodes.push(node);
    } else {
      const c = new Container({
        x: r() * 50,
        y: r() * 50,
        visible: r() > 0.15,
      });
      sc.nodes.push(c);
      const kids = Math.floor(r() * 6);
      for (let i = 0; i < kids; i++) c.addChild(newNode(sc, r, depth + 1));
      node = c;
    }
    return node;
  }

  const isAncestorOrSelf = (a: SceneNode, b: SceneNode): boolean => {
    for (let p: SceneNode | null = b; p; p = p.parent) if (p === a) return true;
    return false;
  };

  function edit(sc: Scene, r: () => number, frameIndex: number): void {
    const edits =
      frameIndex === 0
        ? 0
        : r() < 0.05
          ? 80 // overflows the structure log
          : Math.floor(r() * maxEdits);
    for (let e = 0; e < edits; e++) {
      const all = live(sc);
      const cs = containers(sc).filter(c => c === sc.stage || !!c.parent);
      const node = all.length ? all[Math.floor(r() * all.length)] : null;
      const target = cs.length ? cs[Math.floor(r() * cs.length)] : sc.stage;
      const op = r();
      if (op < 0.2) {
        const n = newNode(sc, r, 0);
        if (r() < 0.5) target.addChild(n);
        else {
          target.addChildAt(n, Math.floor(r() * (target.children.length + 1)));
        }
      } else if (op < 0.3) {
        if (node && node.parent) node.removeFromParent();
      } else if (op < 0.35) {
        const len = target.children.length;
        if (len > 0) {
          const b = Math.floor(r() * len);
          const removed = target.removeChildren(b, b + 1 + Math.floor(r() * 3));
          if (r() < 0.5) for (const x of removed) x.destroy();
        }
      } else if (op < 0.45) {
        const len = target.children.length;
        if (len > 1) {
          target.setChildIndex(
            target.children[Math.floor(r() * len)],
            Math.floor(r() * len),
          );
        }
      } else if (op < 0.55) {
        if (node && node !== sc.stage && !isAncestorOrSelf(node, target)) {
          if (r() < 0.5) target.addChild(node);
          else {
            const len =
              target.children.length - (node.parent === target ? 1 : 0);
            target.addChildAt(node, Math.floor(r() * (len + 1)));
          }
        }
      } else if (op < 0.68) {
        if (node && node !== sc.stage) node.visible = !node.visible;
      } else if (op < 0.75) {
        if (node instanceof Sprite) {
          node.texture = textures[Math.floor(r() * textures.length)];
        }
      } else if (op < 0.8) {
        if (node instanceof Sprite) {
          node.blendMode = BLENDS[Math.floor(r() * 3)];
        }
      } else if (op < 0.84) {
        if (node && node !== sc.stage) node.destroy();
      } else if (op < 0.88) {
        if (node) node.pickable = !node.pickable;
      } else if (op < 0.94) {
        if (node) {
          node.setPosition(node.x + r() * 10 - 5, node.y + r() * 10 - 5);
          if (r() < 0.3) node.rotation = r() * 6;
          if (r() < 0.2) node.alpha = r();
        }
      } else {
        // bulk moves over one container's children
        const bulk = target.bulkChildren(BulkField.POSITION);
        bulk.pull(BulkField.POSITION);
        for (let i = 0; i < bulk.count * 2; i++) bulk.position[i] += r() * 2;
        bulk.commit(BulkField.POSITION);
      }
    }
  }

  function applyStream(sc: Scene): void {
    for (const c of sc.frame.encoder.commands()) {
      if (c.opcode === Op.SPRITE_BUFFER_ALLOC) {
        const next = new Uint8Array(c.words[1] * SPRITE_INSTANCE_BYTES);
        next.fill(0xcd);
        sc.gpu = next;
      } else if (c.opcode === Op.SPRITE_UPLOAD) {
        const first = c.words[1];
        const count = c.words[2];
        const at = c.payloadOffset + 12;
        sc.gpu.set(
          sc.frame.encoder.u8.subarray(at, at + count * SPRITE_INSTANCE_BYTES),
          first * SPRITE_INSTANCE_BYTES,
        );
      }
    }
  }

  function draws(sc: Scene): string[] {
    return sc.frame.encoder
      .commands()
      .filter(c => c.opcode === Op.SPRITE_DRAW || c.opcode === CUSTOM_OP)
      .map(c =>
        c.opcode === CUSTOM_OP
          ? `custom ${c.words[0]}`
          : `sprites ${c.words.slice(1, 5).join(' ')}`,
      );
  }

  const rA = rng(seed);
  const rB = rng(seed);
  // Initial scene
  for (const [sc, r] of [
    [A, rA],
    [B, rB],
  ] as const) {
    for (let i = 0; i < 40; i++) sc.stage.addChild(newNode(sc, r, 0));
  }

  for (let f = 0; f < frames; f++) {
    edit(A, rA, f);
    edit(B, rB, f);
    A.packer.pack(A.stage, A.frame.next());
    B.packer.pack(B.stage, B.frame.next());
    applyStream(A);
    applyStream(B);

    const dA = draws(A);
    const dB = draws(B);
    if (dA.join('\n') !== dB.join('\n')) {
      throw new Error(
        `frame ${f}: draws differ\nA: ${dA.join(' | ')}\nB: ${dB.join(' | ')}`,
      );
    }
    const count = B.packer.instanceCount;
    expect(A.packer.instanceCount).toBe(count);

    // Node pairing by creation index (pick ids are node ids).
    const idMap = new Map<number, number>();
    for (let i = 0; i < A.nodes.length; i++) {
      if (!A.nodes[i].destroyed) idMap.set(A.nodes[i].id, B.nodes[i].id);
    }
    const a32 = new Uint32Array(A.gpu.buffer, 0, A.gpu.byteLength >> 2);
    const b32 = new Uint32Array(B.gpu.buffer, 0, B.gpu.byteLength >> 2);
    for (let i = 0; i < count; i++) {
      const o = i * SPRITE_INSTANCE_BYTES;
      for (let k = 0; k < 36; k++) {
        if (A.gpu[o + k] !== B.gpu[o + k]) {
          throw new Error(
            `frame ${f} instance ${i} byte ${k}: ${A.gpu[o + k]} != ${B.gpu[o + k]}`,
          );
        }
      }
      const fa = a32[i * 10 + 9];
      const fb = b32[i * 10 + 9];
      const pa = fa >>> 8;
      const mapped = pa === 0 ? 0 : (idMap.get(pa) ?? -1);
      if ((fa & 0xff) !== (fb & 0xff) || mapped !== fb >>> 8) {
        throw new Error(`frame ${f} instance ${i}: flags ${fa} vs ${fb}`);
      }
    }

    // Flat lists: same shape (nodes paired by creation index).
    const la = (A.packer as unknown as { list: FlatListView }).list;
    const lb = (B.packer as unknown as { list: FlatListView }).list;
    expect(la.count).toBe(lb.count);
    for (let i = 0; i < la.count; i++) {
      const ia = A.nodes.indexOf(la.nodes[i]);
      const ib = B.nodes.indexOf(lb.nodes[i]);
      if (
        ia !== ib ||
        la.parent[i] !== lb.parent[i] ||
        la.end[i] !== lb.end[i] ||
        la.runEnd[i] !== lb.runEnd[i] ||
        la.inst[i] !== lb.inst[i] ||
        la.kind[i] !== lb.kind[i]
      ) {
        throw new Error(
          `frame ${f} flat ${i}: node ${ia}/${ib} parent ${la.parent[i]}/${lb.parent[i]} ` +
            `end ${la.end[i]}/${lb.end[i]} run ${la.runEnd[i]}/${lb.runEnd[i]} ` +
            `inst ${la.inst[i]}/${lb.inst[i]} kind ${la.kind[i]}/${lb.kind[i]}`,
        );
      }
    }
  }
  if (maxEdits > 3) expect(A.packer.patchCount).toBeGreaterThan(frames / 4);
  A.packer.destroy();
  B.packer.destroy();
  A.stage.destroy({ children: true });
  B.stage.destroy({ children: true });
}

interface FlatListView {
  count: number;
  parent: Int32Array;
  end: Int32Array;
  runEnd: Int32Array;
  inst: Int32Array;
  kind: Uint8Array;
  nodes: SceneNode[];
}

describe('incremental structure pass equals a full rebuild', () => {
  it('few structural edits per frame', () => {
    runPair(1, 150, 4);
    runPair(2, 150, 4);
  });

  it('many structural edits per frame', () => {
    runPair(3, 120, 25);
    runPair(4, 120, 25);
  });

  it('single edits (one region per frame)', () => {
    for (let seed = 10; seed < 16; seed++) runPair(seed, 100, 2);
  });

  const env = (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process?.env;
  const stress = Number(env?.COZY_STRUCT_STRESS ?? 0);
  (stress > 0 ? it : it.skip)('stress (COZY_STRUCT_STRESS=<seeds>)', () => {
    for (let seed = 100; seed < 100 + stress; seed++) {
      try {
        runPair(seed, 200, 1 + (seed % 30));
      } catch (err) {
        (err as Error).message = `seed ${seed}: ${(err as Error).message}`;
        throw err;
      }
    }
  });

  it('appending to a large container patches without a rebuild', () => {
    const stage = new Container();
    const world = stage.addChild(new Container());
    for (let i = 0; i < 2000; i++) world.addChild(new Sprite({ x: i }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame.next());
    const rebuilds = packer.rebuildCount;
    for (let f = 0; f < 10; f++) {
      world.addChild(new Sprite({ x: 5000 + f }));
      packer.pack(stage, frame.next());
    }
    expect(packer.rebuildCount).toBe(rebuilds);
    expect(packer.patchCount).toBe(10);
    expect(packer.instanceCount).toBe(2010);
    expect(packer.instances.f32[2009 * 10 + 4]).toBe(5009);
    // one batch, run covers every child
    expect(packer.batchCount).toBe(1);
    const list = (packer as unknown as { list: FlatListView }).list;
    expect(list.runEnd[2]).toBe(2012);
    packer.destroy();
    stage.destroy({ children: true });
  });
});
