/**
 * SpriteLayer front, stale-state review: what the core must be told after a
 * capacity change, a device loss or a texture swap, so it never draws from
 * streams, registrations or texture ids of an earlier state.
 */
import { LayerOp } from '../commands/layerOpcodes';
import { Op } from '../commands/opcodes';
import type { TextureHandle } from '../scene/types';
import { LayerStream } from '../types/layerLayouts';
import { TestFrame, type Recorded } from './fakes.testutil';
import * as front from './front';
import { emitLayer } from './front';
import { SpriteLayer } from './SpriteLayer';

function handle(sourceId: number, w = 16, h = 16): TextureHandle {
  return {
    sourceId,
    sourceWidth: 64,
    sourceHeight: 64,
    frame: { x: 0, y: 0, width: w, height: h },
    width: w,
    height: h,
    sub: () => {
      throw new Error('unused');
    },
    destroy() {},
    destroyed: false,
  };
}

const WORLD = new Float32Array([1, 0, 0, 1, 0, 0]);

function make(capacity = 16): SpriteLayer {
  const layer = new SpriteLayer({ capacity, frames: [handle(7)] });
  layer._front = front;
  return layer;
}

function emit(layer: SpriteLayer, frame: TestFrame): Recorded[] {
  frame.begin();
  emitLayer(layer, frame, WORLD, 0, 1);
  return frame.end();
}

const only = (r: Recorded[], op: number) => r.filter(c => c.opcode === op);
const uploads = (r: Recorded[]) =>
  r
    .filter(
      c =>
        c.opcode === LayerOp.LAYER_UPLOAD ||
        c.opcode === LayerOp.LAYER_UPLOAD_SHARED,
    )
    .map(c => c.words.slice(1, 4));

describe('SpriteLayer front: stale state', () => {
  it('a capacity change re-creates the streams and re-uploads every written row', () => {
    const layer = make(16);
    layer.count = 4;
    for (let i = 0; i < 4; i++) layer.setInstance(i, i, i);
    const frame = new TestFrame();
    emit(layer, frame);
    layer.capacity = 64;
    const out = emit(layer, frame);
    expect(only(out, LayerOp.LAYER_CREATE)[0].words[1]).toBe(64);
    expect(uploads(out)).toEqual([
      [LayerStream.POSITION, 0, 4],
      [LayerStream.XFORM, 0, 4],
      [LayerStream.COLOR, 0, 4],
    ]);
  });

  it('a capacity change in shared memory registers the new stores', () => {
    const layer = make(16);
    layer.count = 2;
    layer.setInstance(0, 1, 1);
    layer.setInstance(1, 2, 2);
    const frame = new TestFrame();
    frame.sharedMemory = true;
    emit(layer, frame);
    const before = layer.data.position.buffer;
    layer.capacity = 32;
    const out = emit(layer, frame);
    const pos = only(out, LayerOp.LAYER_UPLOAD_SHARED).find(
      c => c.words[1] === LayerStream.POSITION,
    )!;
    expect(frame.shared[pos.words[4] - 1]).toBe(layer.data.position.buffer);
    expect(frame.shared[pos.words[4] - 1]).not.toBe(before);
  });

  it('dirty rows past a shrunk capacity are never uploaded', () => {
    const layer = make(64);
    const frame = new TestFrame();
    emit(layer, frame);
    layer.markDirty(40, 20);
    layer.capacity = 32;
    layer.markDirty(0, 2);
    const out = emit(layer, frame);
    for (const [, first, count] of uploads(out)) {
      expect(first + count).toBeLessThanOrEqual(32);
    }
  });

  it('a device loss re-uploads direct column rows from the caller memory', () => {
    const layer = make(16);
    const xy = new Float32Array(32).map((_, i) => i);
    const binding = layer.bindColumns({ xy });
    binding.commit(5);
    const frame = new TestFrame();
    emit(layer, frame);
    expect(only(emit(layer, frame), LayerOp.LAYER_UPLOAD)).toEqual([]);
    frame.generation++;
    const out = emit(layer, frame);
    const pos = only(out, LayerOp.LAYER_UPLOAD).filter(
      c => c.words[1] === LayerStream.POSITION,
    );
    expect(pos.map(c => c.words.slice(1, 4))).toEqual([
      [LayerStream.POSITION, 0, 5],
    ]);
    expect(Array.from(new Float32Array(pos[0].bytes.buffer, 16, 10))).toEqual(
      Array.from(xy.subarray(0, 10)),
    );
  });

  it('a new frame table re-sends frames and the texture slot table', () => {
    const layer = make(4);
    layer.count = 1;
    layer.setInstance(0, 0, 0);
    const frame = new TestFrame();
    emit(layer, frame);
    layer.frames = [handle(9, 8, 8)];
    const out = emit(layer, frame);
    expect(only(out, LayerOp.LAYER_SET_FRAMES).length).toBe(1);
    const tex = only(out, LayerOp.LAYER_SET_TEXTURES);
    expect(tex.length).toBe(1);
    expect(tex[0].words.slice(1)).toEqual([1, 9]);
  });

  it('a slot texture whose id changes re-sends only the slot table', () => {
    const layer = make(4);
    layer.count = 1;
    layer.setInstance(0, 0, 0);
    const h = handle(7) as { sourceId: number };
    layer.frames = [h as unknown as TextureHandle];
    const frame = new TestFrame();
    emit(layer, frame);
    h.sourceId = 11;
    const out = emit(layer, frame);
    expect(only(out, LayerOp.LAYER_SET_FRAMES)).toEqual([]);
    expect(only(out, LayerOp.LAYER_SET_TEXTURES)[0].words.slice(1)).toEqual([
      1, 11,
    ]);
  });

  it('a destroyed layer frees its core state on the next frame', () => {
    const layer = make(4);
    layer.count = 1;
    layer.setInstance(0, 0, 0);
    const frame = new TestFrame();
    emit(layer, frame);
    const id = layer.id;
    layer.destroy();
    frame.begin();
    const out = frame.end();
    expect(only(out, LayerOp.LAYER_DESTROY).map(c => c.words[0])).toEqual([id]);
  });
});

