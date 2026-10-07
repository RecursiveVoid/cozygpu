/**
 * Retain core system (M5, ARCHITECTURE §27.3), range `OpcodeRange.RETAIN`
 * (0x07), chunk `retain-core`, lazy in both modes. DOM-free.
 *
 * RETAIN_BEGIN(id) … RETAIN_END(id): `drawSpan` draws the DRAW commands in
 * between through their systems and keeps them: the command bytes go into
 * the segment's store (re-read with a small reader of its own) and,
 * when the backend has render bundles, the draws are recorded into a bundle
 * built for the open pass, which then runs in it.
 *
 * RETAIN_DRAW(id): executes the segment's bundle for this pass. The segment
 * is re-recorded from its stored commands when no bundle fits the pass
 * (other attachments: up to MAX_VARIANTS bundles per segment), after
 * `retain.invalidate()` (a GPU object a recorded draw used was replaced),
 * or when its recording skipped a draw (`retain.skipped()`). Without
 * bundles the stored commands are drawn through their systems: still no
 * front work and no transfer.
 *
 * Picking: RETAIN_DRAW replays the stored commands through each system's
 * `drawPick`; RETAIN_BEGIN / RETAIN_END are no-ops there (the commands in
 * between are ordinary DRAW commands of the packet).
 *
 * Steady state (replaying) allocates nothing; recording grows a segment's
 * store at most.
 */
import type {
  RenderBundleEncoder,
  RenderPass,
  RhiBindGroup,
  RhiRenderBundle,
} from '../backend/types';
import {
  CH_FLAGS,
  CH_OPCODE,
  CH_PAYLOAD_BYTES,
  COMMAND_HEADER_BYTES,
  OpcodeRange,
} from '../commands/opcodes';
import { RetainFlag, RetainOp } from '../commands/retainOpcodes';
import type { CommandReader, PacketObject } from '../commands/types';
import type {
  CoreContext,
  CoreFrameState,
  CoreSystem,
  DrawSpan,
  RetainHooks,
} from '../types/core';

/** Bundles kept per segment (main pass, stencil-reopened pass, capture). */
const MAX_VARIANTS = 3;
const INITIAL_WORDS = 64;

/**
 * Reads the stored commands of a segment (written by the core itself, so
 * well formed): a CommandReader over the segment's words, moved command by
 * command with `at`.
 */
class StoredReader implements CommandReader {
  opcode = 0;
  flags = 0;
  commandOffset = 0;
  payloadOffset = 0;
  payloadBytes = 0;
  u8: Uint8Array = new Uint8Array(0);
  u32View: Uint32Array = new Uint32Array(0);
  f32View: Float32Array = new Float32Array(0);
  private cursor = 0;

  /** Positions the reader on the command at byte `offset` of `seg`. */
  at(seg: Segment, offset: number): void {
    if (this.u32View !== seg.u32) {
      this.u8 = seg.u8;
      this.u32View = seg.u32;
      this.f32View = seg.f32;
    }
    const u32 = seg.u32;
    const head = u32[(offset + CH_OPCODE) >> 2];
    this.opcode = head & 0xffff;
    this.flags = u32[(offset + CH_FLAGS) >> 2] >>> 16;
    this.commandOffset = offset;
    this.payloadOffset = this.cursor = offset + COMMAND_HEADER_BYTES;
    this.payloadBytes = u32[(offset + CH_PAYLOAD_BYTES) >> 2];
  }

  u32(): number {
    const c = this.cursor;
    this.cursor = c + 4;
    return this.u32View[c >> 2];
  }

  i32(): number {
    return this.u32() | 0;
  }

  f32(): number {
    const c = this.cursor;
    this.cursor = c + 4;
    return this.f32View[c >> 2];
  }

  blob(byteLength: number): number {
    const c = this.cursor;
    this.cursor = c + ((byteLength + 3) & ~3);
    return c;
  }

  skip(byteLength: number): void {
    this.blob(byteLength);
  }

  /** DRAW commands carry no strings or packet objects. */
  utf8(): string {
    return '';
  }

  object<T extends PacketObject>(): T {
    return undefined as unknown as T;
  }
}

class Segment {
  u32 = new Uint32Array(INITIAL_WORDS);
  u8 = new Uint8Array(this.u32.buffer);
  f32 = new Float32Array(this.u32.buffer);
  /** Bytes of stored commands. */
  byteLength = 0;
  readonly bundles: (RhiRenderBundle | null)[] = [null, null, null];
  /** Bundles in use, and the next slot to replace when all are. */
  nb = 0;
  next = 0;
  /** RetainCore.epoch at recording; a later invalidate() makes it stale. */
  epoch = -1;
  /** A draw was skipped while recording: re-record on the next use. */
  stale = false;
  flags = 0;

