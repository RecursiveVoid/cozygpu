/**
 * Retained rendering opcodes (M5, ARCHITECTURE §27). The range is
 * `OpcodeRange.RETAIN` (0x07) in `opcodes.ts`; the values live here because
 * only the lazily loaded retain chunks use them (a constant imported from
 * `opcodes.ts` by a lazy chunk would land on the minimal path, §26.9).
 *
 * A segment is a run of DRAW commands the core records once and replays
 * while the front reports it unchanged. Segment ids are allocated by the
 * front (per renderer, private to the retain core's table, like graphics
 * buffer ids). The core keeps a copy of the recorded command bytes, so it
 * can re-record a segment itself (pass layout change, a replaced GPU
 * resource, a draw skipped while a pipeline compiled) and replay it into
 * the pick pass. After a device loss every segment is gone; the front
 * re-records them (new `FrontFrame.generation`).
 */
export const RetainOp = {
  /**
   * DRAW. u32 segmentId, u32 flags (RetainFlag). Starts recording: every
   * DRAW command up to the matching RETAIN_END is drawn now AND stored as
   * segment `segmentId`, replacing its previous contents. Non-DRAW commands
   * in between are executed as usual (they are not part of the segment).
   * Segments never nest and never contain a PASS_BREAK command.
   */
  RETAIN_BEGIN: 0x0700,
  /** DRAW. u32 segmentId. Ends the recording opened by RETAIN_BEGIN. */
  RETAIN_END: 0x0701,
  /**
   * DRAW. u32 segmentId. Draws the recorded segment: a render bundle on
   * WebGPU (`RenderPass.executeBundle`), the recorded call list on WebGL2,
   * or a replay of the stored commands through their systems when the
   * backend has neither. Unknown ids draw nothing (one console error).
   */
  RETAIN_DRAW: 0x0702,
  /** u32 segmentId. Frees the stored commands and bundles. */
  RETAIN_DESTROY: 0x0703,
} as const;

/** M5. RETAIN_BEGIN.flags. */
export const RetainFlag = {
  /**
   * Store the commands but never build a native bundle: RETAIN_DRAW replays
   * them through their systems. For A/B measurements and debugging.
   */
  NO_BUNDLE: 1 << 0,
} as const;

/** M5. Payload sizes (bytes). */
export const RETAIN_BEGIN_BYTES = 8;
export const RETAIN_END_BYTES = 4;
export const RETAIN_DRAW_BYTES = 4;
export const RETAIN_DESTROY_BYTES = 4;

/**
 * M5. The scene packer loads the retain chunks only for scenes that profit:
 * a batch list of at least this many entries whose structure stayed
 * unchanged for RETAIN_WARMUP_FRAMES consecutive frames (§27.2).
 */
export const RETAIN_MIN_ENTRIES = 8;
export const RETAIN_WARMUP_FRAMES = 2;

export type RetainOpcode = (typeof RetainOp)[keyof typeof RetainOp];
