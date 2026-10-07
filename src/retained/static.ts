/**
 * Static container bake (M5, ARCHITECTURE §27.5), chunk `static`, loaded by
 * the `Container.static` setter.
 *
 * A static container is a leaf for the scene packer (`_sbLeaf`, set once
 * the graphics chunk and core are ready): its subtree is not walked per
 * frame. The bake walks it once, with transforms relative to the container,
 * and writes persistent records: sprites become baked sprite records (the
 * Graphics SPRITES pool, texture slots in SI_FLAGS bits 3–5), Graphics write
 * theirs through their binding's bake path; the items go in tree order into
 * the bake's own item region and draw as GFX_DRAW_UNIFIED through the
 * container's transform slot. Per frame the bake costs one counter compare
 * (`nodeStore.scopeTouch[scope]`), a 32-byte GFX_SET_TRANSFORM when the
 * container moved or faded, and one RETAIN_DRAW per run of baked draws (or
 * the draws themselves, a handful, while the retain core is not loaded).
 *
 * Nodes that cannot be baked (Swarm, Particles, SpriteLayer, a Graphics with
 * a texture fill) are holes: drawn live in their place with their world
 * (container world × relative), the baked draws split around them. A Group
 * anywhere, or a node that does not extend NodeBase, makes the container
 * draw unbaked (one warning) until it is removed. A change anywhere inside
 * re-bakes the whole container on the next frame, and so does zooming it
 * past the scale its curved Graphics were tessellated for. Zero allocations
 * per frame while idle.
 */
import { CommandFlag, OpcodeRange } from '../commands/opcodes';
import { GfxOp } from '../commands/gfxOpcodes';
import {
  RETAIN_BEGIN_BYTES,
  RETAIN_DESTROY_BYTES,
  RETAIN_DRAW_BYTES,
  RETAIN_END_BYTES,
  RetainOp,
} from '../commands/retainOpcodes';
import { affineFromTRS, affineMultiply } from '../math/affine';
import { registerCoreSystemLoader } from '../renderer/lazySystems';
import type { Container } from '../scene/Container';
import { NodeBase } from '../scene/Node';
import { Sprite } from '../scene/Sprite';
import {
  L_ALPHA,
  L_ANCHOR_X,
  L_ANCHOR_Y,
  L_FRAME_H,
  L_FRAME_W,
  L_PIVOT_X,
  L_PIVOT_Y,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  L_SKEW_X,
  L_SKEW_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  UV_STRIDE,
  bumpNode,
  nodeStore,
} from '../scene/store';
import { ensureTextureUploaded, textureDestroyCount } from '../scene/Texture';
import type { ContainerNode, SceneNode, TextureHandle } from '../scene/types';
import type {
  CustomDrawable,
  FrontFrame,
  FrontFrameHook,
  RetainableDrawable,
} from '../types/core';
import { NO_ID } from '../types/ids';
import {
  GFX_ITEM_CORNER_BITS,
  GFX_ITEM_KIND_SHIFT,
  GFX_MAX_TEXTURE_SLOTS,
  GFX_MAX_TRANSFORMS,
  GFX_SPRITE_SLOT_SHIFT,
  GfxItemKind,
} from '../types/gfxLayouts';
import { SPRITE_INSTANCE_F32_PER } from '../types/layouts';
import { allocSegmentId, freeSegmentId } from './ids';

type Gfx = typeof import('../graphics/emit');
type GfxRenderer = InstanceType<Gfx['RendererState']>;

registerCoreSystemLoader(OpcodeRange.RETAIN, () =>
  import('./core').then(m => m.createRetainCoreSystem),
);

/** Per static container; created when `static` turns true. */
export interface StaticBinding {
  /**
   * Called by the scene packer in draw order instead of walking the subtree:
   * re-bakes when the subtree changed, writes the transform slot when the
   * container moved or faded, and emits the bake's draws (or RETAIN_DRAW).
   * Returns false when the bake gives up (chunks loading, a Group inside):
   * the container is no longer a leaf and the packer walks its subtree from
   * the next frame on (this frame draws the last bake, if any).
   */
  emit(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
  ): boolean;
  /** `static` turned false or the container was destroyed. */
  destroy(): void;
}

let gfx: Gfx | null = null;
let gfxLoading: Promise<Gfx> | null = null;

/** The Graphics front and core: the bake draws through the unified batch. */
function loadGfx(): Promise<Gfx> {
  return (gfxLoading ??= import('../graphics/emit').then(m =>
    m.preloadGraphics('core').then(() => (gfx = m)),
  ));
}

const SPRITE_ITEM = GfxItemKind.SPRITE << GFX_ITEM_KIND_SHIFT;
const I_PER = SPRITE_INSTANCE_F32_PER;
/** Words of the sprite record (§4.1): color, u0v0, u1v1, flags. */
const I_COLOR = 6;
const I_UV = 7;
const I_FLAGS = 9;

