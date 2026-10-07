/**
 * Core half of GPU picking
 * (ARCHITECTURE §16.3, §19.6). DOM-free. Loaded on the first PICK command by
 * the proxy in pickingCore.ts; RenderCore calls `request` (execute phase),
 * `render` (after the main pass, same CommandList), `poll` (start of every
 * packet), `failAll`, `restore` and `destroy`.
 *
 * Per slot (PICK_SLOTS): a 1×1 PICK_TARGET_FORMAT target, a pick View
 * uniform + bind group and a slot of one readback ring, so picks in flight
 * never overwrite each other (writes to one buffer range before a submit
 * collapse to the last one). A slot is busy from its pick pass until `poll`
 * sees its readback READY; requests wait while every slot is busy.
 *
 * Pick View = identity stage → css transform with `translate = 0.5 - (x, y)`
 * and `resolution = (1, 1)`: the target's only texel center samples css
 * point (x, y). (There is no camera API yet, so the frame's View is always
 * the identity.)
 *
 * Systems create pick pipelines lazily. While any is compiling
 * (`pickPipelinesPending`), a rendered pick pass is not read back and its
 * requests stay queued, so a pick never reports a miss because a pipeline was
 * not ready.
 *
 * Nothing is allocated per pick: the answer is a reused message object
 * (posted synchronously in local mode, structured-cloned in worker mode).
 */
import { BufferUsage, ReadbackState, TextureUsage } from '../backend/types';
import type {
  CommandList,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiReadbackRing,
  RhiTexture,
} from '../backend/types';
import type {
  CoreContext,
  CoreFrameState,
  CorePicking,
  PickReplay,
} from '../types/core';
import type { CozyGPUErrorCode } from '../types/errors';
import {
  PICK_RESULT_BYTES,
  PICK_TARGET_FORMAT,
  PICK_TEXEL_INSTANCE,
  PICK_TEXEL_OBJECT,
  PICK_TEXEL_USER,
  VIEW_UNIFORM_BYTES,
  VU_COL0,
  VU_COL1,
  VU_DPR,
  VU_DT,
  VU_RESOLUTION,
  VU_TIME,
  VU_TRANSLATE,
} from '../types/layouts';

/** Picks in flight at once (pick targets and readback ring slots). */
export const PICK_SLOTS = 4;

interface Slot {
  readonly texture: RhiTexture;
  readonly buffer: RhiBuffer;
  readonly bindGroup: RhiBindGroup;
}

class CorePickingImpl implements CorePicking {
  // FIFO of queued requests.
  private ids = new Uint32Array(16);
  private xs = new Float32Array(16);
  private ys = new Float32Array(16);
  private head = 0;
  private size = 0;

  private slots: Slot[] = [];
  private ring: RhiReadbackRing | null = null;
  /** Per ring slot: request in flight (0 = none). */
  private readonly flight = new Uint32Array(PICK_SLOTS);
  private inFlight = 0;
  /** Ring slots acquired in the current render(). */
  private readonly used = new Int32Array(PICK_SLOTS);
  private readonly viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  private readonly clearColor = new Float32Array(4);
  private readonly passDesc: RenderPassDesc;
  private readonly answer = {
    type: 'pick' as const,
    requestId: 0,
    objectId: 0,
    instance: -1,
    userId: 0,
  };
  private destroyed = false;

  constructor(
    private ctx: CoreContext,
    private readonly pipelinesPending: (ctx: CoreContext) => boolean,
  ) {
    this.passDesc = {
      label: 'cozygpu.pick',
      color: {
        target: 'canvas',
        load: 'clear',
        clearColor: this.clearColor,
      },
    };
  }

  get pending(): number {
    return this.size;
  }

  request(requestId: number, x: number, y: number): void {
    if (this.destroyed) {
      this.answerError(requestId, 'DESTROYED', 'renderer was destroyed');
      return;
    }
    if (!this.ctx.backend.caps.integerRenderTargets) {
      this.answerError(
        requestId,
        'UNSUPPORTED',
        'picking needs integer render targets',
      );
      return;
    }
    if (this.size === this.ids.length) this.growQueue();
    const at = (this.head + this.size) % this.ids.length;
    this.ids[at] = requestId;
    this.xs[at] = x;
    this.ys[at] = y;
    this.size++;
  }

  render(list: CommandList, replay: PickReplay, frame: CoreFrameState): void {
    if (this.destroyed || this.size === 0) return;
    const ring = this.ensureSlots();
    const backend = this.ctx.backend;
    const view = this.viewData;
    const cap = this.ids.length;
    const used = this.used;
    let n = 0;
    while (n < this.size) {
      const s = ring.acquire();
      if (s < 0) break; // every slot busy: the rest wait
      used[n] = s;
      const at = (this.head + n) % cap;
      const slot = this.slots[s];
      view[VU_COL0 >> 2] = 1;
      view[(VU_COL0 >> 2) + 1] = 0;
      view[VU_COL1 >> 2] = 0;
      view[(VU_COL1 >> 2) + 1] = 1;
      view[VU_TRANSLATE >> 2] = 0.5 - this.xs[at];
      view[(VU_TRANSLATE >> 2) + 1] = 0.5 - this.ys[at];
      view[VU_RESOLUTION >> 2] = 1;
      view[(VU_RESOLUTION >> 2) + 1] = 1;
      view[VU_TIME >> 2] = frame.time;
      view[VU_DT >> 2] = frame.dt;
      view[VU_DPR >> 2] = frame.resolution;
      backend.writeBuffer(slot.buffer, 0, view);

      this.passDesc.color.target = slot.texture;
      const pass = list.beginRenderPass(this.passDesc);
      for (let d = 0; d < replay.drawCount; d++) {
        replay.drawPick(d, pass, slot.bindGroup);
      }
      pass.end();
      n++;
    }
    // A pipeline still compiling skipped its draws: render again next packet.
    const retry = this.pipelinesPending(this.ctx);
    for (let i = 0; i < n; i++) {
      const s = used[i];
      if (retry) {
        ring.release(s);
        continue;
      }
      ring.copyTexture(list, s, this.slots[s].texture, 0, 0, 1, 1);
      this.flight[s] = this.ids[(this.head + i) % cap];
      this.inFlight++;
    }
    if (retry) return;
    this.head = (this.head + n) % cap;
    this.size -= n;
  }

