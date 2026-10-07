/**
 * Worker transport (docs/ARCHITECTURE.md §8).
 *
 *  - Hands the canvas to the worker with transferControlToOffscreen() and waits
 *    for `ready{caps}` (10 s timeout → UNSUPPORTED).
 *  - One frame in flight: `submit()` transfers the packet buffer (plus
 *    ImageBitmaps) and `busy` stays true until the matching `frameDone`
 *    returns the buffer, which then goes to the recycle ring.
 *  - When crossOriginIsolated, the worker also writes the acknowledged
 *    frameId into a shared Int32Array before posting frameDone, and `busy`
 *    reads it. The frameDone message task usually runs only after the next
 *    rAF callback when the page is busy, which used to skip about every
 *    other frame under heavy scenes although the worker had finished in
 *    under a millisecond. The buffer still returns with the message; until
 *    then the encoder uses (and later recycles) a second buffer.
 *  - `sharedMemory` / `useSharedArrayBuffer` are true when the page is
 *    crossOriginIsolated, so stores can use SharedArrayBuffer + *_SHARED ops.
 *  - M2 command ring (ARCHITECTURE §17), crossOriginIsolated only: two
 *    SharedArrayBuffer slots + a 16 B control block (RingControl). The
 *    encoder writes into a free slot, `submit()` stores slot / frameId /
 *    byteLength and posts the slot index as a bare number. The worker acks
 *    through ACK_FRAME_ID only (no frameDone), so a steady frame allocates
 *    nothing on either side except the doorbell's MessageEvent. Packets with
 *    objects keep the frame message (the slot is shared, objects are
 *    transferred); a packet that outgrew its slot travels as a transferred
 *    ArrayBuffer and the slot is replaced (`ringSlot`). Set
 *    `globalThis.__COZYGPU_RING__ = false` before createRenderer to force the
 *    transfer path (diagnostics / comparisons).
 */
import type { Capabilities } from '../backend/types';
import type { FramePacket } from '../commands/types';
import { CozyGPUError } from '../types/errors';
import type { CoreInitOptions } from '../types/core';
import {
  RING_CONTROL_BYTES,
  RingControl,
  type CoreMessage,
  type Transport,
  type WorkerInboundMessage,
} from '../types/transport';
import { BufferRing } from './BufferRing';
import { toCozyGPUError } from './errors';
import { MessageQueue } from './MessageQueue';

export const WORKER_READY_TIMEOUT_MS = 10_000;
/** Grace period for the worker to destroy its core before it is terminated. */
export const WORKER_TERMINATE_DELAY_MS = 500;
/** Number of command ring slots (ARCHITECTURE §17). */
export const RING_SLOTS = 2;
/** Initial ring slot size; slots are replaced by larger ones on growth. */
export const RING_SLOT_BYTES = 64 * 1024;

const NO_TRANSFER: Transferable[] = [];

/** The subset of `Worker` the transport uses (lets tests pass a fake). */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export function sharedMemoryAvailable(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean };
  return (
    g.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined'
  );
}

/** The command ring is used unless disabled with `__COZYGPU_RING__ = false`. */
export function ringAvailable(): boolean {
  const g = globalThis as { __COZYGPU_RING__?: boolean };
  return sharedMemoryAvailable() && g.__COZYGPU_RING__ !== false;
}

