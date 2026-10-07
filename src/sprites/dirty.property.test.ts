/**
 * Tester: dirty-range tracking.
 *  1. DirtyRanges invariants under random add sequences.
 *  2. ScenePacker end-to-end: a simulated GPU vertex buffer that only
 *     receives SPRITE_BUFFER_ALLOC / SPRITE_UPLOAD bytes must equal an
 *     independently computed instance array after every frame of random
 *     scene edits (so no dirty sprite is ever missed by the ranges).
 */
import { Op } from '../commands/opcodes';
import { affineFromTRS, affineMultiply } from '../math/affine';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import type { SceneNode } from '../scene/types';
import { SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { DirtyRanges, MAX_RANGES, MERGE_GAP } from './DirtyRanges';
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

describe('DirtyRanges invariants (random)', () => {
  it('covers every added index; sorted, disjoint, separated by > MERGE_GAP, ≤ MAX_RANGES', () => {
    const r = rng(2024);
    const ranges = new DirtyRanges();
    for (let iter = 0; iter < 400; iter++) {
      ranges.clear();
      const added: Array<[number, number]> = [];
      const inOrder = r() < 0.5;
      let cursor = 0;
      const n = Math.floor(r() * 60);
      for (let k = 0; k < n; k++) {
        let start: number;
        if (inOrder) {
          cursor += Math.floor(r() * 120);
          start = cursor;
        } else start = Math.floor(r() * 5000);
        const end = start + (r() < 0.2 ? 0 : 1 + Math.floor(r() * 50));
        ranges.addRange(start, end);
        if (end > start) added.push([start, end]);
      }
      const check = () => {
        expect(ranges.count).toBeLessThanOrEqual(MAX_RANGES);
        for (let i = 0; i < ranges.count; i++) {
          expect(ranges.ends[i]).toBeGreaterThan(ranges.starts[i]);
          if (i > 0) {
            expect(ranges.starts[i]).toBeGreaterThan(
              ranges.ends[i - 1] + MERGE_GAP,
            );
          }
        }
        for (const [s, e] of added) {
          let covered = false;
          for (let i = 0; i < ranges.count; i++) {
            if (ranges.starts[i] <= s && e <= ranges.ends[i]) covered = true;
          }
          expect({ s, e, covered }).toEqual({ s, e, covered: true });
        }
      };
      check();
      ranges.finalize();
      check();
      if (added.length === 0) expect(ranges.count).toBe(0);
    }
  });

  it('finalize() collapses to one range iff covered * 2 > span', () => {
    const r = new DirtyRanges();
    r.addRange(0, 50);
    r.addRange(150, 200); // covered 100, span 200 → keep 2
    r.finalize();
    expect(r.count).toBe(2);
    r.addRange(100, 101); // covered 101 > 100 → 1 (and merges within gap)
    r.finalize();
    expect(r.count).toBe(1);
    expect([r.starts[0], r.ends[0]]).toEqual([0, 200]);
  });
});

// ─── Packer vs independent reference ──────────────────────────────────────────

function pixels(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h * 4).fill(v);
}

interface Expected {
  f32: Float64Array; // a b c d tx ty
  color: number;
  uv: number[];
  flags: number;
  node: Sprite;
  /** Stage-space translation the node's worldTransform must report. */
  world: [number, number];
}

function unorm16(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 0xffff : Math.round(v * 0xffff);
}