/**
 * isCustomDrawable / isRenderGroup (src/types/core.ts), inlined: importing
 * them would split that module out of the minimal program's chunk.
 */
function custom(node: object): boolean {
  return typeof (node as { _emitDraw?: unknown })._emitDraw === 'function';
}
function group(node: object): boolean {
  return (
    typeof (node as { _emitGroupBegin?: unknown })._emitGroupBegin ===
    'function'
  );
}

const KIND_SPRITE = 0;
const KIND_GRAPHICS = 1;
const KIND_HOLE = 2;
const PART_SEGMENT = 0;
const PART_HOLE = 1;

// ── scopes ──────────────────────────────────────────────────────────────────

let nextScope = 1;
const freeScopes: number[] = [];

function allocScope(): number {
  const id = freeScopes.length > 0 ? freeScopes.pop()! : nextScope++;
  const s = nodeStore;
  const touch = s.scopeTouch;
  if (!touch || id >= touch.length) {
    const grown = new Uint32Array(Math.max(16, id * 2));
    if (touch) grown.set(touch);
    s.scopeTouch = grown;
  }
  s.scopeTouch![id] = 0;
  scopeColumn();
  return id;
}

/** The scope column covers every slot. */
function scopeColumn(): Uint32Array {
  const s = nodeStore;
  let scope = s.scope;
  if (!scope || scope.length < s.capacity) {
    const grown = new Uint32Array(Math.max(s.capacity, 256));
    if (scope) grown.set(scope);
    s.scope = scope = grown;
  }
  return scope;
}

// ── per renderer: transform slots, segments to free ─────────────────────────

class RendererBakes implements FrontFrameHook {
  private nextTransform = 1;
  private readonly freeTransforms: number[] = [];
  /** Segment ids of dropped bakes, freed at the end of the next frame. */
  readonly dead: number[] = [];
  /** Slot table ids of dropped bakes, released at the end of the next frame. */
  readonly deadSlots: number[] = [];
  /** Released slot table ids, reused before new ones are taken. */
  readonly freeSlots: number[] = [];
  remove: (() => void) | null = null;

  constructor(readonly rid: number) {}

  allocTransform(): number {
    if (this.freeTransforms.length > 0) return this.freeTransforms.pop()!;
    return this.nextTransform < GFX_MAX_TRANSFORMS ? this.nextTransform++ : 0;
  }

  freeTransform(id: number): void {
    if (id > 0) this.freeTransforms.push(id);
  }

  encodeFrame(): void {}

  encodeFrameEnd(frame: FrontFrame): void {
    // Re-armed bakes take effect on the next frame's structure pass.
    if (failedBakes.length > 0) retryFailed();
    const enc = frame.encoder;
    const slots = this.deadSlots;
    for (let i = 0; i < slots.length; i++) {
      // A count of 0 drops the core's table (and its bind group).
      enc.begin(GfxOp.GFX_SET_TEXTURE_SLOTS, 8);
      enc.u32(slots[i]);
      enc.u32(0);
      enc.end();
      this.freeSlots.push(slots[i]);
    }
    slots.length = 0;
    const dead = this.dead;
    if (dead.length === 0) return;
    for (let i = 0; i < dead.length; i++) {
      enc.begin(RetainOp.RETAIN_DESTROY, RETAIN_DESTROY_BYTES);
      enc.u32(dead[i]);
      enc.end();
      freeSegmentId(dead[i]);
    }
    dead.length = 0;
  }

  onRendererDestroyed(): void {
    const i = rendererBakes.indexOf(this);
    if (i >= 0) rendererBakes.splice(i, 1);
    // The core died with the renderer: only the ids go back.
    for (let k = 0; k < this.dead.length; k++) freeSegmentId(this.dead[k]);
    this.dead.length = 0;
    this.deadSlots.length = 0;
  }
}

const rendererBakes: RendererBakes[] = [];

function bakesFor(frame: FrontFrame): RendererBakes {
  for (let i = 0; i < rendererBakes.length; i++) {
    if (rendererBakes[i].rid === frame.rendererId) return rendererBakes[i];
  }
  const b = new RendererBakes(frame.rendererId);
  rendererBakes.push(b);
  b.remove = frame._addFrameHook?.(b) ?? null;
  return b;
}

// ── the bake of one container on one renderer ───────────────────────────────

