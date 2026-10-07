/**
 * SpriteLayer front (ARCHITECTURE §28.4): stream byte layouts against
 * layerLayouts.ts, packing of columns, dirty ranges and commits, and the
 * commands each frame emits.
 */
import { CommandFlag } from '../commands/opcodes';
import {
  LAYER_CREATE_BYTES,
  LAYER_DRAW_BYTES,
  LayerDrawFlag,
  LayerFlag,
  LayerOp,
} from '../commands/layerOpcodes';
import type { TextureHandle } from '../scene/types';
import {
  LAYER_COLOR_BYTES,
  LAYER_FRAME_BYTES,
  LAYER_POSITION_BYTES,
  LAYER_ROTATION_UNITS,
  LAYER_XFORM_BYTES,
  LF_ANCHOR,
  LF_HEIGHT,
  LF_SLOT,
  LF_U0,
  LF_U1,
  LF_V1,
  LF_WIDTH,
  LP_X,
  LP_Y,
  LX_FRAME,
  LX_ROTATION,
  LX_SCALE_X,
  LX_SCALE_Y,
  LayerStream,
  LayerStreamBit,
} from '../types/layerLayouts';
import type { ExternalInstanceBuffer, ExternalLayout } from '../types/interop';
import { TestFrame, type Recorded } from './fakes.testutil';
import { emitLayer, releaseLayer } from './front';
import * as front from './front';
import { SpriteLayer, toHalf } from './SpriteLayer';

/** Reference decoder for IEEE half floats. */
function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function handle(
  sourceId: number,
  x: number,
  y: number,
  width: number,
  height: number,
  sourceWidth = 256,
  sourceHeight = 128,
): TextureHandle {
  return {
    sourceId,
    sourceWidth,
    sourceHeight,
    frame: { x, y, width, height },
    width,
    height,
    sub: () => {
      throw new Error('unused');
    },
    destroy() {},
    destroyed: false,
  };
}

const WORLD = new Float32Array([1, 0, 0, 1, 10, 20]);

function make(
  options: Partial<ConstructorParameters<typeof SpriteLayer>[0]> = {},
): SpriteLayer {
  const layer = new SpriteLayer({
    capacity: 16,
    frames: [handle(7, 0, 0, 16, 16), handle(7, 16, 0, 32, 16)],
    ...options,
  });
  // The tests drive the front directly instead of waiting for the chunk.
  layer._front = front;
  return layer;
}

function emit(layer: SpriteLayer, frame: TestFrame): Recorded[] {
  frame.begin();
  emitLayer(layer, frame, WORLD, 0, 0.5);
  return frame.end();
}

const ops = (r: Recorded[]) => r.map(c => c.opcode);
const uploads = (r: Recorded[]) =>
  r
    .filter(
      c =>
        c.opcode === LayerOp.LAYER_UPLOAD ||
        c.opcode === LayerOp.LAYER_UPLOAD_SHARED,
    )
    .map(c => c.words.slice(0, 4));

describe('half floats', () => {
  it('round-trips representable values and rounds the rest', () => {
    for (const v of [0, 1, -1, 0.5, 2, 1.5, 65504, -0.25, 1e-5, 3.14159]) {
      const h = toHalf(v);
      expect(h).toBeLessThan(0x10000);
      expect(Math.abs(fromHalf(h) - v)).toBeLessThanOrEqual(
        Math.abs(v) * 2 ** -11 + 2 ** -24,
      );
    }
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(1e9)).toBe(0x7c00);
    expect(toHalf(1e-9)).toBe(0);
  });
});