  /** Readbacks start in the CommandList's submit (the ring maps them). */
  afterSubmit(): void {}

  poll(): void {
    if (this.inFlight === 0) return;
    const ring = this.ring!;
    const flight = this.flight;
    for (let s = 0; s < PICK_SLOTS; s++) {
      const requestId = flight[s];
      if (requestId === 0) continue;
      const state = ring.poll(s);
      if (state === ReadbackState.PENDING) continue;
      flight[s] = 0;
      this.inFlight--;
      if (state === ReadbackState.READY) {
        const texel = ring.data(s);
        const msg = this.answer;
        msg.requestId = requestId;
        msg.objectId = texel[PICK_TEXEL_OBJECT];
        msg.instance = msg.objectId === 0 ? -1 : texel[PICK_TEXEL_INSTANCE] - 1;
        msg.userId = msg.objectId === 0 ? 0 : texel[PICK_TEXEL_USER];
        ring.release(s);
        this.ctx.post(msg);
      } else {
        ring.release(s);
        this.answerError(requestId, 'DEVICE_LOST', 'pick readback failed');
      }
    }
  }

  failAll(code: 'DEVICE_LOST' | 'DESTROYED', message: string): void {
    const cap = this.ids.length;
    for (let i = 0; i < this.size; i++) {
      this.answerError(this.ids[(this.head + i) % cap], code, message);
    }
    this.head = 0;
    this.size = 0;
    // Rendered, readback in flight: it can never answer now.
    const flight = this.flight;
    for (let s = 0; s < PICK_SLOTS; s++) {
      if (flight[s] === 0) continue;
      this.ring?.release(s);
      this.answerError(flight[s], code, message);
      flight[s] = 0;
    }
    this.inFlight = 0;
  }

  async restore(ctx: CoreContext): Promise<void> {
    // The old device's objects are gone; recreate lazily on the next pick.
    this.ctx = ctx;
    this.slots = [];
    this.ring = null;
  }

  destroy(): void {
    this.destroyed = true;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.texture.destroy();
      slot.buffer.destroy();
    }
    this.slots = [];
    this.ring?.destroy();
    this.ring = null;
  }

  private answerError(
    requestId: number,
    code: CozyGPUErrorCode,
    message: string,
  ): void {
    this.ctx.post({
      type: 'pick',
      requestId,
      objectId: 0,
      instance: -1,
      code,
      message,
    });
  }

  private growQueue(): void {
    const cap = this.ids.length;
    const ids = new Uint32Array(cap * 2);
    const xs = new Float32Array(cap * 2);
    const ys = new Float32Array(cap * 2);
    for (let i = 0; i < this.size; i++) {
      const at = (this.head + i) % cap;
      ids[i] = this.ids[at];
      xs[i] = this.xs[at];
      ys[i] = this.ys[at];
    }
    this.ids = ids;
    this.xs = xs;
    this.ys = ys;
    this.head = 0;
  }

  private ensureSlots(): RhiReadbackRing {
    const ctx = this.ctx;
    const backend = ctx.backend;
    while (this.slots.length < PICK_SLOTS) {
      const i = this.slots.length;
      const texture = backend.createTexture({
        label: `cozygpu.pick#${i}`,
        width: 1,
        height: 1,
        format: PICK_TARGET_FORMAT,
        usage: TextureUsage.RENDER_TARGET | TextureUsage.COPY_SRC,
      });
      const buffer = backend.createBuffer({
        label: `cozygpu.pick.view#${i}`,
        size: VIEW_UNIFORM_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      const bindGroup = backend.createBindGroup({
        label: `cozygpu.pick.view#${i}`,
        layout: ctx.viewLayout,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      this.slots.push({ texture, buffer, bindGroup });
    }
    return (this.ring ??= backend.createReadbackRing({
      label: 'cozygpu.pick',
      slots: PICK_SLOTS,
      slotBytes: PICK_RESULT_BYTES,
    }));
  }
}

/**
 * The implementation itself (pickingCore.ts wraps it in a lazy proxy and
 * passes `pickPipelinesPending`, so this chunk imports nothing the main
 * chunk would have to split out).
 */
export function createCorePickingNow(
  ctx: CoreContext,
  pipelinesPending: (ctx: CoreContext) => boolean,
): CorePicking {
  return new CorePickingImpl(ctx, pipelinesPending);
}
