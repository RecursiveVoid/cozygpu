/**
 * Owner: "worker". The worker-side message loop (DOM-free).
 *
 * `entry.ts` binds it to the real worker global scope and the real
 * `createRenderCore`; tests bind it to fakes.
 *
 *   'init'    → size the OffscreenCanvas, createRenderCore(), post ready{caps}
 *   'frame'   → core.execute(packet) (the core posts frameDone). If the core is
 *               missing or throws, the host posts error + frameDone itself so
 *               the front never stays busy and the buffer returns to the pool.
 *   number    → M2 ring doorbell (ARCHITECTURE §17): executes the packet in
 *               that SharedArrayBuffer slot through a cached FramePacket, and
 *               acknowledges it through RingControl.ACK_FRAME_ID only.
 *   'ringSlot'→ replaces a ring slot (growth).
 *   A packet that needs a core system still loading (deps.pendingLoad, e.g.
 *   the first SWARM commands) is held unacknowledged until it has loaded.
 *   'destroy' → core.destroy(), close the worker.
 *
 * Every frameDone whose buffer is a SharedArrayBuffer (ring slot) is turned
 * into an ACK_FRAME_ID store and never posted: a SharedArrayBuffer cannot be
 * transferred, and the front does not need it back.
 */
import type { FramePacket } from '../commands/types';
import type { CoreInitOptions, CoreSystem, RenderCore } from '../types/core';
import type { Canvas } from '../types/types';
import {
  RING_CONTROL_BYTES,
  RingControl,
  type CoreMessage,
  type WorkerDoorbell,
  type WorkerInboundMessage,
} from '../types/transport';
import { PH_COMMAND_COUNT } from '../commands/opcodes';
import { errorMessage } from './errors';

export interface WorkerScopeLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage:
    | ((event: { data: WorkerInboundMessage | WorkerDoorbell }) => void)
    | null;
  close?(): void;
}

export interface WorkerHostDeps {
  createRenderCore(
    canvas: Canvas,
    options: CoreInitOptions,
    systems: CoreSystem[],
    post: (message: CoreMessage, transfer?: Transferable[]) => void,
  ): Promise<RenderCore>;
  createSystems(): CoreSystem[];
  /**
   * Optional: when `packet` has commands for a core system that loads lazily
   * and is not loaded yet, starts the load and returns its promise (the host
   * then holds the packet until it settles); otherwise null.
   */
  pendingLoad?(packet: FramePacket): Promise<void> | null;
}

export interface WorkerHost {
  /** Resolves once the current init attempt settled (for tests). */
  readonly initialized: Promise<void>;
  handle(message: WorkerInboundMessage | WorkerDoorbell): void;
}

const NO_TRANSFER: Transferable[] = [];
/** Ring packets never carry objects; shared by every cached ring packet. */
const NO_OBJECTS: FramePacket['objects'] = [];

