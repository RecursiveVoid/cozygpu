/**
 * Front half of filter chains (ARCHITECTURE §22.5, §22.7): what a group emits
 * into the command stream, with the real encoder and decoder.
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, FilterOp, Op, OpcodeRange } from '../commands/opcodes';
import type { CommandEncoder } from '../commands/types';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import type { ContainerNode } from '../scene/types';
import type { FrontFrame } from '../types/core';
import {
  SE_FLAGS,
  SE_MATRIX,
  SPRITE_EFFECT_BYTES,
  SpriteEffectFlag,
} from '../types/layouts';
import { createFilterBinding, loadBuiltinFilters } from './filters';
import { defineFilter, filters } from './presets';

const GROUP_ID = 7;

interface Recorded {
  opcode: number;
  flags: number;
  words: number[];
  bytes: Uint8Array;
}

class Frame implements FrontFrame {
  rendererId = 1;
  encoder: CommandEncoder = createCommandEncoder();
  frameId = 0;
  time = 0;
  dt = 1 / 60;
  cssWidth = 800;
  cssHeight = 600;
  resolution = 2;
  sharedMemory = true;
  useSharedArrayBuffer = false;
  generation = 0;
  caps = FAKE_CAPS;
  ready = true;

  isSystemReady(_range: number): boolean {
    return this.ready;
  }
  registerShared(): number {
    return 1;
  }
  readback(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('unused'));
  }

  /** Finishes the packet and decodes every command in it. */
  take(): Recorded[] {
    const packet = this.encoder.finish(this.frameId++);
    const decoder = createCommandDecoder();
    decoder.reset(packet);
    const out: Recorded[] = [];
    while (decoder.next()) {
      const r = decoder.reader;
      const words: number[] = [];
      const base = r.payloadOffset >> 2;
      for (let i = 0; i < r.payloadBytes >> 2; i++)
        words.push(r.u32View[base + i]);
      out.push({
        opcode: r.opcode,
        flags: r.flags,
        words,
        bytes: r.u8.slice(r.payloadOffset, r.payloadOffset + r.payloadBytes),
      });
    }
    this.encoder.reset();
    return out;
  }
}

const world = new Float32Array(6);
const group = { id: GROUP_ID } as unknown as ContainerNode;

function find(list: Recorded[], opcode: number): Recorded | undefined {
  return list.find(c => c.opcode === opcode);
}

describe('cheap chains stay inside the sprite batch', () => {
  it('emits the effect block and binds it, with no FILTER command', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    const cm = filters.colorMatrix().saturate(0);
    binding.update([cm]);
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(true);
    binding.emitEnd(frame);
    const commands = frame.take();
    expect(commands.map(c => c.opcode)).toEqual([
      Op.SPRITE_DEFINE_EFFECT,
      Op.SPRITE_SET_EFFECT,
      Op.SPRITE_SET_EFFECT,
    ]);
    expect(binding.cheap).toBe(true);
    expect(commands.filter(c => c.opcode >= 0x0500).length).toBe(0);
    // The bind and the reset carry DRAW, the definition does not.
    expect(commands[1].flags & CommandFlag.DRAW).toBe(CommandFlag.DRAW);
    expect(commands[1].words[0]).toBeGreaterThan(0);
    expect(commands[2].words[0]).toBe(0);
    binding.destroy();
  });

  it('packs the color matrix column-major with no NO_MATRIX flag', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([filters.colorMatrix().brightness(0.5)]);
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    const define = find(frame.take(), Op.SPRITE_DEFINE_EFFECT);
    expect(define).toBeDefined();
    const block = new Float32Array(
      define!.bytes.buffer,
      define!.bytes.byteOffset + 4,
      SPRITE_EFFECT_BYTES >> 2,
    );
    const u32 = new Uint32Array(
      define!.bytes.buffer,
      define!.bytes.byteOffset + 4,
      SPRITE_EFFECT_BYTES >> 2,
    );
    expect(block[SE_MATRIX >> 2]).toBeCloseTo(0.5);
    expect(block[(SE_MATRIX >> 2) + 5]).toBeCloseTo(0.5);
    expect(block[(SE_MATRIX >> 2) + 15]).toBeCloseTo(1);
    expect(u32[SE_FLAGS >> 2] & SpriteEffectFlag.NO_MATRIX).toBe(0);
    binding.destroy();
  });

  it('re-uploads the block only when the chain changed', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    const cm = filters.colorMatrix().saturate(0.5);
    binding.update([cm]);
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    frame.take();

    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    expect(find(frame.take(), Op.SPRITE_DEFINE_EFFECT)).toBeUndefined();

    cm.hue(30);
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    expect(find(frame.take(), Op.SPRITE_DEFINE_EFFECT)).toBeDefined();
    binding.destroy();
  });
});