export async function createWorkerTransport(
  canvas: HTMLCanvasElement,
  options: CoreInitOptions,
  workerUrl: string | URL,
  initialSize: { cssWidth: number; cssHeight: number; resolution: number },
): Promise<Transport> {
  if (typeof Worker === 'undefined') {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'worker mode needs Web Worker support',
    );
  }
  if (typeof canvas.transferControlToOffscreen !== 'function') {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'worker mode needs OffscreenCanvas (transferControlToOffscreen)',
    );
  }
  let offscreen: OffscreenCanvas;
  try {
    offscreen = canvas.transferControlToOffscreen();
  } catch (error) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `worker mode needs a canvas without a context that was never transferred (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  const worker = new Worker(workerUrl, { type: 'module', name: 'cozygpu' });
  return connectWorkerTransport(worker, offscreen, options, initialSize);
}

/** @internal Handshake over an existing worker; exported for tests. */
export function connectWorkerTransport(
  worker: WorkerLike,
  offscreen: OffscreenCanvas,
  options: CoreInitOptions,
  initialSize: { cssWidth: number; cssHeight: number; resolution: number },
  timeoutMs: number = WORKER_READY_TIMEOUT_MS,
): Promise<Transport> {
  const useRing = ringAvailable();
  const frameSignal = sharedMemoryAvailable()
    ? new SharedArrayBuffer(useRing ? RING_CONTROL_BYTES : 4)
    : undefined;
  let ring: SharedArrayBuffer[] | undefined;
  if (useRing) {
    ring = [];
    for (let i = 0; i < RING_SLOTS; i++) {
      ring.push(new SharedArrayBuffer(RING_SLOT_BYTES));
    }
  }
  const transport = new WorkerTransport(worker, frameSignal, ring);
  return new Promise<Transport>((resolve, reject) => {
    let settled = false;
    const fail = (error: CozyGPUError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.kill();
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          new CozyGPUError(
            'UNSUPPORTED',
            `worker did not become ready within ${timeoutMs} ms`,
          ),
        ),
      timeoutMs,
    );
    transport.onHandshake = (message: CoreMessage | null, error?: string) => {
      if (settled) return;
      if (message === null) {
        fail(
          new CozyGPUError(
            'UNSUPPORTED',
            `worker failed to start: ${error ?? 'unknown error'}`,
          ),
        );
      } else if (message.type === 'ready') {
        settled = true;
        clearTimeout(timer);
        transport.onReady(message.caps, message.fallbackReason);
        resolve(transport);
      } else if (message.type === 'error') {
        fail(toCozyGPUError(message.code, message.message));
      }
    };

    const init: WorkerInboundMessage = {
      type: 'init',
      canvas: offscreen,
      options,
      cssWidth: initialSize.cssWidth,
      cssHeight: initialSize.cssHeight,
      resolution: initialSize.resolution,
    };
    if (frameSignal) init.frameSignal = frameSignal;
    if (ring) init.ring = ring.slice();
    try {
      worker.postMessage(init, [offscreen]);
    } catch (error) {
      fail(
        new CozyGPUError(
          'UNSUPPORTED',
          `could not post the OffscreenCanvas to the worker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

class WorkerTransport implements Transport {
  public readonly kind = 'worker' as const;
  public readonly sharedMemory = sharedMemoryAvailable();
  public readonly useSharedArrayBuffer = this.sharedMemory;
  /** M2 command ring (ARCHITECTURE §17). */
  public readonly ring: boolean;

  /** @internal Set by connectWorkerTransport until the handshake settles. */
  public onHandshake:
    | ((message: CoreMessage | null, error?: string) => void)
    | null = null;

  private capabilities: Capabilities | null = null;
  private ready = false;
  private destroyed = false;
  private inFlight = false;
  private inFlightFrameId = 0;
  private readonly recycled = new BufferRing();
  private readonly queue = new MessageQueue();
  /** Reused frame message: postMessage clones it synchronously. */
  private readonly frameMessage: { type: 'frame'; packet: FramePacket | null } =
    {
      type: 'frame',
      packet: null,
    };

  /** Control block (RingControl); index 0 = last acked frameId. Null without SAB. */
  private readonly frameSignal: Int32Array | null;
  /** Ring slots (empty without the ring). */
  private readonly slots: SharedArrayBuffer[];
  /** Slot handed out by the last takeRecycledBuffer(). */
  private takenSlot = 0;
  /** Slot of the in-flight ring packet, or -1. */
  private inFlightSlot = -1;
  /** Reused transfer list for ring-slot packets that carry objects. */
  private readonly objectTransfer: Transferable[] = [];
  /** Reused ringSlot message (rare: growth). */
  private readonly ringSlotMessage = {
    type: 'ringSlot' as const,
    slot: 0,
    buffer: null as SharedArrayBuffer | null,
  };