class BakeState {
  gen = -1;
  /** scopeTouch / drawEpoch the bake was made at (-1: re-bake). */
  touch = -1;
  epoch = -1;
  /** textureDestroyCount() at the bake: a destroyed texture re-bakes. */
  texDestroys = -1;
  /**
   * Largest tessellation bucket of the container's world scale × resolution
   * baked so far (0: none): zooming past it re-bakes, finer.
   */
  zoom = 0;
  transform = 0;
  readonly sent = new Float32Array(7);
  sentValid = false;
  spriteFirst = -1;
  spriteCount = 0;
  /** Node slots given this scope by the last bake. */
  members = new Int32Array(64);
  nMembers = 0;
  /** Baked Graphics and the draw versions they were baked at. */
  readonly graphics: (RetainableDrawable | null)[] = [];
  nGraphics = 0;
  versions = new Float64Array(16);
  /** Sprite textures to poll (a provider, or not uploaded yet). */
  readonly live: (TextureHandle | null)[] = [];
  nLive = 0;
  liveIds = new Uint32Array(8);
  /** Draw plan: kind, segment id, recorded generation, command words or hole. */
  nParts = 0;
  partKind = new Uint8Array(4);
  partId = new Uint32Array(4);
  partGen = new Int32Array(4);
  partFrom = new Int32Array(4);
  partTo = new Int32Array(4);
  /** DRAW commands of every segment part, re-emitted without a retain core. */
  cmds = new Uint32Array(64);
  nCmds = 0;
  readonly holes: (CustomDrawable | null)[] = [];
  nHoles = 0;
  holeRel = new Float32Array(12);
  holeAlpha = new Float32Array(2);
  holeWorld = new Float32Array(12);
  /** Texture slot table ids, reused by every bake (private to the core). */
  tables = new Uint32Array(4);
  nTables = 0;

  constructor(
    readonly rid: number,
    readonly key: number,
  ) {}
}

// Bake scratch (one bake at a time): the flattened drawable entries.
const entries: (SceneNode | null)[] = [];
let entryKind = new Uint8Array(256);
let entryRel = new Float32Array(256 * 6);
let entryAlpha = new Float32Array(256);
let nEntries = 0;
/** Relative affine per depth of the walk. */
let depthRel = new Float32Array(16 * 6);
const local = new Float32Array(6);
const tableIds = new Uint32Array(GFX_MAX_TEXTURE_SLOTS);

function growF32(
  a: Float32Array<ArrayBuffer>,
  n: number,
): Float32Array<ArrayBuffer> {
  if (n <= a.length) return a;
  const b = new Float32Array(Math.max(n, a.length * 2));
  b.set(a);
  return b;
}

let warnedGroup = false;

function warnGroup(): void {
  if (warnedGroup) return;
  warnedGroup = true;
  (globalThis as { console?: { warn(...a: unknown[]): void } }).console?.warn(
    'cozygpu: a static container with a Group (or a foreign node) inside draws unbaked',
  );
}

/** A Group or a node that does not extend NodeBase below `node`. */
function blocked(node: SceneNode): boolean {
  const children = (node as ContainerNode).children;
  if (children) {
    for (let c = 0; c < children.length; c++) {
      const child = children[c];
      if (!(child instanceof NodeBase) || group(child) || blocked(child)) {
        return true;
      }
    }
  }
  return false;
}

/** Bakes that gave up on a Group: retried when their scope is touched. */
const failedBakes: StaticBake[] = [];

function retryFailed(): void {
  const touch = nodeStore.scopeTouch;
  if (!touch) return;
  for (let i = failedBakes.length - 1; i >= 0; i--) {
    const b = failedBakes[i];
    if (touch[b.scope] === b.failedTouch) continue;
    b.failedTouch = touch[b.scope];
    if (b.rearm()) {
      failedBakes[i] = failedBakes[failedBakes.length - 1];
      failedBakes.pop();
    }
  }
}

class StaticBake implements StaticBinding {
  private readonly states: BakeState[] = [];
  /** A Group or a foreign node inside: the container draws unbaked. */
  private failed = false;
  /** scopeTouch when the bake failed; a change retries it. */
  failedTouch = 0;
  private destroyed = false;
  readonly scope: number;

  constructor(private readonly c: Container) {
    this.scope = allocScope();
    c._scopeId = this.scope;
    void loadGfx().then(() => {
      if (this.destroyed || !c._static) return;
      c._sbLeaf = true;
      bumpNode(c);
    });
  }

  /**
   * Called when the failed bake's scope was touched: bakes again once the
   * Group (or foreign node) is gone. True: done with retrying.
   */
  rearm(): boolean {
    const c = this.c;
    if (this.destroyed || !c._static) return true;
    if (blocked(c)) return false;
    this.failed = false;
    if (!c._sbLeaf) {
      c._sbLeaf = true;
      bumpNode(c);
    }
    return true;
  }

  /** Re-bake on the next emit (a containing bake took over the subtree). */
  stale(): void {
    for (let i = 0; i < this.states.length; i++) this.states[i].touch = -1;
  }

  private state(rid: number): BakeState {
    const s = this.states;
    for (let i = 0; i < s.length; i++) if (s[i].rid === rid) return s[i];
    const st = new BakeState(rid, -this.scope);
    s.push(st);
    return st;
  }

