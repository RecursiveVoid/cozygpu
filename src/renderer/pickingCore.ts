/**
 * Core half of GPU picking
 * (ARCHITECTURE §16.3, §19.6). DOM-free. RenderCore creates it on the first
 * PICK command and calls `request`, `render`, `poll`, `failAll`, `restore`
 * and `destroy`.
 *
 * This is a small proxy: the implementation (pickingCoreImpl.ts: pick
 * targets, pick pass, readback) loads with a dynamic import on the first
 * PICK, so programs that never pick do not carry it. Requests that arrive
 * before it lands are queued and handed over when it does; they render in
 * the next packet after that (usually one frame later than a warm pick).
 */
import type { CommandList } from '../backend/types';
import type {
  CoreContext,
  CoreFrameState,
  CorePicking,
  PickReplay,
} from '../types/core';
import { pickPipelinesPending } from './pickingPipelines';

class LazyCorePicking implements CorePicking {
  private impl: CorePicking | null = null;
  private dead = false;
  /** Requests queued until the implementation loads: id, x, y triples. */
  private queued: number[] = [];

  constructor(private ctx: CoreContext) {
    // The backend's readback ring is a lazy chunk too; load both before the
    // first pick.
    Promise.all([
      import('./pickingCoreImpl'),
      ctx.backend.loadReadbackRing?.(),
    ]).then(
      ([m]) => {
        if (this.dead) return;
        const impl = m.createCorePickingNow(this.ctx, pickPipelinesPending);
        this.impl = impl;
        const q = this.queued;
        this.queued = [];
        for (let i = 0; i < q.length; i += 3)
          impl.request(q[i], q[i + 1], q[i + 2]);
      },
      (err: unknown) => this.answerQueued('INTERNAL', String(err)),
    );
  }

  get pending(): number {
    return this.impl !== null ? this.impl.pending : 0;
  }

  request(requestId: number, x: number, y: number): void {
    if (this.impl !== null) this.impl.request(requestId, x, y);
    else this.queued.push(requestId, x, y);
  }

  render(list: CommandList, replay: PickReplay, frame: CoreFrameState): void {
    this.impl?.render(list, replay, frame);
  }

  afterSubmit(): void {}

  poll(): void {
    this.impl?.poll!();
  }

  failAll(code: 'DEVICE_LOST' | 'DESTROYED', message: string): void {
    this.answerQueued(code, message);
    this.impl?.failAll(code, message);
  }

  async restore(ctx: CoreContext): Promise<void> {
    this.ctx = ctx;
    if (this.impl !== null) await this.impl.restore(ctx);
  }

  destroy(): void {
    this.dead = true;
    this.impl?.destroy();
  }

  private answerQueued(
    code: 'DEVICE_LOST' | 'DESTROYED' | 'INTERNAL',
    message: string,
  ): void {
    const q = this.queued;
    this.queued = [];
    for (let i = 0; i < q.length; i += 3) {
      this.ctx.post({
        type: 'pick',
        requestId: q[i],
        objectId: 0,
        instance: -1,
        code,
        message,
      });
    }
  }
}

export function createCorePicking(ctx: CoreContext): CorePicking {
  return new LazyCorePicking(ctx);
}
