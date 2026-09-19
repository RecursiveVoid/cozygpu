import type { CommandReader } from '../commands/types';
import type { CoreContext, CoreFrameState, CoreSystem } from '../types/core';
import * as mod from './lazySystems';
import { LazyCoreSystem, registerCoreSystemFactory } from './lazySystems';

const RANGE = 0x7e; // unused by real systems

function fakeSystem(log: string[]): CoreSystem {
  return {
    name: 'fake',
    range: RANGE,
    init: async () => {
      log.push('init');
    },
    execute: () => {
      log.push('execute');
    },
    draw: () => {
      log.push('draw');
    },
    endFrame: () => {
      log.push('endFrame');
    },
    readback: () => Promise.resolve(new ArrayBuffer(4)),
    restore: async () => {
      log.push('restore');
    },
    destroy: () => {
      log.push('destroy');
    },
  };
}

describe('LazyCoreSystem', () => {
  it('ignores commands until a factory is registered, then creates the system once', async () => {
    const log: string[] = [];
    const lazy = new LazyCoreSystem(RANGE, 'fake');
    const ctx = { post: () => undefined } as unknown as CoreContext;
    const reader = {} as CommandReader;
    const frame = {} as CoreFrameState;
    await lazy.init(ctx);
    lazy.execute(reader, frame);
    lazy.draw(reader, {} as never, frame);
    expect(lazy.readback(0, 0, 0, 1)).toBeUndefined();
    expect(log).toEqual([]);

    let created = 0;
    registerCoreSystemFactory(RANGE, () => {
      created++;
      return fakeSystem(log);
    });
    lazy.execute(reader, frame);
    lazy.execute(reader, frame);
    lazy.draw(reader, {} as never, frame);
    lazy.endFrame(frame);
    expect(created).toBe(1);
    expect(log).toEqual(['init', 'execute', 'execute', 'draw', 'endFrame']);
    expect(lazy.readback(0, 0, 0, 1)).toBeInstanceOf(Promise);

    await lazy.restore(ctx);
    lazy.destroy();
    lazy.execute(reader, frame);
    expect(log.slice(-2)).toEqual(['restore', 'destroy']);
    expect(created).toBe(1);
  });

  it('forwards drawPick to a system that supports picking', async () => {
    const range = 0x7b;
    const log: string[] = [];
    const lazy = new LazyCoreSystem(range, 'fake');
    await lazy.init({ post: () => undefined } as unknown as CoreContext);
    const reader = {} as CommandReader;
    const frame = {} as CoreFrameState;
    // RenderCore only calls drawPick when the property exists.
    expect(typeof (lazy as CoreSystem).drawPick).toBe('function');
    lazy.drawPick(reader, {} as never, frame, {} as never);
    registerCoreSystemFactory(range, () => ({
      ...fakeSystem(log),
      range,
      drawPick: () => {
        log.push('drawPick');
      },
    }));
    lazy.execute(reader, frame);
    lazy.drawPick(reader, {} as never, frame, {} as never);
    expect(log).toEqual(['init', 'execute', 'drawPick']);
  });
});

describe('core system loaders (§18.1)', () => {
  const LOADER_RANGE = 0x7d;

  it('starts the import on the first readiness check and becomes ready', async () => {
    const log: string[] = [];
    let calls = 0;
    let resolveLoad!: () => void;
    const gate = new Promise<void>(r => (resolveLoad = r));
    mod.registerCoreSystemLoader(LOADER_RANGE, async () => {
      calls++;
      await gate;
      return () => ({ ...fakeSystem(log), range: LOADER_RANGE });
    });
    expect(calls).toBe(0); // registration alone loads nothing
    expect(mod.isCoreSystemReady(LOADER_RANGE)).toBe(false);
    expect(mod.isCoreSystemReady(LOADER_RANGE)).toBe(false);
    expect(calls).toBe(1);
    resolveLoad();
    await mod.loadCoreSystem(LOADER_RANGE);
    expect(mod.isCoreSystemReady(LOADER_RANGE)).toBe(true);
    expect(calls).toBe(1);

    const lazy = new mod.LazyCoreSystem(LOADER_RANGE, 'fake');
    await lazy.init({ post: () => undefined } as unknown as CoreContext);
    lazy.execute({} as CommandReader, {} as CoreFrameState);
    expect(log).toEqual(['init', 'execute']);
  });

  it('retries after a failed import and ranges without loaders are ready', async () => {
    const range = 0x7c;
    expect(mod.isCoreSystemReady(range)).toBe(true);
    let attempts = 0;
    mod.registerCoreSystemLoader(range, async () => {
      attempts++;
      if (attempts === 1) throw new Error('network');
      return () => fakeSystem([]);
    });
    await expect(mod.loadCoreSystem(range)).rejects.toThrow('network');
    await mod.loadCoreSystem(range);
    expect(attempts).toBe(2);
    expect(mod.isCoreSystemReady(range)).toBe(true);
  });
});