  emit(
    frame: FrontFrame,
    world: Float32Array,
    wo: number,
    alpha: number,
  ): boolean {
    const g = gfx;
    if (
      g === null ||
      this.failed ||
      !frame.isSystemReady(OpcodeRange.GRAPHICS)
    ) {
      return this.unbake();
    }
    const st = this.state(frame.rendererId);
    const bakes = bakesFor(frame);
    const r = g.rendererState(frame);
    r.beginFrame(frame);
    if (!r.unified) return this.unbake();
    if (st.transform === 0) {
      st.transform = bakes.allocTransform();
      if (st.transform === 0) return this.unbake();
    }
    const gen = frame.generation;
    const zoom = g.scaleBucket(world, wo, frame.resolution);
    const regen = st.gen !== gen;
    if (
      regen ||
      st.touch !== nodeStore.scopeTouch![this.scope] ||
      st.texDestroys !== textureDestroyCount() ||
      (st.nGraphics > 0 && zoom > st.zoom) ||
      this.changed(st, frame)
    ) {
      if (regen) {
        st.gen = gen;
        st.sentValid = false;
      }
      return this.bake(st, frame, g, r, world, wo, alpha, zoom, regen);
    }
    this.transform(st, frame, world, wo, alpha);
    this.draw(st, frame, world, wo, alpha);
    return true;
  }

  /** Graphics edited or a polled texture changed since the bake. */
  private changed(st: BakeState, frame: FrontFrame): boolean {
    if (st.epoch !== nodeStore.drawEpoch) {
      const graphics = st.graphics;
      for (let i = 0; i < st.nGraphics; i++) {
        if (graphics[i]!._drawVersion !== st.versions[i]) return true;
      }
      st.epoch = nodeStore.drawEpoch;
    }
    const live = st.live;
    for (let i = 0; i < st.nLive; i++) {
      if (ensureTextureUploaded(frame, live[i]!) !== st.liveIds[i]) return true;
    }
    return false;
  }

  /** A Group or a foreign node inside: unbaked until it is gone. */
  private fail(): false {
    if (!this.failed) {
      this.failed = true;
      this.failedTouch = nodeStore.scopeTouch![this.scope];
      failedBakes.push(this);
    }
    return this.unbake();
  }

  /** The container draws unbaked from now on: the packer walks it again. */
  private unbake(): false {
    const c = this.c;
    if (c._sbLeaf) {
      c._sbLeaf = false;
      bumpNode(c);
    }
    return false;
  }

  /** GFX_SET_TRANSFORM when the container moved or faded. */
  private transform(
    st: BakeState,
    frame: FrontFrame,
    world: Float32Array,
    wo: number,
    alpha: number,
  ): void {
    const sent = st.sent;
    if (
      st.sentValid &&
      sent[0] === world[wo] &&
      sent[1] === world[wo + 1] &&
      sent[2] === world[wo + 2] &&
      sent[3] === world[wo + 3] &&
      sent[4] === world[wo + 4] &&
      sent[5] === world[wo + 5] &&
      sent[6] === alpha
    ) {
      return;
    }
    st.sentValid = true;
    const enc = frame.encoder;
    // Payload through the views: no number crosses a call (no boxing).
    const at = enc.begin(GfxOp.GFX_SET_TRANSFORM, 32) >> 2;
    enc.u32View[at] = st.transform;
    const f = enc.f32View;
    for (let i = 0; i < 6; i++) f[at + 1 + i] = sent[i] = world[wo + i];
    f[at + 7] = sent[6] = alpha;
    enc.end();
  }

  /** The bake's draws: replayed segments and live holes. */
  private draw(
    st: BakeState,
    frame: FrontFrame,
    world: Float32Array,
    wo: number,
    alpha: number,
  ): void {
    const enc = frame.encoder;
    const retain = frame.isSystemReady(OpcodeRange.RETAIN);
    for (let p = 0; p < st.nParts; p++) {
      if (st.partKind[p] === PART_HOLE) {
        const h = st.partFrom[p];
        affineMultiply(st.holeWorld, h * 6, world, wo, st.holeRel, h * 6);
        st.holes[h]!._emitDraw(
          frame,
          st.holeWorld,
          h * 6,
          alpha * st.holeAlpha[h],
        );
        continue;
      }
      if (retain && st.partGen[p] === frame.generation) {
        enc.begin(RetainOp.RETAIN_DRAW, RETAIN_DRAW_BYTES, CommandFlag.DRAW);
        enc.u32(st.partId[p]);
        enc.end();
        continue;
      }
      if (retain) beginSegment(enc, st.partId[p]);
      // The baked draw commands, as recorded.
      const cmds = st.cmds;
      for (let w = st.partFrom[p]; w < st.partTo[p]; ) {
        const head = cmds[w];
        const bytes = cmds[w + 1];
        enc.begin(head & 0xffff, bytes, head >>> 16);
        for (let k = 0; k < bytes >> 2; k++) enc.u32(cmds[w + 2 + k]);
        enc.end();
        w += 2 + (bytes >> 2);
      }
      if (retain) {
        endSegment(enc, st.partId[p]);
        st.partGen[p] = frame.generation;
      }
    }
  }

