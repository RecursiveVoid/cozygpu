/**
 * Destroyed swarms whose SWARM_DESTROY still has to reach their renderer.
 * Kept in its own tiny module so Renderer can flush it every frame without
 * pulling the Swarm implementation into bundles that never use swarms.
 * @internal
 */
import { Op } from '../commands/opcodes';
import type { FrontFrame } from '../types/core';
import { ids } from '../types/ids';

/**
 * rendererId → queued swarm ids. A positive entry frees the id after its
 * SWARM_DESTROY is emitted (the swarm was destroyed). A negative entry
 * (-swarmId) only releases the GPU side on that renderer: the swarm moved to
 * another renderer and still owns its id.
 */
const pendingDestroys = new Map<number, number[]>();

/** Queues SWARM_DESTROY for `swarmId` on renderer `rendererId`. */
export function queueSwarmDestroy(rendererId: number, swarmId: number): void {
  push(rendererId, swarmId);
}

/**
 * Queues SWARM_DESTROY for `swarmId` on renderer `rendererId` WITHOUT freeing
 * the id: used when a live swarm moves to another renderer. Safe against id
 * reuse because a renderer flushes its queue before anything else in a frame
 * can SWARM_CREATE a (possibly reused) id there.
 */
export function queueSwarmRelease(rendererId: number, swarmId: number): void {
  push(rendererId, -swarmId);
}

function push(rendererId: number, entry: number): void {
  let list = pendingDestroys.get(rendererId);
  if (!list) pendingDestroys.set(rendererId, (list = []));
  list.push(entry);
}

/**
 * Emits SWARM_DESTROY for swarms destroyed (or moved away) since the last
 * frame of this renderer and frees the ids of destroyed ones. Called once per
 * frame by Renderer.render() (and by Swarm._emitDraw). Allocation-free when
 * nothing is pending.
 */
export function flushSwarmDestroys(frame: FrontFrame): void {
  const list = pendingDestroys.get(frame.rendererId);
  if (!list || list.length === 0) return;
  const enc = frame.encoder;
  for (let k = 0; k < list.length; k++) {
    const entry = list[k];
    const id = entry < 0 ? -entry : entry;
    enc.begin(Op.SWARM_DESTROY, 4);
    enc.u32(id);
    enc.end();
    if (entry > 0) ids.swarm.free(id);
  }
  list.length = 0;
}

/** Drops everything queued for a destroyed renderer (its core frees the GPU side). */
export function dropSwarmDestroys(rendererId: number): void {
  const list = pendingDestroys.get(rendererId);
  if (!list) return;
  for (let k = 0; k < list.length; k++) {
    if (list[k] > 0) ids.swarm.free(list[k]);
  }
  pendingDestroys.delete(rendererId);
}
