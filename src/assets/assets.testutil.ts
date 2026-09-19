/**
 * Test helpers. Node only; never imported by library code.
 * A KTX2 writer (tiny test files), a fake renderer host, fake fetch /
 * ImageBitmap, and a command recorder over the real encoder + decoder.
 */
import type { Capabilities } from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import type { CommandEncoder, PacketObject } from '../commands/types';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import type {
  TextureFrame,
  TextureHandle,
  TextureProvider,
} from '../scene/types';
import type { FrontFrame, FrontFrameHook, RendererHost } from '../types/core';
import { textureFactory } from './gpu';
import { KTX2_IDENTIFIER } from './ktx2';

// ─── KTX2 writer ──────────────────────────────────────────────────────────────

export interface Ktx2WriteOptions {
  vkFormat: number;
  width: number;
  height: number;
  /** Level 0 first. */
  levels: Uint8Array[];
  /** Header levelCount (default levels.length; 0 = "generate mips"). */
  headerLevelCount?: number;
  supercompression?: number;
  premultiplied?: boolean;
  colorModel?: number;
  transfer?: number;
  faces?: number;
}

/** Writes a minimal valid KTX2 file (basic DFD, no KVD, levels smallest-first). */
export function writeKtx2(o: Ktx2WriteOptions): ArrayBuffer {
  const n = o.levels.length;
  const dfdBytes = 44;
  const dfdOffset = 80 + n * 24;
  let cursor = dfdOffset + dfdBytes;
  const offsets: number[] = new Array(n);
  // Smallest level first in the file, padded to 8.
  for (let i = n - 1; i >= 0; i--) {
    cursor = Math.ceil(cursor / 8) * 8;
    offsets[i] = cursor;
    cursor += o.levels[i].byteLength;
  }
  const buffer = new ArrayBuffer(cursor);
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  u8.set(KTX2_IDENTIFIER, 0);
  view.setUint32(12, o.vkFormat, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, o.width, true);
  view.setUint32(24, o.height, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, o.faces ?? 1, true);
  view.setUint32(40, o.headerLevelCount ?? n, true);
  view.setUint32(44, o.supercompression ?? 0, true);
  view.setUint32(48, dfdOffset, true);
  view.setUint32(52, dfdBytes, true);
  for (let i = 0; i < n; i++) {
    const at = 80 + i * 24;
    view.setUint32(at, offsets[i], true);
    view.setUint32(at + 8, o.levels[i].byteLength, true);
    view.setUint32(at + 16, o.levels[i].byteLength, true);
    u8.set(o.levels[i], offsets[i]);
  }
  view.setUint32(dfdOffset, dfdBytes, true);
  view.setUint32(dfdOffset + 4, 0, true); // vendor 0, type 0
  view.setUint16(dfdOffset + 8, 2, true); // version
  view.setUint16(dfdOffset + 10, 40, true); // block size
  view.setUint8(dfdOffset + 12, o.colorModel ?? 1);
  view.setUint8(dfdOffset + 13, 1);
  view.setUint8(dfdOffset + 14, o.transfer ?? 1);
  view.setUint8(dfdOffset + 15, o.premultiplied ? 1 : 0);
  return buffer;
}

export function filled(bytes: number, value: number): Uint8Array {
  return new Uint8Array(bytes).fill(value);
}

// ─── Fake bitmaps, fetch, textures ────────────────────────────────────────────

export class FakeBitmap {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}

/**
 * Installs a `createImageBitmap` that reads "WxH" from a fake image body:
 * bytes 0..7 = PNG magic, then ASCII "W H". Returns an uninstaller.
 */
export function installFakeImageDecoder(): {
  bitmaps: FakeBitmap[];
  restore: () => void;
} {
  const g = globalThis as { createImageBitmap?: unknown };
  const previous = g.createImageBitmap;
  const bitmaps: FakeBitmap[] = [];
  g.createImageBitmap = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(bytes.subarray(8));
    const m = /^(\d+) (\d+)/.exec(text);
    if (!m) throw new Error('not an image');
    const bitmap = new FakeBitmap(Number(m[1]), Number(m[2]));
    bitmaps.push(bitmap);
    return bitmap;
  };
  return {
    bitmaps,
    restore: () => {
      g.createImageBitmap = previous;
    },
  };
}

export function fakePng(width: number, height: number): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const tail = new TextEncoder().encode(`${width} ${height}`);
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

export interface FakeServer {
  files: Map<string, Uint8Array | string>;
  /** URLs requested, in order. */
  requests: string[];
  /** When set, responses wait until `flush()`. */
  hold: boolean;
  flush(): void;
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  aborted: string[];
}