  /** Walks the subtree, writes the bake and draws it. */
  private bake(
    st: BakeState,
    frame: FrontFrame,
    g: Gfx,
    r: GfxRenderer,
    world: Float32Array,
    wo: number,
    alpha: number,
    zoom: number,
    regen: boolean,
  ): boolean {
    const touch = nodeStore.scopeTouch![this.scope];
    const epoch = nodeStore.drawEpoch;
    if (blocked(this.c)) {
      warnGroup();
      // The subtree is not in this frame's batches (the container is a
      // leaf): draw the last bake once more rather than nothing.
      if (!regen && st.nParts > 0) {
        this.transform(st, frame, world, wo, alpha);
        this.draw(st, frame, world, wo, alpha);
      }
      return this.fail();
    }
    this.release(st, r);
    nEntries = 0;
    if (!this.walk(st, this.c, 0, 1)) return this.fail();
    st.touch = touch;
    st.epoch = epoch;
    st.texDestroys = textureDestroyCount();
    // Tessellate for the largest zoom baked so far (no churn zooming back).
    if (zoom > st.zoom) st.zoom = zoom;
    this.transform(st, frame, world, wo, alpha);

    // Sprite records: one block for the whole bake.
    let sprites = 0;
    for (let i = 0; i < nEntries; i++) {
      if (entryKind[i] === KIND_SPRITE) sprites++;
    }
    const sab = frame.useSharedArrayBuffer;
    st.spriteCount = sprites;
    st.spriteFirst = sprites > 0 ? r.sprites.alloc(sprites, sab) : -1;

    const enc = frame.encoder;
    const retain = frame.isSystemReady(OpcodeRange.RETAIN);
    const region = r.regionFor(st.key);
    region.begin(frame.frameId);
    region.reset();
    r.bakeKey = st.key;
    r.transform = st.transform;
    r.slots = 0;
    const bakes = bakesFor(frame);
    let tableCount = 0;
    let tables = 0;
    let rec = st.spriteFirst;
    let complete = true;
    let open = false;
    let partStart = 0;
    st.nParts = 0;
    st.nCmds = 0;
    for (let i = 0; i < nEntries; i++) {
      const node = entries[i]!;
      const kind = entryKind[i];
      if (kind === KIND_SPRITE) {
        const sprite = node as Sprite;
        const texture = sprite._texture;
        const texId = ensureTextureUploaded(frame, texture);
        if (
          texId === NO_ID ||
          (texture as { _source?: { provider?: unknown } })._source?.provider
        ) {
          addLive(st, texture, texId);
        }
        let slot = -1;
        for (let k = 0; k < tableCount; k++) {
          if (tableIds[k] === texId) slot = k;
        }
        if (slot < 0) {
          if (tableCount === GFX_MAX_TEXTURE_SLOTS || r.slots === 0) {
            if (r.slots !== 0) sendSlots(enc, r.slots, tableCount);
            r.slots = tableId(st, r, bakes, tables++);
            tableCount = 0;
          }
          slot = tableCount;
          tableIds[tableCount++] = texId;
        }
        if (!open) {
          partStart = this.openPart(st, enc, retain);
          open = true;
        }
        writeSprite(r, rec, sprite._slot, entryRel, i * 6, entryAlpha[i], slot);
        const at = region.top;
        region.top += 6;
        region.ensure(region.top, sab);
        const items = region.u32;
        const base = (SPRITE_ITEM | (rec << GFX_ITEM_CORNER_BITS)) >>> 0;
        items[at] = base;
        items[at + 1] = base + 1;
        items[at + 2] = base + 2;
        items[at + 3] = base + 2;
        items[at + 4] = base + 1;
        items[at + 5] = base + 3;
        region.touch(at, 6);
        g.drawUnified(r, enc, region, at, 6, sprite._blendId, 0);
        rec++;
        continue;
      }
      if (kind === KIND_GRAPHICS) {
        const binding = (node as unknown as { _binding: GfxBinding | null })
          ._binding;
        if (binding === null) {
          complete = false;
          continue;
        }
        if (!open) {
          partStart = this.openPart(st, enc, retain);
          open = true;
        }
        if (binding.bake(frame, entryRel, i * 6, entryAlpha[i], st.zoom)) {
          if (!binding.baked) complete = false;
          addGraphics(st, node as unknown as RetainableDrawable);
          continue;
        }
      }
      // A hole: close the run of baked draws, draw the node live.
      if (open) {
        this.closePart(st, enc, retain, partStart);
        open = false;
      }
      const h = addHole(st, node as unknown as CustomDrawable, i, world, wo);
      st.holes[h]!._emitDraw(frame, st.holeWorld, h * 6, alpha * entryAlpha[i]);
    }
    if (open) this.closePart(st, enc, retain, partStart);
    // Segments of a bake with more parts than this one.
    for (let p = st.nParts; p < st.partId.length; p++) {
      if (st.partId[p] !== 0) {
        bakes.dead.push(st.partId[p]);
        st.partId[p] = 0;
      }
    }
    if (r.slots !== 0) sendSlots(enc, r.slots, tableCount);
    r.bakeKey = 0;
    r.transform = 0;
    r.slots = 0;
    if (st.spriteCount > 0) r.sprites.touch(st.spriteFirst, st.spriteCount);
    for (let i = 0; i < st.nGraphics; i++) {
      st.versions[i] = st.graphics[i]!._drawVersion;
    }
    // Something was still loading: bake again next frame.
    if (!complete) st.touch = -1;
    for (let i = 0; i < nEntries; i++) entries[i] = null;
    return true;
  }

