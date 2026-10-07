/**
 * Render-thread executor: the same code runs on the main
 * thread (LocalTransport) and in the worker (src/worker/entry.ts).
 *
 * Per packet (ARCHITECTURE §2 "Frame lifecycle"):
 *   1. decode sequentially; DRAW-flagged commands are only remembered, the
 *      rest are executed (0x00 core, 0x01 textures/shared memory, other ranges
 *      go to their CoreSystem)
 *   2. compute phase: system.compute(list) in registration order
 *   3. one main render pass (MSAA-resolved when antialias) replaying the DRAW
 *      commands in stream order
 *   4. submit, system.endFrame(), post frameDone (buffer handed back)
 * M2.5: step 0 polls in-flight pick readbacks (ARCHITECTURE §19.6), and the
 * core keeps the table of external buffers registered through interop
 * (§19.4).
 *
 * Steady state allocates nothing: the frame state, pass descriptor, clear
 * color, draw-offset list and the frameDone message are reused.
 * DOM-free (worker-safe).
 */
import { createBackend } from '../backend/createBackend';
import type {
  Backend,
  BackendOptions,
  CommandList,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiTexture,
} from '../backend/types';
import { BufferUsage, ShaderStage, TextureUsage } from '../backend/types';
import { isDebugEnabled } from '../backend/utils';
import { createCommandDecoder } from '../commands';
import { CommandFlag, Op, OpcodeRange } from '../commands/opcodes';
import type {
  CommandDecoder,
  CommandReader,
  FramePacket,
  PacketObject,
} from '../commands/types';
import type {
  CoreContext,
  CoreFrameState,
  CoreInitOptions,
  CorePicking,
  CoreSystem,
  CoreTexture,
  PickReplay,
  RenderCore,
} from '../types/core';
import { CozyGPUError } from '../types/errors';
import {
  VIEW_UNIFORM_BYTES,
  VU_COL0,
  VU_COL1,
  VU_DPR,
  VU_DT,
  VU_RESOLUTION,
  VU_TIME,
  VU_TRANSLATE,
} from '../types/layouts';
import type { CoreMessage } from '../types/transport';
import type { Canvas } from '../types/types';
import { createCorePicking } from './pickingCore';
import { beginPickPipeline, endPickPipeline } from './pickingPipelines';
import { TextureRegistry, type ExternalImage } from './TextureRegistry';

type Post = (message: CoreMessage, transfer?: Transferable[]) => void;

const CoreState = {
  READY: 0,
  LOST: 1,
  DEAD: 2,
  DESTROYED: 3,
} as const;
/** recover(): consecutive DEVICE_LOST failures after a restore before DEAD. */
const MAX_LOSS_RETRIES = 3;

type CoreStateValue = (typeof CoreState)[keyof typeof CoreState];

/**
 * Optional backend hooks for readback pacing (not part of the RHI). Backends
 * pace only while a readback is in flight (ARCHITECTURE §7.1, §19.5).
 */
interface FramePacer {
  backlogged(): boolean;
  whenCaughtUp(callback: () => void): void;
  /**
   * Set by the core once picking exists: the backend calls it when a
   * readback lands (WebGPU: a ring slot's map; WebGL2: a ring fence seen by
   * a 1 ms timer), so picks are answered then, not in a later render().
   */
  onReadbackLanded: (() => void) | null;
}

class FrameState implements CoreFrameState {
  frameId = 0;
  time = 0;
  dt = 0;
  pixelWidth = 0;
  pixelHeight = 0;
  cssWidth = 0;
  cssHeight = 0;
  resolution = 1;
}

/** Mutable CoreContext: GPU objects are replaced after a device restore. */
export class Context implements CoreContext {
  viewLayout!: RhiBindGroupLayout;
  viewBindGroup!: RhiBindGroup;
  textureLayout!: RhiBindGroupLayout;
  textures!: TextureRegistry;
  /** M3: the descriptor of the frame's main pass (ARCHITECTURE §21.3). */
  mainPass!: RenderPassDesc;

  constructor(
    readonly backend: Backend,
    readonly sampleCount: 1 | 4,
    readonly post: Post,
  ) {}