export function createFakeServer(): FakeServer {
  const held: (() => void)[] = [];
  const server: FakeServer = {
    files: new Map(),
    requests: [],
    aborted: [],
    hold: false,
    flush() {
      const all = held.splice(0);
      for (const run of all) run();
    },
    fetch(url, init) {
      server.requests.push(url);
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const respond = (): void => {
          if (signal?.aborted) return;
          const body = server.files.get(url);
          if (body === undefined) {
            resolve(
              new Response('missing', { status: 404, statusText: 'Not Found' }),
            );
          } else {
            resolve(
              new Response(typeof body === 'string' ? body : body.slice()),
            );
          }
        };
        signal?.addEventListener('abort', () => {
          server.aborted.push(url);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        if (server.hold) held.push(respond);
        else queueMicrotask(respond);
      });
    },
  };
  return server;
}

export class FakeTexture implements TextureHandle {
  destroyed = false;
  constructor(
    readonly provider: TextureProvider,
    readonly frame: TextureFrame,
  ) {}
  get sourceId(): number {
    return this.provider.id;
  }
  get sourceWidth(): number {
    return this.provider.width;
  }
  get sourceHeight(): number {
    return this.provider.height;
  }
  get width(): number {
    return this.frame.width;
  }
  get height(): number {
    return this.frame.height;
  }
  sub(x: number, y: number, width: number, height: number): FakeTexture {
    return new FakeTexture(this.provider, {
      x: this.frame.x + x,
      y: this.frame.y + y,
      width,
      height,
    });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.provider.release();
  }
}

/** Replaces Texture.fromProvider with FakeTexture while tests run. */
export function installFakeTextures(): () => void {
  const previous = textureFactory.create;
  textureFactory.create = (provider, frame) =>
    new FakeTexture(
      provider,
      frame ?? { x: 0, y: 0, width: provider.width, height: provider.height },
    );
  return () => {
    textureFactory.create = previous;
  };
}

// ─── Fake renderer host + command recorder ────────────────────────────────────

export interface Cmd {
  op: number;
  u32: number[];
  objects: PacketObject[];
}

export class FakeHost implements RendererHost {
  readonly _rendererId = 7;
  _caps: Capabilities;
  hooks: FrontFrameHook[] = [];
  destroyed = false;
  generation = 0;
  frameId = 0;
  readonly encoder: CommandEncoder = createCommandEncoder(1 << 12);

  constructor(caps: Partial<Capabilities> = {}) {
    this._caps = { ...FAKE_CAPS, ...caps };
  }

  _addFrameHook(hook: FrontFrameHook): () => void {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** M2.5 events recorded as [name, payload] (RendererHost._emit). */
  events: [string, unknown][] = [];
  _emit(name: string, payload: unknown): void {
    this.events.push([name, payload]);
  }

  /** A FrontFrame over a fresh packet; `draw` providers are uploaded like the packer would. */
  frame(): FrontFrame {
    const self = this;
    return {
      rendererId: this._rendererId,
      caps: this._caps,
      encoder: this.encoder,
      frameId: this.frameId,
      time: 0,
      dt: 1 / 60,
      cssWidth: 100,
      cssHeight: 100,
      resolution: 1,
      sharedMemory: true,
      useSharedArrayBuffer: false,
      get generation() {
        return self.generation;
      },
      registerShared: () => 0,
      readback: () => Promise.reject(new Error('unused')),
      isSystemReady: () => true,
    };
  }

  /** Runs every hook for one frame, then "draws" `providers`; returns the commands. */
  render(...providers: TextureProvider[]): { cmds: Cmd[]; ready: boolean[] } {
    this.frameId++;
    this.encoder.reset();
    const frame = this.frame();
    const hooks = this.hooks.slice();
    for (const hook of hooks) hook.encodeFrame(frame);
    const ready = providers.map(p => p.upload(frame));
    return { cmds: decode(this.encoder), ready };
  }

  restoreDevice(): void {
    this.generation++;
    for (const hook of this.hooks.slice()) hook.onDeviceRestored?.();
  }

  destroyRenderer(): void {
    this.destroyed = true;
    for (const hook of this.hooks.slice()) hook.onRendererDestroyed?.();
  }
}

export function decode(encoder: CommandEncoder): Cmd[] {
  const packet = encoder.finish(1);
  const decoder = createCommandDecoder();
  decoder.reset(packet);
  const out: Cmd[] = [];
  const r = decoder.reader;
  while (decoder.next()) {
    const words: number[] = [];
    for (let i = 0; i < r.payloadBytes / 4 && i < 16; i++) words.push(r.u32());
    out.push({ op: r.opcode, u32: words, objects: packet.objects });
  }
  return out;
}

/** Fake Renderer object accepted by `new Assets(renderer)`. */
export function fakeRenderer(
  host: FakeHost,
): import('../types/renderer').Renderer {
  return host as unknown as import('../types/renderer').Renderer;
}

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}
