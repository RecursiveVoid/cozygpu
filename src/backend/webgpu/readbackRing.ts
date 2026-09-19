/**
 * Owner: "renderer-hooks". M2.5 readback ring on WebGPU (ARCHITECTURE §19.6).
 *
 * One MAP_READ | COPY_DST buffer per slot, created once. `copyTexture`
 * records copyTextureToBuffer on the frame's encoder; the backend's
 * afterSubmit() calls `submitted()`, which starts mapAsync for the slots
 * copied in that submit. `poll` never awaits: it checks `mapState`, copies
 * the mapped bytes into the slot's persistent view (tight rows) and unmaps.
 * No staging buffer, promise chain or ArrayBuffer is created by this code
 * per read; the only per-read objects are mapAsync's own promise (handled
 * by per-slot callbacks made once) and the mapped range. A callback that
 * runs while its slot's newer map is still pending belongs to an aborted
 * map and is ignored.
 *
 * Pacing: a slot counts in `host.reads` from its submit until its map lands;
 * then `host.landed()` lets a held frame go, so the next render() polls it
 * instead of waiting for a later frame's fence.
 */
import { CozyGPUError } from '../../types/errors';
import type { CommandList, RhiReadbackRing, RhiTexture } from '../types';
import { ReadbackState } from '../types';
// From ../utils, not ./convert: importing convert here would split it into a
// chunk of its own on the minimal program (convert stays in the backend chunk).
import { checkReadRect } from '../readRect';
import { align4, bytesPerTexel } from '../utils';
import type { WebGPUCommandList } from './commands';
import type { WebGPUTexture } from './resources';

/** GPUBufferUsage.MAP_READ | COPY_DST (spec values). */
const STAGING_USAGE = 0x0001 | 0x0008;

/** What the ring needs from the backend. */
export interface RingHost {
  readonly device: GPUDevice;
  readonly lost: boolean;
  /** Reads in flight (pacing); the ring counts its mapping slots here. */
  reads: number;
  readonly rings: WebGPUReadbackRing[];
  /** A slot's map starts (counts in `reads`). */
  readStarted(): void;
  /** A slot's map landed or failed (no longer in `reads`). */
  landed(): void;
}

/** What `readTexture` needs from the backend. */
export interface ReadTextureHost {
  readStaging(
    what: string,
    size: number,
    record: (enc: GPUCommandEncoder, staging: GPUBuffer) => void,
    extract: (mapped: ArrayBuffer) => ArrayBuffer,
  ): Promise<ArrayBuffer>;
}

/**
 * RHI `readTexture` (M2 parity; rare, so it lives in this lazy chunk):
 * copyTextureToBuffer into a one-shot MAP_READ staging buffer, then strip
 * WebGPU's 256-byte row alignment so rows come back tight, top row first.
 */
export function readTexture(
  host: ReadTextureHost,
  texture: RhiTexture,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const tex = texture as WebGPUTexture;
  checkReadRect(tex, x, y, width, height);
  if (width === 0 || height === 0) return Promise.resolve(new ArrayBuffer(0));
  const rowBytes = width * bytesPerTexel(tex.format);
  const paddedRow = Math.ceil(rowBytes / 256) * 256;
  return host.readStaging(
    'readTexture',
    paddedRow * (height - 1) + rowBytes,
    (enc, staging) =>
      enc.copyTextureToBuffer(
        { texture: tex.raw, origin: { x, y } },
        { buffer: staging, bytesPerRow: paddedRow },
        { width, height },
      ),
    data => {
      const mapped = new Uint8Array(data);
      const out = new Uint8Array(rowBytes * height);
      for (let row = 0; row < height; row++) {
        const from = row * paddedRow;
        out.set(mapped.subarray(from, from + rowBytes), row * rowBytes);
      }
      return out.buffer;
    },
  );
}

/** Slot states beyond ReadbackState: copy recorded, mapAsync started. */
const RECORDED = 4;
const MAPPING = 5;

export class WebGPUReadbackRing implements RhiReadbackRing {
  private readonly device: GPUDevice;
  private readonly buffers: GPUBuffer[] = [];
  private readonly state: Uint8Array;
  private readonly bytes: Uint8Array[] = [];
  private readonly views: Uint32Array[] = [];
  /** Per slot: tight row bytes, padded row bytes, rows of the last copy. */
  private readonly rows: Uint32Array;
  /** 1 while a slot counts in `host.reads`. */
  private readonly counted: Uint8Array;
  /** Per-slot mapAsync handlers, made once. */
  private readonly onMapped: (() => void)[] = [];
  private recorded = 0;

  // Reused copy descriptors.
  private readonly origin = { x: 0, y: 0, z: 0 };
  private readonly src = {
    texture: null as unknown as GPUTexture,
    origin: this.origin,
  };
  private readonly dst: GPUTexelCopyBufferInfo = {
    buffer: null as unknown as GPUBuffer,
    bytesPerRow: undefined,
  };
  private readonly extent: GPUExtent3DDict = { width: 0, height: 0 };