  /** Opens a run of baked draws (a segment); returns the encoder offset. */
  private openPart(
    st: BakeState,
    enc: FrontFrame['encoder'],
    retain: boolean,
  ): number {
    const p = st.nParts;
    if (p >= st.partKind.length) growParts(st, p + 1);
    st.partKind[p] = PART_SEGMENT;
    if (st.partId[p] === 0) st.partId[p] = allocSegmentId();
    st.partGen[p] = -1;
    if (retain) beginSegment(enc, st.partId[p]);
    return enc.byteLength;
  }

  /** Closes the open run: keeps its DRAW commands, ends the segment. */
  private closePart(
    st: BakeState,
    enc: FrontFrame['encoder'],
    retain: boolean,
    from: number,
  ): void {
    const p = st.nParts++;
    st.partFrom[p] = st.nCmds;
    copyDraws(st, enc, from);
    st.partTo[p] = st.nCmds;
    if (retain) {
      endSegment(enc, st.partId[p]);
      st.partGen[p] = st.gen;
    }
  }

  /**
   * Flattens the visible drawables of `node`'s subtree with transforms
   * relative to the container, and gives every node this scope. False: the
   * subtree cannot be baked (a Group, a foreign node).
   */
  private walk(
    st: BakeState,
    node: ContainerNode,
    depth: number,
    alpha: number,
  ): boolean {
    const children = node.children;
    const scope = scopeColumn();
    const s = nodeStore;
    const L = s.local;
    const P = s.pos;
    for (let c = 0; c < children.length; c++) {
      const child = children[c];
      if (!(child instanceof NodeBase) || group(child)) return false;
      const slot = child._slot;
      scope[slot] = this.scope;
      if (st.nMembers === st.members.length) {
        const m = new Int32Array(st.members.length * 2);
        m.set(st.members);
        st.members = m;
      }
      st.members[st.nMembers++] = slot;
      const lo = slot * LOCAL_STRIDE;
      affineFromTRS(
        local,
        0,
        P[slot * POS_STRIDE],
        P[slot * POS_STRIDE + 1],
        L[lo + L_ROT],
        L[lo + L_SCALE_X],
        L[lo + L_SCALE_Y],
        L[lo + L_SKEW_X],
        L[lo + L_SKEW_Y],
        L[lo + L_PIVOT_X],
        L[lo + L_PIVOT_Y],
      );
      const d = (depth + 1) * 6;
      depthRel = growF32(depthRel, d + 6);
      if (depth === 0) depthRel.set(local, d);
      else affineMultiply(depthRel, d, depthRel, depth * 6, local, 0);
      const a = alpha * L[lo + L_ALPHA];
      if (!child._visible) {
        // Not drawn, but its subtree keeps this scope (showing it re-bakes).
        if (!this.claim(child)) return false;
        continue;
      }
      const sprite = child instanceof Sprite;
      const drawable = !sprite && custom(child);
      if (sprite || drawable) {
        const i = nEntries++;
        if (i === entryKind.length) {
          const k = new Uint8Array(i * 2);
          k.set(entryKind);
          entryKind = k;
        }
        entryRel = growF32(entryRel, (i + 1) * 6);
        entryAlpha = growF32(entryAlpha, i + 1);
        entries[i] = child;
        // By kind: other drawables (SpriteLayer) have a `_binding` too.
        entryKind[i] = sprite
          ? KIND_SPRITE
          : child.kind === 'graphics'
            ? KIND_GRAPHICS
            : KIND_HOLE;
        for (let k = 0; k < 6; k++) entryRel[i * 6 + k] = depthRel[d + k];
        entryAlpha[i] = a;
        continue;
      }
      const grand = (child as unknown as ContainerNode).children;
      if (
        grand &&
        !this.walk(st, child as unknown as ContainerNode, depth + 1, a)
      ) {
        return false;
      }
      // A static container inside folds into this bake; its own bake is
      // stale once it draws on its own again (its subtree took this scope).
      const inner = (child as unknown as Container)._sb;
      if (inner) (inner as StaticBake).stale();
    }
    return true;
  }