  get whiteTexture(): CoreTexture {
    return this.textures.whiteTexture;
  }

  getTexture(texId: number): CoreTexture {
    return this.textures.get(texId);
  }

  // Filled by the core (shared-memory table).
  shared = new Map<number, ArrayBuffer | SharedArrayBuffer>();

  getShared(sharedId: number): ArrayBuffer | SharedArrayBuffer | undefined {
    return this.shared.get(sharedId);
  }

  /** M2.5 interop: imported buffers by external id (dropped on device loss). */
  ext = new Map<number, RhiBuffer>();
  /** Device losses so far (readbacks and interop registrations older than one fail). */
  lossEpoch = 0;

  getExternalBuffer(externalId: number): RhiBuffer | undefined {
    return this.ext.get(externalId);
  }

  pickPipelinePending(delta: 1 | -1): void {
    if (delta > 0) beginPickPipeline(this);
    else endPickPipeline(this);
  }
}

/** Reused PickReplay over the current packet's DRAW offsets (M2). */
class DrawReplay implements PickReplay {
  drawCount = 0;
  offsets: Uint32Array = new Uint32Array(0);

  constructor(
    private readonly decoder: CommandDecoder,
    private readonly systemsByRange: (CoreSystem | undefined)[],
    private readonly frame: CoreFrameState,
  ) {}

  drawPick(index: number, pass: RenderPass, view: RhiBindGroup): void {
    const decoder = this.decoder;
    decoder.seek(this.offsets[index]);
    const reader = decoder.reader;
    const system = this.systemsByRange[reader.opcode >>> 8];
    if (system && system.drawPick)
      system.drawPick(reader, pass, this.frame, view);
  }
}

export class RenderCoreImpl implements RenderCore {
  private state: CoreStateValue = CoreState.READY;
  private readonly ctx: Context;
  private readonly decoder: CommandDecoder;
  private readonly frame = new FrameState();
  private readonly systemsByRange: (CoreSystem | undefined)[] = new Array(256);

  private viewBuffer: RhiBuffer | null = null;
  private readonly view = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  private msaaTarget: RhiTexture | null = null;

  private drawOffsets = new Uint32Array(256);
  private readonly clearColor = new Float32Array([0, 0, 0, 1]);
  private readonly passDesc: RenderPassDesc = {
    label: 'cozygpu main',
    color: {
      target: 'canvas',
      resolveTarget: undefined,
      load: 'clear',
      clearColor: this.clearColor,
    },
  };

  private readonly frameDone = {
    type: 'frameDone' as const,
    frameId: 0,
    buffer: null as ArrayBuffer | SharedArrayBuffer | null,
  };
  /** M2 picking, created on the first PICK command. */
  private picking: CorePicking | null = null;
  private readonly replay: DrawReplay;
  private readonly frameDoneTransfer: Transferable[] = [];

  private readonly warned = new Set<string>();
  /** One bit per opcode: unknown opcodes warn once without building strings per frame. */
  private readonly warnedOpcodes = new Uint8Array(0x10000 >> 3);
  private restoring: Promise<void> | null = null;
  private lostAgain = false;

  /** Dev-only: gates the `debug()` hook (see createRenderCore). */
  private readonly debugEnabled: boolean;

