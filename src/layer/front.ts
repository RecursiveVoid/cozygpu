/**
 * Front half of SpriteLayer (M5, ARCHITECTURE §28.4), chunk `layer`.
 *
 * Per layer and renderer: LAYER_CREATE on first draw, on a capacity,
 * cull or blend change and on a new generation (then every written row is
 * uploaded again); LAYER_SET_FRAMES when the frame table or a source's size
 * changed; LAYER_SET_TEXTURES when a slot's texId changed; LAYER_SET_SOURCE
 * when the external source changed. Committed rows of packed columns are
 * converted into the own stores here, in one tight loop per column; direct
 * columns and own-store dirty ranges become LAYER_UPLOAD_SHARED (zero copy)
 * or inline LAYER_UPLOAD. Every frame: LAYER_CULL (when culling) and
 * LAYER_DRAW, about 100 bytes. Allocation-free in steady state.
 *
 * Loading this chunk registers the core system's loader for the
 * SPRITE_LAYER range (main-thread renderers fetch `layer-core` on the first
 * `frame.isSystemReady`; the worker entry registers its own).
 */
import { BlendModeId } from '../backend/types';
import { CommandFlag, OpcodeRange } from '../commands/opcodes';
import {
  LAYER_CREATE_BYTES,
  LAYER_CULL_BYTES,
  LAYER_DRAW_BYTES,
  LAYER_SET_SOURCE_BYTES,
  LayerDrawFlag,
  LayerFlag,
  LayerOp,
} from '../commands/layerOpcodes';
import {
  loadCoreSystem,
  registerCoreSystemLoader,
} from '../renderer/lazySystems';
import { ensureTextureUploaded } from '../scene/Texture';
import type { TextureHandle } from '../scene/types';
import type { FrontFrame } from '../types/core';
import { SI_PICK_MAX } from '../types/layouts';
import {
  COLOR,
  FRAME_BYTES,
  MAX_TEXTURES,
  POSITION,
  STREAM_BYTES,
  XFORM,
} from './format';
// Types only: a value import of the shell would put a shared chunk on the
// minimal program (see format.ts). Half floats come through `L._half`.
import type { SpriteLayer } from './SpriteLayer';

/** Radians → u16 turns (LX_ROTATION). */
const TURNS = 65536 / (2 * Math.PI);
/** u32 words per row by stream; packed columns (SpriteLayer PACKED). */
const WORDS = [2, 2, 1, 1];
const PACKED_COUNT = 9;

registerCoreSystemLoader(OpcodeRange.SPRITE_LAYER, () =>
  import('./core').then(m => m.createSpriteLayerCoreSystem),
);

/** Backs `GPU.loadSpriteLayer` and `layer.ready`. */
export function preload(): Promise<void> {
  return loadCoreSystem(OpcodeRange.SPRITE_LAYER);
}

const HAS_SAB = typeof SharedArrayBuffer !== 'undefined';
/** Bytes per instance of the widest stream (position, xform). */
const MAX_STREAM_BYTES = 8;

/** FrontFrame with the renderer's event hook (absent on test frames). */
type FrameWithEmit = FrontFrame & {
  _emit?(
    name: 'error',
    payload: { code: 'OUT_OF_CAPACITY'; message: string },
  ): void;
};

/** What one renderer's core holds for a layer. */
class State {
  rid = -1;
  /** Its renderer clears `pending` when destroyed (it has frame hooks). */
  hooked = false;
  gen = -1;
  /** Capacity, LayerFlag and blend id of the last LAYER_CREATE (-1: none). */
  cap = -1;
  flags = -1;
  blend = -1;
  framesVersion = -1;
  sourceVersion = -1;
  /** Capacity refused for the device's buffer limit (reported once). */
  refused = -1;
  /** First frame of each texture source, by slot. */
  slots: TextureHandle[] = [];
  readonly slotSize = new Float64Array(2 * MAX_TEXTURES);
  readonly texIds = new Uint32Array(MAX_TEXTURES);
  /** Registered (Shared)ArrayBuffers: own stores 0–3, direct columns 4–7. */
  readonly shared: (ArrayBufferLike | null)[] = [];
  readonly sharedIds = new Uint32Array(8);