  /** Gives an invisible subtree this scope. */
  private claim(node: SceneNode): boolean {
    const children = (node as ContainerNode).children;
    if (!children) return true;
    const scope = scopeColumn();
    for (let c = 0; c < children.length; c++) {
      const child = children[c];
      if (!(child instanceof NodeBase) || group(child)) return false;
      scope[child._slot] = this.scope;
      if (!this.claim(child)) return false;
    }
    return true;
  }

  /** Frees the last bake's sprite records and forgets its members. */
  private release(st: BakeState, r: GfxRenderer | null): void {
    if (r !== null && st.spriteCount > 0) {
      r.sprites.free(st.spriteFirst, st.spriteCount);
    }
    st.spriteFirst = -1;
    st.spriteCount = 0;
    const scope = nodeStore.scope;
    if (scope) {
      for (let i = 0; i < st.nMembers; i++) {
        const slot = st.members[i];
        if (slot < scope.length && scope[slot] === this.scope) scope[slot] = 0;
      }
    }
    st.nMembers = 0;
    // Counts reset, arrays kept (no allocation on the next bake).
    for (let i = 0; i < st.nGraphics; i++) st.graphics[i] = null;
    for (let i = 0; i < st.nLive; i++) st.live[i] = null;
    for (let i = 0; i < st.nHoles; i++) st.holes[i] = null;
    st.nGraphics = st.nLive = st.nHoles = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const g = gfx;
    for (let i = 0; i < this.states.length; i++) {
      const st = this.states[i];
      let r: GfxRenderer | null = null;
      if (g !== null) {
        for (let k = 0; k < rendererBakes.length; k++) {
          const bakes = rendererBakes[k];
          if (bakes.rid !== st.rid) continue;
          bakes.freeTransform(st.transform);
          for (let p = 0; p < st.partId.length; p++) {
            if (st.partId[p] !== 0) bakes.dead.push(st.partId[p]);
          }
          for (let t = 0; t < st.nTables; t++)
            bakes.deadSlots.push(st.tables[t]);
          st.nTables = 0;
        }
        r = findGfxRenderer(g, st.rid);
      }
      this.release(st, r);
    }
    this.states.length = 0;
    nodeStore.scopeTouch![this.scope] = 0;
    freeScopes.push(this.scope);
    if (this.c._scopeId === this.scope) this.c._scopeId = 0;
  }
}

/** The binding methods the bake uses (src/graphics/emit.ts Binding). */
interface GfxBinding {
  bake(
    frame: FrontFrame,
    world: Float32Array,
    worldOffset: number,
    worldAlpha: number,
    scale: number,
  ): boolean;
  readonly baked: boolean;
}

function findGfxRenderer(g: Gfx, rid: number): GfxRenderer | null {
  // rendererState() would create one; only look it up here.
  return g.findRendererState(rid);
}