  /** Starts a new recording. */
  reset(flags: number): void {
    this.byteLength = 0;
    this.flags = flags;
    this.drop();
  }

  /** Forgets every bundle. */
  drop(): void {
    for (let i = 0; i < MAX_VARIANTS; i++) {
      this.bundles[i]?.destroy();
      this.bundles[i] = null;
    }
    this.nb = this.next = 0;
  }

  /** Appends the command `reader` is on (header + payload, whole words). */
  push(reader: CommandReader): void {
    const from = reader.commandOffset >> 2;
    const n = (COMMAND_HEADER_BYTES + reader.payloadBytes) >> 2;
    const at = this.byteLength >> 2;
    if (at + n > this.u32.length) {
      const grown = new Uint32Array(Math.max(at + n, this.u32.length * 2));
      grown.set(this.u32);
      this.u32 = grown;
      this.u8 = new Uint8Array(grown.buffer);
      this.f32 = new Float32Array(grown.buffer);
    }
    const src = reader.u32View;
    const dst = this.u32;
    for (let i = 0; i < n; i++) dst[at + i] = src[from + i];
    this.byteLength = (at + n) << 2;
  }

  /** Keeps `bundle` as one of the variants. */
  keep(bundle: RhiRenderBundle): void {
    const k = this.nb < MAX_VARIANTS ? this.nb++ : this.next;
    this.bundles[k]?.destroy();
    this.bundles[k] = bundle;
    this.next = (k + 1) % MAX_VARIANTS;
  }
}

/** Packets after a restore that may still carry old-generation segment ids. */
const RESTORE_QUIET_PACKETS = 16;

export class RetainCoreSystem implements CoreSystem, RetainHooks {
  readonly name = 'retain';
  readonly range = OpcodeRange.RETAIN;

  private ctx: CoreContext | null = null;
  private readonly segments: (Segment | null)[] = [];
  private readonly reader = new StoredReader();
  /** Bumped by invalidate(): bundles recorded before are stale. */
  private epoch = 0;
  /** Inside a recording (skipped() only counts then). */
  private recording = false;
  private skippedDraw = false;
  private warnedUnknown = false;
  /**
   * Packets left after a device restore in which RETAIN_DRAW of an unknown
   * segment is expected (encoded before the front saw the new generation;
   * it re-records once it does) and dropped without a report.
   */
  private quiet = 0;
  /** Debug/tests: segments replayed and recorded so far. */
  replayed = 0;
  recorded = 0;

  async init(ctx: CoreContext): Promise<void> {
    this.install(ctx);
    await ctx.backend.loadRenderBundles?.();
  }

  async restore(ctx: CoreContext): Promise<void> {
    // Every bundle belonged to the lost device; the front re-records.
    this.segments.length = 0;
    this.quiet = RESTORE_QUIET_PACKETS;
    this.warnedUnknown = false;
    this.install(ctx);
    await ctx.backend.loadRenderBundles?.();
  }

  private install(ctx: CoreContext): void {
    this.ctx = ctx;
    ctx.retain = this;
  }

  // ── RetainHooks ────────────────────────────────────────────────────────────

  invalidate(): void {
    this.epoch++;
  }

  skipped(): void {
    if (this.recording) this.skippedDraw = true;
  }

  // ── commands ───────────────────────────────────────────────────────────────

  execute(reader: CommandReader, _frame: CoreFrameState): void {
    if (reader.opcode !== RetainOp.RETAIN_DESTROY) return;
    const id = reader.u32();
    this.segments[id]?.drop();
    if (id < this.segments.length) this.segments[id] = null;
  }

  draw(reader: CommandReader, pass: RenderPass, frame: CoreFrameState): void {
    if (reader.opcode === RetainOp.RETAIN_DRAW) {
      this.drawSegment(reader.u32(), pass, frame);
    }
  }

  drawSpan(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    span: DrawSpan,
  ): number {
    if (reader.opcode !== RetainOp.RETAIN_BEGIN) {
      this.draw(reader, pass, frame);
      return 0;
    }
    const ctx = this.ctx;
    const id = reader.u32();
    const flags = reader.u32();
    const seg = (this.segments[id] ??= new Segment());
    seg.reset(flags);
    // Store every DRAW command up to RETAIN_END, drawing it into a bundle
    // encoder (or straight into the pass).
    const encoder = this.encoderFor(pass, seg);
    const target: RenderPass = encoder ?? pass;
    this.recording = true;
    this.skippedDraw = false;
    let i = span.index + 1;
    for (; i < span.count; i++) {
      const r = span.seek(i);
      if (r.opcode === RetainOp.RETAIN_END) break;
      seg.push(r);
      const system = ctx?.systemFor?.(r.opcode >>> 8);
      if (system && system !== this) this.drawWith(system, r, target, frame);
    }
    this.recording = false;
    seg.epoch = this.epoch;
    seg.stale = this.skippedDraw;
    this.recorded++;
    if (encoder) this.finish(seg, encoder, pass, frame);
    return Math.min(i, span.count - 1) - span.index;
  }

