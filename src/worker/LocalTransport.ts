/**
 * Owner: "worker". Main-thread transport: executes packets synchronously on a
 * RenderCore in the same heap. Zero copies: the core decodes the encoder's own
 * ArrayBuffer, and the same buffer is handed back for the next frame.
 */
import type { Capabilities } from '../backend/types';
import type { FramePacket } from '../commands/types';
import { createRenderCore } from '../renderer/RenderCore';
import { createLocalCoreSystems } from '../renderer/systems';
import { CozyGPUError } from '../types/errors';
import type { CoreInitOptions, RenderCore } from '../types/core';
import type { Canvas } from '../types/types';
import type { CoreMessage, Transport } from '../types/transport';
import { BufferRing } from './BufferRing';
import { errorMessage } from './errors';
import { MessageQueue } from './MessageQueue';

export async function createLocalTransport(
  canvas: Canvas,
  options: CoreInitOptions,
): Promise<Transport> {
  const transport = new LocalTransport();
  const core = await createRenderCore(
    canvas,
    options,
    createLocalCoreSystems(),
    transport.receive,
  );
  transport.attach(core);
  return transport;
}

/** @internal Exported for tests. */
export class LocalTransport implements Transport {
  public readonly kind = 'local' as const;
  public readonly sharedMemory = true;
  public readonly useSharedArrayBuffer = false;
  public readonly ring = false;

  private core: RenderCore | null = null;
  private destroyed = false;
  private lastSubmitted: ArrayBuffer | null = null;
  private readonly recycled = new BufferRing();
  private readonly queue = new MessageQueue();

  /**
   * The core acknowledges a packet synchronously unless the GPU is several
   * frames behind (frame pacing, RenderCore.ack): then the front skips frames
   * until the GPU catches up.
   */
  get busy(): boolean {
    return this.lastSubmitted !== null;
  }

  get caps(): Capabilities {
    if (this.core === null) {
      throw new CozyGPUError('DESTROYED', 'local transport has no core');
    }
    return this.core.caps;
  }

  get fallbackReason(): string | undefined {
    return this.core?.fallbackReason;
  }

  /** Dev-only (Transport.debug): the core is in this heap, so call it directly. */
  debug(action: 'loseDevice'): void {
    this.core?.debug?.(action);
  }

  /** @internal */
  attach(core: RenderCore): void {
    this.core = core;
  }

  /** The core's `post` callback (bound). */
  readonly receive = (message: CoreMessage): void => {
    if (message.type === 'frameDone') {
      const buffer = message.buffer ?? this.lastSubmitted;
      if (buffer !== null) this.recycled.push(buffer as ArrayBuffer);
      this.lastSubmitted = null;
    }
    this.queue.deliver(message);
  };

  submit(packet: FramePacket, _transfer: Transferable[]): void {
    const core = this.core;
    if (core === null || this.destroyed) {
      throw new CozyGPUError('DESTROYED', 'submit() on a destroyed transport');
    }
    this.lastSubmitted = packet.buffer as ArrayBuffer;
    try {
      core.execute(packet);
    } catch (error) {
      this.queue.deliver(errorMessage(error, 'INVALID_ARGUMENT'));
      if (this.lastSubmitted !== null) this.recycled.push(this.lastSubmitted);
      this.lastSubmitted = null;
    }
  }

  takeRecycledBuffer(): ArrayBuffer | undefined {
    return this.recycled.shift();
  }

  setListener(listener: (message: CoreMessage) => void): void {
    this.queue.setListener(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const core = this.core;
    this.core = null;
    this.recycled.clear();
    core?.destroy();
  }
}
