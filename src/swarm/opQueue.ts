/**
 * Owner: "swarm". Core-side per-swarm op queue shared by the WebGPU
 * (./core.ts) and WebGL2 (./coreGl.ts) swarm cores. Ops are u32 words in
 * one growable array; nothing allocates in steady state.
 */
import {
  SWARM_COLD_BYTES,
  SWARM_HOT_BYTES,
  SWARM_SPAWN_BYTES,
} from '../types/layouts';

export const OP_SPAWN = 1; // [op, 28 words SpawnParams]
export const OP_KILL_RANGE = 2; // [op, first, count]
export const OP_KILL_LIST = 3; // [op, n, ...n]
export const OP_WRITE_HOT = 4; // [op, first, count, ...count*10 words]
export const OP_WRITE_COLD = 5; // [op, first, count, ...count*4 words]
export const OP_STEP = 6; // [op, dt(f32), substeps, count]
/** allocation 'gpu': fill the free list with [capacity-1 … 0]. */
export const OP_INIT_FREE = 7; // [op]
/**
 * M2.5 SWARM_SET_SOURCE (WebGPU core): switch hot/cold to external buffers
 * (0 = own). Ordered like a write: never after a dispatch of the same frame.
 */
export const OP_SOURCE = 8; // [op, hotExternalId, coldExternalId, flags]

export const SPAWN_WORDS = SWARM_SPAWN_BYTES / 4;
export const HOT_WORDS = SWARM_HOT_BYTES / 4;
export const COLD_WORDS = SWARM_COLD_BYTES / 4;

export class OpQueue {
  u32 = new Uint32Array(256);
  f32 = new Float32Array(this.u32.buffer);
  u8 = new Uint8Array(this.u32.buffer);
  length = 0;

  reserve(words: number): number {
    const at = this.length;
    const end = at + words;
    if (end > this.u32.length) {
      let size = this.u32.length * 2;
      while (size < end) size *= 2;
      const next = new Uint32Array(size);
      next.set(this.u32.subarray(0, this.length));
      this.u32 = next;
      this.f32 = new Float32Array(next.buffer);
      this.u8 = new Uint8Array(next.buffer);
    }
    this.length = end;
    return at;
  }

  sizeAt(k: number): number {
    switch (this.u32[k]) {
      case OP_SPAWN:
        return 1 + SPAWN_WORDS;
      case OP_KILL_RANGE:
        return 3;
      case OP_KILL_LIST:
        return 2 + this.u32[k + 1];
      case OP_WRITE_HOT:
        return 3 + this.u32[k + 2] * HOT_WORDS;
      case OP_WRITE_COLD:
        return 3 + this.u32[k + 2] * COLD_WORDS;
      case OP_INIT_FREE:
        return 1;
      default:
        return 4; // OP_STEP, OP_SOURCE
    }
  }

  /** Keeps ops in [from, length) except steps, moved to the front. */
  retainFrom(from: number): void {
    let out = 0;
    let k = from;
    const end = this.length;
    while (k < end) {
      const size = this.sizeAt(k);
      if (this.u32[k] !== OP_STEP) {
        if (out !== k) this.u32.copyWithin(out, k, k + size);
        out += size;
      }
      k += size;
    }
    this.length = out;
  }
}

/** Splits a `//@STAGE name` sectioned GLSL string (swarm-internal format). */
export function glslStage(source: string, name: string): string {
  const marker = `//@STAGE ${name}\n`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const from = start + marker.length;
  const end = source.indexOf('//@STAGE ', from);
  return end < 0 ? source.slice(from) : source.slice(from, end);
}
