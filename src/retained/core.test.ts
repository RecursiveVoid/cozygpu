/**
 * Retain core (ARCHITECTURE §27.3) behind the real RenderCore: RETAIN_BEGIN …
 * RETAIN_END spans recorded through `drawSpan`, replayed by RETAIN_DRAW as
 * commands or bundles, re-recorded on invalidate() / skipped() / a pass the
 * bundle does not fit, replayed into the pick pass, freed by RETAIN_DESTROY.
 */
import type {
  Backend,
  RenderBundleEncoder,
  RenderPass,
  RhiRenderBundle,
} from '../backend/types';
import { createCommandEncoder } from '../commands';
import { CommandFlag, Op, OpcodeRange } from '../commands/opcodes';
import { RetainFlag, RetainOp } from '../commands/retainOpcodes';
import type { CommandEncoder, CommandReader } from '../commands/types';
import { RenderCoreImpl } from '../renderer/RenderCore';
import { FakeBackend } from '../renderer/testing/fakeBackend';
import type {
  CoreContext,
  CoreFrameState,
  CoreSystem,
  RetainHooks,
} from '../types/core';
import type { CoreMessage } from '../types/transport';
import { RetainCoreSystem, createRetainCoreSystem } from './core';

const DRAW_A = 0x0210; // a sprite-range DRAW opcode
const STEP = 0x0202; // a sprite-range non-DRAW opcode

/** A sprite-range system that logs what it draws, into which pass. */
class LogSystem implements CoreSystem {
  readonly name = 'log';
  readonly range = OpcodeRange.SPRITE;
  ctx: CoreContext | null = null;
  /** Draws to skip (pipeline "compiling"). */
  skip = 0;
  /** Sets a scissor before drawing (pass state a bundle cannot hold). */
  scissor = false;
  constructor(private readonly log: string[]) {}
  async init(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
  }
  execute(reader: CommandReader): void {
    this.log.push(`execute ${reader.u32()}`);
  }
  draw(reader: CommandReader, pass: RenderPass): void {
    const v = reader.u32();
    if (this.skip > 0) {
      this.skip--;
      this.ctx!.retain?.skipped();
      this.log.push(`skip ${v}`);
      return;
    }
    if (this.scissor) pass.setScissor(0, 0, 1, 1);
    pass.draw(v);
  }
  drawPick(reader: CommandReader): void {
    this.log.push(`pick ${reader.u32()}`);
  }
  async restore(): Promise<void> {}
  destroy(): void {}
}

/** Bundles over the fake backend: a bundle is the list of draws it holds. */
function installBundles(backend: FakeBackend, log: string[]): { key: string } {
  const pass = (backend as unknown as { renderPass: RenderPass }).renderPass;
  const state = { key: 'main' };
  pass.executeBundle = (bundle: RhiRenderBundle) => {
    const b = bundle as unknown as { key: string; draws: number[] };
    if (b.key !== state.key) return false;
    log.push(`bundle [${b.draws.join(',')}]`);
    return true;
  };
  (backend as unknown as Backend).createRenderBundleEncoder =
    (): RenderBundleEncoder => {
      const draws: number[] = [];
      let ok = true;
      log.push('record');
      const key = state.key;
      return {
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        setViewport() {},
        setScissor: () => {
          ok = false;
        },
        setStencilReference() {},
        draw: (n: number) => void draws.push(n),
        drawIndexed() {},
        drawIndirect() {},
        end() {},
        finish: () =>
          ok
            ? ({
                key,
                draws,
                label: 'b',
                destroy() {},
              } as unknown as RhiRenderBundle)
            : null,
      };
    };
  return state;
}

function setup() {
  const backend = new FakeBackend();
  const log = backend.calls;
  const messages: CoreMessage[] = [];
  const system = new LogSystem(log);
  const retain = createRetainCoreSystem() as RetainCoreSystem;
  const core = new RenderCoreImpl(
    backend,
    { backend: 'auto', antialias: false },
    [system, retain],
    message => messages.push({ ...message } as CoreMessage),
  );
  return { backend, log, messages, system, retain, core };
}