  /** A bundle encoder for `pass`, or null (no bundles, or NO_BUNDLE). */
  private encoderFor(
    pass: RenderPass,
    seg: Segment,
  ): RenderBundleEncoder | null {
    const backend = this.ctx?.backend;
    return backend &&
      backend.createRenderBundleEncoder &&
      pass.executeBundle &&
      (seg.flags & RetainFlag.NO_BUNDLE) === 0
      ? backend.createRenderBundleEncoder(pass)
      : null;
  }

  /** Ends a bundle recording: keeps and executes it, or draws directly. */
  private finish(
    seg: Segment,
    encoder: RenderBundleEncoder,
    pass: RenderPass,
    frame: CoreFrameState,
  ): void {
    const bundle = encoder.finish();
    if (bundle === null) {
      // A pass-state call: this segment is drawn as commands only.
      seg.flags |= RetainFlag.NO_BUNDLE;
      this.replay(seg, pass, frame, null);
      return;
    }
    pass.executeBundle!(bundle);
    if (seg.stale) bundle.destroy();
    else seg.keep(bundle);
  }

  /** RETAIN_DRAW: a fitting bundle, else a fresh recording, else commands. */
  private drawSegment(id: number, pass: RenderPass, frame: CoreFrameState) {
    const seg = this.segments[id];
    if (!seg) {
      if (this.quiet === 0 && !this.warnedUnknown) {
        this.warnedUnknown = true;
        this.ctx?.post({
          type: 'error',
          code: 'INTERNAL',
          message: `RETAIN_DRAW: unknown segment ${id}`,
        });
      }
      return;
    }
    this.replayed++;
    if (seg.stale || seg.epoch !== this.epoch) {
      seg.drop();
      seg.stale = false;
      seg.epoch = this.epoch;
    }
    const execute = pass.executeBundle;
    if (execute) {
      for (let k = 0; k < seg.nb; k++) {
        if (pass.executeBundle!(seg.bundles[k]!)) return;
      }
    }
    const encoder = this.encoderFor(pass, seg);
    if (!encoder) {
      this.replay(seg, pass, frame, null);
      return;
    }
    this.recording = true;
    this.skippedDraw = false;
    this.replay(seg, encoder, frame, null);
    this.recording = false;
    seg.stale = this.skippedDraw;
    this.finish(seg, encoder, pass, frame);
  }

  /** Draws (or, with `pickView`, picks) the stored commands of `seg`. */
  private replay(
    seg: Segment,
    pass: RenderPass,
    frame: CoreFrameState,
    pickView: RhiBindGroup | null,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const r = this.reader;
    for (let at = 0; at < seg.byteLength; ) {
      r.at(seg, at);
      at = r.payloadOffset + r.payloadBytes;
      const system = ctx.systemFor?.(r.opcode >>> 8);
      if (!system || system === this) continue;
      if (pickView === null) this.drawWith(system, r, pass, frame);
      else if (system.drawPick) {
        try {
          system.drawPick(r, pass, frame, pickView);
        } catch (err) {
          this.report(err);
        }
      }
    }
  }

  private drawWith(
    system: CoreSystem,
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
  ): void {
    try {
      system.draw(reader, pass, frame);
    } catch (err) {
      this.report(err);
    }
  }

  private report(err: unknown): void {
    this.ctx?.post({
      type: 'error',
      code: 'INTERNAL',
      message: `retained segment: ${(err as Error)?.message ?? String(err)}`,
    });
  }

  endFrame(): void {
    if (this.quiet > 0) this.quiet--;
  }

  drawPick(
    reader: CommandReader,
    pass: RenderPass,
    frame: CoreFrameState,
    view: RhiBindGroup,
  ): void {
    if (reader.opcode !== RetainOp.RETAIN_DRAW) return;
    const seg = this.segments[reader.u32()];
    if (seg) this.replay(seg, pass, frame, view);
  }

  destroy(): void {
    for (let i = 0; i < this.segments.length; i++) this.segments[i]?.drop();
    this.segments.length = 0;
    if (this.ctx && this.ctx.retain === this) this.ctx.retain = undefined;
    this.ctx = null;
  }
}

export function createRetainCoreSystem(): CoreSystem {
  return new RetainCoreSystem();
}
