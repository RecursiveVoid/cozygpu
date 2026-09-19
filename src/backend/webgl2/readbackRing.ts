/**
 * Owner: "renderer-hooks". M2.5 readback ring on WebGL2 (ARCHITECTURE §19.6).
 *
 * One PIXEL_PACK buffer per slot, created once. `copyTexture` runs
 * readPixels into the slot's buffer (WebGL executes immediately) and inserts
 * a fence; `poll` checks the fence without blocking and, once it signalled,
 * copies the bytes with getBufferSubData into the slot's persistent view
 * (tight rows, top row first). The only per-read object is the native sync.
 * `readTexture` is a one-slot ring polled on a timer.
 */
import { CozyGPUError } from '../../types/errors';
import type {
  CommandList,
  RhiBuffer,
  ReadbackRingDesc,
  RhiReadbackRing,
  RhiTexture,
} from '../types';
import { ReadbackState } from '../types';
import { checkReadRect } from '../readRect';
import { align4, bytesPerTexel } from '../utils';
import * as G from './glconst';
import type { GLBuffer, GLTexture } from './resources';
import type { GLState } from './state';

/** What the ring needs from the backend. */
export interface GLRingHost {
  readonly gl: WebGL2RenderingContext;
  readonly lost: boolean;
  /** Bumped per context loss. */
  readonly epoch: number;
  /** beginCommands() count (pacing). */
  readonly frameSerial: number;
  readonly rings: GLReadbackRing[];
  /** Called once a watched fence signalled (RenderCore polls picking). */
  readonly onReadbackLanded: (() => void) | null;
  bindTargetFramebuffer(texture: GLTexture, depth: GLTexture | null): void;
}

/** What `readBuffer` needs from the backend. */
export interface ReadBufferHost {
  readonly gl: WebGL2RenderingContext;
  readonly lost: boolean;
  readonly epoch: number;
  readonly state: GLState;
  noticeLoss(): void;
}

function lostError(what: string): CozyGPUError {
  return new CozyGPUError('DEVICE_LOST', `${what}: WebGL context lost`);
}

/**
 * RHI `readBuffer` on WebGL2 (rare, so it lives in this lazy chunk): waits
 * for a fence on a 1 ms timer, then getBufferSubData. `epoch` is the
 * backend's loss count when the read was requested. Allocates per call.
 */
export async function readBuffer(
  host: ReadBufferHost,
  buffer: RhiBuffer,
  offset: number,
  byteLength: number,
  epoch: number,
): Promise<ArrayBuffer> {
  const src = buffer as GLBuffer;
  if (offset < 0 || byteLength < 0 || offset + byteLength > src.size) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `readBuffer range [${offset}, ${offset + byteLength}) is outside buffer "${src.label ?? ''}" (${src.size} B)`,
    );
  }
  if (byteLength === 0) return new ArrayBuffer(0);
  const gl = host.gl;
  const sync = gl.fenceSync(G.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) {
    if (host.lost) throw lostError('readBuffer');
    await new Promise(resolve => setTimeout(resolve, 0));
  } else {
    gl.flush();
    await new Promise<void>((resolve, reject) => {
      const poll = (): void => {
        if (gl.isContextLost()) {
          host.noticeLoss();
          reject(lostError('readBuffer'));
          return;
        }
        const status = gl.clientWaitSync(sync, 0, 0);
        if (done(status)) {
          gl.deleteSync(sync);
          resolve();
        } else if (status === G.WAIT_FAILED) {
          gl.deleteSync(sync);
          reject(
            new CozyGPUError('INTERNAL', 'readBuffer: clientWaitSync failed'),
          );
        } else {
          setTimeout(poll, 1);
        }
      };
      setTimeout(poll, 0);
    });
  }
  if (epoch !== host.epoch || host.lost) throw lostError('readBuffer');
  if (src.destroyed) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `readBuffer: buffer "${src.label ?? ''}" was destroyed`,
    );
  }
  const out = new Uint8Array(byteLength);
  const target =
    src.target === G.ELEMENT_ARRAY_BUFFER
      ? G.ELEMENT_ARRAY_BUFFER
      : G.COPY_READ_BUFFER;
  if (target === G.ELEMENT_ARRAY_BUFFER) host.state.bindVertexArray(null);
  gl.bindBuffer(target, src.raw);
  gl.getBufferSubData(target, offset, out);
  gl.bindBuffer(target, null);
  return out.buffer;
}

/** What `readTexture` needs from the backend. */
export interface ReadTextureHost {
  readonly lost: boolean;
  readonly epoch: number;
  readonly list: CommandList;
  createReadbackRing(desc: ReadbackRingDesc): RhiReadbackRing;
  startRead(): void;
  endRead(): void;
  noticeLoss(): void;
}

/**
 * RHI `readTexture` on WebGL2 (rare, so it lives in this lazy chunk): a
 * one-slot ring polled on a 1 ms timer. Allocates per call.
 */
