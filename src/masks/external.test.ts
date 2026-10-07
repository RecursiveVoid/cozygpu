/**
 * Masks whose geometry another system draws (a Graphics, ARCHITECTURE
 * §26.8): what the mask front emits around `_emitMaskGeometry`, and how the
 * mask core drives the stencil reference and the soft-mask passes for
 * `MaskFlag.EXTERNAL` pushes and MASK_GEOMETRY_END.
 */
import type {
  RenderPassDesc,
  RhiTexture,
  TextureFormat,
} from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import {
  CommandFlag,
  MaskFlag,
  MaskOp,
  OpcodeRange,
} from '../commands/opcodes';
import { GfxDrawFlag, GfxOp } from '../commands/gfxOpcodes';
import type { CommandEncoder } from '../commands/types';
import { Container } from '../scene/Container';
import type { CoreSystem, FrontFrame } from '../types/core';
import { isMaskDrawable } from '../types/core';
import { createMaskCoreSystem } from './core';
import { createMaskBinding } from './mask';
import {
  MaskBackend,
  RecordList,
  createFrameState,
  createFrontFrame,
  createMaskContext,
} from './testutil';

let passNow: RenderPassDesc | null = null;

jest.mock('../filters/targets', () => ({
  releaseTargetPool: () => {},
  resetTargetPool: () => {},
  currentPassDesc: () => passNow,
  setCurrentPassDesc: (_backend: unknown, desc: RenderPassDesc | null) => {
    passNow = desc;
  },
  acquireTargetPool: (backend: {
    createTexture(desc: {
      label: string;
      width: number;
      height: number;
      format: TextureFormat;
      usage: number;
      sampleCount: 1 | 4;
    }): RhiTexture;
  }) => {
    let n = 0;
    return {
      acquire: (
        width: number,
        height: number,
        format: TextureFormat,
        samples = 1,
      ) =>
        backend.createTexture({
          label: `pool ${n++}${samples > 1 ? ' msaa' : ''}`,
          width,
          height,
          format,
          usage: 0,
          sampleCount: samples as 1 | 4,
        }),
      release: () => {},
      endFrame: () => {},
      bytes: 0,
      destroy: () => {},
    };
  },
}));

beforeEach(() => {
  passNow = null;
});

// ─── front ─────────────────────────────────────────────────────────────────

/** A scene node that draws its own mask geometry, like Graphics. */
class Shape extends Container {
  rect: number[] | null = null;
  ready = true;
  readonly calls: string[] = [];

  _maskRect(out: Float32Array): boolean {
    if (!this.rect) return false;
    out.set(this.rect);
    return true;
  }

  _emitMaskGeometry(
    frame: FrontFrame,
    world: Float32Array,
    offset: number,
    stencil: boolean,
  ): boolean {
    this.calls.push(`geometry ${stencil} tx=${world[offset + 4]}`);
    if (!this.ready) return false;
    const enc = frame.encoder;
    enc.begin(GfxOp.GFX_DRAW_SHAPES, 20, CommandFlag.DRAW);
    enc.u32(1);
    enc.u32(0);
    enc.u32(1);
    enc.u32(0);
    enc.u32(stencil ? GfxDrawFlag.MASK_WRITE : 0);
    enc.end();
    return true;
  }
}

interface Seen {
  opcode: number;
  flags: number;
  words: number[];
  floats: number[];
}

const decoder = createCommandDecoder();

function commands(frame: ReturnType<typeof createFrontFrame>): Seen[] {
  decoder.reset(frame._encoder.finish(frame.frameId));
  const reader = decoder.reader;
  const out: Seen[] = [];
  while (decoder.next()) {
    const at = reader.payloadOffset >> 2;
    const n = reader.payloadBytes >> 2;
    out.push({
      opcode: reader.opcode,
      flags: reader.flags,
      words: Array.from(reader.u32View.subarray(at, at + n)),
      floats: Array.from(reader.f32View.subarray(at, at + n)),
    });
  }
  return out;
}

function scene(shape: Shape): Container {
  const stage = new Container();
  const group = new Container();
  stage.addChild(group);
  stage.addChild(shape);
  stage.updateTransform();
  return group;
}

function frameFor(
  backend: 'webgl2' | 'webgpu',
): ReturnType<typeof createFrontFrame> {
  return createFrontFrame({ caps: { backend } });
}