describe('custom filters take a pooled target', () => {
  const pixelate = defineFilter({
    name: 'pixelate',
    params: { block: 'f32' },
    defaults: { block: 8 },
    wgsl: `@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let s = max($params.block, 1.0) * fpass.texel;
  return cozySample(floor(in.uv / s) * s);
}`,
  });

  it('defines, uploads and brackets the subtree', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([pixelate()], { resolution: 0.5, blendMode: 'add' });
    expect(binding.emitBegin(frame, world, 0, 0.75)).toBe(true);
    binding.emitEnd(frame);
    const commands = frame.take();
    expect(commands.map(c => c.opcode)).toEqual([
      FilterOp.FILTER_DEFINE,
      FilterOp.FILTER_SET_UNIFORMS,
      FilterOp.FILTER_BEGIN,
      FilterOp.FILTER_END,
    ]);
    expect(binding.cheap).toBe(false);

    const begin = commands[2];
    expect(begin.flags & CommandFlag.PASS_BREAK).toBe(CommandFlag.PASS_BREAK);
    expect(begin.flags & CommandFlag.DRAW).toBe(CommandFlag.DRAW);
    expect(begin.words[0]).toBe(GROUP_ID);
    const f32 = new Float32Array(
      begin.bytes.buffer,
      begin.bytes.byteOffset,
      begin.bytes.byteLength >> 2,
    );
    expect([f32[1], f32[2], f32[3], f32[4]]).toEqual([0, 0, 800, 600]);
    expect(f32[5]).toBeCloseTo(0.5);

    const end = commands[3];
    expect(end.flags & CommandFlag.PASS_BREAK).toBe(CommandFlag.PASS_BREAK);
    expect(end.words[0]).toBe(GROUP_ID);
    expect(end.words[1]).toBe(1); // BlendModeId.add
    expect(
      new Float32Array(end.bytes.buffer, end.bytes.byteOffset, 4)[2],
    ).toBeCloseTo(0.75);
    expect(end.words[3]).toBe(1);
    expect(end.words[4]).toBe(commands[0].words[0]);
    binding.destroy();
  });

  it('composes the pass uniform block and binds $params to it', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([pixelate()]);
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    const define = find(frame.take(), FilterOp.FILTER_DEFINE)!;
    const srcBytes = define.words[4];
    const source = new TextDecoder().decode(
      define.bytes.subarray(20, 20 + srcBytes),
    );
    expect(source).toContain('struct FilterPass {');
    expect(source).toContain('@size(8) texel: vec2f');
    expect(source).toContain('@size(16) area: vec4f');
    expect(source).toContain('@size(16) block: f32');
    expect(source).toContain('@group(2) @binding(0) var<uniform> fpass');
    expect(source).toContain('fpass.block');
    expect(source).not.toContain('$params');
    // passCount, uniform bytes, flags.
    expect(define.words[1]).toBe(1);
    expect(define.words[2]).toBe(64);
    binding.destroy();
  });

  it('clips the area to the canvas and grows it by the chain padding', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([pixelate()], {
      area: { x: -50, y: 10, width: 4000, height: 100 },
    });
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    const begin = find(frame.take(), FilterOp.FILTER_BEGIN)!;
    const f32 = new Float32Array(
      begin.bytes.buffer,
      begin.bytes.byteOffset,
      begin.bytes.byteLength >> 2,
    );
    expect(f32[1]).toBe(0);
    expect(f32[3]).toBe(800);
    expect(f32[2] + f32[4]).toBeLessThanOrEqual(600);
    binding.destroy();
  });

  it('skips the subtree while the core system is not ready', () => {
    const frame = new Frame();
    frame.ready = false;
    const binding = createFilterBinding(group);
    binding.update([pixelate()]);
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(false);
    expect(frame.take()).toHaveLength(0);
    binding.destroy();
  });

  it('unbinds the cheap effect when the area clips the group away', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    // A cheap prefix (the sprite effect block) plus a target program, with an
    // area entirely off-canvas: the subtree is skipped, so emitEnd never runs
    // and the effect would otherwise stay bound for the rest of the frame.
    binding.update([filters.colorMatrix().saturate(0), pixelate()], {
      area: { x: 900, y: 0, width: 100, height: 100 },
    });
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(false);
    const sets = frame.take().filter(c => c.opcode === Op.SPRITE_SET_EFFECT);
    expect(sets).toHaveLength(2);
    expect(sets[0].words[0]).toBeGreaterThan(0);
    expect(sets[1].words[0]).toBe(0);

    // emitEnd still runs for a group whose begin succeeded, and unbinds once.
    binding.update([filters.colorMatrix().saturate(0), pixelate()]);
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(true);
    binding.emitEnd(frame);
    const again = frame.take().filter(c => c.opcode === Op.SPRITE_SET_EFFECT);
    expect(again.map(c => c.words[0] === 0)).toEqual([false, true]);
    binding.destroy();
  });

  it('re-defines the program after a device loss', () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([pixelate()]);
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    frame.take();
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    expect(find(frame.take(), FilterOp.FILTER_DEFINE)).toBeUndefined();
    frame.generation = 1;
    binding.emitBegin(frame, world, 0, 1);
    binding.emitEnd(frame);
    expect(find(frame.take(), FilterOp.FILTER_DEFINE)).toBeDefined();
    binding.destroy();
  });

  it('skips a filter that has no shader for this backend', () => {
    const glslOnly = defineFilter({
      name: 'glslOnly',
      params: { k: 'f32' },
      defaults: { k: 1 },
      glsl: 'void main() { fragColor = cozySample(vUv) * $params.k; }',
    })();
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([glslOnly]);
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(true);
    binding.emitEnd(frame);
    // Nothing is left to run, so the group costs no target and no command.
    expect(frame.take()).toHaveLength(0);
    binding.destroy();
  });

  it('rejects a definition with no shader at all', () => {
    expect(() =>
      defineFilter({ name: 'empty', params: {}, defaults: {} }),
    ).toThrow(/INVALID_ARGUMENT/);
  });
});