describe('stream layouts', () => {
  it('setInstance writes the records of layerLayouts.ts', () => {
    const layer = make({ streams: { user: true } });
    layer.setInstance(3, 12.5, -4, Math.PI / 2, 2, 1, 0x80402010);
    const d = layer.data;
    const pos = new DataView(d.position.buffer);
    expect(pos.getFloat32(3 * LAYER_POSITION_BYTES + LP_X, true)).toBe(12.5);
    expect(pos.getFloat32(3 * LAYER_POSITION_BYTES + LP_Y, true)).toBe(-4);
    const xf = new DataView(d.xform.buffer);
    const at = 3 * LAYER_XFORM_BYTES;
    expect(fromHalf(xf.getUint16(at + LX_SCALE_X, true))).toBe(2);
    expect(fromHalf(xf.getUint16(at + LX_SCALE_Y, true))).toBe(2);
    expect(xf.getUint16(at + LX_ROTATION, true)).toBe(LAYER_ROTATION_UNITS / 4);
    expect(xf.getUint16(at + LX_FRAME, true)).toBe(1);
    const col = new DataView(d.color.buffer);
    expect(col.getUint32(3 * LAYER_COLOR_BYTES, true)).toBe(0x80402010);
    expect(d.user.length).toBe(16);
  });

  it('defaults new rows to scale 1, rotation 0, frame 0 and opaque white', () => {
    const layer = make();
    const xf = new DataView(layer.data.xform.buffer);
    expect(xf.getUint16(5 * 8 + LX_SCALE_X, true)).toBe(0x3c00);
    expect(xf.getUint16(5 * 8 + LX_SCALE_Y, true)).toBe(0x3c00);
    expect(xf.getUint32(5 * 8 + LX_ROTATION, true)).toBe(0);
    expect(layer.data.color[5]).toBe(0xffffffff);
    expect(layer.data.user.length).toBe(0);
  });

  it('keeps rows when the capacity grows', () => {
    const layer = make();
    layer.setInstance(2, 5, 6);
    layer.capacity = 64;
    expect(layer.data.position[4]).toBe(5);
    expect(layer.data.position.length).toBe(128);
    expect(layer.data.color[40]).toBe(0xffffffff);
  });

  it('packs columns into the same bytes as setInstance', () => {
    const a = make();
    const b = make();
    a.setInstance(1, 3, 4, -0.5, 1.5, 1, 0x7f336699);
    const binding = b.bindColumns({
      x: new Float32Array([0, 3]),
      y: new Float32Array([0, 4]),
      rotation: new Float32Array([0, -0.5]),
      scale: new Float32Array([1, 1.5]),
      frame: new Uint32Array([0, 1]),
      tint: new Uint32Array([0, 0x996633]),
      alpha: new Float32Array([1, 0x7f / 255]),
    });
    expect(binding.streams).toBe(
      LayerStreamBit.POSITION | LayerStreamBit.XFORM | LayerStreamBit.COLOR,
    );
    binding.commit(1, 1);
    // commit only records the rows: nothing is converted yet.
    expect(b.data.position[2]).toBe(0);
    emit(b, new TestFrame());
    expect(Array.from(b.data.position.subarray(2, 4))).toEqual([3, 4]);
    expect(Array.from(b.data.xform.subarray(4, 8))).toEqual(
      Array.from(a.data.xform.subarray(4, 8)),
    );
    expect(b.data.color[1]).toBe(a.data.color[1]);
  });

  it('reads strided column sources', () => {
    const layer = make();
    const xy = new Float32Array([0, 0, 0, 0, 7, 8, 0, 0]);
    const binding = layer.bindColumns({
      x: { array: xy, offset: 0, stride: 2 },
      y: { array: xy, offset: 1, stride: 2 },
      scaleX: { array: new Float32Array([9, 9, 2, 9]), offset: 1 },
    });
    binding.commit(2, 1);
    emit(layer, new TestFrame());
    expect(layer.data.position[4]).toBe(7);
    expect(layer.data.position[5]).toBe(8);
    expect(fromHalf(layer.data.xform[4])).toBe(2);
    expect(layer.data.xform[5]).toBe(0x3c00);
  });
});