describe('external mask geometry: front', () => {
  it('a Graphics-like node is a MaskDrawable', () => {
    expect(isMaskDrawable(new Shape())).toBe(true);
  });

  it('one unrotated plain rect is a scissor; no geometry is drawn', () => {
    const shape = new Shape({ x: 5, y: 7 });
    shape.rect = [10, 20, 100, 50];
    const binding = createMaskBinding(scene(shape));
    binding.update(shape);
    const frame = frameFor('webgl2');
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
    binding.emitEnd(frame);
    expect(binding.mode).toBe('scissor');
    expect(shape.calls).toEqual([]);
    const seen = commands(frame);
    expect(seen.map(c => c.opcode)).toEqual([
      MaskOp.MASK_PUSH_SCISSOR,
      MaskOp.MASK_POP,
    ]);
    expect(seen[0].floats.slice(1, 5)).toEqual([15, 27, 100, 50]);
  });

  it('WebGL2: any other shape is a stencil mask drawn by the node', () => {
    const shape = new Shape({ x: 3, rotation: 0.5 });
    shape.rect = [0, 0, 10, 10];
    const binding = createMaskBinding(scene(shape));
    binding.update(shape);
    const frame = frameFor('webgl2');
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
    binding.emitEnd(frame);
    expect(binding.mode).toBe('stencil');
    expect(shape.calls).toEqual(['geometry true tx=3']);
    const seen = commands(frame);
    expect(seen.map(c => c.opcode)).toEqual([
      MaskOp.MASK_PUSH_STENCIL,
      GfxOp.GFX_DRAW_SHAPES,
      MaskOp.MASK_GEOMETRY_END,
      MaskOp.MASK_POP,
    ]);
    const push = seen[0];
    expect(push.flags).toBe(CommandFlag.DRAW | CommandFlag.PASS_BREAK);
    // No quads: buffer 0, count 0, the EXTERNAL flag.
    expect(push.words.slice(1, 5)).toEqual([0, 0, 0, 0]);
    expect(push.words[5] & MaskFlag.EXTERNAL).toBe(MaskFlag.EXTERNAL);
    expect(seen[2].flags).toBe(CommandFlag.DRAW);
    expect(seen[2].words).toEqual([push.words[0]]);
    expect(seen[3].flags).toBe(CommandFlag.DRAW);
  });

  it('WebGPU (and inverted shapes): a soft mask with a coverage pass', () => {
    for (const [backend, invert] of [
      ['webgpu', false],
      ['webgl2', true],
    ] as const) {
      const shape = new Shape();
      const binding = createMaskBinding(scene(shape));
      binding.update({ source: shape, invert });
      const frame = frameFor(backend);
      expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
      binding.emitEnd(frame);
      expect(binding.mode).toBe('alpha');
      expect(shape.calls).toEqual(['geometry false tx=0']);
      const seen = commands(frame);
      expect(seen.map(c => c.opcode)).toEqual([
        MaskOp.MASK_PUSH_ALPHA,
        GfxOp.GFX_DRAW_SHAPES,
        MaskOp.MASK_GEOMETRY_END,
        MaskOp.MASK_POP,
      ]);
      const breaks = CommandFlag.DRAW | CommandFlag.PASS_BREAK;
      expect(seen[0].flags).toBe(breaks);
      expect(seen[0].words[5] & MaskFlag.EXTERNAL).toBe(MaskFlag.EXTERNAL);
      expect((seen[0].words[5] & MaskFlag.INVERT) !== 0).toBe(invert);
      expect(seen[2].flags).toBe(breaks);
      expect(seen[3].flags).toBe(breaks);
    }
  });

  it('a detached mask node is placed relative to the group parent', () => {
    const shape = new Shape({ x: 4 });
    const stage = new Container({ x: 100 });
    const group = new Container();
    stage.addChild(group);
    stage.updateTransform();
    const binding = createMaskBinding(group);
    binding.update(shape);
    const frame = frameFor('webgl2');
    binding.emitBegin(frame, new Float32Array(6), 0, 1);
    expect(shape.calls).toEqual(['geometry true tx=104']);
  });

  it('stays balanced when the node cannot draw its geometry yet (graphics chunks loading)', () => {
    const shape = new Shape();
    shape.ready = false;
    const binding = createMaskBinding(scene(shape));
    binding.update(shape);
    const frame = frameFor('webgl2');
    expect(binding.emitBegin(frame, new Float32Array(6), 0, 1)).toBe(true);
    binding.emitEnd(frame);
    expect(commands(frame).map(c => c.opcode)).toEqual([
      MaskOp.MASK_PUSH_STENCIL,
      MaskOp.MASK_GEOMETRY_END,
      MaskOp.MASK_POP,
    ]);
  });
});

// ─── core ──────────────────────────────────────────────────────────────────