/** Depth-first reference computation using only public getters + math helpers. */
function reference(stage: Container): Expected[] {
  const out: Expected[] = [];
  const m = new Float64Array(6 * 64);
  const visit = (node: SceneNode, depth: number, parentAlpha: number) => {
    if (!node.visible) return;
    const o = (depth + 1) * 6;
    affineFromTRS(
      m,
      o,
      node.x,
      node.y,
      node.rotation,
      node.scaleX,
      node.scaleY,
      node.skewX,
      node.skewY,
      node.pivotX,
      node.pivotY,
    );
    affineMultiply(m, o, m, depth * 6, m, o);
    const alpha = parentAlpha * node.alpha;
    if (node instanceof Sprite) {
      const t = node.texture;
      const fw = t.frame.width;
      const fh = t.frame.height;
      const q = new Float64Array([
        fw,
        0,
        0,
        fh,
        -node.anchorX * fw,
        -node.anchorY * fh,
      ]);
      const inst = new Float64Array(6);
      affineMultiply(inst, 0, m, o, q, 0);
      const tint = node.tint;
      const a =
        alpha <= 0 ? 0 : alpha >= 1 ? 255 : Math.floor(alpha * 255 + 0.5);
      out.push({
        f32: inst,
        color:
          (((tint >>> 16) & 0xff) |
            (((tint >>> 8) & 0xff) << 8) |
            ((tint & 0xff) << 16) |
            (a << 24)) >>>
          0,
        uv: [
          unorm16(t.frame.x / t.sourceWidth),
          unorm16(t.frame.y / t.sourceHeight),
          unorm16((t.frame.x + t.frame.width) / t.sourceWidth),
          unorm16((t.frame.y + t.frame.height) / t.sourceHeight),
        ],
        flags: node.pickable ? (node.id << 8) >>> 0 : 0,
        node,
        world: [m[o + 4], m[o + 5]],
      });
    }
    const children = (node as Container).children;
    if (children) for (const c of children) visit(c, depth + 1, alpha);
  };
  m.set([1, 0, 0, 1, 0, 0], 0);
  visit(stage, 0, 1);
  return out;
}