  constructor(
    private readonly worker: WorkerLike,
    frameSignal?: SharedArrayBuffer,
    ring?: SharedArrayBuffer[],
  ) {
    this.frameSignal = frameSignal
      ? new Int32Array(
          frameSignal,
          0,
          Math.min(frameSignal.byteLength, RING_CONTROL_BYTES) >> 2,
        )
      : null;
    this.slots =
      ring && this.frameSignal !== null && this.frameSignal.length >= 4
        ? ring.slice()
        : [];
    this.ring = this.slots.length > 0;
    worker.onmessage = this.onMessage;
    worker.onerror = this.onError;
    worker.onmessageerror = this.onMessageError;
  }

  /** Set from the core's ready message when 'auto' fell back to WebGL2. */
  fallbackReason: string | undefined = undefined;

  get caps(): Capabilities {
    if (this.capabilities === null) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'worker transport is not ready',
      );
    }
    return this.capabilities;
  }

  get busy(): boolean {
    if (
      this.inFlight &&
      this.frameSignal !== null &&
      Atomics.load(this.frameSignal, RingControl.ACK_FRAME_ID) ===
        (this.inFlightFrameId | 0)
    ) {
      this.inFlight = false;
      this.inFlightSlot = -1;
    }
    return this.inFlight;
  }

  /** @internal */
  onReady(caps: Capabilities, fallbackReason?: string): void {
    this.capabilities = caps;
    this.fallbackReason = fallbackReason;
    this.ready = true;
    this.onHandshake = null;
  }

  submit(packet: FramePacket, transfer: Transferable[]): void {
    if (this.destroyed || !this.ready) {
      throw new CozyGPUError(
        'DESTROYED',
        'submit() on a destroyed or unready worker transport',
      );
    }
    if (this.busy) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'submit() while busy: check transport.busy and skip the frame',
      );
    }
    const buffer = packet.buffer;
    const slot = this.ring
      ? this.slots.indexOf(buffer as SharedArrayBuffer)
      : -1;
    if (slot >= 0) {
      this.submitRing(packet, slot, transfer);
      return;
    }
    if (isShared(buffer)) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'submit(): a SharedArrayBuffer packet must be a ring slot of this transport',
      );
    }
    // Read before posting: the transfer detaches the buffer.
    const bufferBytes = buffer.byteLength;
    // The buffer must travel by transfer, never by copy.
    if (transfer.indexOf(buffer) < 0) transfer.push(buffer);
    const message = this.frameMessage;
    message.packet = packet;
    try {
      this.worker.postMessage(message, transfer);
    } finally {
      message.packet = null;
    }
    this.inFlight = true;
    this.inFlightFrameId = packet.frameId;
    // No ring slot is in flight: this packet travels by transfer.
    this.inFlightSlot = -1;
    // The encoder outgrew its ring slot: replace that slot with a larger one
    // so the next frames use the ring again.
    if (this.ring && bufferBytes > this.slots[this.takenSlot].byteLength) {
      this.growSlot(this.takenSlot, bufferBytes);
    }
  }

  private submitRing(
    packet: FramePacket,
    slot: number,
    transfer: Transferable[],
  ): void {
    const control = this.frameSignal as Int32Array;
    Atomics.store(control, RingControl.SUBMITTED_SLOT, slot);
    Atomics.store(control, RingControl.SUBMITTED_FRAME_ID, packet.frameId | 0);
    Atomics.store(
      control,
      RingControl.SUBMITTED_BYTE_LENGTH,
      packet.byteLength,
    );
    if (packet.objects.length === 0) {
      // Doorbell: the slot index as a bare number (WorkerDoorbell).
      this.worker.postMessage(slot, NO_TRANSFER);
    } else {
      // Objects need the frame message; the slot itself is shared (a
      // SharedArrayBuffer in a transfer list throws).
      const list = this.objectTransfer;
      let n = 0;
      for (let i = 0; i < transfer.length; i++) {
        const t = transfer[i];
        if (t === packet.buffer || isShared(t)) continue;
        list[n++] = t;
      }
      list.length = n;
      const message = this.frameMessage;
      message.packet = packet;
      try {
        this.worker.postMessage(message, list);
      } finally {
        message.packet = null;
        list.length = 0;
      }
    }
    this.inFlight = true;
    this.inFlightFrameId = packet.frameId;
    this.inFlightSlot = slot;
  }

  private growSlot(slot: number, minBytes: number): void {
    let size = this.slots[slot].byteLength;
    while (size < minBytes) size *= 2;
    const buffer = new SharedArrayBuffer(size);
    this.slots[slot] = buffer;
    const message = this.ringSlotMessage;
    message.slot = slot;
    message.buffer = buffer;
    try {
      this.worker.postMessage(message, NO_TRANSFER);
    } finally {
      message.buffer = null;
    }
  }

  /** Dev-only (Transport.debug): drives a core-side action inside the worker. */
  debug(action: 'loseDevice'): void {
    if (this.destroyed || !this.ready) return;
    this.worker.postMessage({ type: 'debug', action }, NO_TRANSFER);
  }

  takeRecycledBuffer(): ArrayBuffer | SharedArrayBuffer | undefined {
    if (this.ring) {
      // Any slot that is not in flight. `busy` was false when the Renderer
      // started this frame, so normally the last slot is reused (warm views).
      let slot = this.takenSlot;
      if (slot === this.inFlightSlot && !this.acked()) {
        slot = (slot + 1) % this.slots.length;
      }
      this.takenSlot = slot;
      return this.slots[slot];
    }
    return this.recycled.shift();
  }

  private acked(): boolean {
    const control = this.frameSignal;
    return (
      control !== null &&
      Atomics.load(control, RingControl.ACK_FRAME_ID) ===
        (this.inFlightFrameId | 0)
    );
  }

  setListener(listener: (message: CoreMessage) => void): void {
    this.queue.setListener(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.inFlight = false;
    this.recycled.clear();
    const worker = this.worker;
    try {
      worker.postMessage(
        { type: 'destroy' } satisfies WorkerInboundMessage,
        [],
      );
    } catch {
      // The worker may already be gone.
    }
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    setTimeout(() => worker.terminate(), WORKER_TERMINATE_DELAY_MS);
  }

  /** @internal Immediate teardown after a failed handshake. */
  kill(): void {
    this.destroyed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const message = event.data as CoreMessage;
    if (!this.ready) {
      this.onHandshake?.(message);
      if (!this.ready) {
        if (message.type !== 'ready' && message.type !== 'error')
          this.queue.deliver(message);
        return;
      }
    }
    if (message.type === 'frameDone') {
      // With the ring, returned transfer-path buffers are not needed.
      if (message.buffer !== null && !this.ring && !isShared(message.buffer)) {
        this.recycled.push(message.buffer);
      }
      if (message.frameId === this.inFlightFrameId) this.inFlight = false;
    }
    if (message.type === 'ready') return;
    this.queue.deliver(message);
  };

  private readonly onError = (event: ErrorEvent): void => {
    const text =
      event.message ||
      'uncaught error in the cozygpu worker (script failed to load?)';
    if (!this.ready) {
      event.preventDefault?.();
      this.onHandshake?.(null, text);
      return;
    }
    this.queue.deliver({
      type: 'error',
      code: 'INTERNAL',
      message: text,
    });
  };

  private readonly onMessageError = (): void => {
    const message =
      'a message from the cozygpu worker could not be deserialized';
    if (!this.ready) {
      this.onHandshake?.(null, message);
      return;
    }
    this.queue.deliver({ type: 'error', code: 'INVALID_ARGUMENT', message });
  };
}

/** SharedArrayBuffer check that also works across realms (rare path). */
function isShared(value: unknown): value is SharedArrayBuffer {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (value instanceof SharedArrayBuffer) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof ArrayBuffer) &&
    Object.prototype.toString.call(value) === '[object SharedArrayBuffer]'
  );
}