/** RenderCore's replay for the mask system; GRAPHICS draws are logged. */
function run(
  system: CoreSystem,
  encoder: CommandEncoder,
  frameId: number,
): RecordList {
  const frame = createFrameState(frameId);
  decoder.reset(encoder.finish(frameId));
  const reader = decoder.reader;
  const list = new RecordList();
  const draws: number[] = [];
  while (decoder.next()) {
    if ((reader.flags & CommandFlag.DRAW) !== 0) {
      draws.push(reader.commandOffset);
    } else system.execute(reader, frame);
  }
  let pass = list.beginRenderPass({
    label: 'main',
    color: { target: 'canvas', load: 'clear' },
  });
  for (let i = 0; i < draws.length; i++) {
    decoder.seek(draws[i]);
    if (reader.opcode >>> 8 === OpcodeRange.GRAPHICS) {
      list.pass.calls.push('graphics draw');
      continue;
    }
    if ((reader.flags & CommandFlag.PASS_BREAK) !== 0 && system.passBreak) {
      pass.end();
      const desc = system.passBreak(reader, list, frame);
      pass = list.beginRenderPass(
        desc ?? { label: 'main', color: { target: 'canvas', load: 'load' } },
      );
    }
    system.draw(reader, pass, frame);
  }
  pass.end();
  system.endFrame?.(frame);
  return list;
}

function externalMask(
  encoder: CommandEncoder,
  alpha: boolean,
  id = 9,
  invert = false,
): void {
  const breaks = CommandFlag.DRAW | CommandFlag.PASS_BREAK;
  const flags = MaskFlag.EXTERNAL | (invert ? MaskFlag.INVERT : 0);
  if (alpha) {
    encoder.begin(MaskOp.MASK_PUSH_ALPHA, 44, breaks);
    encoder.u32(id);
    for (let i = 0; i < 4; i++) encoder.u32(0);
    encoder.u32(flags);
    for (let i = 0; i < 5; i++) encoder.f32(0);
  } else {
    encoder.begin(MaskOp.MASK_PUSH_STENCIL, 28, breaks);
    encoder.u32(id);
    for (let i = 0; i < 4; i++) encoder.u32(0);
    encoder.u32(flags);
    encoder.f32(0.5);
  }
  encoder.end();
  encoder.begin(GfxOp.GFX_DRAW_SHAPES, 20, CommandFlag.DRAW);
  for (let i = 0; i < 5; i++) encoder.u32(0);
  encoder.end();
  encoder.begin(MaskOp.MASK_GEOMETRY_END, 4, alpha ? breaks : CommandFlag.DRAW);
  encoder.u32(id);
  encoder.end();
  encoder.begin(GfxOp.GFX_DRAW_SHAPES, 20, CommandFlag.DRAW); // the subtree
  for (let i = 0; i < 5; i++) encoder.u32(0);
  encoder.end();
  encoder.begin(MaskOp.MASK_POP, 4, alpha ? breaks : CommandFlag.DRAW);
  encoder.u32(id);
  encoder.end();
}

async function core(): Promise<{
  system: CoreSystem;
  backend: MaskBackend;
}> {
  const backend = new MaskBackend();
  backend.caps = { ...backend.caps, backend: 'webgl2' };
  const system = createMaskCoreSystem();
  await system.init(createMaskContext(backend));
  return { system, backend };
}

function encoder(): CommandEncoder {
  const enc = createCommandEncoder(4096);
  enc.reset();
  return enc;
}