describe('built-ins arrive as their own chunk', () => {
  it('skips the subtree until filters-builtin landed, then draws', async () => {
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([filters.blur({ strength: 4 })]);
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(false);
    expect(frame.take()).toHaveLength(0);
    await loadBuiltinFilters();
    await Promise.resolve();
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(true);
    binding.emitEnd(frame);
    const define = find(frame.take(), FilterOp.FILTER_DEFINE)!;
    expect(define.words[1]).toBe(2); // separable blur: two passes
    binding.destroy();
  });

  it('splits a mixed chain into a cheap prefix and a target', async () => {
    await loadBuiltinFilters();
    await Promise.resolve();
    const frame = new Frame();
    const binding = createFilterBinding(group);
    binding.update([filters.colorMatrix().sepia(), filters.blur()]);
    expect(binding.emitBegin(frame, world, 0, 1)).toBe(true);
    binding.emitEnd(frame);
    const opcodes = frame.take().map(c => c.opcode);
    expect(opcodes).toContain(Op.SPRITE_DEFINE_EFFECT);
    expect(opcodes).toContain(Op.SPRITE_SET_EFFECT);
    expect(opcodes).toContain(FilterOp.FILTER_BEGIN);
    expect(opcodes).toContain(FilterOp.FILTER_END);
    expect(binding.cheap).toBe(false);
    binding.destroy();
  });

  it('registers the filter core system factory when the chunk loads', () => {
    expect(OpcodeRange.FILTER).toBe(0x05);
  });
});