function runScenario(
  seed: number,
  allowShrink: boolean,
  incremental = true,
): void {
  {
    const r = rng(seed);
    const atlas = Texture.fromPixels(64, 32, pixels(64, 32, 200));
    const frames = [atlas, atlas.sub(0, 0, 16, 16), atlas.sub(16, 8, 32, 24)];
    const other = Texture.fromPixels(8, 8, pixels(8, 8, 90));
    const textures = [...frames, other, Texture.WHITE];

    const stage = new Container();
    const groups: Container[] = [];
    const sprites: Sprite[] = [];
    for (let g = 0; g < 6; g++) {
      const c = new Container({ x: r() * 100, y: r() * 100, rotation: r() });
      (g > 0 && r() < 0.5
        ? groups[Math.floor(r() * groups.length)]
        : stage
      ).addChild(c);
      groups.push(c);
    }
    const makeSprite = () =>
      new Sprite({
        texture: textures[Math.floor(r() * textures.length)],
        x: r() * 500,
        y: r() * 500,
        anchor: r(),
        tint: Math.floor(r() * 0xffffff),
        rotation: r() < 0.3 ? r() * 6 : 0,
        pivotX: r() < 0.2 ? r() * 8 : 0,
        pivotY: r() < 0.2 ? r() * 8 : 0,
      });
    for (let i = 0; i < 800; i++) {
      const s = makeSprite();
      groups[Math.floor(r() * groups.length)].addChild(s);
      sprites.push(s);
    }

    const packer = new SpriteScenePacker();
    packer.incremental = incremental;
    // The immediate path: these checks read every frame's SPRITE_DRAWs
    // (retained segments would replay them).
    packer.retained = false;
    const frame = new FakeFrame();
    let gpu = new Uint8Array(0);
    let uploadedBytesTotal = 0;
    let bulkFrames = 0;

    for (let f = 0; f < 120; f++) {
      frame.next();
      // ── random edits (mostly small, so dirty tracking matters)
      const edits = f === 0 ? 0 : Math.floor(r() * 12);
      // Bulk moves (the S1 benchmark pattern): long runs of translation-only
      // sprites, mixed with parent changes from the edits below.
      const bulk = f > 0 && r() < 0.4;
      if (bulk) bulkFrames++;
      if (bulk) {
        for (const s of sprites) {
          if (r() < 0.9) s.setPosition(s.x + r() * 4 - 2, s.y + r() * 4 - 2);
        }
      }
      for (let e = 0; e < edits; e++) {
        const pick = r();
        const s = sprites[Math.floor(r() * sprites.length)];
        const g = groups[Math.floor(r() * groups.length)];
        if (pick < 0.15) {
          s.x += r() * 10 - 5;
          s.rotation = r() * 6;
        } else if (pick < 0.3) {
          // translation-only fast path (Dirty.POSITION)
          if (r() < 0.5) s.setPosition(r() * 500, r() * 500);
          else s.y += r() * 10 - 5;
        } else if (pick < 0.35) {
          // parent translation only (CH_TRANSLATE propagation)
          g.setPosition(g.x + r() * 4 - 2, g.y + r() * 4 - 2);
        } else if (pick < 0.4) {
          g.x += r() * 4 - 2;
          g.scaleY = 0.5 + r();
        } else if (pick < 0.47) g.alpha = r();
        else if (pick < 0.54) s.alpha = r() * 1.2;
        else if (pick < 0.57) s.tint = Math.floor(r() * 0xffffff);
        else if (pick < 0.6) s.pickable = !s.pickable;
        else if (pick < 0.65) s.setAnchor(r(), r());
        else if (pick < 0.7) {
          if (allowShrink) s.visible = !s.visible;
        } else if (pick < 0.74) {
          if (allowShrink) g.visible = !g.visible;
        } else if (pick < 0.8)
          s.texture = textures[Math.floor(r() * textures.length)];
        else if (pick < 0.85) {
          const parent = s.parent as Container | null;
          if (parent && parent.children.length > 1) {
            parent.setChildIndex(s, Math.floor(r() * parent.children.length));
          }
        } else if (pick < 0.9) {
          // reparent (moves to end); same-parent re-add is a separate bug
          if (s.parent !== g) g.addChild(s);
        } else if (pick < 0.94) {
          // pivot changes invalidate the cached pivot offset used by the
          // translation-only path (bulk moves in later frames)
          if (r() < 0.5) s.skewX = r() - 0.5;
          else s.setPivot(r() * 8, r() * 8);
        } else if (pick < 0.97) {
          if (!allowShrink) continue;
          const idx = sprites.indexOf(s);
          sprites.splice(idx, 1);
          s.destroy();
        } else {
          const n = makeSprite();
          g.addChild(n);
          sprites.push(n);
        }
      }

      packer.pack(stage, frame);

      // ── apply the stream to the simulated vertex buffer
      const enc = frame.encoder;
      for (const c of enc.commands()) {
        if (c.opcode === Op.SPRITE_BUFFER_ALLOC) {
          const next = new Uint8Array(c.words[1] * SPRITE_INSTANCE_BYTES);
          // contents are undefined after ALLOC: poison with garbage
          next.fill(0xcd);
          gpu = next;
        } else if (c.opcode === Op.SPRITE_UPLOAD) {
          const first = c.words[1];
          const count = c.words[2];
          const bytes = count * SPRITE_INSTANCE_BYTES;
          const at = c.payloadOffset + 12;
          expect((first + count) * SPRITE_INSTANCE_BYTES).toBeLessThanOrEqual(
            gpu.byteLength,
          );
          gpu.set(
            enc.u8.subarray(at, at + bytes),
            first * SPRITE_INSTANCE_BYTES,
          );
          if (!bulk) uploadedBytesTotal += bytes;
        } else if (c.opcode === Op.SPRITE_UPLOAD_SHARED) {
          throw new Error('unexpected shared upload');
        }
      }

      // ── compare
      const expected = reference(stage);
      const draws = enc.commands().filter(c => c.opcode === Op.SPRITE_DRAW);
      expect(draws.reduce((n, d) => n + d.words[2], 0)).toBe(expected.length);
      const f32 = new Float32Array(gpu.buffer, 0, gpu.byteLength >> 2);
      const u32 = new Uint32Array(gpu.buffer, 0, gpu.byteLength >> 2);
      const u16 = new Uint16Array(gpu.buffer, 0, gpu.byteLength >> 1);
      for (let i = 0; i < expected.length; i++) {
        const e = expected[i];
        const o = i * 10;
        for (let k = 0; k < 6; k++) {
          const want = e.f32[k];
          const got = f32[o + k];
          const tol = 1e-3 * Math.max(1, Math.abs(want));
          if (!(Math.abs(got - want) <= tol)) {
            throw new Error(
              `frame ${f} instance ${i} component ${k}: gpu ${got} != expected ${want}`,
            );
          }
        }
        if (u32[o + 6] !== e.color) {
          throw new Error(
            `frame ${f} instance ${i}: color ${u32[o + 6].toString(16)} != ${e.color.toString(16)}`,
          );
        }
        for (let k = 0; k < 4; k++) {
          if (u16[o * 2 + 14 + k] !== e.uv[k]) {
            throw new Error(
              `frame ${f} instance ${i}: uv[${k}] ${u16[o * 2 + 14 + k]} != ${e.uv[k]}`,
            );
          }
        }
        if (u32[o + 9] !== e.flags)
          throw new Error(
            `frame ${f} instance ${i}: flags ${u32[o + 9]} != ${e.flags}`,
          );
        // worldTransform must agree, whichever path wrote the translation.
        const w = e.node.worldTransform;
        const wo = e.node.worldTransformOffset;
        for (let k = 0; k < 2; k++) {
          const want = e.world[k];
          const got = w[wo + 4 + k];
          const tol = 1e-3 * Math.max(1, Math.abs(want));
          if (!(Math.abs(got - want) <= tol)) {
            throw new Error(
              `frame ${f} instance ${i} world[${k}]: ${got} != expected ${want}`,
            );
          }
        }
      }
      // draws are contiguous and in order
      let next = 0;
      for (const d of draws) {
        if (d.words[1] !== next)
          throw new Error(`frame ${f}: draw gap at ${next}`);
        next += d.words[2];
      }
    }
    // dirty tracking actually saved bytes vs full uploads every frame
    // (frames with bulk moves upload nearly everything and are not counted)
    expect(uploadedBytesTotal).toBeLessThan(
      (120 - bulkFrames) * 800 * SPRITE_INSTANCE_BYTES * 0.5,
    );
    packer.destroy();
    stage.destroy({ children: true });
  }
}

