/**
 * Mask front: which implementation 'auto' picks, what it puts on the command
 * stream, and when the quads are re-uploaded (ARCHITECTURE §21.2, §21.4).
 */
import { createCommandDecoder } from '../commands';
import { CommandFlag, MaskFlag, MaskOp } from '../commands/opcodes';
import type { CommandDecoder } from '../commands/types';
import { Container } from '../scene/Container';
import { Sprite } from '../scene/Sprite';
import { Texture } from '../scene/Texture';
import { createMaskBinding } from './mask';
import { createFrontFrame } from './testutil';

interface Seen {
  opcode: number;
  flags: number;
  payload: number[];
  floats: number[];
}

const decoder: CommandDecoder = createCommandDecoder();

function commands(frame: ReturnType<typeof createFrontFrame>): Seen[] {
  const packet = frame._encoder.finish(frame.frameId);
  decoder.reset(packet);
  const out: Seen[] = [];
  const reader = decoder.reader;
  while (decoder.next()) {
    const words = reader.payloadBytes >> 2;
    const at = reader.payloadOffset >> 2;
    const payload: number[] = [];
    const floats: number[] = [];
    for (let i = 0; i < words; i++) {
      payload.push(reader.u32View[at + i]);
      floats.push(reader.f32View[at + i]);
    }
    out.push({ opcode: reader.opcode, flags: reader.flags, payload, floats });
  }
  return out;
}

function find(seen: Seen[], opcode: number): Seen | undefined {
  return seen.find(c => c.opcode === opcode);
}

function makeGroup(): Container {
  const stage = new Container();
  const group = new Container();
  stage.addChild(group);
  stage.updateTransform();
  return group;
}

function sprite(x: number, y: number, size = 40, rotation = 0): Sprite {
  const s = new Sprite({ texture: Texture.WHITE, x, y, rotation });
  s.width = size;
  s.height = size;
  return s;
}

