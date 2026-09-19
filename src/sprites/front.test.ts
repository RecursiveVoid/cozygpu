import { Op, CommandFlag, TextureFlag } from '../commands/opcodes';
import { Container } from '../scene/Container';
import { NodeBase } from '../scene/Node';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { nodeStore } from '../scene/store';
import type { FrontFrame } from '../types/core';
import { NO_ID } from '../types/ids';
import { SI_COLOR, SI_U0, SPRITE_INSTANCE_BYTES } from '../types/layouts';
import { DirtyRanges, MAX_RANGES, MERGE_GAP } from './DirtyRanges';
import { FakeFrame } from './fakes.testutil';
import { SpriteScenePacker } from './front';

const white4 = () => new Uint8Array(4 * 4 * 4).fill(255);

function ops(frame: FakeFrame): number[] {
  return frame.encoder.commands().map(c => c.opcode);
}

function instanceF32(p: SpriteScenePacker, inst: number): number[] {
  return Array.from(p.instances.f32.subarray(inst * 10, inst * 10 + 6));
}

describe('DirtyRanges', () => {
  it('merges in-order adds within the gap', () => {
    const r = new DirtyRanges();
    r.add(0);
    r.add(1);
    r.add(1 + MERGE_GAP);
    expect(r.count).toBe(1);
    r.add(1000);
    expect(r.count).toBe(2);
    expect([r.starts[1], r.ends[1]]).toEqual([1000, 1001]);
  });

  it('never exceeds MAX_RANGES and merges nearest', () => {
    const r = new DirtyRanges();
    for (let i = 0; i < 20; i++) r.add(i * 1000 + (i === 5 ? 0 : 0));
    expect(r.count).toBe(MAX_RANGES);
    for (let i = 1; i < r.count; i++) {
      expect(r.starts[i]).toBeGreaterThan(r.ends[i - 1]);
    }
    expect(r.starts[0]).toBe(0);
    expect(r.ends[r.count - 1]).toBe(19001);
  });

  it('handles out-of-order adds and finalize collapses dense sets', () => {
    const r = new DirtyRanges();
    r.addRange(500, 600);
    r.addRange(100, 200);
    r.addRange(150, 520);
    expect(r.count).toBe(1);
    expect([r.starts[0], r.ends[0]]).toEqual([100, 600]);
    const d = new DirtyRanges();
    d.addRange(0, 100);
    d.addRange(200, 300);
    d.finalize();
    expect(d.count).toBe(1);
    const s = new DirtyRanges();
    s.addRange(0, 10);
    s.addRange(1000, 1010);
    s.finalize();
    expect(s.count).toBe(2);
  });
});