function beginSegment(enc: FrontFrame['encoder'], id: number): void {
  enc.begin(RetainOp.RETAIN_BEGIN, RETAIN_BEGIN_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  enc.u32(0);
  enc.end();
}

function endSegment(enc: FrontFrame['encoder'], id: number): void {
  enc.begin(RetainOp.RETAIN_END, RETAIN_END_BYTES, CommandFlag.DRAW);
  enc.u32(id);
  enc.end();
}

function sendSlots(
  enc: FrontFrame['encoder'],
  id: number,
  count: number,
): void {
  enc.begin(GfxOp.GFX_SET_TEXTURE_SLOTS, 8 + count * 4);
  enc.u32(id);
  enc.u32(count);
  for (let i = 0; i < count; i++) enc.u32(tableIds[i]);
  enc.end();
}

/** Copies the DRAW commands encoded since `from` into the bake's store. */
function copyDraws(st: BakeState, enc: FrontFrame['encoder'], from: number) {
  const u = enc.u32View;
  const end = enc.byteLength;
  for (let p = from; p < end; ) {
    const head = u[p >> 2];
    const bytes = u[(p >> 2) + 1];
    const words = 2 + (bytes >> 2);
    if ((head >>> 16) & CommandFlag.DRAW) {
      if (st.nCmds + words > st.cmds.length) {
        const c = new Uint32Array(
          Math.max(st.cmds.length * 2, st.nCmds + words),
        );
        c.set(st.cmds);
        st.cmds = c;
      }
      for (let k = 0; k < words; k++) st.cmds[st.nCmds + k] = u[(p >> 2) + k];
      st.nCmds += words;
    }
    p += words << 2;
  }
}

function growParts(st: BakeState, n: number): void {
  const cap = Math.max(n, st.partKind.length * 2);
  const kind = new Uint8Array(cap);
  kind.set(st.partKind);
  st.partKind = kind;
  const id = new Uint32Array(cap);
  id.set(st.partId);
  st.partId = id;
  const gen = new Int32Array(cap);
  gen.set(st.partGen);
  st.partGen = gen;
  const from = new Int32Array(cap);
  from.set(st.partFrom);
  st.partFrom = from;
  const to = new Int32Array(cap);
  to.set(st.partTo);
  st.partTo = to;
}

/** The bake's `k`-th slot table id (allocated on first use, then kept). */
function tableId(
  st: BakeState,
  r: GfxRenderer,
  bakes: RendererBakes,
  k: number,
): number {
  if (k < st.nTables) return st.tables[k];
  if (k >= st.tables.length) {
    const t = new Uint32Array(k * 2);
    t.set(st.tables);
    st.tables = t;
  }
  st.nTables = k + 1;
  const free = bakes.freeSlots;
  return (st.tables[k] = free.length > 0 ? free.pop()! : r.nextSlots++);
}

function addLive(st: BakeState, texture: TextureHandle, texId: number): void {
  const i = st.nLive++;
  st.live[i] = texture;
  if (i >= st.liveIds.length) {
    const ids = new Uint32Array(i * 2);
    ids.set(st.liveIds);
    st.liveIds = ids;
  }
  st.liveIds[i] = texId;
}

function addGraphics(st: BakeState, node: RetainableDrawable): void {
  const i = st.nGraphics++;
  st.graphics[i] = node;
  if (i >= st.versions.length) {
    const v = new Float64Array(i * 2);
    v.set(st.versions);
    st.versions = v;
  }
}

/** Records hole `node` (entry `i`) and its world for this frame; returns its index. */
function addHole(
  st: BakeState,
  node: CustomDrawable,
  i: number,
  world: Float32Array,
  wo: number,
): number {
  const h = st.nHoles++;
  st.holes[h] = node;
  st.holeRel = growF32(st.holeRel, (h + 1) * 6);
  st.holeWorld = growF32(st.holeWorld, (h + 1) * 6);
  st.holeAlpha = growF32(st.holeAlpha, h + 1);
  for (let k = 0; k < 6; k++) st.holeRel[h * 6 + k] = entryRel[i * 6 + k];
  st.holeAlpha[h] = entryAlpha[i];
  affineMultiply(st.holeWorld, h * 6, world, wo, st.holeRel, h * 6);
  const p = st.nParts++;
  if (p >= st.partKind.length) growParts(st, p + 1);
  st.partKind[p] = PART_HOLE;
  st.partFrom[p] = h;
  return h;
}

/**
 * The baked sprite record (§4.1) of `slot` at `rec`: relative affine ×
 * T(-anchor·size) · S(size), tint × alpha, frame uv, flags with the
 * texture slot in bits 3–5.
 */
function writeSprite(
  r: GfxRenderer,
  rec: number,
  slot: number,
  rel: Float32Array,
  ro: number,
  alpha: number,
  texSlot: number,
): void {
  const s = nodeStore;
  const L = s.local;
  const lo = slot * LOCAL_STRIDE;
  const fw = L[lo + L_FRAME_W];
  const fh = L[lo + L_FRAME_H];
  const ax = L[lo + L_ANCHOR_X] * fw;
  const ay = L[lo + L_ANCHOR_Y] * fh;
  const a = rel[ro];
  const b = rel[ro + 1];
  const c = rel[ro + 2];
  const d = rel[ro + 3];
  const f = r.sprites.f32;
  const u = r.sprites.u32;
  const o = rec * I_PER;
  f[o] = a * fw;
  f[o + 1] = b * fw;
  f[o + 2] = c * fh;
  f[o + 3] = d * fh;
  f[o + 4] = rel[ro + 4] - (a * ax + c * ay);
  f[o + 5] = rel[ro + 5] - (b * ax + d * ay);
  const tint = s.tint[slot];
  const al = alpha <= 0 ? 0 : alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0;
  u[o + I_COLOR] =
    (((tint >>> 16) & 0xff) |
      (((tint >>> 8) & 0xff) << 8) |
      ((tint & 0xff) << 16) |
      (al << 24)) >>>
    0;
  const uo = slot * UV_STRIDE;
  const uv = s.uv;
  u[o + I_UV] = (uv[uo] | (uv[uo + 1] << 16)) >>> 0;
  u[o + I_UV + 1] = (uv[uo + 2] | (uv[uo + 3] << 16)) >>> 0;
  u[o + I_FLAGS] = (s.flags[slot] | (texSlot << GFX_SPRITE_SLOT_SHIFT)) >>> 0;
}

export function createStaticBinding(container: ContainerNode): StaticBinding {
  return new StaticBake(container as Container);
}

/**
 * Applies `container.static` (called by the setter once this chunk loaded):
 * creates the bake, or drops it and lets the packer walk the subtree again.
 */
export function setStatic(c: Container): void {
  if (c._static) {
    if (!c._sb && !c.destroyed) c._sb = createStaticBinding(c);
    return;
  }
  c._sb?.destroy();
  c._sb = null;
  if (c._sbLeaf) {
    c._sbLeaf = false;
    bumpNode(c);
  }
}
