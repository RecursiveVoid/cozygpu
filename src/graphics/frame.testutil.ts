/**
 * Test helpers for the Graphics front: a FrontFrame over the real command
 * encoder that runs its frame hooks like the Renderer does, and decodes the
 * finished packet back into commands.
 */
import { createCommandDecoder, createCommandEncoder } from '../commands';
import type { CommandEncoder } from '../commands/types';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import type { FrontFrame, FrontFrameHook } from '../types/core';
import { triangulate } from './earcut';

export interface Recorded {
  opcode: number;
  flags: number;
  /** Payload as u32 words. */
  words: number[];
  /** Payload as f32 values. */
  floats: number[];
  bytes: Uint8Array;
}

export class TestFrame implements FrontFrame {
  rendererId = 1;
  encoder: CommandEncoder = createCommandEncoder();
  frameId = 0;
  time = 0;
  dt = 1 / 60;
  cssWidth = 800;
  cssHeight = 600;
  resolution = 1;
  sharedMemory = false;
  useSharedArrayBuffer = false;
  generation = 0;
  caps = FAKE_CAPS;
  retainSegment = 0;
  ready = true;
  hooks: FrontFrameHook[] = [];
  shared: (ArrayBuffer | SharedArrayBuffer)[] = [];

  isSystemReady(): boolean {
    return this.ready;
  }

  registerShared(buffer: ArrayBuffer | SharedArrayBuffer): number {
    this.shared.push(buffer);
    return this.shared.length;
  }

  readback(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('unused'));
  }

  _addFrameHook(hook: FrontFrameHook): () => void {
    this.hooks.push(hook);
    return () => {
      this.hooks.splice(this.hooks.indexOf(hook), 1);
    };
  }

  /** Runs encodeFrameEnd hooks, finishes and decodes the packet, starts the next frame. */
  end(): Recorded[] {
    for (const h of this.hooks) h.encodeFrameEnd?.(this);
    const packet = this.encoder.finish(this.frameId++);
    const decoder = createCommandDecoder();
    decoder.reset(packet);
    const out: Recorded[] = [];
    while (decoder.next()) {
      const r = decoder.reader;
      const words: number[] = [];
      const floats: number[] = [];
      const base = r.payloadOffset >> 2;
      for (let i = 0; i < r.payloadBytes >> 2; i++) {
        words.push(r.u32View[base + i]);
        floats.push(r.f32View[base + i]);
      }
      out.push({
        opcode: r.opcode,
        flags: r.flags,
        words,
        floats,
        bytes: r.u8.slice(r.payloadOffset, r.payloadOffset + r.payloadBytes),
      });
    }
    this.encoder.reset();
    return out;
  }
}

/** Twice the signed area of triangle (a, b, c) of a flat point list. */
export function triArea2(
  p: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): number {
  return (
    (p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) -
    (p[2 * c] - p[2 * a]) * (p[2 * b + 1] - p[2 * a + 1])
  );
}

/** Area of a simple polygon given as flat points [from, to) (vertex indices). */
export function ringArea(
  p: ArrayLike<number>,
  from: number,
  to: number,
): number {
  let s = 0;
  for (let i = from, j = to - 1; i < to; j = i++) {
    s += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1];
  }
  return Math.abs(s) / 2;
}

/** Sum of |area| of the triangles in `idx[0 .. n)` over flat points `p`. */
export function trianglesArea(
  p: ArrayLike<number>,
  idx: ArrayLike<number>,
  n: number,
): number {
  let s = 0;
  for (let i = 0; i < n; i += 3)
    s += Math.abs(triArea2(p, idx[i], idx[i + 1], idx[i + 2])) / 2;
  return s;
}

/** Triangulates flat points with holes (vertex starts); returns the index list. */
export function tri(points: number[], holes: number[] = []): number[] {
  const coords = new Float64Array(points);
  const out = new Uint32Array(3 * (points.length / 2 + 2 * holes.length) + 3);
  const n = triangulate(
    coords,
    coords.length,
    holes.length ? new Uint32Array(holes) : null,
    holes.length,
    out,
    0,
    0,
  );
  return Array.from(out.subarray(0, n));
}

/** Even-odd point-in-polygon over flat points [from, to). */
export function insideRing(
  p: ArrayLike<number>,
  from: number,
  to: number,
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = from, j = to - 1; i < to; j = i++) {
    const xi = p[2 * i];
    const yi = p[2 * i + 1];
    const xj = p[2 * j];
    const yj = p[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