describe('SpriteLayer front: shared registrations', () => {
  const releases = (r: Recorded[]) =>
    r.filter(c => c.opcode === Op.SHARED_RELEASE).map(c => c.words[0]);

  function sharedFrame(): TestFrame {
    const frame = new TestFrame();
    frame.sharedMemory = true;
    return frame;
  }

  it('a capacity change releases the replaced stores', () => {
    const layer = make(16);
    layer.count = 2;
    layer.setInstance(0, 1, 1);
    layer.setInstance(1, 2, 2);
    const frame = sharedFrame();
    emit(layer, frame);
    const old = [
      layer.data.position.buffer,
      layer.data.xform.buffer,
      layer.data.color.buffer,
    ];
    const oldIds = old.map(b => frame.shared.indexOf(b) + 1);
    layer.capacity = 32;
    const out = emit(layer, frame);
    expect(releases(out).sort()).toEqual(oldIds.sort());
    expect(frame.released).toEqual(expect.arrayContaining(old));
    // Released before the new stores are used.
    const first = out.findIndex(c => c.opcode === Op.SHARED_RELEASE);
    const upload = out.findIndex(c => c.opcode === LayerOp.LAYER_UPLOAD_SHARED);
    expect(first).toBeLessThan(upload);
  });

  it('rebinding a column releases the old one; a destroyed layer releases all', () => {
    const layer = make(8);
    const a = new Float32Array(16);
    const frame = sharedFrame();
    layer.bindColumns({ xy: a }).commit(4);
    emit(layer, frame);
    const b = new Float32Array(16);
    layer.bindColumns({ xy: b }).commit(4);
    emit(layer, frame);
    expect(frame.released).toEqual([a.buffer]);
    const color = layer.data.color.buffer;
    layer.destroy();
    frame.begin();
    const out = frame.end();
    expect(frame.released).toContain(b.buffer);
    expect(frame.released).toContain(color);
    expect(frame.shared.filter(x => x.byteLength > 0)).toEqual([]);
    // SHARED_RELEASE first, then LAYER_DESTROY.
    expect(out.map(c => c.opcode).pop()).toBe(LayerOp.LAYER_DESTROY);
  });

  it('a column shared by two layers stays registered until both let go', () => {
    const xy = new Float32Array(32);
    const frame = sharedFrame();
    const one = make(8);
    const two = make(8);
    one.bindColumns({ xy: xy.subarray(0, 16) }).commit(4);
    two.bindColumns({ xy: xy.subarray(16) }).commit(4);
    frame.begin();
    emitLayer(one, frame, WORLD, 0, 1);
    emitLayer(two, frame, WORLD, 0, 1);
    frame.end();
    one.destroy();
    frame.begin();
    emitLayer(two, frame, WORLD, 0, 1);
    frame.end();
    expect(frame.released).not.toContain(xy.buffer);
    two.destroy();
    frame.begin();
    frame.end();
    expect(frame.released).toContain(xy.buffer);
  });

  it('a released column bound again registers again', () => {
    const layer = make(8);
    const a = new Float32Array(16);
    const frame = sharedFrame();
    layer.bindColumns({ xy: a }).commit(2);
    emit(layer, frame);
    layer.bindColumns({ xy: new Float32Array(16) }).commit(2);
    emit(layer, frame);
    layer.bindColumns({ xy: a }).commit(2);
    const out = emit(layer, frame);
    const pos = only(out, LayerOp.LAYER_UPLOAD_SHARED).find(
      c => c.words[1] === LayerStream.POSITION,
    )!;
    expect(frame.shared[pos.words[4] - 1]).toBe(a.buffer);
  });
});

describe('SpriteLayer front: device limits', () => {
  it('a layer over the buffer binding limit reports OUT_OF_CAPACITY once and draws nothing', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const layer = make(1024);
    layer.count = 4;
    for (let i = 0; i < 4; i++) layer.setInstance(i, i, i);
    const frame = new TestFrame();
    frame.caps = { ...frame.caps, maxStorageBufferBindingSize: 4096 };
    const out = [...emit(layer, frame), ...emit(layer, frame)];
    expect(only(out, LayerOp.LAYER_CREATE)).toEqual([]);
    expect(only(out, LayerOp.LAYER_DRAW)).toEqual([]);
    expect(frame.errors.map(e => e.code)).toEqual(['OUT_OF_CAPACITY']);
    expect(error).toHaveBeenCalledTimes(1);
    // Back under the limit: created and drawn with the rows kept.
    layer.capacity = 512;
    const back = emit(layer, frame);
    expect(only(back, LayerOp.LAYER_CREATE).length).toBe(1);
    expect(only(back, LayerOp.LAYER_DRAW).length).toBe(1);
    error.mockRestore();
  });

  it('setSourceCount without a source does nothing', () => {
    const layer = make(4);
    expect(() => layer.setSourceCount(3)).not.toThrow();
  });
});