describe('mask front: implementation choice', () => {
  it('uses a scissor for an axis-aligned rect, in canvas pixels', () => {
    const group = makeGroup();
    const binding = createMaskBinding(group);
    binding.update({ x: 10, y: 20, width: 100, height: 50 });
    const frame = createFrontFrame();
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
    binding.emitEnd(frame);
    expect(binding.mode).toBe('scissor');
    const seen = commands(frame);
    const push = find(seen, MaskOp.MASK_PUSH_SCISSOR)!;
    expect(push).toBeDefined();
    expect(push.flags & CommandFlag.DRAW).toBe(CommandFlag.DRAW);
    expect(push.flags & CommandFlag.PASS_BREAK).toBe(0);
    expect(push.floats.slice(1, 5)).toEqual([10, 20, 100, 50]);
    expect(find(seen, MaskOp.MASK_POP)).toBeDefined();
  });

  it('follows the masked group parent transform', () => {
    const stage = new Container();
    const layer = new Container({ x: 100, y: 5 });
    const group = new Container();
    stage.addChild(layer);
    layer.addChild(group);
    stage.updateTransform();
    const binding = createMaskBinding(group);
    binding.update({ x: 10, y: 20, width: 100, height: 50 });
    const frame = createFrontFrame();
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    const push = find(commands(frame), MaskOp.MASK_PUSH_SCISSOR)!;
    expect(push.floats.slice(1, 5)).toEqual([110, 25, 100, 50]);
  });

  it('uses a scissor for an unrotated sprite and its world bounds', () => {
    const group = makeGroup();
    const shape = sprite(30, 40, 60);
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);
    binding.update(shape);
    const frame = createFrontFrame();
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
    expect(binding.mode).toBe('scissor');
    const push = find(commands(frame), MaskOp.MASK_PUSH_SCISSOR)!;
    expect(push.floats.slice(1, 5)).toEqual([30, 40, 60, 60]);
  });

  it('a rotated shape takes the stencil on WebGL2 and the alpha path on WebGPU', () => {
    const group = makeGroup();
    const shape = sprite(30, 40, 60, 0.4);
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);
    binding.update(shape);

    const gl = createFrontFrame({ caps: { backend: 'webgl2' } });
    expect(binding.emitBegin(gl, new Float32Array(6), 0, 1)).toBe(true);
    expect(binding.mode).toBe('stencil');
    const glSeen = commands(gl);
    expect(find(glSeen, MaskOp.MASK_BUFFER_ALLOC)).toBeDefined();
    expect(find(glSeen, MaskOp.MASK_UPLOAD)).toBeDefined();

    const gpu = createFrontFrame({ caps: { backend: 'webgpu' }, frameId: 2 });
    expect(binding.emitBegin(gpu, new Float32Array(6), 0, 1)).toBe(true);
    expect(binding.mode).toBe('alpha');
    const push = find(commands(gpu), MaskOp.MASK_PUSH_ALPHA)!;
    expect(push.flags & CommandFlag.PASS_BREAK).toBe(CommandFlag.PASS_BREAK);
  });

  it('packs the quad alpha from the RESOLVED mode, not the requested one', () => {
    // MASK_UPLOAD: bufferId, first, count, then the instance records; the
    // instance color is word 6 and its alpha is the shader's `level`.
    const colorOf = (upload: Seen): number => upload.payload[3 + 6] >>> 24;
    const group = makeGroup();
    const shape = sprite(30, 40, 60, 0.4); // rotated: no scissor
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);

    // 'auto' on WebGPU resolves to the soft path, which MULTIPLIES the
    // coverage by this level: the default threshold would render the whole
    // subtree at 50% opacity.
    binding.update(shape);
    const soft = createFrontFrame({ caps: { backend: 'webgpu' } });
    expect(binding.emitBegin(soft, new Float32Array(6), 0, 1)).toBe(true);
    expect(binding.mode).toBe('alpha');
    expect(colorOf(find(commands(soft), MaskOp.MASK_UPLOAD)!)).toBe(255);

    // A binary mode compares a texel against the level, so it keeps the
    // threshold (0.5 -> 128).
    const binary = createMaskBinding(group);
    binary.update(shape);
    const gl = createFrontFrame({ caps: { backend: 'webgl2' }, frameId: 2 });
    expect(binary.emitBegin(gl, new Float32Array(6), 0, 1)).toBe(true);
    expect(binary.mode).toBe('stencil');
    expect(colorOf(find(commands(gl), MaskOp.MASK_UPLOAD)!)).toBe(128);
  });

  it('an explicit threshold reaches a soft mask at full strength', () => {
    const group = makeGroup();
    const shape = sprite(0, 0, 20, 0.3);
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);
    binding.update({ source: shape, mode: 'alpha', threshold: 0.25 });
    const frame = createFrontFrame({ caps: { backend: 'webgpu' } });
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    expect(binding.mode).toBe('alpha');
    const upload = find(commands(frame), MaskOp.MASK_UPLOAD)!;
    expect(upload.payload[3 + 6] >>> 24).toBe(255);
  });

  it('an inverted rect cannot be a scissor', () => {
    const group = makeGroup();
    const binding = createMaskBinding(group);
    binding.update({
      source: { x: 0, y: 0, width: 10, height: 10 },
      invert: true,
    });
    const frame = createFrontFrame({ caps: { backend: 'webgl2' } });
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    expect(binding.mode).toBe('stencil');
    const push = find(commands(frame), MaskOp.MASK_PUSH_STENCIL)!;
    expect(push.payload[5] & MaskFlag.INVERT).toBe(MaskFlag.INVERT);
  });

  it('an explicit stencil mode falls back to alpha without caps.stencil', () => {
    const group = makeGroup();
    const shape = sprite(0, 0, 10);
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);
    binding.update({ source: shape, mode: 'stencil' });
    const frame = createFrontFrame({
      caps: { backend: 'webgl2', stencil: false },
    });
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    expect(binding.mode).toBe('alpha');
  });
});

