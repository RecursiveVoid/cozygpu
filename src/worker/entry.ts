/**
 * Owner: "worker+build". Worker bundle entry → dist/cozygpu.worker.js.
 * Receives WorkerInboundMessage ('init' | 'frame' | 'destroy'), creates the
 * RenderCore with createDefaultCoreSystems(), posts CoreMessage back.
 * DOM-free: only `globalThis` is used. Outside a worker scope (e.g. when the
 * module is imported by a test or bundler analysis) it does nothing.
 */
import { createCommandDecoder } from '../commands';
import { OpcodeRange } from '../commands/opcodes';
import type { FramePacket } from '../commands/types';
import { createRenderCore } from '../renderer/RenderCore';
import {
  isCoreSystemReady,
  loadCoreSystem,
  registerCoreSystemLoader,
} from '../renderer/lazySystems';
import { createDefaultCoreSystems } from '../renderer/systems';
import { startWorkerHost } from './host';
import type { WorkerScopeLike } from './host';

// Optional core systems are their own chunks in the worker too, so a
// sprite-only worker fetches none of them. The front never waits on
// `isSystemReady` in worker mode, so the host holds the first packet that
// carries commands of such a range until the chunk has loaded (pendingLoad).
const LAZY_RANGES = [
  OpcodeRange.SWARM,
  OpcodeRange.MASK,
  OpcodeRange.FILTER,
] as const;

registerCoreSystemLoader(OpcodeRange.SWARM, () =>
  import('../swarm/core').then(m => m.createSwarmCoreSystem),
);
registerCoreSystemLoader(OpcodeRange.MASK, () =>
  import('../masks/core').then(m => m.createMaskCoreSystem),
);
registerCoreSystemLoader(OpcodeRange.FILTER, () =>
  import('../filters/core').then(m => m.createFilterCoreSystem),
);

const scan = createCommandDecoder();
/** Ranges already loaded; once every one is in, the scan stops running. */
let readyRanges = 0;
const ALL_READY = (1 << LAZY_RANGES.length) - 1;

/** Header walk of `packet` until every lazy range it needs has loaded. */
function pendingLoad(packet: FramePacket): Promise<void> | null {
  if (readyRanges === ALL_READY) return null;
  try {
    scan.reset(packet);
    while (scan.next()) {
      const range = scan.reader.opcode >>> 8;
      const index = LAZY_RANGES.indexOf(range as (typeof LAZY_RANGES)[number]);
      if (index < 0 || (readyRanges & (1 << index)) !== 0) continue;
      if (isCoreSystemReady(range)) {
        readyRanges |= 1 << index;
        continue;
      }
      return loadCoreSystem(range);
    }
  } catch {
    // A corrupt packet is the core's to report.
  }
  return null;
}

const scope = globalThis as unknown as {
  WorkerGlobalScope?: new () => unknown;
};

if (
  typeof scope.WorkerGlobalScope === 'function' &&
  globalThis instanceof scope.WorkerGlobalScope
) {
  startWorkerHost(globalThis as unknown as WorkerScopeLike, {
    createRenderCore,
    createSystems: createDefaultCoreSystems,
    pendingLoad,
  });
}