class Packet {
  readonly enc: CommandEncoder = createCommandEncoder();
  constructor() {
    this.enc.reset();
    this.cmd(Op.FRAME_BEGIN, [0, 0]);
  }
  cmd(op: number, words: number[], flags = 0): this {
    this.enc.begin(op, words.length * 4, flags);
    for (const w of words) this.enc.u32(w);
    this.enc.end();
    return this;
  }
  draw(v: number): this {
    return this.cmd(DRAW_A, [v], CommandFlag.DRAW);
  }
  begin(id: number, flags = 0): this {
    return this.cmd(RetainOp.RETAIN_BEGIN, [id, flags], CommandFlag.DRAW);
  }
  end(id: number): this {
    return this.cmd(RetainOp.RETAIN_END, [id], CommandFlag.DRAW);
  }
  replay(id: number): this {
    return this.cmd(RetainOp.RETAIN_DRAW, [id], CommandFlag.DRAW);
  }
  run(core: RenderCoreImpl, log: string[], frameId = 1): string[] {
    this.cmd(Op.FRAME_END, []);
    log.length = 0;
    core.execute(this.enc.finish(frameId));
    return log.filter(
      l =>
        l.startsWith('draw') ||
        l.startsWith('bundle') ||
        l.startsWith('record') ||
        l.startsWith('skip') ||
        l.startsWith('execute') ||
        l.startsWith('pick'),
    );
  }
}

describe('retain core: commands only (no bundles)', () => {
  it('records a span while drawing it, and the core continues after it', async () => {
    const { core, log, retain } = setup();
    await core.init();
    const out = new Packet()
      .draw(1)
      .begin(5)
      .draw(2)
      .cmd(STEP, [9])
      .draw(3)
      .end(5)
      .draw(4)
      .run(core, log);
    // Non-DRAW commands inside run in the decode phase, as always.
    expect(out).toEqual(['execute 9', 'draw 1', 'draw 2', 'draw 3', 'draw 4']);
    expect(retain.recorded).toBe(1);
  });

  it('RETAIN_DRAW replays the stored commands through their systems', async () => {
    const { core, log, retain } = setup();
    await core.init();
    new Packet().begin(1).draw(7).draw(8).end(1).run(core, log);
    const out = new Packet().draw(0).replay(1).draw(9).run(core, log, 2);
    expect(out).toEqual(['draw 0', 'draw 7', 'draw 8', 'draw 9']);
    expect(retain.replayed).toBe(1);
  });

  it('BEGIN replaces a segment; DESTROY frees it; unknown ids draw nothing once', async () => {
    const { core, log, messages } = setup();
    await core.init();
    new Packet().begin(1).draw(1).end(1).run(core, log);
    new Packet().begin(1).draw(2).end(1).run(core, log, 2);
    expect(new Packet().replay(1).run(core, log, 3)).toEqual(['draw 2']);
    new Packet().cmd(RetainOp.RETAIN_DESTROY, [1]).run(core, log, 4);
    expect(new Packet().replay(1).replay(1).run(core, log, 5)).toEqual([]);
    expect(
      messages.filter(m => m.type === 'error' && /segment 1/.test(m.message))
        .length,
    ).toBe(1);
  });

  it('installs ctx.retain and replays segments into the pick pass', async () => {
    const { core, log, system, retain } = setup();
    await core.init();
    expect(system.ctx!.retain).toBe(retain as RetainHooks);
    new Packet().begin(2).draw(4).draw(5).end(2).run(core, log);
    const pass = { draw() {} } as unknown as RenderPass;
    const enc = new Packet().replay(2);
    enc.cmd(Op.FRAME_END, []);
    const packet = enc.enc.finish(2);
    // Replay the RETAIN_DRAW command into a pick pass by hand.
    const { createCommandDecoder } = await import('../commands');
    const decoder = createCommandDecoder();
    decoder.reset(packet);
    log.length = 0;
    while (decoder.next()) {
      if (decoder.reader.opcode === RetainOp.RETAIN_DRAW) {
        retain.drawPick(decoder.reader, pass, {} as CoreFrameState, {
          label: 'view',
          destroy() {},
        });
      }
    }
    expect(log).toEqual(['pick 4', 'pick 5']);
  });
});