  constructor(
    readonly backend: Backend,
    options: CoreInitOptions,
    private readonly systems: CoreSystem[],
    post: Post,
  ) {
    this.debugEnabled = isDebugEnabled(options);
    this.ctx = new Context(backend, options.antialias ? 4 : 1, post);
    this.ctx.mainPass = this.passDesc;
    this.decoder = createCommandDecoder();
    this.replay = new DrawReplay(this.decoder, this.systemsByRange, this.frame);
    for (let i = 0; i < systems.length; i++) {
      const range = systems[i].range;
      if (range === OpcodeRange.CORE || range === OpcodeRange.TEXTURE) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `system "${systems[i].name}" claims reserved opcode range 0x${range.toString(16)}`,
        );
      }
      if (this.systemsByRange[range]) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `systems "${this.systemsByRange[range]!.name}" and "${systems[i].name}" share opcode range 0x${range.toString(16)}`,
        );
      }
      this.systemsByRange[range] = systems[i];
    }
    this.frame.pixelWidth = backend.pixelWidth;
    this.frame.pixelHeight = backend.pixelHeight;
    this.frame.cssWidth = backend.pixelWidth;
    this.frame.cssHeight = backend.pixelHeight;
    // Identity stage → css transform.
    this.view[VU_COL0 >> 2] = 1;
    this.view[(VU_COL1 >> 2) + 1] = 1;
    this.createCoreResources();
    // Only the core's own destroy() is intentional, and it sets DESTROYED
    // before the backend releases the device (handleDeviceLost ignores it).
    // A 'destroyed' loss while the core is alive came from outside the
    // renderer (app code, extension, shared device): restore like any loss.
    backend.onDeviceLost(info => {
      this.handleDeviceLost(
        info.reason === 'destroyed'
          ? `GPU device was destroyed outside the renderer (${info.message})`
          : info.message,
      );
    });
  }

  /** Awaits every system's init (in registration order). */
  async init(): Promise<void> {
    for (let i = 0; i < this.systems.length; i++) {
      await this.systems[i].init(this.ctx);
    }
  }

  get caps(): Backend['caps'] {
    return this.backend.caps;
  }

  get fallbackReason(): string | undefined {
    return this.backend.fallbackReason;
  }

  /**
   * Dev-only debug actions driven from the front (Transport.debug). Only
   * reachable in debug mode, and a no-op on a backend without the hook.
   */
  debug(action: 'loseDevice'): void {
    if (!this.debugEnabled) return;
    if (action === 'loseDevice') {
      (
        this.backend as unknown as { simulateDeviceLoss?(): void }
      ).simulateDeviceLoss?.();
    }
  }

  /** @internal For tests, the device-loss example and interop (coreInterop.ts). */
  get context(): Context {
    return this.ctx;
  }

  /** @internal False while the device is lost or after destroy. */
  get ready(): boolean {
    return this.state === CoreState.READY;
  }

  /** @internal Resolves when an in-flight device restore finishes. */
  get restorePromise(): Promise<void> | null {
    return this.restoring;
  }

  execute(packet: FramePacket): void {
    // frameDone is posted exactly once per packet, whatever happens inside.
    try {
      this.runPacket(packet);
    } catch (err) {
      this.report(err, 'frame');
    } finally {
      this.ack(packet);
    }
  }

  private runPacket(packet: FramePacket): void {
    if (this.state !== CoreState.READY) {
      this.dropPacket(packet);
      return;
    }
    // 0. Answer pick readbacks that finished since the last packet.
    this.picking?.poll!();
    const decoder = this.decoder;
    try {
      decoder.reset(packet);
    } catch (err) {
      this.report(err, 'dropped corrupt packet');
      return;
    }
    const frame = this.frame;
    frame.frameId = decoder.frameId;
    const reader = decoder.reader;
    let drawCount = 0;
    // M3: a frame with a pass break reopens the main pass, so under MSAA its
    // multisampled attachment must survive the first pass' resolve.
    let passBreaks = 0;

    // 1. Execute non-DRAW commands, remember DRAW offsets.
    while (decoder.next()) {
      if ((reader.flags & CommandFlag.DRAW) !== 0) {
        if (drawCount === this.drawOffsets.length) this.growDrawOffsets();
        this.drawOffsets[drawCount++] = reader.commandOffset;
        if ((reader.flags & CommandFlag.PASS_BREAK) !== 0) passBreaks++;
        continue;
      }
      try {
        this.executeCommand(reader);
      } catch (err) {
        this.report(err, `opcode 0x${reader.opcode.toString(16)}`);
      }
      if (this.state !== CoreState.READY) {
        this.answerDroppedReadbacks();
        return;
      }
    }

    // A hidden (zero-size) canvas skips GPU work but still acks the frame.
    if (frame.pixelWidth > 0 && frame.pixelHeight > 0) {
      this.renderFrame(reader, drawCount, passBreaks);
    }

    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i];
      if (system.endFrame) {
        try {
          system.endFrame(frame);
        } catch (err) {
          this.report(err, `${system.name}.endFrame`);
        }
      }
    }
  }

  destroy(): void {
    if (this.state === CoreState.DESTROYED) return;
    this.state = CoreState.DESTROYED;
    for (let i = 0; i < this.systems.length; i++) {
      try {
        this.systems[i].destroy();
      } catch (err) {
        this.report(err, `${this.systems[i].name}.destroy`);
      }
    }
    if (this.picking) {
      (this.backend as Partial<FramePacer>).onReadbackLanded = null;
      this.picking.failAll('DESTROYED', 'renderer was destroyed');
      this.picking.destroy();
      this.picking = null;
    }
    this.destroyCoreResources();
    this.ctx.shared.clear();
    this.ctx.ext.clear();
    this.backend.destroy();
  }

  // ─── Frame phases ──────────────────────────────────────────────────────────

  private renderFrame(
    reader: CommandReader,
    drawCount: number,
    passBreaks: number,
  ): void {
    const backend = this.backend;
    const frame = this.frame;
    const view = this.view;
    view[VU_TIME >> 2] = frame.time;
    view[VU_DT >> 2] = frame.dt;
    backend.writeBuffer(this.viewBuffer!, 0, view);

    let list: CommandList | null = null;
    try {
      list = backend.beginCommands();

      // 2. Compute phase.
      for (let i = 0; i < this.systems.length; i++) {
        const system = this.systems[i];
        if (system.compute) {
          try {
            system.compute(list, frame);
          } catch (err) {
            this.report(err, `${system.name}.compute`);
          }
        }
      }

      // 3. Main render pass: replay DRAW commands in stream order.
      const color = this.passDesc.color;
      color.load = 'clear';
      if (this.msaaTarget) {
        color.target = this.msaaTarget;
        color.resolveTarget = 'canvas';
        color.keepMultisampled = passBreaks > 0;
      } else {
        color.target = 'canvas';
        color.resolveTarget = undefined;
      }
      let pass = list.beginRenderPass(this.passDesc);
      const decoder = this.decoder;
      for (let i = 0; i < drawCount; i++) {
        decoder.seek(this.drawOffsets[i]);
        const system = this.systemsByRange[reader.opcode >>> 8];
        if (!system) {
          this.warnUnknownOpcode(reader.opcode);
          continue;
        }
        // M3 (ARCHITECTURE §21.3): masks and filters may need a different
        // pass (stencil attachment, offscreen target) for what follows.
        if ((reader.flags & CommandFlag.PASS_BREAK) !== 0 && system.passBreak) {
          pass.end();
          let desc: RenderPassDesc | null = null;
          try {
            desc = system.passBreak(reader, list, frame);
          } catch (err) {
            this.report(err, `${system.name}.passBreak`);
          }
          color.load = 'load';
          pass = list.beginRenderPass(desc ?? this.passDesc);
        }
        try {
          system.draw(reader, pass, frame);
        } catch (err) {
          this.report(err, `${system.name}.draw`);
        }
      }
      pass.end();

      // 3b. M2 pick pass (ARCHITECTURE §16.3), same command list.
      const picking = this.picking;
      if (picking && picking.pending > 0) {
        const replay = this.replay;
        replay.drawCount = drawCount;
        replay.offsets = this.drawOffsets;
        try {
          picking.render(list, replay, frame);
        } catch (err) {
          this.report(err, 'pick');
        }
      }
    } catch (err) {
      this.report(err, 'frame');
    } finally {
      // 4. Always submit what was recorded so passes are closed.
      if (list) {
        try {
          list.submit();
        } catch (err) {
          this.report(err, 'submit');
        }
      }
    }
  }

  private executeCommand(reader: CommandReader): void {
    const opcode = reader.opcode;
    const range = opcode >>> 8;
    if (range === OpcodeRange.CORE) {
      this.executeCore(reader);
    } else if (range === OpcodeRange.TEXTURE) {
      this.executeTexture(reader);
    } else {
      const system = this.systemsByRange[range];
      if (system) {
        system.execute(reader, this.frame);
      } else {
        this.warnUnknownOpcode(opcode);
      }
    }
  }

  private executeCore(reader: CommandReader): void {
    const frame = this.frame;
    switch (reader.opcode) {
      case Op.NOP:
      case Op.FRAME_END:
        return;
      case Op.FRAME_BEGIN:
        frame.time = reader.f32();
        frame.dt = reader.f32();
        return;
      case Op.RESIZE: {
        const cssWidth = reader.f32();
        const cssHeight = reader.f32();
        const resolution = reader.f32();
        this.resize(cssWidth, cssHeight, resolution);
        return;
      }
      case Op.SET_CLEAR_COLOR:
        this.clearColor[0] = reader.f32();
        this.clearColor[1] = reader.f32();
        this.clearColor[2] = reader.f32();
        this.clearColor[3] = reader.f32();
        return;
      case Op.SET_VIEW: {
        // (a, b) → col0, (c, d) → col1, (tx, ty) → translate.
        const view = this.view;
        view[VU_COL0 >> 2] = reader.f32();
        view[(VU_COL0 >> 2) + 1] = reader.f32();
        view[VU_COL1 >> 2] = reader.f32();
        view[(VU_COL1 >> 2) + 1] = reader.f32();
        view[VU_TRANSLATE >> 2] = reader.f32();
        view[(VU_TRANSLATE >> 2) + 1] = reader.f32();
        return;
      }
      default:
        this.warnUnknownOpcode(reader.opcode);
    }
  }

  private executeTexture(reader: CommandReader): void {
    const textures = this.ctx.textures;
    switch (reader.opcode) {
      case Op.TEXTURE_CREATE: {
        const texId = reader.u32();
        const width = reader.u32();
        const height = reader.u32();
        const formatId = reader.u32();
        const flags = reader.u32();
        textures.create(texId, width, height, formatId, flags);
        return;
      }
      case Op.TEXTURE_UPLOAD_PIXELS: {
        const texId = reader.u32();
        const x = reader.u32();
        const y = reader.u32();
        const w = reader.u32();
        const h = reader.u32();
        const at = reader.blob(w * h * 4);
        textures.uploadPixels(texId, x, y, w, h, reader.u8, at);
        return;
      }
      case Op.TEXTURE_UPLOAD_BITMAP: {
        const texId = reader.u32();
        const objectIndex = reader.u32();
        const flipY = reader.u32() !== 0;
        const image = reader.object<PacketObject>(objectIndex);
        textures.uploadImage(texId, image as unknown as ExternalImage, flipY);
        return;
      }
      case Op.TEXTURE_DESTROY:
        textures.destroy(reader.u32());
        return;
      case Op.TEXTURE_UPLOAD_BITMAP_REGION: {
        const texId = reader.u32();
        const objectIndex = reader.u32();
        const x = reader.u32();
        const y = reader.u32();
        const flipY = reader.u32() !== 0;
        const image = reader.object<PacketObject>(objectIndex);
        textures.uploadBitmapRegion(
          texId,
          image as unknown as ExternalImage,
          x,
          y,
          flipY,
        );
        return;
      }
      case Op.TEXTURE_UPLOAD_COMPRESSED: {
        const texId = reader.u32();
        const mipLevel = reader.u32();
        const width = reader.u32();
        const height = reader.u32();
        const objectIndex = reader.u32();
        const byteOffset = reader.u32();
        const byteLength = reader.u32();
        const data = reader.object<ArrayBuffer>(objectIndex);
        textures.uploadCompressed(
          texId,
          mipLevel,
          width,
          height,
          data,
          byteOffset,
          byteLength,
        );
        return;
      }
      case Op.TEXTURE_GENERATE_MIPMAPS:
        textures.generateMipmaps(reader.u32());
        return;
      case Op.SHARED_REGISTER: {
        const sharedId = reader.u32();
        const objectIndex = reader.u32();
        this.ctx.shared.set(
          sharedId,
          reader.object<ArrayBuffer | SharedArrayBuffer>(objectIndex),
        );
        return;
      }
      case Op.SHARED_RELEASE:
        this.ctx.shared.delete(reader.u32());
        return;
      case Op.READBACK: {
        const requestId = reader.u32();
        const srcKind = reader.u32();
        const srcId = reader.u32();
        const first = reader.u32();
        const count = reader.u32();
        this.readback(requestId, srcKind, srcId, first, count);
        return;
      }
      case Op.PICK: {
        const requestId = reader.u32();
        const x = reader.f32();
        const y = reader.f32();
        if (!this.picking) {
          this.picking = createCorePicking(this.ctx);
          (this.backend as Partial<FramePacer>).onReadbackLanded =
            this.pollPicks;
        }
        this.picking.request(requestId, x, y);
        return;
      }
      default:
        this.warnUnknownOpcode(reader.opcode);
    }
  }

  private resize(
    cssWidth: number,
    cssHeight: number,
    resolution: number,
  ): void {
    const frame = this.frame;
    const res = resolution > 0 ? resolution : 1;
    const w = Math.max(0, cssWidth);
    const h = Math.max(0, cssHeight);
    this.backend.resize(Math.round(w * res), Math.round(h * res));
    frame.cssWidth = w;
    frame.cssHeight = h;
    frame.resolution = res;
    frame.pixelWidth = this.backend.pixelWidth;
    frame.pixelHeight = this.backend.pixelHeight;
    this.view[VU_RESOLUTION >> 2] = w;
    this.view[(VU_RESOLUTION >> 2) + 1] = h;
    this.view[VU_DPR >> 2] = res;
    this.recreateTargets();
  }

  private readback(
    requestId: number,
    srcKind: number,
    srcId: number,
    first: number,
    count: number,
  ): void {
    let pending: Promise<ArrayBuffer> | undefined;
    for (let i = 0; i < this.systems.length && !pending; i++) {
      const system = this.systems[i];
      if (system.readback) {
        pending = system.readback(srcKind, srcId, first, count);
      }
    }
    const post = this.ctx.post;
    if (!pending) {
      post({
        type: 'readback',
        requestId,
        data: new ArrayBuffer(0),
        code: 'UNSUPPORTED',
        message: `no system handles srcKind ${srcKind}`,
      });
      return;
    }
    const readbackEpoch = this.ctx.lossEpoch;
    pending.then(
      data => post({ type: 'readback', requestId, data }, [data]),
      err => {
        const message = (err as Error)?.message ?? String(err);
        // mapAsync rejects when the device is lost mid-read; that is not an
        // internal error (the front already hears deviceLost).
        if (
          this.state !== CoreState.READY ||
          readbackEpoch !== this.ctx.lossEpoch ||
          (err instanceof CozyGPUError && err.code === 'DEVICE_LOST')
        ) {
          post({
            type: 'readback',
            requestId,
            data: new ArrayBuffer(0),
            code: 'DEVICE_LOST',
            message,
          });
          return;
        }
        // Library errors (e.g. OUT_OF_CAPACITY for a refused swarm) go to the
        // caller through the promise; anything else is a bug worth logging.
        if (!(err instanceof CozyGPUError)) {
          this.report(err, `READBACK ${requestId}`);
        }
        post({
          type: 'readback',
          requestId,
          data: new ArrayBuffer(0),
          code: err instanceof CozyGPUError ? err.code : 'INTERNAL',
          message,
        });
      },
    );
  }

  /**
   * A packet that cannot run (device lost, dead) still answers its READBACK
   * commands with empty data, so front-side promises always settle.
   */
  private dropPacket(packet: FramePacket): void {
    if (this.state === CoreState.DESTROYED) return;
    try {
      this.decoder.reset(packet);
    } catch {
      return; // corrupt: nothing trustworthy to answer
    }
    this.answerDroppedReadbacks();
  }

  /** Answers every READBACK left in the current packet with empty data. */
  private answerDroppedReadbacks(): void {
    const decoder = this.decoder;
    const reader = decoder.reader;
    const post = this.ctx.post;
    while (decoder.next()) {
      if (reader.opcode === Op.PICK) {
        post({
          type: 'pick',
          requestId: reader.u32(),
          objectId: 0,
          instance: -1,
          code: 'DEVICE_LOST',
          message: 'GPU device lost before the pick ran',
        });
        continue;
      }
      if (reader.opcode !== Op.READBACK) continue;
      post({
        type: 'readback',
        requestId: reader.u32(),
        data: new ArrayBuffer(0),
        code: 'DEVICE_LOST',
        message: 'GPU device lost before the readback ran',
      });
    }
  }

  private ack(packet: FramePacket): void {
    const msg = this.frameDone;
    msg.frameId = packet.frameId;
    msg.buffer = packet.buffer;
    // Readback pacing: while the GPU is far behind, frameDone waits for it,
    // so the transport stays busy and the front skips frames instead of
    // queueing more work in front of the readback.
    const pacer = this.backend as Partial<FramePacer>;
    if (pacer.backlogged !== undefined && pacer.backlogged()) {
      pacer.whenCaughtUp!(this.releaseHeld);
      return;
    }
    this.postFrameDone();
  }

  /**
   * A held frame goes (its readback landed): answer finished picks now. The
   * next render() may come a display tick later (ARCHITECTURE §19.5).
   */
  private readonly releaseHeld = (): void => {
    if (this.state === CoreState.READY) this.picking?.poll!();
    this.postFrameDone();
  };

  /**
   * FramePacer.onReadbackLanded: a readback landed between packets; answer
   * finished picks now instead of in a later render() (ARCHITECTURE §19.6).
   */
  private readonly pollPicks = (): void => {
    if (this.state === CoreState.READY) this.picking?.poll!();
  };

  private readonly postFrameDone = (): void => {
    const msg = this.frameDone;
    if (msg.buffer === null) return;
    this.frameDoneTransfer[0] = msg.buffer;
    // Reused message object: listeners must read it synchronously.
    this.ctx.post(msg, this.frameDoneTransfer);
    msg.buffer = null;
  };

  // ─── GPU resources owned by the core ───────────────────────────────────────

  private createCoreResources(): void {
    const backend = this.backend;
    const ctx = this.ctx;
    const compute = backend.caps.compute ? ShaderStage.COMPUTE : 0;
    ctx.viewLayout = backend.createBindGroupLayout({
      label: 'cozygpu view',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT | compute,
          type: { kind: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
        },
      ],
    });
    this.viewBuffer = backend.createBuffer({
      label: 'cozygpu view',
      size: VIEW_UNIFORM_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    backend.writeBuffer(this.viewBuffer, 0, this.view);
    ctx.viewBindGroup = backend.createBindGroup({
      label: 'cozygpu view',
      layout: ctx.viewLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer } }],
    });
    ctx.textureLayout = backend.createBindGroupLayout({
      label: 'cozygpu texture',
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: { kind: 'texture', sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
          type: { kind: 'sampler', filtering: true },
        },
      ],
    });
    if (!ctx.textures) {
      ctx.textures = new TextureRegistry({
        backend,
        get textureLayout() {
          return ctx.textureLayout;
        },
        warn: message => this.warnOnce(message),
      });
    }
    this.recreateTargets();
  }

  private recreateTargets(): void {
    if (this.msaaTarget) {
      this.msaaTarget.destroy();
      this.msaaTarget = null;
    }
    const backend = this.backend;
    if (
      this.ctx.sampleCount === 4 &&
      backend.pixelWidth > 0 &&
      backend.pixelHeight > 0
    ) {
      this.msaaTarget = backend.createTexture({
        label: 'cozygpu msaa',
        width: backend.pixelWidth,
        height: backend.pixelHeight,
        format: backend.caps.canvasFormat,
        usage: TextureUsage.RENDER_TARGET,
        sampleCount: 4,
      });
    }
  }

  private destroyCoreResources(): void {
    if (this.ctx.textures) this.ctx.textures.destroyAll();
    if (this.viewBuffer) this.viewBuffer.destroy();
    this.viewBuffer = null;
    if (this.msaaTarget) this.msaaTarget.destroy();
    this.msaaTarget = null;
  }

  // ─── Device loss (ARCHITECTURE §9.1) ───────────────────────────────────────

  private handleDeviceLost(message: string): void {
    if (this.state === CoreState.DESTROYED || this.state === CoreState.DEAD) {
      return;
    }
    if (this.restoring) {
      this.lostAgain = true;
      return;
    }
    this.state = CoreState.LOST;
    this.ctx.lossEpoch++;
    this.ctx.ext.clear();
    this.picking?.failAll('DEVICE_LOST', message);
    this.ctx.post({ type: 'deviceLost', message });
    this.restoring = this.recover().finally(() => {
      this.restoring = null;
    });
  }

  private async recover(): Promise<void> {
    // Losses noticed by a failing call (DEVICE_LOST) after the backend came
    // back, before its own loss notification arrived; bounded so a device
    // that keeps failing still ends DEAD.
    let lossRetries = 0;
    do {
      this.lostAgain = false;
      let restored = false;
      try {
        await this.backend.restore();
        restored = true;
        if (this.isDestroyed()) return;
        this.msaaTarget = null;
        this.createCoreResources();
        this.ctx.textures.restore();
        for (let i = 0; i < this.systems.length; i++) {
          await this.systems[i].restore(this.ctx);
          if (this.isDestroyed()) return;
        }
        if (this.picking) await this.picking.restore(this.ctx);
      } catch (err) {
        if (this.isDestroyed()) return;
        if (this.lostAgain) continue;
        if (
          restored &&
          err instanceof CozyGPUError &&
          err.code === 'DEVICE_LOST' &&
          lossRetries < MAX_LOSS_RETRIES
        ) {
          // Lost again while re-creating resources (WebGL2: program creation
          // sees the lost context before the webglcontextlost event fires).
          // Restore again instead of going DEAD.
          lossRetries++;
          this.lostAgain = true;
          continue;
        }
        this.state = CoreState.DEAD;
        this.ctx.post({
          type: 'error',
          code: 'DEVICE_LOST',
          message: (err as Error)?.message ?? String(err),
        });
        return;
      }
    } while (this.lostAgain);
    this.state = CoreState.READY;
    this.ctx.post({ type: 'deviceRestored' });
  }

  private isDestroyed(): boolean {
    return this.state === CoreState.DESTROYED;
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────────

  private growDrawOffsets(): void {
    const next = new Uint32Array(this.drawOffsets.length * 2);
    next.set(this.drawOffsets);
    this.drawOffsets = next;
  }

  private warnUnknownOpcode(opcode: number): void {
    const byte = opcode >>> 3;
    const bit = 1 << (opcode & 7);
    if ((this.warnedOpcodes[byte] & bit) !== 0) return;
    this.warnedOpcodes[byte] |= bit;
    this.warnOnce(`unknown opcode 0x${opcode.toString(16)} skipped`);
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    // eslint-disable-next-line no-console
    console.warn(`[cozygpu] ${message}`);
  }

  /** Posts one `error` message per distinct failure (never floods per frame). */
  private report(err: unknown, where: string): void {
    const code = err instanceof CozyGPUError ? err.code : 'INTERNAL';
    const message = `${where}: ${(err as Error)?.message ?? String(err)}`;
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.ctx.post({ type: 'error', code, message });
  }
}

/**
 * Creates the backend, wires the systems and awaits their `init`.
 * Does not post `ready`: the transport / worker entry does that.
 */
export async function createRenderCore(
  canvas: Canvas,
  options: CoreInitOptions,
  systems: CoreSystem[],
  post: Post,
): Promise<RenderCore> {
  const backendOptions: BackendOptions = {
    preference: options.backend,
    powerPreference: options.powerPreference,
    limits: options.limits,
    alphaMode: options.alphaMode ?? 'premultiplied',
    debug: options.debug,
  };
  const backend = await createBackend(canvas, backendOptions);
  let core: RenderCoreImpl;
  try {
    core = new RenderCoreImpl(backend, options, systems, post);
  } catch (err) {
    backend.destroy();
    throw err;
  }
  try {
    await core.init();
  } catch (err) {
    core.destroy();
    throw err;
  }
  if (isDebugEnabled(backendOptions)) {
    // Dev-only handle for examples/tests (e.g. simulating a device loss).
    (globalThis as { __COZYGPU_CORE__?: RenderCoreImpl }).__COZYGPU_CORE__ =
      core;
  }
  return core;
}