  constructor(readonly id: number) {}
}

/** Core states of destroyed (or moved) layers, freed on their renderer. */
const pending: State[] = [];
const hooked: number[] = [];
/**
 * Per renderer: registered buffer → its users (layer × slot). A caller
 * column may serve several layers; at 0 users it is released.
 */
const users = new Map<number, Map<ArrayBufferLike, number>>();

function usersOf(rid: number): Map<ArrayBufferLike, number> {
  let u = users.get(rid);
  if (!u) users.set(rid, (u = new Map()));
  return u;
}

function unshare(rid: number, buf: ArrayBufferLike, frame: FrontFrame): void {
  const u = usersOf(rid);
  const n = (u.get(buf) ?? 1) - 1;
  if (n > 0) u.set(buf, n);
  else {
    u.delete(buf);
    frame._releaseShared?.(buf as ArrayBuffer);
  }
}

/** `S` gives up every registration (on its renderer, encoding `frame`). */
function unshareAll(S: State, frame: FrontFrame): void {
  for (let c = 0; c < S.shared.length; c++) {
    if (S.shared[c]) unshare(S.rid, S.shared[c]!, frame);
  }
  S.shared.length = 0;
}

/** SHARED_RELEASE and LAYER_DESTROY for layers released from this renderer. */
function flush(frame: FrontFrame): void {
  if (pending.length === 0) return;
  let w = 0;
  for (let i = 0; i < pending.length; i++) {
    const S = pending[i];
    if (S.rid === frame.rendererId) {
      unshareAll(S, frame);
      frame.encoder.begin(LayerOp.LAYER_DESTROY, 4);
      frame.encoder.u32(S.id);
    } else pending[w++] = S;
  }
  pending.length = w;
}

/**
 * Queues `S` to be freed on its renderer, unless that renderer is already
 * destroyed (its core went with it, and no frame would ever flush `S`).
 */
function retire(S: State): void {
  if (S.rid >= 0 && (!S.hooked || hooked.indexOf(S.rid) >= 0)) pending.push(S);
}

/** One hook per renderer: flushes destroys before the scene is packed. */
function hook(frame: FrontFrame): boolean {
  const rid = frame.rendererId;
  if (!frame._addFrameHook) return false;
  if (hooked.indexOf(rid) >= 0) return true;
  hooked.push(rid);
  frame._addFrameHook({
    encodeFrame: flush,
    onRendererDestroyed() {
      hooked.splice(hooked.indexOf(rid), 1);
      users.delete(rid);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].rid === rid) pending.splice(i, 1);
      }
    },
  });
  return true;
}

/** The layer is destroyed: free its GPU side on the next frame. */
export function releaseLayer(layer: SpriteLayer): void {
  const S = layer._state as State | null;
  if (S) retire(S);
  layer._state = null;
}

let warned = false;