describe('retain core: bundles', () => {
  it('records into a bundle, executes it, and replays the bundle', async () => {
    const { core, log, backend } = setup();
    installBundles(backend, log);
    await core.init();
    expect(new Packet().begin(1).draw(1).draw(2).end(1).run(core, log)).toEqual(
      ['record', 'bundle [1,2]'],
    );
    expect(new Packet().replay(1).replay(1).run(core, log, 2)).toEqual([
      'bundle [1,2]',
      'bundle [1,2]',
    ]);
  });

  it('re-records after invalidate() and for a pass the bundle does not fit', async () => {
    const { core, log, backend, retain } = setup();
    const state = installBundles(backend, log);
    await core.init();
    new Packet().begin(1).draw(3).end(1).run(core, log);
    retain.invalidate();
    expect(new Packet().replay(1).run(core, log, 2)).toEqual([
      'record',
      'bundle [3]',
    ]);
    // Another pass layout: a second variant, then both are kept.
    state.key = 'capture';
    expect(new Packet().replay(1).run(core, log, 3)).toEqual([
      'record',
      'bundle [3]',
    ]);
    expect(new Packet().replay(1).run(core, log, 4)).toEqual(['bundle [3]']);
    state.key = 'main';
    expect(new Packet().replay(1).run(core, log, 5)).toEqual(['bundle [3]']);
  });

  it('a skipped draw keeps no bundle: the next use records again', async () => {
    const { core, log, backend, system } = setup();
    installBundles(backend, log);
    await core.init();
    system.skip = 1;
    expect(new Packet().begin(1).draw(1).draw(2).end(1).run(core, log)).toEqual(
      ['record', 'skip 1', 'bundle [2]'],
    );
    expect(new Packet().replay(1).run(core, log, 2)).toEqual([
      'record',
      'bundle [1,2]',
    ]);
    expect(new Packet().replay(1).run(core, log, 3)).toEqual(['bundle [1,2]']);
  });

  it('NO_BUNDLE and pass-state calls keep the segment as commands', async () => {
    const { core, log, backend, system } = setup();
    installBundles(backend, log);
    await core.init();
    expect(
      new Packet()
        .begin(1, RetainFlag.NO_BUNDLE)
        .draw(1)
        .end(1)
        .replay(1)
        .run(core, log),
    ).toEqual(['draw 1', 'draw 1']);
    system.scissor = true;
    // The bundle comes back null: drawn as commands now and from then on.
    expect(new Packet().begin(2).draw(5).end(2).run(core, log, 2)).toEqual([
      'record',
      'draw 5',
    ]);
    expect(new Packet().replay(2).run(core, log, 3)).toEqual(['draw 5']);
  });

  it('restore drops every segment', async () => {
    const { core, log, backend, retain, system } = setup();
    installBundles(backend, log);
    await core.init();
    new Packet().begin(1).draw(1).end(1).run(core, log);
    await retain.restore(system.ctx!);
    expect(new Packet().replay(1).run(core, log, 2)).toEqual([]);
  });

  it('old-generation RETAIN_DRAW after a restore is dropped without a report', async () => {
    const { core, log, retain, system, messages } = setup();
    await core.init();
    new Packet().begin(1).draw(1).end(1).run(core, log);
    await retain.restore(system.ctx!);
    // Packets the front encoded before it saw the new generation.
    for (let f = 2; f < 6; f++) {
      expect(new Packet().replay(1).replay(3).run(core, log, f)).toEqual([]);
    }
    const unknown = () =>
      messages.filter(m => m.type === 'error' && /unknown/.test(m.message));
    expect(unknown()).toEqual([]);
    // The front re-records; much later an unknown id is a real bug again.
    new Packet().begin(1).draw(2).end(1).run(core, log, 6);
    for (let f = 7; f < 40; f++) new Packet().replay(1).run(core, log, f);
    new Packet().replay(9).run(core, log, 40);
    expect(unknown().length).toBe(1);
  });
});