  constructor(
    private readonly host: RingHost,
    readonly slots: number,
    readonly slotBytes: number,
    readonly label: string | undefined,
  ) {
    this.device = host.device;
    this.state = new Uint8Array(slots);
    this.rows = new Uint32Array(slots * 3);
    this.counted = new Uint8Array(slots);
    const bytes = align4(Math.max(4, slotBytes));
    for (let i = 0; i < slots; i++) {
      this.onMapped.push(() => {
        // The late rejection of a map aborted by release() can run after the
        // slot was acquired, copied and submitted again: while that newer
        // map is still pending the callback is not its own, so it must not
        // uncount it or report it landed.
        if (
          this.state[i] === MAPPING &&
          this.buffers[i].mapState === 'pending'
        ) {
          return;
        }
        this.uncount(i);
        host.landed();
      });
      this.buffers.push(this.staging(bytes));
      const view = new Uint32Array(bytes >> 2);
      this.views.push(view);
      this.bytes.push(new Uint8Array(view.buffer));
    }
    host.rings.push(this);
  }

  acquire(): number {
    const state = this.state;
    for (let i = 0; i < state.length; i++) {
      if (state[i] === ReadbackState.FREE) {
        state[i] = ReadbackState.PENDING;
        return i;
      }
    }
    return -1;
  }

  copyTexture(
    list: CommandList,
    slot: number,
    texture: RhiTexture,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const tex = texture as WebGPUTexture;
    checkReadRect(tex, x, y, width, height);
    const rowBytes = width * bytesPerTexel(tex.format);
    if (
      this.state[slot] !== ReadbackState.PENDING ||
      rowBytes * height > this.slotBytes
    ) {
      throw new CozyGPUError('INVALID_ARGUMENT', 'readback slot');
    }
    // Rows of a multi-row copy are 256-byte aligned in the staging buffer.
    const padded = height > 1 ? Math.ceil(rowBytes / 256) * 256 : rowBytes;
    const need = align4(padded * (height - 1) + rowBytes);
    let buffer = this.buffers[slot];
    if (need > buffer.size) {
      buffer.destroy();
      buffer = this.buffers[slot] = this.staging(need);
    }
    const r = slot * 3;
    this.rows[r] = rowBytes;
    this.rows[r + 1] = padded;
    this.rows[r + 2] = height;
    this.src.texture = tex.raw;
    this.origin.x = x;
    this.origin.y = y;
    this.dst.buffer = buffer;
    this.dst.bytesPerRow = height > 1 ? padded : undefined;
    this.extent.width = width;
    this.extent.height = height;
    (list as WebGPUCommandList).copyTextureToBuffer(
      this.src,
      this.dst,
      this.extent,
    );
    this.src.texture = null as unknown as GPUTexture;
    this.state[slot] = RECORDED;
    this.recorded++;
  }

  /** @internal Backend afterSubmit(): maps the slots copied in that submit. */
  submitted(): void {
    if (this.recorded === 0) return;
    this.recorded = 0;
    const state = this.state;
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== RECORDED) continue;
      state[i] = MAPPING;
      this.counted[i] = 1;
      this.host.readStarted();
      // Landed or failed: either way it stops counting for pacing.
      this.buffers[i]
        .mapAsync(1 /* GPUMapMode.READ */)
        .then(this.onMapped[i], this.onMapped[i]);
    }
  }

  poll(slot: number): number {
    const s = this.state[slot];
    if (s < RECORDED && s !== ReadbackState.PENDING) return s;
    if (this.host.lost || this.host.device !== this.device) {
      return this.fail(slot);
    }
    if (s !== MAPPING) return ReadbackState.PENDING;
    const buffer = this.buffers[slot];
    const mapState = buffer.mapState;
    if (mapState === 'pending') return ReadbackState.PENDING;
    if (mapState !== 'mapped') return this.fail(slot);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const out = this.bytes[slot];
    const r = slot * 3;
    const rowBytes = this.rows[r];
    const padded = this.rows[r + 1];
    const rows = this.rows[r + 2];
    for (let row = 0; row < rows; row++) {
      const from = row * padded;
      const to = row * rowBytes;
      for (let b = 0; b < rowBytes; b++) out[to + b] = mapped[from + b];
    }
    buffer.unmap();
    this.uncount(slot);
    this.state[slot] = ReadbackState.READY;
    return ReadbackState.READY;
  }

  data(slot: number): Uint32Array {
    return this.views[slot];
  }

  release(slot: number): void {
    const s = this.state[slot];
    if (s === RECORDED) this.recorded--;
    if (s === MAPPING) this.settle(slot);
    this.state[slot] = ReadbackState.FREE;
  }

  destroy(): void {
    for (let i = 0; i < this.slots; i++) {
      this.release(i);
      this.buffers[i].destroy();
    }
    const rings = this.host.rings;
    const at = rings.indexOf(this);
    if (at >= 0) rings.splice(at, 1);
  }

  private staging(size: number): GPUBuffer {
    return this.device.createBuffer({
      label: this.label,
      size,
      usage: STAGING_USAGE,
    });
  }

  private uncount(slot: number): void {
    if (this.counted[slot] === 0) return;
    this.counted[slot] = 0;
    if (this.host.device === this.device) this.host.reads--;
  }

  /** Leaves MAPPING (a pending map is aborted by unmap). */
  private settle(slot: number): void {
    this.uncount(slot);
    if (this.host.device === this.device) this.buffers[slot].unmap();
  }

  private fail(slot: number): number {
    if (this.state[slot] === MAPPING) this.settle(slot);
    this.state[slot] = ReadbackState.FAILED;
    return ReadbackState.FAILED;
  }
}