/** CustomDrawable body of SpriteLayer (`_emitDraw`). */
export function emitLayer(
  L: SpriteLayer,
  frame: FrontFrame,
  world: Float32Array,
  wo: number,
  alpha: number,
): void {
  flush(frame);
  const caps = frame.caps;
  L._noIndirect = !caps.indirectDraw;
  if (!frame.isSystemReady(OpcodeRange.SPRITE_LAYER)) return;
  if (caps.shaderLanguage === 'wgsl' && !caps.vertexStorage) {
    if (!warned) {
      warned = true;
      console.warn('cozygpu: SpriteLayer needs vertex-stage storage buffers');
    }
    return;
  }
  const enc = frame.encoder;
  const id = L.id;
  let S = L._state as State | null;
  if (!S || (S.rid >= 0 && S.rid !== frame.rendererId)) {
    // Moved to another renderer: the old one frees its state.
    if (S) retire(S);
    L._state = S = new State(id);
  }
  if (S.rid !== frame.rendererId || S.gen !== frame.generation) {
    if (S.rid >= 0) {
      // A new generation (device loss): registrations are made again, and
      // the core dropped every external registration (§28.5).
      unshareAll(S, frame);
      if (L._source) {
        L._source = null;
        L._sourceVersion++;
      }
    }
    S.hooked = hook(frame);
    S.rid = frame.rendererId;
    S.gen = frame.generation;
    S.cap = S.framesVersion = -1;
    S.sourceVersion = L._source ? -1 : L._sourceVersion;
    S.texIds.fill(0);
  }

  // Each stream is one buffer (8 B per instance at most): over the limit the
  // core could not bind it. Report once, draw nothing, keep the rows.
  const limit =
    caps.shaderLanguage === 'wgsl'
      ? caps.maxStorageBufferBindingSize
      : caps.maxBufferSize;
  if (limit > 0 && L._capacity * MAX_STREAM_BYTES > limit) {
    if (S.refused !== L._capacity) {
      S.refused = L._capacity;
      const message = `SpriteLayer: capacity ${L._capacity} is over the device buffer limit (${limit} B per stream); nothing is drawn`;
      console.error(`[cozygpu:OUT_OF_CAPACITY] ${message}`);
      (frame as FrameWithEmit)._emit?.('error', {
        code: 'OUT_OF_CAPACITY',
        message,
      });
    }
    return;
  }
  S.refused = -1;

  const flags =
    L._cull && caps.compute && caps.indirectDraw ? LayerFlag.CULL : 0;
  const blend = BlendModeId[L._blendMode] ?? 0;
  const full = S.cap !== L._capacity;
  if (full || flags !== S.flags || blend !== S.blend) {
    enc.begin(LayerOp.LAYER_CREATE, LAYER_CREATE_BYTES);
    enc.u32(id);
    enc.u32(L._capacity);
    enc.u32(L.streams);
    enc.u32(flags);
    enc.u32(blend);
    S.cap = L._capacity;
    S.flags = flags;
    S.blend = blend;
  }
  emitFrames(L, S, frame);
  emitSource(L, S, frame);
  upload(L, S, frame, full);

  // Draw.
  const source = L._source;
  const count = source ? L._sourceCount : L._count;
  let drawFlags = 0;
  if (source?.indirect && caps.indirectDraw) drawFlags = LayerDrawFlag.INDIRECT;
  if (count === 0) return;
  if (flags && !drawFlags) {
    enc.begin(LayerOp.LAYER_CULL, LAYER_CULL_BYTES, CommandFlag.COMPUTE);
    enc.u32(id);
    enc.u32(count);
    for (let k = 0; k < 6; k++) enc.f32(world[wo + k]);
    enc.f32(L.cullMargin);
    drawFlags = LayerDrawFlag.CULLED;
  }
  enc.begin(LayerOp.LAYER_DRAW, LAYER_DRAW_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  for (let k = 0; k < 6; k++) enc.f32(world[wo + k]);
  enc.f32(alpha);
  enc.u32(count);
  enc.u32(L.pickable && id <= SI_PICK_MAX ? id : 0);
  enc.u32(drawFlags);
}

/** LAYER_SET_FRAMES and LAYER_SET_TEXTURES when they changed. */
function emitFrames(L: SpriteLayer, S: State, frame: FrontFrame): void {
  const frames = L._frames;
  let slots = S.slots;
  let changed = S.framesVersion !== L._framesVersion;
  if (changed) {
    // Rare (frames assigned): one slot per texture source, in order.
    slots = S.slots = [];
    for (let i = 0; i < frames.length; i++) {
      let s = 0;
      while (s < slots.length && slots[s].sourceId !== frames[i].sourceId) s++;
      if (s === slots.length) slots.push(frames[i]);
    }
    S.framesVersion = L._framesVersion;
  }
  // An atlas page that grew moves every uv of its frames.
  const size = S.slotSize;
  for (let s = 0; s < slots.length; s++) {
    if (
      size[2 * s] !== slots[s].sourceWidth ||
      size[2 * s + 1] !== slots[s].sourceHeight
    ) {
      size[2 * s] = slots[s].sourceWidth;
      size[2 * s + 1] = slots[s].sourceHeight;
      changed = true;
    }
  }
  const enc = frame.encoder;
  if (changed) {
    const n = frames.length;
    enc.begin(LayerOp.LAYER_SET_FRAMES, 8 + n * FRAME_BYTES);
    enc.u32(L.id);
    enc.u32(n);
    for (let i = 0; i < n; i++) {
      const t = frames[i];
      const f = t.frame;
      let s = 0;
      while (slots[s].sourceId !== t.sourceId) s++;
      const w = t.sourceWidth;
      const h = t.sourceHeight;
      enc.f32(f.x / w);
      enc.f32(f.y / h);
      enc.f32((f.x + f.width) / w);
      enc.f32((f.y + f.height) / h);
      enc.f32(t.width);
      enc.f32(t.height);
      enc.u32(L._anchor);
      enc.u32(s);
    }
  }
  const ids = S.texIds;
  let texChanged = changed;
  for (let s = 0; s < slots.length; s++) {
    const texId = ensureTextureUploaded(frame, slots[s]);
    if (texId !== ids[s]) {
      ids[s] = texId;
      texChanged = true;
    }
  }
  if (texChanged) {
    enc.begin(LayerOp.LAYER_SET_TEXTURES, 8 + slots.length * 4);
    enc.u32(L.id);
    enc.u32(slots.length);
    for (let s = 0; s < slots.length; s++) enc.u32(ids[s]);
  }
}

function emitSource(L: SpriteLayer, S: State, frame: FrontFrame): void {
  if (S.sourceVersion === L._sourceVersion) return;
  S.sourceVersion = L._sourceVersion;
  const s = L._source;
  const enc = frame.encoder;
  enc.begin(LayerOp.LAYER_SET_SOURCE, LAYER_SET_SOURCE_BYTES);
  enc.u32(L.id);
  enc.u32(s ? s.position.id : 0);
  enc.u32(s?.xform?.id ?? 0);
  enc.u32(s?.color?.id ?? 0);
  enc.u32(s?.user?.id ?? 0);
  enc.u32(frame.caps.indirectDraw ? (s?.indirect?.id ?? 0) : 0);
}

/**
 * Converts the committed rows of packed columns into the own stores and
 * marks them dirty, then uploads: own-store dirty ranges first, committed
 * rows of direct columns last (they win). `full`: the core's streams are
 * new, so every written row goes up again.
 */
function upload(
  L: SpriteLayer,
  S: State,
  frame: FrontFrame,
  full: boolean,
): void {
  const commits = L._commits;
  const cols = L._cols;
  const data = L._data;
  if (commits.count > 0 && cols.length > 0) {
    commits.finalize();
    for (let r = 0; r < commits.count; r++) {
      pack(L, commits.starts[r], commits.ends[r]);
    }
  }
  const cap = L._capacity;
  for (let k = 0; k < 4; k++) {
    if ((L.streams & (1 << k)) === 0) continue;
    const ranges = L._dirty[k];
    const direct = L._direct[k];
    const store =
      k === 0
        ? data.position
        : k === 1
          ? data.xform
          : k === 2
            ? data.color
            : data.user;
    if (full) {
      ranges.clear();
      const rows = L._rows;
      const own = direct ? Math.min(rows, direct.length / WORDS[k]) : 0;
      if (direct) send(frame, S, L.id, k, k + 4, direct, 0, own);
      send(frame, S, L.id, k, k, store, own, rows - own);
      continue;
    }
    ranges.finalize();
    for (let r = 0; r < ranges.count; r++) {
      const first = ranges.starts[r];
      send(
        frame,
        S,
        L.id,
        k,
        k,
        store,
        first,
        Math.min(ranges.ends[r], cap) - first,
      );
    }
    ranges.clear();
    if (direct) {
      for (let r = 0; r < commits.count; r++) {
        const first = commits.starts[r];
        send(
          frame,
          S,
          L.id,
          k,
          k + 4,
          direct,
          first,
          Math.min(commits.ends[r], cap) - first,
        );
      }
    }
  }
  commits.clear();
}

/**
 * Uploads rows [first, first + count) of `view` (row 0 at its start) to
 * stream k; `c` is the registration slot (k: own store, k + 4: column).
 */
function send(
  frame: FrontFrame,
  S: State,
  id: number,
  k: number,
  c: number,
  view: ArrayBufferView,
  first: number,
  count: number,
): void {
  if (count <= 0) return;
  const enc = frame.encoder;
  const buf = view.buffer;
  const bytes = count * STREAM_BYTES[k];
  if (
    frame.sharedMemory &&
    (!frame.useSharedArrayBuffer ||
      (HAS_SAB && buf instanceof SharedArrayBuffer))
  ) {
    // Own stores 0–3, direct columns 4–7: each keeps its registration.
    if (S.shared[c] !== buf) {
      const u = usersOf(S.rid);
      // Count the new user first: a buffer shared by both slots stays.
      u.set(buf, (u.get(buf) ?? 0) + 1);
      if (S.shared[c]) unshare(S.rid, S.shared[c]!, frame);
      S.shared[c] = buf;
      S.sharedIds[c] = frame.registerShared(buf);
    }
    enc.begin(LayerOp.LAYER_UPLOAD_SHARED, 24);
    enc.u32(id);
    enc.u32(k);
    enc.u32(first);
    enc.u32(count);
    enc.u32(S.sharedIds[c]);
    enc.u32(view.byteOffset);
  } else {
    enc.begin(LayerOp.LAYER_UPLOAD, 16 + bytes);
    enc.u32(id);
    enc.u32(k);
    enc.u32(first);
    enc.u32(count);
    enc.bytes(view, first * STREAM_BYTES[k], bytes);
  }
}

/** Packs committed rows [first, end) of the packed columns into the own stores. */
export function pack(L: SpriteLayer, first: number, end: number): void {
  const d = L._data;
  const cols = L._cols;
  const P = d.position;
  const X = d.xform;
  const C = d.color;
  for (let j = 0; j < PACKED_COUNT; j++) {
    const c = cols[j];
    if (!c) continue;
    const a = c.a;
    const s = c.s;
    let i = first;
    let at = c.o + first * s;
    switch (j) {
      case 0: // x
      case 1: // y
        for (let p = 2 * i + j; i < end; i++, at += s, p += 2) P[p] = a[at];
        break;
      case 2: // scale
        for (let p = 4 * i; i < end; i++, at += s, p += 4) {
          X[p] = X[p + 1] = L._half(a[at]);
        }
        break;
      case 3: // scaleX
      case 4: // scaleY
        for (let p = 4 * i + j - 3; i < end; i++, at += s, p += 4) {
          X[p] = L._half(a[at]);
        }
        break;
      case 5: // rotation
        for (let p = 4 * i + 2; i < end; i++, at += s, p += 4) {
          X[p] = Math.round(a[at] * TURNS);
        }
        break;
      case 6: // frame
        for (let p = 4 * i + 3; i < end; i++, at += s, p += 4) X[p] = a[at];
        break;
      case 7: // tint 0xRRGGBB → r | g << 8 | b << 16, alpha kept
        for (; i < end; i++, at += s) {
          const t = a[at];
          C[i] =
            ((C[i] & 0xff000000) |
              ((t >>> 16) & 0xff) |
              (t & 0xff00) |
              ((t & 0xff) << 16)) >>>
            0;
        }
        break;
      default: // alpha 0..1
        for (; i < end; i++, at += s) {
          const v = Math.round(Math.min(1, Math.max(0, a[at])) * 255);
          C[i] = ((C[i] & 0xffffff) | (v << 24)) >>> 0;
        }
    }
    L._dirty[j < 2 ? POSITION : j < 7 ? XFORM : COLOR].addRange(first, end);
  }
}