describe('frames', () => {
  it('sends uv rect, size, anchor and slot per frame', () => {
    const layer = make({
      frames: [handle(7, 0, 0, 16, 16), handle(9, 32, 64, 16, 32, 64, 128)],
      anchorX: 0,
      anchorY: 1,
      count: 1,
    });
    const out = emit(layer, new TestFrame());
    const frames = out.find(c => c.opcode === LayerOp.LAYER_SET_FRAMES)!;
    expect(frames.words[1]).toBe(2);
    const f = new DataView(frames.bytes.buffer, 8 + LAYER_FRAME_BYTES);
    expect(f.getFloat32(LF_U0, true)).toBe(0.5);
    expect(f.getFloat32(LF_U1, true)).toBe(0.75);
    expect(f.getFloat32(LF_V1, true)).toBe(0.75);
    expect(f.getFloat32(LF_WIDTH, true)).toBe(16);
    expect(f.getFloat32(LF_HEIGHT, true)).toBe(32);
    expect(f.getUint32(LF_ANCHOR, true)).toBe(0xffff0000);
    expect(f.getUint32(LF_SLOT, true)).toBe(1);
    const tex = out.find(c => c.opcode === LayerOp.LAYER_SET_TEXTURES)!;
    expect(tex.words).toEqual([layer.id, 2, 7, 9]);
  });

  it('rejects more than 8 texture sources', () => {
    const frames = Array.from({ length: 9 }, (_, i) =>
      handle(i + 1, 0, 0, 1, 1),
    );
    expect(() => make({ frames })).toThrow(/INVALID_ARGUMENT/);
    expect(() => make({ frames: [] })).toThrow(/INVALID_ARGUMENT/);
  });
});

