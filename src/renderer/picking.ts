/**
 * Owner: "sprites". Front half of GPU picking (ARCHITECTURE §16.3).
 * Renderer.ts (frozen) creates one client per renderer and calls:
 *   - `pick(x, y)` from renderer.pick()
 *   - `encode(frame)` inside render(), after control commands
 *   - `handleMessage(msg)` for CoreMessage 'pick'
 *   - `rejectAll(code, message)` on device loss / destroy
 * Resolves `objectId` (a SceneNode id) back to the node with a walk of the
 * renderer's stage (picks are rare; no per-node registry is kept, so nodes
 * stay as small as before); ids that no longer belong to a live node in the
 * stage resolve null.
 *
 * Request ids come from `ids.readback`. An id stays allocated until the core
 * answers it, even when the promise was already rejected (device loss), so a
 * late answer can never settle a newer request that reused the id.
 */
import { Op } from '../commands/opcodes';
import type { ContainerNode, SceneNode } from '../scene/types';
import type { CoreMessage } from '../types/transport';
import type { FrontFrame, PickClient } from '../types/core';
import { CozyGPUError } from '../types/errors';
import { ids } from '../types/ids';
import type { PickHit } from '../types/renderer';

export interface PickClientHost {
  readonly stage: ContainerNode;
}

interface Waiter {
  readonly x: number;
  readonly y: number;
  resolve(hit: PickHit | null): void;
  reject(error: Error): void;
}

class PickClientImpl implements PickClient {
  /** requestId → waiter; null = already rejected, waiting for the core's answer. */
  private readonly waiters = new Map<number, Waiter | null>();
  /** Requests not yet encoded (FIFO). */
  private readonly queued: number[] = [];
  private readonly stack: SceneNode[] = [];

  constructor(private readonly host: PickClientHost) {}

  pick(x: number, y: number): Promise<PickHit | null> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return Promise.reject(
        new CozyGPUError('INVALID_ARGUMENT', `pick(${x}, ${y})`),
      );
    }
    return new Promise<PickHit | null>((resolve, reject) => {
      const requestId = ids.readback.alloc();
      this.waiters.set(requestId, { x, y, resolve, reject });
      this.queued.push(requestId);
    });
  }

  encode(frame: FrontFrame): void {
    const queued = this.queued;
    if (queued.length === 0) return;
    const enc = frame.encoder;
    for (let i = 0; i < queued.length; i++) {
      const requestId = queued[i];
      const waiter = this.waiters.get(requestId);
      if (!waiter) continue;
      enc.begin(Op.PICK, 12);
      enc.u32(requestId);
      enc.f32(waiter.x);
      enc.f32(waiter.y);
      enc.end();
    }
    queued.length = 0;
  }

  handleMessage(message: Extract<CoreMessage, { type: 'pick' }>): void {
    const waiter = this.waiters.get(message.requestId);
    if (waiter === undefined) return;
    this.waiters.delete(message.requestId);
    ids.readback.free(message.requestId);
    if (waiter === null) return;
    if (message.code !== undefined) {
      waiter.reject(
        new CozyGPUError(
          message.code,
          `pick ${message.requestId} failed` +
            (message.message ? `: ${message.message}` : ''),
        ),
      );
      return;
    }
    const node =
      message.objectId === 0 ? null : this.findNode(message.objectId);
    waiter.resolve(
      node
        ? {
            node,
            instance: node.kind === 'sprite' ? -1 : message.instance,
            x: waiter.x,
            y: waiter.y,
          }
        : null,
    );
  }

  rejectAll(code: 'DEVICE_LOST' | 'DESTROYED', message: string): void {
    const error = new CozyGPUError(code, `pick rejected: ${message}`);
    // Never sent: nothing will answer them.
    const queued = this.queued;
    for (let i = 0; i < queued.length; i++) {
      const waiter = this.waiters.get(queued[i]);
      this.waiters.delete(queued[i]);
      ids.readback.free(queued[i]);
      waiter?.reject(error);
    }
    queued.length = 0;
    const destroyed = code === 'DESTROYED';
    this.waiters.forEach((waiter, requestId) => {
      waiter?.reject(error);
      if (destroyed) ids.readback.free(requestId);
      else this.waiters.set(requestId, null);
    });
    if (destroyed) this.waiters.clear();
  }

  /** Live node with `id` in the stage (visible or not). */
  private findNode(id: number): SceneNode | null {
    const stack = this.stack;
    stack.length = 0;
    stack.push(this.host.stage);
    while (stack.length > 0) {
      const node = stack.pop() as SceneNode;
      if (node.id === id) {
        stack.length = 0;
        return node.destroyed ? null : node;
      }
      const children = (node as ContainerNode).children;
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
    return null;
  }
}

export function createPickClient(host: PickClientHost): PickClient {
  return new PickClientImpl(host);
}