interface RingEntry {
  packet: FramePacket;
  header: Uint32Array;
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

function ringEntry(buffer: SharedArrayBuffer): RingEntry {
  return {
    packet: {
      buffer,
      byteLength: 0,
      frameId: 0,
      commandCount: 0,
      objects: NO_OBJECTS,
    },
    header: new Uint32Array(buffer, 0, 4),
  };
}

export function startWorkerHost(
  scope: WorkerScopeLike,
  deps: WorkerHostDeps,
): WorkerHost {
  let core: RenderCore | null = null;
  let initializing = false;
  let destroyed = false;
  let initialized: Promise<void> = Promise.resolve();

  /** Shared control block (see WorkerInboundMessage 'init'.frameSignal / RingControl). */
  let frameSignal: Int32Array | null = null;
  /** Ring slots with their cached packets (index = slot). */
  const ring: RingEntry[] = [];

  const post = (message: CoreMessage, transfer?: Transferable[]): void => {
    if (message.type === 'frameDone') {
      // Signal first: the core no longer reads shared memory for this frame
      // (writeBuffer copies synchronously), so the front may encode the next.
      if (frameSignal !== null) {
        Atomics.store(
          frameSignal,
          RingControl.ACK_FRAME_ID,
          message.frameId | 0,
        );
      }
      // Ring packets are acknowledged through the control block only.
      if (isShared(message.buffer)) return;
    }
    scope.postMessage(message, transfer ?? NO_TRANSFER);
  };

  // Reused for host-generated acks (the core posts its own in the normal path).
  const frameDone = {
    type: 'frameDone' as const,
    frameId: 0,
    buffer: null as ArrayBuffer | null,
  };
  const transferOne: Transferable[] = [];

  const ackFrame = (packet: FramePacket): void => {
    const buffer = packet.buffer;
    if (isShared(buffer)) {
      // Ring slot: acknowledge through the control block only.
      if (frameSignal !== null) {
        Atomics.store(
          frameSignal,
          RingControl.ACK_FRAME_ID,
          packet.frameId | 0,
        );
      }
      return;
    }
    // A detached buffer means the core already posted frameDone for this
    // packet; a second ack would clear `busy` for the NEXT frame early.
    if (buffer.byteLength === 0) return;
    frameDone.frameId = packet.frameId;
    // M2 ring packets (SharedArrayBuffer) must not reach here: acked via RingControl.
    frameDone.buffer = buffer as ArrayBuffer;
    transferOne[0] = buffer as ArrayBuffer;
    post(frameDone, transferOne);
    frameDone.buffer = null;
    transferOne.length = 0;
  };

  const init = async (
    msg: Extract<WorkerInboundMessage, { type: 'init' }>,
  ): Promise<void> => {
    if (core !== null || initializing) {
      post({
        type: 'error',
        code: 'INVALID_ARGUMENT',
        message: 'worker core already initialized',
      });
      return;
    }
    initializing = true;
    if (isShared(msg.frameSignal)) {
      frameSignal = new Int32Array(
        msg.frameSignal,
        0,
        Math.min(msg.frameSignal.byteLength, RING_CONTROL_BYTES) >> 2,
      );
      const slots = msg.ring;
      if (slots && frameSignal.length > RingControl.SUBMITTED_BYTE_LENGTH) {
        for (let i = 0; i < slots.length; i++) ring[i] = ringEntry(slots[i]);
      }
    }
    try {
      const canvas = msg.canvas;
      const pw = Math.max(1, Math.round(msg.cssWidth * msg.resolution));
      const ph = Math.max(1, Math.round(msg.cssHeight * msg.resolution));
      if (Number.isFinite(pw) && Number.isFinite(ph)) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const created = await deps.createRenderCore(
        canvas,
        msg.options,
        deps.createSystems(),
        post,
      );
      if (destroyed) {
        created.destroy();
        return;
      }
      core = created;
      post({
        type: 'ready',
        caps: created.caps,
        fallbackReason: created.fallbackReason,
      });
    } catch (error) {
      post(errorMessage(error, 'UNSUPPORTED'));
    } finally {
      initializing = false;
    }
  };

  const executeRing = (slot: number): void => {
    const entry = ring[slot];
    const control = frameSignal;
    if (entry === undefined || control === null) {
      post({
        type: 'error',
        code: 'INVALID_ARGUMENT',
        message: `doorbell for unknown command ring slot ${slot}`,
      });
      return;
    }
    const packet = entry.packet;
    packet.frameId =
      Atomics.load(control, RingControl.SUBMITTED_FRAME_ID) >>> 0;
    packet.byteLength = Atomics.load(
      control,
      RingControl.SUBMITTED_BYTE_LENGTH,
    );
    packet.commandCount = entry.header[PH_COMMAND_COUNT >> 2];
    if (core === null || destroyed) {
      ackFrame(packet);
      return;
    }
    run(packet);
  };

  /**
   * Packets waiting for a lazily loaded core system (see pendingLoad), in
   * arrival order: a packet that arrives meanwhile queues behind them, so
   * commands never run out of order and none is overwritten.
   */
  const held: FramePacket[] = [];

  const execute = (packet: FramePacket): void => {
    try {
      (core as RenderCore).execute(packet);
    } catch (error) {
      post(errorMessage(error, 'INTERNAL'));
      ackFrame(packet);
    }
  };

  /**
   * Runs the held packets in order. Each is checked again before it runs:
   * one packet can need several chunks (a mask and a swarm added in the
   * same frame), and running it after only the first has loaded would drop
   * the other range's commands (e.g. a SWARM_CREATE). `force` runs the head
   * after a failed load, as a lone packet always did.
   */
  const drain = (force: boolean): void => {
    while (held.length > 0) {
      const packet = held[0];
      if (core === null || destroyed) {
        held.shift();
        ackFrame(packet);
        continue;
      }
      const wait = force ? null : deps.pendingLoad?.(packet);
      if (wait) {
        wait.then(drainLoaded, drainFailed);
        return;
      }
      force = false;
      held.shift();
      execute(packet);
    }
  };
  const drainLoaded = (): void => drain(false);
  const drainFailed = (error: unknown): void => {
    post(errorMessage(error, 'INTERNAL'));
    drain(true);
  };

  /**
   * Runs `packet`, unless it needs a core system that is still loading: then
   * it waits (unacknowledged, so the front skips frames) and runs when the
   * chunk arrives.
   */
  const run = (packet: FramePacket): void => {
    if (held.length > 0) {
      held.push(packet);
      return;
    }
    const wait = deps.pendingLoad?.(packet);
    if (!wait) {
      execute(packet);
      return;
    }
    held.push(packet);
    wait.then(drainLoaded, drainFailed);
  };

  const handle = (msg: WorkerInboundMessage | WorkerDoorbell): void => {
    if (typeof msg === 'number') {
      executeRing(msg);
      return;
    }
    switch (msg.type) {
      case 'ringSlot':
        if (isShared(msg.buffer) && msg.slot >= 0 && msg.slot < ring.length) {
          ring[msg.slot] = ringEntry(msg.buffer);
        }
        return;
      case 'init':
        initialized = init(msg);
        return;
      case 'frame': {
        const packet = msg.packet;
        if (core === null || destroyed) {
          closeBitmaps(packet);
          ackFrame(packet);
          return;
        }
        run(packet);
        return;
      }
      case 'debug':
        // Dev-only; the core ignores it unless it was created with debug: true.
        core?.debug?.(msg.action);
        return;
      case 'destroy':
        if (destroyed) return;
        destroyed = true;
        try {
          core?.destroy();
        } catch (error) {
          post(errorMessage(error, 'DESTROYED'));
        }
        core = null;
        scope.onmessage = null;
        scope.close?.();
        return;
    }
  };

  scope.onmessage = event => handle(event.data);

  return {
    get initialized() {
      return initialized;
    },
    handle,
  };
}

/** Dropped frames still own transferred ImageBitmaps: release them promptly. */
function closeBitmaps(packet: FramePacket): void {
  const objects = packet.objects;
  if (!objects) return;
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i] as { close?: () => void };
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.close === 'function'
    )
      obj.close();
  }
}