export async function readTexture(
  host: ReadTextureHost,
  texture: RhiTexture,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  if (width === 0 || height === 0) {
    checkReadRect(texture, x, y, width, height, 'rgba16float');
    return new ArrayBuffer(0);
  }
  const bytes = width * height * bytesPerTexel(texture.format);
  const epoch = host.epoch;
  const ring = host.createReadbackRing({ slots: 1, slotBytes: bytes });
  try {
    ring.acquire();
    ring.copyTexture(host.list, 0, texture, x, y, width, height);
    host.startRead();
    try {
      let state: number;
      while ((state = ring.poll(0)) === ReadbackState.PENDING) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      if (state !== ReadbackState.READY) {
        host.noticeLoss();
        throw host.lost || epoch !== host.epoch
          ? lostError('readTexture')
          : new CozyGPUError('INTERNAL', 'readTexture: clientWaitSync failed');
      }
      return (ring.data(0).buffer as ArrayBuffer).slice(0, bytes);
    } finally {
      host.endRead();
    }
  } finally {
    ring.destroy();
  }
}

/**
 * FormatKind.UINT / FLOAT (./formats). Not imported: that would split
 * formats.ts into a chunk of its own on the minimal program.
 */
const KIND_UINT = 1;
const KIND_FLOAT = 2;

/** Slot state beyond ReadbackState: readPixels issued, fence pending. */
const MAPPING = 4;

/** Per-slot metadata of the last copy (u32 each). */
const M_WIDTH = 0;
const M_HEIGHT = 1;
const M_IN = 2; // bytes per texel as read (RGBA)
const M_OUT = 3; // bytes per texel kept (tight)
const M_FLIP = 4; // render target: rows stored bottom-up
const M_STRIDE = 5;

function done(status: number): boolean {
  return status === G.ALREADY_SIGNALED || status === G.CONDITION_SATISFIED;
}

export class GLReadbackRing implements RhiReadbackRing {
  private readonly epoch: number;
  private readonly pbos: (WebGLBuffer | null)[] = [];
  private readonly syncs: (WebGLSync | null)[] = [];
  private readonly state: Uint8Array;
  /** frameSerial of each slot's copy. */
  private readonly frames: Uint32Array;
  private readonly meta: Uint32Array;
  private readonly bytes: Uint8Array[] = [];
  /** Pending fence-watch timer (0 = none). */
  private timer = 0;
  private readonly views: Uint32Array[] = [];
  /** getBufferSubData scratch: RGBA reads are up to 4× the tight bytes. */
  private readonly raw: Uint8Array;

  constructor(
    private readonly host: GLRingHost,
    readonly slots: number,
    readonly slotBytes: number,
    readonly label: string | undefined,
  ) {
    const gl = host.gl;
    this.epoch = host.epoch;
    this.state = new Uint8Array(slots);
    this.frames = new Uint32Array(slots);
    this.meta = new Uint32Array(slots * M_STRIDE);
    const size = align4(Math.max(4, slotBytes));
    this.raw = new Uint8Array(size * 4);
    for (let i = 0; i < slots; i++) {
      const pbo = gl.createBuffer();
      gl.bindBuffer(G.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(G.PIXEL_PACK_BUFFER, size * 4, G.STREAM_READ);
      this.pbos.push(pbo);
      this.syncs.push(null);
      const view = new Uint32Array(size >> 2);
      this.views.push(view);
      this.bytes.push(new Uint8Array(view.buffer));
    }
    gl.bindBuffer(G.PIXEL_PACK_BUFFER, null);
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
    _list: CommandList,
    slot: number,
    texture: RhiTexture,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const tex = texture as GLTexture;
    checkReadRect(tex, x, y, width, height, 'rgba16float');
    const format = tex.gl;
    const uint = format.kind === KIND_UINT;
    const float = format.kind === KIND_FLOAT;
    const componentBytes = uint || float ? 4 : 1;
    const components =
      format.format === G.RED || format.format === G.RED_INTEGER
        ? 1
        : format.format === G.RG_INTEGER
          ? 2
          : 4;
    if (
      this.state[slot] !== ReadbackState.PENDING ||
      !tex.raw ||
      format.format === 0 ||
      width * height * components * componentBytes > this.slotBytes
    ) {
      throw new CozyGPUError('INVALID_ARGUMENT', 'readback slot');
    }
    const host = this.host;
    const gl = host.gl;
    host.bindTargetFramebuffer(tex, tex.fboDepth);
    gl.bindBuffer(G.PIXEL_PACK_BUFFER, this.pbos[slot]);
    // Always-supported read pairs: 4 components per texel.
    gl.readPixels(
      x,
      tex.renderTarget ? tex.height - y - height : y,
      width,
      height,
      uint ? G.RGBA_INTEGER : G.RGBA,
      uint ? G.UNSIGNED_INT : float ? G.FLOAT : G.UNSIGNED_BYTE,
      0,
    );
    gl.bindBuffer(G.PIXEL_PACK_BUFFER, null);
    this.syncs[slot] = gl.fenceSync(G.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const m = slot * M_STRIDE;
    const meta = this.meta;
    meta[m + M_WIDTH] = width;
    meta[m + M_HEIGHT] = height;
    meta[m + M_IN] = 4 * componentBytes;
    meta[m + M_OUT] = components * componentBytes;
    meta[m + M_FLIP] = tex.renderTarget ? 1 : 0;
    this.frames[slot] = host.frameSerial;
    this.state[slot] = MAPPING;
    if (host.onReadbackLanded && this.timer === 0) {
      this.timer = setTimeout(this.watch, 1) as unknown as number;
    }
  }

  /**
   * 1 ms fence watch while a slot is in flight: once a fence signalled (or
   * failed), the host's onReadbackLanded answers it without waiting for the
   * next render(). One pre-bound callback; nothing allocated per tick.
   */
  private readonly watch = (): void => {
    this.timer = 0;
    const host = this.host;
    if (host.lost || host.epoch !== this.epoch) return;
    const state = this.state;
    let landed = false;
    let waiting = false;
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== MAPPING) continue;
      if (host.gl.clientWaitSync(this.syncs[i]!, 0, 0) === G.TIMEOUT_EXPIRED) {
        waiting = true;
      } else {
        landed = true;
      }
    }
    if (landed) host.onReadbackLanded?.();
    if (waiting && this.timer === 0) {
      this.timer = setTimeout(this.watch, 1) as unknown as number;
    }
  };