describe('external mask geometry: core', () => {
  it('stencil: the geometry increments at the old level, the subtree draws at the new one', async () => {
    const { system, backend } = await core();
    expect(backend.pipelines.map(p => p.label)).toContain('cozygpu.mask.reset');
    const reset = backend.pipelines.find(
      p => p.label === 'cozygpu.mask.reset',
    )!;
    expect(reset.stencil).toEqual({ compare: 'less', passOp: 'replace' });
    expect(reset.colorWriteDisabled).toBe(true);
    const enc = encoder();
    externalMask(enc, false);
    const calls = run(system, enc, 1).pass.calls;
    expect(
      calls.filter(c => !c.startsWith('bind') && !c.startsWith('vertex')),
    ).toEqual([
      'beginPass main',
      'end',
      // WebGL2 draws into the default framebuffer's own stencil buffer.
      'beginPass main',
      'ref 0',
      'graphics draw',
      'ref 1',
      'graphics draw',
      // Pop: one canvas quad lowers everything above level 0 back to 0.
      'pipeline cozygpu.mask.reset',
      'ref 0',
      'draw 4x1@0',
      'ref 0',
      'end',
    ]);
  });

  it('stencil: nests on top of an open level', async () => {
    const { system } = await core();
    const enc = encoder();
    externalMask(enc, false, 1);
    const calls = run(system, enc, 1).pass.calls;
    expect(calls.filter(c => c.startsWith('ref'))).toEqual([
      'ref 0',
      'ref 1',
      'ref 0',
      'ref 0',
    ]);
    // Two nested external masks: 0 → 1 → 2, then back.
    const enc2 = encoder();
    const breaks = CommandFlag.DRAW | CommandFlag.PASS_BREAK;
    for (const id of [1, 2]) {
      enc2.begin(
        MaskOp.MASK_PUSH_STENCIL,
        28,
        id === 1 ? breaks : CommandFlag.DRAW,
      );
      enc2.u32(id);
      for (let i = 0; i < 4; i++) enc2.u32(0);
      enc2.u32(MaskFlag.EXTERNAL);
      enc2.f32(0.5);
      enc2.end();
      enc2.begin(MaskOp.MASK_GEOMETRY_END, 4, CommandFlag.DRAW);
      enc2.u32(id);
      enc2.end();
    }
    for (const id of [2, 1]) {
      enc2.begin(MaskOp.MASK_POP, 4, CommandFlag.DRAW);
      enc2.u32(id);
      enc2.end();
    }
    const nested = run(system, enc2, 2).pass.calls.filter(c =>
      c.startsWith('ref'),
    );
    expect(nested).toEqual([
      'ref 0',
      'ref 1',
      'ref 1',
      'ref 2',
      'ref 1',
      'ref 1',
      'ref 0',
      'ref 0',
    ]);
  });

  it('stencil: clips everything away while the pipelines compile', async () => {
    const backend = new MaskBackend();
    backend.caps = { ...backend.caps, backend: 'webgl2' };
    backend.stallPipelines = true;
    const system = createMaskCoreSystem();
    void system.init(createMaskContext(backend));
    await new Promise(r => setTimeout(r, 0));
    const enc = encoder();
    externalMask(enc, false);
    const calls = run(system, enc, 1).pass.calls;
    expect(calls).toContain('scissor 0 0 0 0');
    expect(calls.some(c => c.startsWith('ref'))).toBe(false);
  });

  it('alpha: the geometry draws into the coverage target, then the capture opens', async () => {
    const { system } = await core();
    // The first soft mask loads the alpha half and clips everything away.
    const first = encoder();
    externalMask(first, true);
    const fallback = run(system, first, 1);
    expect(fallback.pass.calls).toContain('scissor 0 0 0 0');
    await new Promise(r => setTimeout(r, 0));
    const second = encoder();
    externalMask(second, true);
    const list = run(system, second, 2);
    expect(list.passes.map(p => p.label)).toEqual([
      'main',
      'cozygpu mask coverage',
      'cozygpu mask capture',
      'main',
    ]);
    const coverage = list.passes[1].color.target as RhiTexture;
    const capture = list.passes[2].color.target as RhiTexture;
    expect(coverage.label).toBe('pool 0');
    expect(capture.label).toBe('pool 1');
    // Geometry in the coverage pass, the subtree in the capture, composite last.
    const calls = list.pass.calls;
    const at = (s: string) => calls.indexOf(s);
    expect(at('beginPass cozygpu mask coverage')).toBeLessThan(
      calls.indexOf('graphics draw'),
    );
    expect(calls.indexOf('graphics draw')).toBeLessThan(
      at('beginPass cozygpu mask capture'),
    );
    expect(calls.lastIndexOf('graphics draw')).toBeGreaterThan(
      at('beginPass cozygpu mask capture'),
    );
    expect(calls).toContain('pipeline cozygpu.mask.composite');
  });

  it('alpha under MSAA: the geometry draws multisampled and resolves', async () => {
    const backend = new MaskBackend();
    const system = createMaskCoreSystem();
    await system.init(createMaskContext(backend, 4));
    const first = encoder();
    externalMask(first, true);
    run(system, first, 1);
    await new Promise(r => setTimeout(r, 0));
    const second = encoder();
    externalMask(second, true, 9, true);
    const list = run(system, second, 2);
    const coverage = list.passes[1].color;
    expect((coverage.target as RhiTexture).sampleCount).toBe(4);
    expect((coverage.resolveTarget as RhiTexture).sampleCount).toBe(1);
    expect(list.pass.calls).toContain('pipeline cozygpu.mask.composite.invert');
  });
});
