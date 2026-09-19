/**
 * Tester: texture id lifecycle across destroy / flush / reuse.
 */
import { Op } from '../commands/opcodes';
import { FakeFrame } from '../sprites/fakes.testutil';
import { SpriteScenePacker } from '../sprites/front';
import { NO_ID } from '../types/ids';
import { Container } from './Container';
import { Sprite } from './Sprite';
import {
  dropTextureUploads,
  ensureTextureUploaded,
  flushTextureDestroys,
  Texture,
} from './Texture';

const px = () => new Uint8Array(4 * 4 * 4).fill(255);

describe('texture lifecycle', () => {
  it('uploads once per (renderer, generation) and destroys once per renderer', () => {
    const t = Texture.fromPixels(4, 4, px());
    const f1 = new FakeFrame();
    const f2 = new FakeFrame();
    f2.rendererId = 2;
    const ops = (f: FakeFrame) => f.encoder.commands().map(c => c.opcode);
    expect(ensureTextureUploaded(f1.next(), t)).toBe(t.sourceId);
    expect(ensureTextureUploaded(f1, t)).toBe(t.sourceId);
    expect(ops(f1)).toEqual([Op.TEXTURE_CREATE, Op.TEXTURE_UPLOAD_PIXELS]);
    ensureTextureUploaded(f2.next(), t);
    expect(ops(f2)).toEqual([Op.TEXTURE_CREATE, Op.TEXTURE_UPLOAD_PIXELS]);
    f1.next();
    ensureTextureUploaded(f1, t); // renderer 1 again after renderer 2 used it
    expect(ops(f1)).toEqual([]);
    f1.generation = 1;
    ensureTextureUploaded(f1, t);
    expect(ops(f1)).toEqual([Op.TEXTURE_CREATE, Op.TEXTURE_UPLOAD_PIXELS]);

    // pixel payload: header + w*h*4 bytes, premultiplied
    const upload = f1.encoder.commands()[1];
    expect(upload.words.slice(0, 5)).toEqual([t.sourceId, 0, 0, 4, 4]);
    expect(upload.payloadBytes).toBe(20 + 64);

    t.destroy();
    expect(ensureTextureUploaded(f1.next(), t)).toBe(NO_ID);
    flushTextureDestroys(f1);
    flushTextureDestroys(f1); // once only
    expect(ops(f1)).toEqual([Op.TEXTURE_DESTROY]);
    flushTextureDestroys(f2.next());
    expect(ops(f2)).toEqual([Op.TEXTURE_DESTROY]);
  });

  // Regression (M1 low bug): a texture uploaded to a renderer that was later
  // destroyed was never released (the dead renderer never flushes) and its id
  // was never freed. Renderer.destroy() now calls dropTextureUploads().
  it('destroying a texture frees its id even if a renderer that used it is gone', () => {
    const t = Texture.fromPixels(4, 4, px());
    const live = new FakeFrame();
    const dead = new FakeFrame();
    dead.rendererId = 999;
    ensureTextureUploaded(live.next(), t);
    ensureTextureUploaded(dead.next(), t);
    const id = t.sourceId;
    t.destroy();
    dropTextureUploads(999); // renderer 999 destroyed after the texture
    flushTextureDestroys(live.next());
    expect(live.encoder.commands().map(c => c.opcode)).toEqual([
      Op.TEXTURE_DESTROY,
    ]);
    const next = Texture.fromPixels(4, 4, px());
    expect(next.sourceId).toBe(id); // freed id is reused (LIFO free list)
    next.destroy();
  });

  it('a texture destroyed after its only renderer is gone frees its id at once', () => {
    const t = Texture.fromPixels(4, 4, px());
    const dead = new FakeFrame();
    dead.rendererId = 998;
    ensureTextureUploaded(dead.next(), t);
    dropTextureUploads(998);
    const id = t.sourceId;
    t.destroy();
    const next = Texture.fromPixels(4, 4, px());
    expect(next.sourceId).toBe(id);
    next.destroy();
  });

  it('dropping a renderer that is the last holder frees pending ids', () => {
    const t = Texture.fromPixels(4, 4, px());
    const dead = new FakeFrame();
    dead.rendererId = 997;
    ensureTextureUploaded(dead.next(), t);
    const id = t.sourceId;
    t.destroy(); // pending: 997 still holds it
    const other = Texture.fromPixels(1, 1, px());
    expect(other.sourceId).not.toBe(id);
    dropTextureUploads(997);
    const next = Texture.fromPixels(4, 4, px());
    expect(next.sourceId).toBe(id);
    next.destroy();
    other.destroy();
  });

  // Regression: once a destroyed texture's id is freed and reused by a new
  // texture, sprites still holding the destroyed handle must not batch with
  // sprites of the new texture (the batch key compares sources, not ids).
  it('sprites of a destroyed texture never draw with a texture that reused its id', () => {
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    const stage = new Container();
    const old = Texture.fromPixels(4, 4, px());
    const stale = new Sprite(old);
    packer.pack(stage, frame.next());
    old.destroy();
    flushTextureDestroys(frame.next()); // frees the id (never uploaded here)
    const fresh = Texture.fromPixels(4, 4, px());
    expect(fresh.sourceId).toBe(old.sourceId); // id reused
    stage.addChild(new Sprite(fresh));
    stage.addChild(stale);
    packer.pack(stage, frame.next());
    const draws = frame.encoder
      .commands()
      .filter(c => c.opcode === Op.SPRITE_DRAW)
      .map(c => ({ first: c.words[1], count: c.words[2], tex: c.words[3] }));
    packer.destroy();
    stage.destroy({ children: true });
    expect(draws).toEqual([
      { first: 0, count: 1, tex: fresh.sourceId },
      { first: 1, count: 1, tex: NO_ID },
    ]);
  });
  it('a stale sprite before a sprite of the reusing texture gets its own batch', () => {
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    const stage = new Container();
    const old = Texture.fromPixels(4, 4, px());
    const stale = stage.addChild(new Sprite(old));
    old.destroy(); // never uploaded: the id is freed at once
    const fresh = Texture.fromPixels(4, 4, px());
    expect(fresh.sourceId).toBe(old.sourceId);
    stage.addChild(new Sprite(fresh));
    stage.addChild(new Sprite(fresh.sub(0, 0, 2, 2))); // frames of one source batch
    packer.pack(stage, frame.next());
    const draws = frame.encoder
      .commands()
      .filter(c => c.opcode === Op.SPRITE_DRAW)
      .map(c => ({ first: c.words[1], count: c.words[2], tex: c.words[3] }));
    expect(draws).toEqual([
      { first: 0, count: 1, tex: NO_ID },
      { first: 1, count: 2, tex: fresh.sourceId },
    ]);
    expect(stale.texture).toBe(old);
    packer.destroy();
    stage.destroy({ children: true });
  });

  it('assigning a texture that reused a destroyed id rebuilds the batches', () => {
    const packer = new SpriteScenePacker();
    const frame = new FakeFrame();
    const stage = new Container();
    const old = Texture.fromPixels(4, 4, px());
    const sprite = stage.addChild(new Sprite(old));
    old.destroy();
    const fresh = Texture.fromPixels(4, 4, px());
    expect(fresh.sourceId).toBe(old.sourceId);
    packer.pack(stage, frame.next());
    sprite.texture = fresh; // same id, different source
    packer.pack(stage, frame.next());
    const draw = frame.encoder
      .commands()
      .find(c => c.opcode === Op.SPRITE_DRAW)!;
    expect(draw.words[3]).toBe(fresh.sourceId);
    packer.destroy();
    stage.destroy({ children: true });
  });
});