describe('ScenePacker', () => {
  it('first frame: alloc, full upload, texture upload, batched draws', () => {
    const tex = Texture.fromPixels(4, 4, white4());
    const atlasFrame = tex.sub(0, 0, 2, 2);
    const other = Texture.fromPixels(4, 4, white4());
    const stage = new Container();
    stage.addChild(new Sprite(tex));
    stage.addChild(new Sprite(atlasFrame)); // same source → same batch
    stage.addChild(new Sprite({ texture: other }));
    stage.addChild(new Sprite({ texture: other, blendMode: 'add' }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);

    const cmds = frame.encoder.commands();
    expect(cmds.map(c => c.opcode)).toEqual([
      Op.SPRITE_BUFFER_ALLOC,
      Op.SPRITE_UPLOAD,
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_PIXELS,
      Op.SPRITE_DRAW,
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_PIXELS,
      Op.SPRITE_DRAW,
      Op.SPRITE_DRAW,
    ]);
    const upload = cmds[1];
    expect(upload.words.slice(0, 3)).toEqual([packer.bufferId, 0, 4]);
    expect(upload.payloadBytes).toBe(12 + 4 * SPRITE_INSTANCE_BYTES);
    const create = cmds[2];
    expect(create.words[0]).toBe(tex.sourceId);
    expect(create.words[4] & TextureFlag.PREMULTIPLIED).toBeTruthy();

    const draws = cmds.filter(c => c.opcode === Op.SPRITE_DRAW);
    expect(draws.every(c => c.flags === CommandFlag.DRAW)).toBe(true);
    expect(draws.map(c => c.words)).toEqual([
      [packer.bufferId, 0, 2, tex.sourceId, 0],
      [packer.bufferId, 2, 1, other.sourceId, 0],
      [packer.bufferId, 3, 1, other.sourceId, 1],
    ]);
  });

  it('packs affine with anchor and size, straight color, unorm16 uvs', () => {
    const tex = Texture.fromPixels(4, 4, white4());
    const stage = new Container({ x: 100, y: 50 });
    const s = new Sprite({
      texture: tex.sub(2, 0, 2, 4),
      anchor: 0.5,
      x: 10,
      y: 20,
      scale: 2,
      tint: 0x336699,
      alpha: 0.5,
    });
    stage.addChild(s);
    const packer = new SpriteScenePacker();
    packer.pack(stage, new FakeFrame());
    // size 2×4 scaled ×2 → 4×8, anchored at center, at (110, 70)
    expect(instanceF32(packer, 0)).toEqual([4, 0, 0, 8, 108, 66]);
    const i32 = packer.instances.u32;
    expect(i32[SI_COLOR / 4]).toBe(0x80996633);
    const u16 = packer.instances.u16;
    expect(Array.from(u16.subarray(SI_U0 / 2, SI_U0 / 2 + 4))).toEqual([
      0x8000, 0, 0xffff, 0xffff,
    ]);
    expect(s.worldAlpha).toBeCloseTo(0.5);
    expect(s.width).toBe(4);
  });

  it('steady state emits only draws; moves upload minimal ranges', () => {
    const stage = new Container();
    const sprites: Sprite[] = [];
    for (let i = 0; i < 2000; i++) sprites.push(stage.addChild(new Sprite()));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);

    packer.pack(stage, frame.next());
    expect(ops(frame)).toEqual([Op.SPRITE_DRAW]);
    expect(frame.encoder.commands()[0].words[3]).toBe(NO_ID);

    sprites[1500].x = 5;
    packer.pack(stage, frame.next());
    const cmds = frame.encoder.commands();
    expect(cmds.map(c => c.opcode)).toEqual([Op.SPRITE_UPLOAD, Op.SPRITE_DRAW]);
    expect(cmds[0].words.slice(0, 3)).toEqual([packer.bufferId, 1500, 1]);
    expect(instanceF32(packer, 1500)[4]).toBe(5);
  });

  it('preserves draw order: interleaved textures do not merge', () => {
    const a = Texture.fromPixels(4, 4, white4());
    const b = Texture.fromPixels(4, 4, white4());
    const stage = new Container();
    const group = stage.addChild(new Container());
    group.addChild(new Sprite(a));
    group.addChild(new Sprite(a));
    stage.addChild(new Sprite(b));
    stage.addChild(new Sprite(a.sub(0, 0, 1, 1)));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    const draws = frame.encoder
      .commands()
      .filter(c => c.opcode === Op.SPRITE_DRAW)
      .map(c => c.words.slice(1, 4));
    expect(draws).toEqual([
      [0, 2, a.sourceId],
      [2, 1, b.sourceId],
      [3, 1, a.sourceId],
    ]);
  });

  it('idle frames skip the transform pass but later edits still upload', () => {
    const stage = new Container();
    const s = stage.addChild(new Sprite({ tint: 0x010203 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    packer.pack(stage, frame.next());
    packer.pack(stage, frame.next());
    expect(ops(frame)).toEqual([Op.SPRITE_DRAW]);
    s.alpha = 0;
    packer.pack(stage, frame.next());
    expect(ops(frame)).toEqual([Op.SPRITE_UPLOAD, Op.SPRITE_DRAW]);
    expect(packer.instances.u32[SI_COLOR / 4]).toBe(0x00030201);
  });

  it('parent changes propagate; hidden subtrees catch up when shown', () => {
    const stage = new Container();
    const group = stage.addChild(new Container());
    const inner = group.addChild(new Container());
    const s = inner.addChild(new Sprite());
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);

    group.x = 10;
    packer.pack(stage, frame.next());
    expect(instanceF32(packer, 0)[4]).toBe(10);

    inner.visible = false;
    packer.pack(stage, frame.next());
    expect(ops(frame)).toEqual([]);
    group.x = 30; // moves while inner is hidden
    packer.pack(stage, frame.next());
    inner.visible = true;
    packer.pack(stage, frame.next());
    expect(instanceF32(packer, 0)[4]).toBe(30);
    expect(s.worldTransform[s.worldTransformOffset + 4]).toBe(30);
  });

  it('reorder rewrites moved instances', () => {
    const stage = new Container();
    const a = stage.addChild(new Sprite({ x: 1 }));
    stage.addChild(new Sprite({ x: 2 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    stage.setChildIndex(a, 1);
    packer.pack(stage, frame.next());
    expect(instanceF32(packer, 0)[4]).toBe(2);
    expect(instanceF32(packer, 1)[4]).toBe(1);
  });

  it('CustomDrawables split batches and receive their world transform', () => {
    class Custom extends NodeBase {
      calls: number[] = [];
      get kind(): 'swarm' {
        return 'swarm';
      }
      _emitDraw(f: FrontFrame, world: Float32Array, o: number, alpha: number) {
        this.calls.push(world[o + 4], alpha);
        f.encoder.begin(0x030a, 0, CommandFlag.DRAW);
        f.encoder.end();
      }
    }
    const stage = new Container({ x: 7 });
    stage.addChild(new Sprite());
    const custom = stage.addChild(new Custom({ x: 3, alpha: 0.5 }));
    stage.addChild(new Sprite());
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    expect(ops(frame).slice(-3)).toEqual([
      Op.SPRITE_DRAW,
      0x030a,
      Op.SPRITE_DRAW,
    ]);
    expect(custom.calls).toEqual([10, 0.5]);
  });

  it('shared memory: registers once and uploads by reference', () => {
    const stage = new Container();
    const s = stage.addChild(new Sprite());
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    frame.sharedMemory = true;
    packer.pack(stage, frame);
    let cmds = frame.encoder.commands();
    expect(cmds[1].opcode).toBe(Op.SPRITE_UPLOAD_SHARED);
    expect(cmds[1].words).toEqual([packer.bufferId, 0, 1, 100, 0]);
    expect(frame.registered).toEqual([packer.instances.buffer]);
    s.y = 3;
    packer.pack(stage, frame.next());
    cmds = frame.encoder.commands();
    expect(cmds.map(c => c.opcode)).toEqual([
      Op.SPRITE_UPLOAD_SHARED,
      Op.SPRITE_DRAW,
    ]);
    expect(frame.registered.length).toBe(1);
  });

  it('growth and generation bumps re-allocate and fully upload', () => {
    const stage = new Container();
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    stage.addChild(new Sprite());
    packer.pack(stage, frame);
    for (let i = 0; i < 1500; i++) stage.addChild(new Sprite());
    packer.pack(stage, frame.next());
    let cmds = frame.encoder.commands();
    expect(cmds[0].words).toEqual([packer.bufferId, 2048]);
    expect(cmds[1].words.slice(0, 3)).toEqual([packer.bufferId, 0, 1501]);

    packer.pack(stage, frame.next());
    frame.generation++;
    packer.pack(stage, frame.next());
    cmds = frame.encoder.commands();
    expect(cmds[0].opcode).toBe(Op.SPRITE_BUFFER_ALLOC);
    expect(cmds[1].words.slice(0, 3)).toEqual([packer.bufferId, 0, 1501]);
  });

  it('texture destroy emits TEXTURE_DESTROY once and draws white', () => {
    const tex = Texture.fromPixels(4, 4, white4());
    const stage = new Container();
    stage.addChild(new Sprite(tex));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    const id = tex.sourceId;
    tex.destroy();
    packer.pack(stage, frame.next());
    const cmds = frame.encoder.commands();
    expect(cmds[0].opcode).toBe(Op.TEXTURE_DESTROY);
    expect(cmds[0].words[0]).toBe(id);
    expect(cmds[cmds.length - 1].words[3]).toBe(NO_ID);
    packer.pack(stage, frame.next());
    expect(ops(frame)).toEqual([Op.SPRITE_DRAW]);
  });

  it('tree ops maintain parents and destroy frees slots', () => {
    const a = new Container();
    const b = new Container();
    const s = new Sprite();
    a.addChild(s);
    b.addChild(s);
    expect(a.children.length).toBe(0);
    expect(s.parent).toBe(b);
    expect(() => s.parent && b.addChild(b)).toThrow();
    const live = nodeStore.live;
    b.destroy();
    expect(s.destroyed).toBe(true);
    expect(nodeStore.live).toBe(live - 2);
    expect(() => b.addChild(new Sprite())).toThrow();
  });

  it('destroys a container with many children in linear time', () => {
    const c = new Container();
    const kids: Sprite[] = [];
    for (let i = 0; i < 50_000; i++) kids.push(c.addChild(new Sprite()));
    const live = nodeStore.live;
    const t = Date.now();
    c.destroy();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(c.children.length).toBe(0);
    expect(kids[0].destroyed && kids[49_999].destroyed).toBe(true);
    expect(kids[123].parent).toBe(null);
    expect(nodeStore.live).toBe(live - 50_001);
  });

  it('allocates nothing per frame in steady state (typed arrays stay put)', () => {
    const stage = new Container();
    for (let i = 0; i < 100; i++) stage.addChild(new Sprite({ x: i }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    const views = [packer.instances.f32, packer.flatSlot, nodeStore.world];
    for (let f = 0; f < 10; f++) {
      for (const c of stage.children) c.x += 1;
      packer.pack(stage, frame.next());
    }
    expect(packer.instances.f32).toBe(views[0]);
    expect(packer.flatSlot).toBe(views[1]);
    expect(nodeStore.world).toBe(views[2]);
    expect(packer.instances.f32[10 * 99 + 4]).toBe(99 + 10);
  });
});

describe('lazy world translation', () => {
  /** [tx, ty] of a node's stage-space affine. */
  function worldXY(n: Sprite | Container): [number, number] {
    const w = n.worldTransform;
    const o = n.worldTransformOffset;
    return [w[o + 4], w[o + 5]];
  }

  it('worldTransform follows sprites moved through the fast path', () => {
    const stage = new Container();
    const group = stage.addChild(new Container({ x: 100, y: 200 }));
    const a = group.addChild(new Sprite({ x: 1, y: 2 }));
    const b = group.addChild(new Sprite({ x: 3, y: 4 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    expect(worldXY(a)).toEqual([101, 202]);

    // A run of moved siblings: both take the packer's dense fast path.
    a.setPosition(10, 20);
    b.setPosition(30, 40);
    packer.pack(stage, frame.next());
    expect(worldXY(a)).toEqual([110, 220]);
    expect(worldXY(b)).toEqual([130, 240]);
    // Reading twice must be stable, and must not disturb the instances.
    expect(worldXY(a)).toEqual([110, 220]);
    expect(instanceF32(packer, 0)[4]).toBe(110);
    expect(instanceF32(packer, 1)[4]).toBe(130);
  });

  it('keeps the last pack’s world after a later, unpacked move', () => {
    const stage = new Container();
    const s = stage.addChild(new Sprite({ x: 5, y: 6 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    s.setPosition(7, 8);
    packer.pack(stage, frame.next());
    s.setPosition(90, 90); // not packed yet
    expect(worldXY(s)).toEqual([7, 8]);
  });

  it('a fast-path sprite that then rotates gets the full affine', () => {
    const stage = new Container();
    const s = stage.addChild(new Sprite({ x: 2, y: 3 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    s.setPosition(11, 12); // fast path: world translation goes dense
    packer.pack(stage, frame.next());
    s.rotation = Math.PI / 2; // slow path next: needs the full record back
    packer.pack(stage, frame.next());
    const [x, y] = worldXY(s);
    expect(x).toBeCloseTo(11, 5);
    expect(y).toBeCloseTo(12, 5);
  });

  it('moved pivoted sprites keep their pivot offset', () => {
    const stage = new Container();
    const plain = stage.addChild(new Sprite({ x: 1, y: 1 }));
    const pivoted = stage.addChild(new Sprite({ x: 10, y: 20 }));
    pivoted.setPivot(3, 4);
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    expect(worldXY(pivoted)).toEqual([7, 16]);

    plain.setPosition(2, 2);
    pivoted.setPosition(30, 40);
    packer.pack(stage, frame.next());
    expect(worldXY(plain)).toEqual([2, 2]);
    expect(worldXY(pivoted)).toEqual([27, 36]);
    expect(instanceF32(packer, 1)[4]).toBe(27);
  });

  it('updateTransform() agrees with the packer after fast-path moves', () => {
    const stage = new Container();
    const group = stage.addChild(new Container({ x: 7 }));
    const s = group.addChild(new Sprite({ x: 1, y: 1 }));
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    packer.pack(stage, frame);
    s.setPosition(5, 6);
    packer.pack(stage, frame.next());
    expect(worldXY(s)).toEqual([12, 6]);
    group.updateTransform();
    expect(worldXY(s)).toEqual([12, 6]);
    expect(worldXY(group)).toEqual([7, 0]);
  });

  it('a second packer over the same scene sees the same world', () => {
    const stage = new Container();
    const s = stage.addChild(new Sprite({ x: 1, y: 1 }));
    const a = new SpriteScenePacker();
    const b = new SpriteScenePacker();
    const frame = new FakeFrame();
    a.pack(stage, frame);
    b.pack(stage, frame.next());
    s.setPosition(40, 50);
    a.pack(stage, frame.next());
    b.pack(stage, frame.next());
    expect(worldXY(s)).toEqual([40, 50]);
  });
});
