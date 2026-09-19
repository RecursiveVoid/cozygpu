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

// The swarm core (~10 KB min+gzip) is its own chunk in the worker too, so a
// sprite-only worker does not fetch it. The front never waits on
// `isSystemReady` in worker mode, so the host holds the first packet with
// SWARM commands until the chunk has loaded (pendingLoad below).
registerCoreSystemLoader(OpcodeRange.SWARM, () =>
  import('../swarm/core').then(m => m.createSwarmCoreSystem),
);

const scan = createCommandDecoder();
let swarmReady = false;

/** Header walk of `packet` until the swarm core is loaded (then free). */
function pendingLoad(packet: FramePacket): Promise<void> | null {
  if (swarmReady) return null;
  try {
    scan.reset(packet);
    while (scan.next()) {
      if (scan.reader.opcode >>> 8 !== OpcodeRange.SWARM) continue;
      if (isCoreSystemReady(OpcodeRange.SWARM)) {
        swarmReady = true;
        return null;
      }
      return loadCoreSystem(OpcodeRange.SWARM);
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
