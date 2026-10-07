/** The default core systems, used by LocalTransport and the worker entry. */
import { createSpriteCoreSystem } from '../sprites/core';
import { OpcodeRange } from '../commands/opcodes';
import type { CommandReader } from '../commands/types';
import type { RenderPass } from '../backend/types';
import type { CoreFrameState, CoreSystem, DrawSpan } from '../types/core';
import { LazyCoreSystem } from './lazySystems';

/**
 * M5 (ARCHITECTURE §27.3). The retain core's placeholder: like any lazy
 * system, plus `drawSpan`, so RenderCore hands it the DRAW commands it
 * records. The real system is created on first use, as LazyCoreSystem does.
 */
class LazySpanSystem extends LazyCoreSystem {
  drawSpan(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    span: DrawSpan,
  ): number {
    const inner = this.resolve();
    if (inner && inner.drawSpan) {
      return inner.drawSpan(reader, pass, frame, span);
    }
    this.draw(reader, pass, frame);
    return 0;
  }
}

/**
 * Every system. The swarm core goes through a `LazyCoreSystem` in BOTH modes:
 * a static `import '../swarm/core'` in this module would pin ~33 KB of swarm
 * core (core.ts + coreGl.ts) into every sprite-only program, because this
 * module is also what `LocalTransport` imports (ARCHITECTURE §18.1).
 *
 * Who registers the factory decides when it loads:
 *   - worker bundle: `src/worker/entry.ts` registers it eagerly (the bundle
 *     already contains it, and the front never waits in worker mode);
 *   - main thread: `src/swarm/Swarm.ts` registers a loader, so the core
 *     arrives as its own chunk the first time a Swarm draws.
 */
export function createDefaultCoreSystems(): CoreSystem[] {
  return [
    createSpriteCoreSystem(),
    new LazyCoreSystem(OpcodeRange.SWARM, 'swarm'),
    // M3. Masks and filters are lazy in BOTH modes: their front modules
    // register the factory when `Group` pulls their chunk in (main thread),
    // and `src/worker/entry.ts` registers a loader for worker mode. Programs
    // without a Group never load either (ARCHITECTURE §21.6).
    new LazyCoreSystem(OpcodeRange.MASK, 'mask'),
    new LazyCoreSystem(OpcodeRange.FILTER, 'filter'),
    // M4. Graphics: the `graphics` front chunk registers the loader (main
    // thread), `src/worker/entry.ts` its own (ARCHITECTURE §26.7).
    new LazyCoreSystem(OpcodeRange.GRAPHICS, 'graphics'),
    // M5. Retained segments (§27.3): the `retain` front chunk registers the
    // loader; SpriteLayer (§28.3): the layer front chunk. The worker entry
    // registers both.
    new LazySpanSystem(OpcodeRange.RETAIN, 'retain'),
    new LazyCoreSystem(OpcodeRange.SPRITE_LAYER, 'layer'),
  ];
}

/**
 * Main-thread systems: sprites eagerly, swarm through a lazy placeholder, so a
 * program that never imports Swarm does not bundle the swarm core
 * (see ./lazySystems.ts).
 */
export function createLocalCoreSystems(): CoreSystem[] {
  return createDefaultCoreSystems();
}
