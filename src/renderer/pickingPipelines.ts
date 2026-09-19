/**
 * Owner: "sprites". Pick pipeline readiness per core (ARCHITECTURE §16.3).
 * DOM-free.
 *
 * Systems create their pick pipelines lazily, on their first `drawPick`
 * call, and a draw whose pipeline is still compiling is skipped. The core
 * picking module must not read back a pick pass that skipped draws (it would
 * report a miss), so systems register in-flight pick pipeline creations here
 * and `createCorePicking` keeps its requests queued (re-rendering them next
 * frame) while any is pending for that core.
 *
 * Usage in a CoreSystem (swarm can use the same helpers):
 *
 *   beginPickPipeline(ctx);
 *   backend.createRenderPipeline(desc).then(...).finally(() => endPickPipeline(ctx));
 */
import type { CoreContext } from '../types/core';

const pending = new WeakMap<CoreContext, number>();

/** A pick pipeline for `ctx`'s core started compiling. */
export function beginPickPipeline(ctx: CoreContext): void {
  pending.set(ctx, (pending.get(ctx) ?? 0) + 1);
}

/** A pick pipeline creation finished (resolved or failed). */
export function endPickPipeline(ctx: CoreContext): void {
  const n = (pending.get(ctx) ?? 0) - 1;
  if (n > 0) pending.set(ctx, n);
  else pending.delete(ctx);
}

/** True while some system's pick pipeline for this core is compiling. */
export function pickPipelinesPending(ctx: CoreContext): boolean {
  return (pending.get(ctx) ?? 0) > 0;
}