describe('mask front: stream', () => {
  it('skips the subtree while the core system is not ready', () => {
    const group = makeGroup();
    const binding = createMaskBinding(group);
    binding.update({ x: 0, y: 0, width: 10, height: 10 });
    const frame = createFrontFrame({ ready: false });
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(false);
    expect(commands(frame)).toHaveLength(0);
  });

  it('emits nothing for a cleared mask, and skips a mask with no geometry', () => {
    const group = makeGroup();
    const binding = createMaskBinding(group);
    binding.update(null);
    const frame = createFrontFrame();
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
    binding.emitEnd(frame);
    expect(commands(frame)).toHaveLength(0);

    binding.update(new Container());
    const second = createFrontFrame({ frameId: 2 });
    expect(binding.emitBegin(second, new Float32Array(6), 0, 1)).toBe(false);
    expect(commands(second)).toHaveLength(0);
  });

  it('uploads the quads once and again only when they moved', () => {
    const group = makeGroup();
    const shape = sprite(0, 0, 10, 0.3);
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);
    binding.update({ source: shape, mode: 'stencil' });
    const caps = { backend: 'webgl2' as const };

    const first = createFrontFrame({ caps });
    binding.emitBegin(first, new Float32Array(6), 0, 1);
    expect(find(commands(first), MaskOp.MASK_UPLOAD)).toBeDefined();

    const second = createFrontFrame({ caps, frameId: 2 });
    binding.emitBegin(second, new Float32Array(6), 0, 1);
    expect(find(commands(second), MaskOp.MASK_UPLOAD)).toBeUndefined();

    shape.x = 12;
    group.parent!.updateTransform();
    const third = createFrontFrame({ caps, frameId: 3 });
    binding.emitBegin(third, new Float32Array(6), 0, 1);
    expect(find(commands(third), MaskOp.MASK_UPLOAD)).toBeDefined();
  });

  it('breaks the pass once per frame, however many stencil masks there are', () => {
    const stage = new Container();
    const a = new Container();
    const b = new Container();
    stage.addChild(a);
    stage.addChild(b);
    const shape = sprite(0, 0, 10, 0.3);
    stage.addChild(shape);
    stage.updateTransform();
    const first = createMaskBinding(a);
    const second = createMaskBinding(b);
    first.update({ source: shape, mode: 'stencil' });
    second.update({ source: shape, mode: 'stencil' });
    const caps = { backend: 'webgl2' as const };

    const frame = createFrontFrame({ caps, frameId: 11 });
    first.emitBegin(frame, new Float32Array(6), 0, 1);
    first.emitEnd(frame);
    second.emitBegin(frame, new Float32Array(6), 0, 1);
    second.emitEnd(frame);
    const pushes = commands(frame).filter(
      c => c.opcode === MaskOp.MASK_PUSH_STENCIL,
    );
    expect(pushes).toHaveLength(2);
    expect(pushes[0].flags & CommandFlag.PASS_BREAK).toBe(
      CommandFlag.PASS_BREAK,
    );
    expect(pushes[1].flags & CommandFlag.PASS_BREAK).toBe(0);

    const next = createFrontFrame({ caps, frameId: 12 });
    first.emitBegin(next, new Float32Array(6), 0, 1);
    const again = commands(next).filter(
      c => c.opcode === MaskOp.MASK_PUSH_STENCIL,
    );
    expect(again[0].flags & CommandFlag.PASS_BREAK).toBe(
      CommandFlag.PASS_BREAK,
    );
  });

  it('packs one quad per sprite of a container mask', () => {
    const group = makeGroup();
    const shape = new Container({ rotation: 0.2 });
    shape.addChild(sprite(0, 0, 10));
    shape.addChild(sprite(20, 0, 10));
    group.parent!.addChild(shape);
    group.parent!.updateTransform();
    const binding = createMaskBinding(group);
    binding.update({ source: shape, mode: 'stencil' });
    const frame = createFrontFrame({ caps: { backend: 'webgl2' } });
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    const push = find(commands(frame), MaskOp.MASK_PUSH_STENCIL)!;
    expect(push.payload[3]).toBe(2);
  });

  it('places a detached mask node in the group parent space', () => {
    const stage = new Container();
    const layer = new Container({ x: 200, y: 100 });
    const group = new Container();
    stage.addChild(layer);
    layer.addChild(group);
    stage.updateTransform();
    const detached = sprite(5, 5, 20);
    const binding = createMaskBinding(group);
    binding.update(detached);
    const frame = createFrontFrame();
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    const push = find(commands(frame), MaskOp.MASK_PUSH_SCISSOR)!;
    expect(push.floats.slice(1, 5)).toEqual([205, 105, 20, 20]);
  });
});