describe('ScenePacker: GPU mirror equals reference after random edits', () => {
  it('120 frames: moves, alpha, tint, anchor, skew, reorder, reparent, add, texture swaps', () => {
    runScenario(777, false);
    runScenario(31337, false);
  });

  // Regression: same scenario with visibility toggles and destroys (instance
  // count shrinks and regrows).
  it('120 frames including hide/show and destroy', () => {
    runScenario(777, true);
  });

  // Regression: rebuild() reset `hasPivots` although it rewrites only the
  // instances it forces, so after any full rebuild a translation-only move
  // of an unchanged sprite with a pivot dropped the pivot offset. Full
  // rebuilds run whenever the incremental pass cannot (and until it loads).
  it('the same scenarios with full rebuilds only', () => {
    runScenario(777, false, false);
    runScenario(31337, false, false);
    runScenario(777, true, false);
  });

  // Regression: `parent.addChild(existingChild)` (Pixi bring-to-front idiom)
  // used to throw INVALID_ARGUMENT because the index was computed before the
  // child was removed from this same parent.
  it('re-adding an existing child moves it to the end', () => {
    const c = new Container();
    const a = c.addChild(new Container());
    const b = c.addChild(new Container());
    c.addChild(a);
    expect(c.children).toEqual([b, a]);
    c.destroy({ children: true });
  });

  // Regression: rebuild() did not invalidate instOwner[i] for i at or past the
  // new instanceCount, so a sprite returning to a vacated tail index kept the
  // bytes written there before it moved.
  it('addChildAt on the same parent removes first, then inserts', () => {
    const c = new Container();
    const a = c.addChild(new Container());
    const b = c.addChild(new Container());
    const d = c.addChild(new Container());
    c.addChildAt(a, 1);
    expect(c.children).toEqual([b, a, d]);
    c.addChildAt(d, 0);
    expect(c.children).toEqual([d, b, a]);
    expect(() => c.addChildAt(b, 4)).toThrow(/out of/);
    expect(b.parent).toBe(c);
    c.destroy({ children: true });
  });

  it('a sprite returning to a vacated tail index after a color change is rewritten', () => {
    const stage = new Container();
    const a = stage.addChild(new Sprite());
    const b = stage.addChild(new Sprite({ tint: 0xff0000 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame.next());
    a.visible = false;
    packer.pack(stage, frame.next());
    b.tint = 0x00ff00;
    packer.pack(stage, frame.next());
    a.visible = true;
    packer.pack(stage, frame.next());
    const color = packer.instances.u32[1 * 10 + 6];
    packer.destroy();
    stage.destroy({ children: true });
    expect(color & 0xffffff).toBe(0x00ff00);
  });

  it('minimal repro: last sprite keeps stale bytes after hide/move/show', () => {
    const stage = new Container();
    const a = stage.addChild(new Sprite({ x: 0 }));
    const b = stage.addChild(new Sprite({ x: 0 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame.next()); // b at instance 1
    a.visible = false;
    packer.pack(stage, frame.next()); // b at instance 0
    b.x = 123;
    packer.pack(stage, frame.next()); // written at instance 0
    a.visible = true;
    packer.pack(stage, frame.next()); // b back at instance 1
    const tx = packer.instances.f32[1 * 10 + 4];
    packer.destroy();
    stage.destroy({ children: true });
    expect(tx).toBe(123);
  });
});