  poll(slot: number): number {
    const s = this.state[slot];
    if (s !== MAPPING) return s;
    const host = this.host;
    if (host.lost || host.epoch !== this.epoch) return this.fail(slot);
    const gl = host.gl;
    const status = gl.clientWaitSync(this.syncs[slot]!, 0, 0);
    if (status === G.WAIT_FAILED) return this.fail(slot);
    if (!done(status)) return ReadbackState.PENDING;
    this.dropSync(slot);
    const m = slot * M_STRIDE;
    const meta = this.meta;
    const width = meta[m + M_WIDTH];
    const height = meta[m + M_HEIGHT];
    const texelIn = meta[m + M_IN];
    const texelOut = meta[m + M_OUT];
    const flip = meta[m + M_FLIP] === 1;
    const raw = this.raw;
    gl.bindBuffer(G.COPY_READ_BUFFER, this.pbos[slot]);
    gl.getBufferSubData(
      G.COPY_READ_BUFFER,
      0,
      raw,
      0,
      width * height * texelIn,
    );
    gl.bindBuffer(G.COPY_READ_BUFFER, null);
    // Tight rows, top row first (GL render targets are stored bottom-up).
    const out = this.bytes[slot];
    for (let row = 0; row < height; row++) {
      const srcRow = flip ? height - 1 - row : row;
      for (let col = 0; col < width; col++) {
        const from = (srcRow * width + col) * texelIn;
        const to = (row * width + col) * texelOut;
        for (let b = 0; b < texelOut; b++) out[to + b] = raw[from + b];
      }
    }
    this.state[slot] = ReadbackState.READY;
    return ReadbackState.READY;
  }

  data(slot: number): Uint32Array {
    return this.views[slot];
  }

  release(slot: number): void {
    this.dropSync(slot);
    this.state[slot] = ReadbackState.FREE;
  }

  /**
   * @internal Pacing: true when a copy made at frameSerial ≤ `serial` still
   * waits for its fence (the GPU is that many frames behind).
   */
  lagging(serial: number): boolean {
    const state = this.state;
    for (let i = 0; i < state.length; i++) {
      if (
        state[i] === MAPPING &&
        this.frames[i] <= serial &&
        this.host.epoch === this.epoch &&
        this.host.gl.clientWaitSync(this.syncs[i]!, 0, 0) === G.TIMEOUT_EXPIRED
      ) {
        return true;
      }
    }
    return false;
  }

  destroy(): void {
    if (this.timer !== 0) clearTimeout(this.timer);
    this.timer = 0;
    const live = this.host.epoch === this.epoch;
    for (let i = 0; i < this.slots; i++) {
      this.release(i);
      if (live) this.host.gl.deleteBuffer(this.pbos[i]);
    }
    const rings = this.host.rings;
    const at = rings.indexOf(this);
    if (at >= 0) rings.splice(at, 1);
  }

  private dropSync(slot: number): void {
    const sync = this.syncs[slot];
    if (sync === null) return;
    this.syncs[slot] = null;
    if (this.host.epoch === this.epoch) this.host.gl.deleteSync(sync);
  }

  private fail(slot: number): number {
    this.dropSync(slot);
    this.state[slot] = ReadbackState.FAILED;
    return ReadbackState.FAILED;
  }
}
