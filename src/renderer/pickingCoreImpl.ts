/**
 * Owner: "sprites". Core half of GPU picking (ARCHITECTURE §16.3). DOM-free.
 * Loaded on the first PICK command by the proxy in pickingCore.ts, which
 * RenderCore.ts (frozen) creates and calls `request` (execute phase), `render` (after the main pass, same
 * CommandList), `afterSubmit` (starts `backend.readTexture`), `failAll`,
 * `restore` and `destroy`.
 *
 * Per request slot (at most PICK_SLOTS per packet; the rest wait for the next
 * one): a 1×1 `rg32uint` target and a pick View uniform + bind group, so
 * several picks in one frame never overwrite each other (writes to one
 * buffer range before a submit collapse to the last one).
 *
 * Pick View = identity stage → css transform with `translate = 0.5 - (x, y)`
 * and `resolution = (1, 1)`: the target's only texel center samples css
 * point (x, y). (M2 has no camera API, so the frame's View is always the
 * identity; see openIssues for a camera-aware contract.)
 *
 * Systems create pick pipelines lazily. While any is compiling
 * (`pickPipelinesPending`), a rendered pick pass is not read back and its
 * requests stay queued, so a pick never reports a miss because a pipeline was
 * not ready.
 */
import { BufferUsage, TextureUsage } from '../backend/types';
import type {
  CommandList,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiTexture,
} from '../backend/types';
import type {
  CoreContext,
  CoreFrameState,
  CorePicking,
  PickReplay,
} from '../types/core';
import { CozyGPUError, type CozyGPUErrorCode } from '../types/errors';
import {
  PICK_RESULT_BYTES,
  PICK_TARGET_FORMAT,
  VIEW_UNIFORM_BYTES,
  VU_COL0,
  VU_COL1,
  VU_DPR,
  VU_DT,
  VU_RESOLUTION,
  VU_TIME,
  VU_TRANSLATE,
} from '../types/layouts';

/** Pick requests rendered per packet. */
/** Pick requests rendered per packet. */
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
  /** Requests rendered this packet, waiting for afterSubmit(). */
  private rendered = 0;
  private readonly renderedIds = new Uint32Array(PICK_SLOTS);
  private readonly viewData = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  private readonly clearColor = new Float32Array(4);
  private readonly passDesc: RenderPassDesc;
  /** Bumped by restore/destroy so late readbacks of old slots still answer. */
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
    const n = this.size < PICK_SLOTS ? this.size : PICK_SLOTS;
    this.ensureSlots(n);
    const backend = this.ctx.backend;
    const view = this.viewData;
    const cap = this.ids.length;
    for (let i = 0; i < n; i++) {
      const at = (this.head + i) % cap;
      const slot = this.slots[i];
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
    }
    // A pipeline still compiling skipped its draws: render again next packet.
    if (this.pipelinesPending(this.ctx)) return;
    for (let i = 0; i < n; i++) {
      this.renderedIds[i] = this.ids[(this.head + i) % cap];
    }
    this.head = (this.head + n) % cap;
    this.size -= n;
    this.rendered = n;
  }

  afterSubmit(): void {
    const n = this.rendered;
    if (n === 0) return;
    this.rendered = 0;
    const backend = this.ctx.backend;
    for (let i = 0; i < n; i++) {
      const requestId = this.renderedIds[i];
      let read: Promise<ArrayBuffer>;
      try {
        read = backend.readTexture(this.slots[i].texture, 0, 0, 1, 1);
      } catch (err) {
        read = Promise.reject(err);
      }
      read.then(
        data => {
          if (data.byteLength < PICK_RESULT_BYTES) {
            this.answerError(requestId, 'INTERNAL', 'short pick readback');
            return;
          }
          const texel = new Uint32Array(data, 0, 2);
          const objectId = texel[0];
          this.ctx.post({
            type: 'pick',
            requestId,
            objectId,
            instance: objectId === 0 ? -1 : texel[1] - 1,
          });
        },
        (err: unknown) => {
          const code =
            err instanceof CozyGPUError ? err.code : ('INTERNAL' as const);
          this.answerError(
            requestId,
            code,
            (err as Error)?.message ?? String(err),
          );
        },
      );
    }
  }

  failAll(code: 'DEVICE_LOST' | 'DESTROYED', message: string): void {
    const cap = this.ids.length;
    for (let i = 0; i < this.size; i++) {
      this.answerError(this.ids[(this.head + i) % cap], code, message);
    }
    this.head = 0;
    this.size = 0;
    // Rendered but not yet read back: the readback never starts.
    for (let i = 0; i < this.rendered; i++) {
      this.answerError(this.renderedIds[i], code, message);
    }
    this.rendered = 0;
  }

  async restore(ctx: CoreContext): Promise<void> {
    // The old device's objects are gone; recreate lazily on the next pick.
    this.ctx = ctx;
    this.slots = [];
  }

  destroy(): void {
    this.destroyed = true;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.texture.destroy();
      slot.buffer.destroy();
    }
    this.slots = [];
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

  private ensureSlots(n: number): void {
    const ctx = this.ctx;
    const backend = ctx.backend;
    while (this.slots.length < n) {
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