describe('frame commands', () => {
  it('creates once, then sends only the draw for a static layer', () => {
    const layer = make({ count: 4 });
    for (let i = 0; i < 4; i++) layer.setInstance(i, i, i);
    const frame = new TestFrame();
    const first = emit(layer, frame);
    expect(ops(first)).toEqual([
      LayerOp.LAYER_CREATE,
      LayerOp.LAYER_SET_FRAMES,
      LayerOp.LAYER_SET_TEXTURES,
      LayerOp.LAYER_UPLOAD,
      LayerOp.LAYER_UPLOAD,
      LayerOp.LAYER_UPLOAD,
      LayerOp.LAYER_DRAW,
    ]);
    const create = first[0];
    expect(create.words).toEqual([
      layer.id,
      16,
      LayerStreamBit.POSITION | LayerStreamBit.XFORM | LayerStreamBit.COLOR,
      LayerFlag.CULL * 0,
      0,
    ]);
    expect(create.words.length * 4).toBe(LAYER_CREATE_BYTES);
    // Full upload of the written rows, per stream.
    expect(uploads(first)).toEqual([
      [layer.id, LayerStream.POSITION, 0, 4],
      [layer.id, LayerStream.XFORM, 0, 4],
      [layer.id, LayerStream.COLOR, 0, 4],
    ]);
    const second = emit(layer, frame);
    expect(ops(second)).toEqual([LayerOp.LAYER_DRAW]);
    const draw = second[0];
    expect(draw.flags & CommandFlag.DRAW).toBeTruthy();
    expect(draw.words.length * 4).toBe(LAYER_DRAW_BYTES);
    expect(draw.floats.slice(1, 8)).toEqual([1, 0, 0, 1, 10, 20, 0.5]);
    expect(draw.words.slice(8)).toEqual([4, 0, 0]);
    // Packet stays tiny: header + one 44-byte command.
    expect(frame.encoder.byteLength).toBeLessThan(1024);
  });

  it('uploads only the dirty rows of the dirty streams', () => {
    const layer = make({ count: 16 });
    const frame = new TestFrame();
    emit(layer, frame);
    layer.data.position[2 * 9] = 1;
    layer.markDirty(9, 1, LayerStreamBit.POSITION);
    layer.markDirty(2, 2, LayerStreamBit.COLOR);
    layer.markDirty(13, 1, LayerStreamBit.COLOR);
    const out = emit(layer, frame);
    expect(uploads(out)).toEqual([
      [layer.id, LayerStream.POSITION, 9, 1],
      [layer.id, LayerStream.COLOR, 2, 12],
    ]);
    const up = out.find(c => c.opcode === LayerOp.LAYER_UPLOAD)!;
    expect(new Float32Array(up.bytes.buffer, 16, 2)[0]).toBe(1);
  });

  it('a positions-only commit uploads positions only, zero-copy when shared', () => {
    const layer = make({ count: 0 });
    const xy = new Float32Array(64);
    const binding = layer.bindColumns({ xy: xy.subarray(8) });
    const frame = new TestFrame();
    frame.sharedMemory = true;
    emit(layer, frame);
    binding.commit(10);
    expect(layer.count).toBe(10);
    const out = emit(layer, frame);
    const shared = out.filter(c => c.opcode === LayerOp.LAYER_UPLOAD_SHARED);
    expect(shared.map(c => c.words)).toEqual([
      [layer.id, LayerStream.POSITION, 0, 10, 1, 32],
    ]);
    expect(frame.shared[0]).toBe(xy.buffer);
    expect(ops(out)).not.toContain(LayerOp.LAYER_UPLOAD);
  });

  it('copies inline in worker mode without shared memory', () => {
    const layer = make();
    const binding = layer.bindColumns({ xy: new Float32Array([1, 2, 3, 4]) });
    binding.commit(2);
    const out = emit(layer, new TestFrame());
    const up = out.filter(c => c.opcode === LayerOp.LAYER_UPLOAD);
    const pos = up.find(c => c.words[1] === LayerStream.POSITION)!;
    expect(pos.words.slice(0, 4)).toEqual([layer.id, 0, 0, 2]);
    expect(Array.from(new Float32Array(pos.bytes.buffer, 16, 4))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('never zero-copies a plain ArrayBuffer to a worker', () => {
    const layer = make();
    const binding = layer.bindColumns({ xy: new Float32Array(4) });
    const frame = new TestFrame();
    frame.sharedMemory = true;
    frame.useSharedArrayBuffer = true;
    binding.commit(2);
    const out = emit(layer, frame);
    expect(ops(out)).not.toContain(LayerOp.LAYER_UPLOAD_SHARED);
  });

  it('re-creates and re-uploads every written row on a new generation', () => {
    const layer = make({ count: 3 });
    for (let i = 0; i < 3; i++) layer.setInstance(i, i, i);
    const frame = new TestFrame();
    emit(layer, frame);
    expect(ops(emit(layer, frame))).toEqual([LayerOp.LAYER_DRAW]);
    frame.generation++;
    const out = emit(layer, frame);
    expect(out[0].opcode).toBe(LayerOp.LAYER_CREATE);
    expect(uploads(out)).toEqual([
      [layer.id, 0, 0, 3],
      [layer.id, 1, 0, 3],
      [layer.id, 2, 0, 3],
    ]);
  });

  it('keeps the streams on blend or cull changes', () => {
    const layer = make({ count: 1 });
    layer.setInstance(0, 1, 1);
    const frame = new TestFrame();
    emit(layer, frame);
    layer.blendMode = 'add';
    layer.cull = true;
    const out = emit(layer, frame);
    expect(ops(out)).toEqual([
      LayerOp.LAYER_CREATE,
      LayerOp.LAYER_CULL,
      LayerOp.LAYER_DRAW,
    ]);
    expect(out[0].words.slice(3)).toEqual([LayerFlag.CULL, 1]);
    expect(out[1].flags & CommandFlag.COMPUTE).toBeTruthy();
    expect(out[2].words[10]).toBe(LayerDrawFlag.CULLED);
  });

  it('does not cull without compute', () => {
    const layer = make({ count: 1, cull: true });
    const frame = new TestFrame();
    frame.caps = { ...frame.caps, compute: false, indirectDraw: false };
    const out = emit(layer, frame);
    expect(out[0].words[3]).toBe(0);
    expect(ops(out)).not.toContain(LayerOp.LAYER_CULL);
  });

  it('waits for the core system', () => {
    const layer = make({ count: 1 });
    const frame = new TestFrame();
    frame.ready = false;
    expect(emit(layer, frame)).toEqual([]);
  });

  it('sends the pick id when pickable', () => {
    const layer = make({ count: 1, pickable: true });
    const draw = emit(layer, new TestFrame()).pop()!;
    expect(draw.words[9]).toBe(layer.id);
  });

  it('destroys on the renderer it was created on', () => {
    const layer = make({ count: 1 });
    const frame = new TestFrame();
    emit(layer, frame);
    const id = layer.id;
    layer.destroy();
    frame.begin();
    const out = frame.end();
    expect(out.map(c => [c.opcode, c.words[0]])).toEqual([
      [LayerOp.LAYER_DESTROY, id],
    ]);
    releaseLayer(layer);
    frame.begin();
    expect(frame.end()).toEqual([]);
  });

  it('does not queue a layer destroyed after its renderer', () => {
    const layer = make({ count: 1 });
    const a = new TestFrame();
    emit(layer, a);
    const id = layer.id;
    for (const h of a.hooks.slice()) h.onRendererDestroyed?.();
    layer.destroy();
    // Same renderer id seen again: nothing of the old layer was kept.
    const b = new TestFrame();
    b.rendererId = a.rendererId;
    const other = make({ count: 1 });
    const out = emit(other, b);
    expect(
      out.filter(c => c.opcode === LayerOp.LAYER_DESTROY).map(c => c.words[0]),
    ).not.toContain(id);
  });

  it('frees the old renderer when moved', () => {
    const layer = make({ count: 1 });
    const a = new TestFrame();
    const b = new TestFrame();
    emit(layer, a);
    expect(emit(layer, b)[0].opcode).toBe(LayerOp.LAYER_CREATE);
    a.begin();
    expect(a.end().map(c => c.opcode)).toEqual([LayerOp.LAYER_DESTROY]);
  });
});

describe('external sources', () => {
  function ext(layout: ExternalLayout, id: number, capacity = 100) {
    return {
      id,
      layout,
      capacity,
      valid: true,
      release() {},
    } as ExternalInstanceBuffer;
  }

  it('sends the source and draws the smallest capacity', () => {
    const layer = make({ count: 0 });
    layer.setSource({
      position: ext('layer-position', 41, 50),
      color: ext('layer-color', 42),
    });
    const out = emit(layer, new TestFrame());
    const src = out.find(c => c.opcode === LayerOp.LAYER_SET_SOURCE)!;
    expect(src.words).toEqual([layer.id, 41, 0, 42, 0, 0]);
    // XFORM still comes from the own store (capacity 16).
    expect(out.pop()!.words[8]).toBe(16);
    layer.setSourceCount(5);
    expect(emit(layer, new TestFrame()).pop()!.words[8]).toBe(5);
  });

  it('draws indirectly from a GPU count', () => {
    const layer = make({ count: 0, cull: true });
    layer.setSource({
      position: ext('layer-position', 1),
      indirect: ext('draw-indirect', 2, 1),
    });
    const out = emit(layer, new TestFrame());
    expect(ops(out)).not.toContain(LayerOp.LAYER_CULL);
    expect(out.pop()!.words[10]).toBe(LayerDrawFlag.INDIRECT);
  });

  it('validates layouts and drops the source on device loss', () => {
    const layer = make();
    expect(() => layer.setSource({ position: ext('layer-color', 1) })).toThrow(
      /INVALID_ARGUMENT/,
    );
    layer.setSource({ position: ext('layer-position', 1) });
    const frame = new TestFrame();
    emit(layer, frame);
    frame.generation++;
    emit(layer, frame);
    expect(layer.source).toBeNull();
  });
});

describe('column validation', () => {
  it('rejects conflicting, missing or short columns', () => {
    const layer = make();
    const f = new Float32Array(16);
    expect(() => layer.bindColumns({ xy: f, x: f, y: f })).toThrow(
      /INVALID_ARGUMENT/,
    );
    expect(() => layer.bindColumns({ x: f })).toThrow(/INVALID_ARGUMENT/);
    expect(() => layer.bindColumns({ userId: new Uint32Array(4) })).toThrow(
      /INVALID_ARGUMENT/,
    );
    const binding = layer.bindColumns({ xy: new Float32Array(8) });
    expect(() => binding.commit(5)).toThrow(/too short/);
    expect(() => binding.commit(1, 16)).toThrow(/INVALID_ARGUMENT/);
    binding.commit(4);
    expect(layer.count).toBe(4);
  });

  it('marks dirty ranges merged, as the sprite store does', () => {
    const layer = make();
    layer.markDirty(0, 2);
    layer.markDirty(4, 2);
    expect(layer._dirty[0].count).toBe(1);
    expect(layer._dirty[0].ends[0]).toBe(6);
    expect(() => layer.markDirty(15, 2)).toThrow(/INVALID_ARGUMENT/);
  });
});
