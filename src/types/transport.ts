/**
 * Transport contracts between front and core.
 * Implementations (src/worker/LocalTransport.ts,
 * src/worker/WorkerTransport.ts, src/worker/entry.ts, src/worker/host.ts).
 * Spec: docs/ARCHITECTURE.md §3.5, §8 and §17 (M2 command ring).
 */
import type { Capabilities } from '../backend/types';
import type { FramePacket } from '../commands/types';
import type { CoreInitOptions, CoreInterop, RenderCore } from './core';
import type { CozyGPUErrorCode } from './errors';

/** Core → front. */
export type CoreMessage =
  /**
   * `fallbackReason` (M2) is set only when `backend: 'auto'` ended up on
   * WebGL2; it says why WebGPU was not used (§13.5).
   */
  | { type: 'ready'; caps: Capabilities; fallbackReason?: string }
  /**
   * `buffer` is the packet buffer handed back for reuse (null in local mode if
   * kept). Ring packets (SharedArrayBuffer, M2) are acknowledged through the
   * ring control block only: the worker host does not post frameDone for them.
   */
  | {
      type: 'frameDone';
      frameId: number;
      buffer: ArrayBuffer | SharedArrayBuffer | null;
    }
  /**
   * Accepted M1 contract: `code`/`message` are set when the readback failed
   * (then `data` is empty): DEVICE_LOST (lost before or while reading),
   * OUT_OF_CAPACITY (refused/disabled swarm), UNSUPPORTED (no system owns
   * srcKind), INTERNAL. The front rejects the promise with that code.
   */
  | {
      type: 'readback';
      requestId: number;
      data: ArrayBuffer;
      code?: CozyGPUErrorCode;
      message?: string;
    }
  /**
   * M2 (ARCHITECTURE §16.3). Answer to a PICK command. `objectId` is the node
   * id written by the pick pass (0 = nothing hit); `instance` is the Swarm
   * instance index, or -1 for sprites. On failure `code`/`message` are set
   * and objectId is 0. M2.5: `userId` is the texel's PICK_TEXEL_USER value
   * (a Swarm instance's cold.user; 0 for sprites); absent means 0.
   */
  | {
      type: 'pick';
      requestId: number;
      objectId: number;
      instance: number;
      userId?: number;
      code?: CozyGPUErrorCode;
      message?: string;
    }
  | { type: 'deviceLost'; message: string }
  | { type: 'deviceRestored' }
  | { type: 'error'; code: string; message: string };

/**
 * M2 command ring control block (Int32Array over `init.frameSignal`, 16 B
 * when the ring is enabled, 4 B otherwise). Index 0 keeps its M1 meaning.
 */
export const RingControl = {
  /** Last frameId the core finished (written before any frameDone post). */
  ACK_FRAME_ID: 0,
  /** Ring slot index of the submitted packet (front writes before the doorbell). */
  SUBMITTED_SLOT: 1,
  /** frameId of the submitted packet. */
  SUBMITTED_FRAME_ID: 2,
  /** Used bytes of the submitted packet (incl. the 16 B header). */
  SUBMITTED_BYTE_LENGTH: 3,
} as const;
export const RING_CONTROL_BYTES = 16;

/** Front → worker. */
export type WorkerInboundMessage =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      options: CoreInitOptions;
      /** Initial css size + resolution so the first frame is correct. */
      cssWidth: number;
      cssHeight: number;
      resolution: number;
      /**
       * Accepted M1 contract. crossOriginIsolated only: a SharedArrayBuffer
       * whose Int32Array[RingControl.ACK_FRAME_ID] receives the frameId of
       * every finished packet before frameDone is posted, so the front sees an
       * acknowledged frame without waiting for the message task (the main
       * thread often runs the next rAF first). M2: 16 B (RING_CONTROL_BYTES)
       * when `ring` is present.
       */
      frameSignal?: SharedArrayBuffer;
      /**
       * M2 command ring slots (ARCHITECTURE §17). Present only with
       * `frameSignal`. The front encodes into a free slot, fills the control
       * block and posts a doorbell (a bare number = the slot index).
       */
      ring?: SharedArrayBuffer[];
    }
  | { type: 'frame'; packet: FramePacket }
  /** M2. Replaces ring slot `slot` with a larger buffer (rare: growth). */
  | { type: 'ringSlot'; slot: number; buffer: SharedArrayBuffer }
  /**
   * M2, dev-only. Drives a core-side debug action from the front, so worker
   * mode can exercise paths the main thread reaches through
   * `globalThis.__COZYGPU_CORE__`. Ignored unless the core runs with
   * `debug: true`. 'loseDevice' simulates a GPU device / context loss.
   */
  | { type: 'debug'; action: 'loseDevice' }
  | { type: 'destroy' };

/**
 * M2 doorbell: the front posts the ring slot index as a bare number (the
 * cheapest structured clone). The packet header lives in the slot; the
 * control block carries frameId and byteLength.
 */
export type WorkerDoorbell = number;

export interface Transport {
  readonly kind: 'local' | 'worker';
  readonly caps: Capabilities;
  /** M2. Why `backend: 'auto'` fell back to WebGL2, when it did (§13.5). */
  readonly fallbackReason?: string;
  /** Core can read front ArrayBuffers directly (local) or via SharedArrayBuffer (worker + crossOriginIsolated). */
  readonly sharedMemory: boolean;
  /** Use SharedArrayBuffer for stores (only true in worker mode with crossOriginIsolated). */
  readonly useSharedArrayBuffer: boolean;
  /**
   * M2. Packets travel through the SharedArrayBuffer command ring (worker +
   * crossOriginIsolated). False for 'local' and for the transfer path.
   */
  readonly ring: boolean;
  /**
   * A submitted packet has not been acknowledged yet (max 1 frame in flight).
   * While busy, Renderer.render() SKIPS the frame: it encodes nothing, keeps
   * accumulating dt, and leaves dirty flags / Swarm queues untouched so the
   * next submitted frame carries the latest state. Always false for 'local'.
   */
  readonly busy: boolean;
  submit(packet: FramePacket, transfer: Transferable[]): void;
  /**
   * Buffers returned by the core for reuse (FIFO), or (M2, ring) the next free
   * ring slot; undefined if none.
   */
  takeRecycledBuffer(): ArrayBuffer | SharedArrayBuffer | undefined;
  /** Single listener (the Renderer). */
  setListener(listener: (message: CoreMessage) => void): void;
  /**
   * M2, dev-only. Runs a debug action on the core wherever it lives (local:
   * straight on the backend; worker: as a 'debug' message). Present on both
   * transports; a core without `debug: true` ignores it.
   */
  debug?(action: 'loseDevice'): void;
  /**
   * M2.5 (ARCHITECTURE §19.4). The core's interop half. Only the local
   * transport has it (the core shares the heap); worker transports omit it
   * and `renderer.interop()` rejects with UNSUPPORTED. `create` builds the
   * core half over the local core (`createCoreInterop` from
   * src/renderer/coreInterop.ts, passed in by the lazy interop chunk so the
   * minimal program does not carry it).
   */
  interop?(create: (core: RenderCore) => CoreInterop): CoreInterop;
  destroy(): void;
}
