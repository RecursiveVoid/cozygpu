/**
 * Front half of device interop (ARCHITECTURE §19.4),
 * a lazily imported chunk: `renderer.interop()` loads it on first use, so the
 * minimal program pays only for the method stub. Main-thread mode only: the
 * core half (coreInterop.ts, re-exported here so it ships in this chunk) is
 * built over the local core through LocalTransport.interop(create).
 *
 * Registration is rare (not per frame) and may allocate.
 */
import { BufferUsage } from '../backend/types';
import type { CoreInterop } from '../types/core';
import { CozyGPUError } from '../types/errors';
import { ids } from '../types/ids';
import type {
  ExternalInstanceBuffer,
  ExternalInstanceBufferDesc,
  ExternalLayout,
  RendererInterop,
} from '../types/interop';
import { SWARM_COLD_BYTES, SWARM_HOT_BYTES } from '../types/layouts';
// Not '../types/layerLayouts': see src/layer/format.ts.
import { INDIRECT_BYTES, STREAM_BYTES } from '../layer/format';

export { createCoreInterop } from './coreInterop';

/** What the handle needs from the renderer. */
export interface InteropOwner {
  readonly destroyed: boolean;
  /** Capabilities decide how an imported buffer is bound (storage or vertex). */
  readonly _caps: { readonly storageBuffers: boolean };
}

/** By LayerStream. */
const LAYER_LAYOUTS: ExternalLayout[] = [
  'layer-position',
  'layer-xform',
  'layer-color',
  'layer-user',
];

function recordBytes(layout: ExternalLayout): number {
  if (layout === 'swarm-hot') return SWARM_HOT_BYTES;
  if (layout === 'swarm-cold') return SWARM_COLD_BYTES;
  // M5 SpriteLayer streams and the GPU-written draw count (§28.5).
  const stream = LAYER_LAYOUTS.indexOf(layout);
  if (stream >= 0) return STREAM_BYTES[stream];
  if (layout === 'draw-indirect') return INDIRECT_BYTES;
  throw new CozyGPUError(
    layout === 'sprite-instance' ? 'UNSUPPORTED' : 'INVALID_ARGUMENT',
    `registerInstanceBuffer: layout '${String(layout)}' is not supported`,
  );
}

class ExternalBuffer implements ExternalInstanceBuffer {
  private released = false;

  constructor(
    private readonly core: CoreInterop,
    private readonly owner: InteropOwner,
    readonly id: number,
    readonly layout: ExternalLayout,
    readonly capacity: number,
    private readonly epoch: number,
  ) {}

  get valid(): boolean {
    return (
      !this.released &&
      !this.owner.destroyed &&
      this.epoch === this.core.lossEpoch
    );
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    // The id is never reused: a node still pointing at it draws nothing
    // instead of drawing a later registration (ARCHITECTURE §19.4).
    if (!this.owner.destroyed) this.core.releaseBuffer(this.id);
  }
}

class Interop implements RendererInterop {
  constructor(
    private readonly core: CoreInterop,
    private readonly owner: InteropOwner,
  ) {}

  get backend(): RendererInterop['backend'] {
    return this.core.backend;
  }

  get device(): unknown {
    return this.core.device();
  }

  registerInstanceBuffer(
    buffer: unknown,
    desc: ExternalInstanceBufferDesc,
  ): ExternalInstanceBuffer {
    const owner = this.owner;
    if (owner.destroyed) {
      throw new CozyGPUError('DESTROYED', 'renderer was destroyed');
    }
    const record = recordBytes(desc?.layout);
    const capacity = desc.capacity;
    if (
      buffer === null ||
      typeof buffer !== 'object' ||
      !Number.isInteger(capacity) ||
      capacity < 1
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'registerInstanceBuffer(buffer, { layout, capacity }): need a native buffer and an integer capacity >= 1',
      );
    }
    const indirect = desc.layout === 'draw-indirect';
    if (indirect && !owner._caps.storageBuffers) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        "registerInstanceBuffer: 'draw-indirect' needs the WebGPU backend",
      );
    }
    const core = this.core;
    const epoch = core.lossEpoch;
    const id = ids.external.alloc();
    core.registerBuffer(id, buffer, {
      label: desc.label,
      size: capacity * record,
      usage: indirect
        ? BufferUsage.INDIRECT
        : owner._caps.storageBuffers
          ? BufferUsage.STORAGE
          : BufferUsage.VERTEX,
    });
    return new ExternalBuffer(core, owner, id, desc.layout, capacity, epoch);
  }

  invalidateState(): void {
    if (!this.owner.destroyed) this.core.invalidateState();
  }
}

export function createInterop(
  core: CoreInterop,
  owner: InteropOwner,
): RendererInterop {
  return new Interop(core, owner);
}
