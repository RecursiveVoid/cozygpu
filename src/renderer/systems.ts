/** Owner: "worker+build". The default core systems, used by LocalTransport and the worker entry. */
import { createSpriteCoreSystem } from '../sprites/core';
import { OpcodeRange } from '../commands/opcodes';
import type { CoreSystem } from '../types/core';
import { LazyCoreSystem } from './lazySystems';

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
