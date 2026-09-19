/**
 * ChildBulk and ColumnBindingImpl. The dense writer
 * behind `Container.bulkChildren()` (ARCHITECTURE §16.1) and the external
 * column binding behind `Container.bindColumns()` (§19.1).
 *
 * Both share ONE copy path, `Rows._copy`: every column is a strided source
 * (array, offset, stride), row i at `offset + i × stride`. The bulk writer's
 * own arrays are the dense case (position: x at offset 0 and y at offset 1,
 * stride 2); caller columns are whatever they bound. `_copy` writes the node
 * store in one tight loop per column, ORs the dirty bits and bumps `touch`
 * once. A POSITION-only commit sets only `Dirty.POSITION`, so the packer
 * takes its translation fast path over the whole run of children.
 *
 * The children snapshot (store slot per child, sprite flag) is refreshed when
 * the container's `childrenVersion` changes.
 *
 * Bulk arrays are sized for every field requested so far (a field requested
 * once stays sized), so alternating `bulkChildren(POSITION)` and
 * `bulkChildren(ROTATION)` never reallocates. Fields never requested are
 * zero-length.
 */
import { CozyGPUError } from '../types/errors';
import { NodeBase } from './Node';
import {
  Dirty,
  L_ALPHA,
  L_ROT,
  L_SCALE_X,
  L_SCALE_Y,
  LOCAL_STRIDE,
  POS_STRIDE,
  TOUCH_MASK,
  nodeStore,
} from './store';
import { BulkField } from './types';
import type {
  BindColumnsOptions,
  BulkChildren,
  ColumnBinding,
  SceneNode,
  SpriteColumns,
  SpriteNode,
  TextureHandle,
} from './types';

/** What the writers need from their Container (avoids an import cycle). */
export interface BulkHost {
  readonly _children: SceneNode[];
  readonly _childrenVersion: number;
  readonly _destroyed: boolean;
}

type Column = Float32Array | Uint32Array;
type Props = Record<string, number>;

const EMPTY_F32 = new Float32Array(0);
/** POSITION | ROTATION | SCALE | ALPHA | TINT: the bulkChildren fields. */
const ALL_FIELDS = 31;

// Column indexes (Rows._a/_o/_s) in SpriteColumns key order. Columns below
// C_TINT are Float32Array, the rest Uint32Array.
const C_Y = 1;
const C_ROT = 2;
const C_SY = 4;
const C_TINT = 6;
const C_FRAME = 7;
/** Column keys; also the node property each column writes (except frame). */
const KEYS = [
  'x',
  'y',
  'rotation',
  'scaleX',
  'scaleY',
  'alpha',
  'tint',
  'frame',
  'userId',
] as const;
/** BulkField bit of each column. */
const COL_FIELD = [1, 1, 2, 4, 4, 8, 16, 32, 64];
/** Store record stride and offset, and the dirty bit, of each column. */
const COL_STRIDE = [
  POS_STRIDE,
  POS_STRIDE,
  LOCAL_STRIDE,
  LOCAL_STRIDE,
  LOCAL_STRIDE,
  LOCAL_STRIDE,
  1,
  0,
  1,
];
const COL_OFF = [0, 1, L_ROT, L_SCALE_X, L_SCALE_Y, L_ALPHA, 0, 0, 0];
const COL_DIRTY = [
  Dirty.POSITION,
  Dirty.POSITION,
  Dirty.LOCAL,
  Dirty.LOCAL,
  Dirty.LOCAL,
  Dirty.ALPHA,
  Dirty.SPRITE,
  0,
  0,
];

/** The node-store array a column writes (not for C_FRAME). */
function storeOf(c: number): Column {
  const s = nodeStore;
  return c < C_ROT
    ? s.pos
    : c < C_TINT
      ? s.local
      : c === C_TINT
        ? s.tint
        : s.userId;
}
/** Bulk array per BulkField bit (1 << k), and its first column. */
const BULK_NAMES = ['position', 'rotation', 'scale', 'alpha', 'tint'] as const;
const BULK_COL = [0, C_ROT, 3, 5, C_TINT];

/** Children snapshot plus one strided source per column. */
class Rows {
  count = 0;
  /** -1 until the first snapshot. */
  version = -1;
  /** Store slot per child; -1 for SceneNodes that do not extend NodeBase. */
  _slots = new Int32Array(0);
  /** 1 when the child is a sprite (TINT, FRAME apply). */
  _sprite = new Uint8Array(0);
  _foreign = false;
  /** Source array per column (null: not bound). */
  _a = new Array<Column | null>(9).fill(null);
  _o = new Int32Array(9);
  _s = new Int32Array(9);
  _frames: readonly TextureHandle[] = [];

  constructor(readonly _host: BulkHost) {}

  _snapshot(): void {
    const children = this._host._children;
    const n = children.length;
    if (this._slots.length < n) {
      const cap = Math.max(n, this._slots.length * 2);
      this._slots = new Int32Array(cap);
      this._sprite = new Uint8Array(cap);
    }
    let foreign = false;
    for (let i = 0; i < n; i++) {
      const child = children[i];
      const base = child instanceof NodeBase;
      this._slots[i] = base ? child._slot : -1;
      if (!base) foreign = true;
      this._sprite[i] = child.kind === 'sprite' ? 1 : 0;
    }
    this._foreign = foreign;
    this.count = n;
    this.version = this._host._childrenVersion;
  }

  /** Throws INVALID_ARGUMENT unless [first, first + count) is in range. */
  _range(what: string, first: number, count: number): void {
    if (
      !(first >= 0 && count >= 0 && first + count <= this.count) ||
      first % 1 ||
      count % 1
    ) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `${what}: [${first}, ${first + count}) outside [0, ${this.count}]`,
      );
    }
  }

  /**
   * THE copy path: rows [first, end) of the `fields` columns into children
   * [first, end). Zero allocations; `touch` bumped once. Callers validate
   * everything first (ranges, column lengths, frame indexes), so a commit
   * either applies every row or throws before writing any. `touch` is still
   * bumped in `finally`: should a setter throw part-way (a foreign child),
   * the rows already written are picked up by the packer, never left
   * written but not rendered.
   */
  _copy(fields: number, first: number, end: number): void {
    const s = nodeStore;
    try {
      const a = this._a;
      const o = this._o;
      const st = this._s;
      const slots = this._slots;
      const sprite = this._sprite;
      const dirty = s.dirty;
      if (this._foreign) {
        // Slow path through the public setters (a child is not a NodeBase).
        const children = this._host._children;
        for (let i = first; i < end; i++) {
          const node = children[i] as unknown as Props;
          for (let c = 0; c < 9; c++) {
            const src = a[c];
            if (
              src !== null &&
              c !== C_FRAME &&
              (fields & COL_FIELD[c]) !== 0 &&
              (c !== C_TINT || sprite[i] === 1)
            ) {
              node[KEYS[c]] = src[o[c] + i * st[c]];
            }
          }
        }
      } else {
        // One tight loop per column; x and y are separate columns.
        for (let c = 0; c < 9; c++) {
          const src = a[c];
          if (src === null || c === C_FRAME || (fields & COL_FIELD[c]) === 0) {
            continue;
          }
          const off = o[c];
          const stride = st[c];
          const T = storeOf(c);
          const ts = COL_STRIDE[c];
          const to = COL_OFF[c];
          const bit = COL_DIRTY[c];
          if (c < C_TINT) {
            for (let i = first; i < end; i++) {
              const slot = slots[i];
              T[slot * ts + to] = src[off + i * stride];
              dirty[slot] |= bit;
            }
          } else {
            // tint (sprites only, 24 bits) or userId (no dirty bit).
            const tint = c === C_TINT;
            const mask = tint ? 0xffffff : -1;
            for (let i = first; i < end; i++) {
              if (tint && sprite[i] !== 1) continue;
              const slot = slots[i];
              T[slot] = src[off + i * stride] & mask;
              dirty[slot] |= bit;
            }
          }
        }
      }
      if ((fields & BulkField.FRAME) !== 0) {
        // The Sprite texture setter: a no-op for an unchanged handle.
        const src = a[C_FRAME] as Column;
        const children = this._host._children;
        for (let i = first; i < end; i++) {
          if (sprite[i] !== 1) continue;
          // Indexes were checked by _frameRows before any write.
          (children[i] as SpriteNode).texture =
            this._frames[src[o[C_FRAME] + i * st[C_FRAME]]];
        }
      }
    } finally {
      s.touch = (s.touch + 1) & TOUCH_MASK;
    }
  }

  /**
   * Throws INVALID_ARGUMENT unless every sprite row in [first, end) holds a
   * valid index into the frames table. Runs before any write.
   */
  _frameRows(first: number, end: number): void {
    const src = this._a[C_FRAME] as Column;
    for (let i = first; i < end; i++) {
      if (
        this._sprite[i] === 1 &&
        !this._frames[src[this._o[C_FRAME] + i * this._s[C_FRAME]]]
      ) {
        throw new CozyGPUError('INVALID_ARGUMENT', `commit: frame, row ${i}`);
      }
    }
  }
}

export class ChildBulk extends Rows implements BulkChildren {
  position: Float32Array = EMPTY_F32;
  rotation: Float32Array = EMPTY_F32;
  scale: Float32Array = EMPTY_F32;
  alpha: Float32Array = EMPTY_F32;
  tint: Uint32Array = new Uint32Array(0);

  /** BulkField bits whose arrays are sized. */
  private sized = 0;
  /** Backing buffer per bulk array (BULK_NAMES order). */
  private bufs: Column[] = [
    EMPTY_F32,
    EMPTY_F32,
    EMPTY_F32,
    EMPTY_F32,
    this.tint,
  ];

  constructor(host: BulkHost) {
    super(host);
    // Dense layout of the bulk arrays: [x, y, …] and [sx, sy, …], stride 2.
    this._o[C_Y] = this._o[C_SY] = 1;
    this._s.fill(1);
    this._s.fill(2, 0, 2);
    this._s.fill(2, 3, 5);
  }

  /** @internal Called by Container.bulkChildren(). */
  _acquire(fields: number): void {
    const want = (fields & ALL_FIELDS) | this.sized;
    const stale = this._host._childrenVersion !== this.version;
    if (stale) this._snapshot();
    if (stale || want !== this.sized) this.resize(want, stale);
  }

  /** Sizes the arrays of `fields`; `force` re-slices every sized view. */
  private resize(fields: number, force: boolean): void {
    const self = this as unknown as Record<string, Column>;
    for (let k = 0; k < 5; k++) {
      if ((fields & (1 << k)) === 0) continue;
      const len = this.count * (k === 0 || k === 2 ? 2 : 1);
      let buf = this.bufs[k];
      if (buf.length < len) {
        const next = new (k === 4 ? Uint32Array : Float32Array)(
          Math.max(len, buf.length * 2),
        );
        next.set(buf);
        buf = next;
      }
      if (force || buf !== this.bufs[k] || self[BULK_NAMES[k]].length !== len) {
        this.bufs[k] = buf;
        self[BULK_NAMES[k]] = buf.subarray(0, len);
      }
    }
    this.sized = fields;
  }

  /** Validates, then points the column sources at the current arrays. */
  private check(
    what: string,
    fields: number,
    first: number,
    count: number,
  ): void {
    what = 'BulkChildren.' + what;
    if (this.version !== this._host._childrenVersion) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `${what}: children changed; call bulkChildren() again`,
      );
    }
    this._range(what, first, count);
    if (fields & ALL_FIELDS & ~this.sized) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        `${what}: fields ${fields} not requested`,
      );
    }
    const self = this as unknown as Record<string, Column>;
    for (let k = 0; k < 5; k++) {
      const c = BULK_COL[k];
      this._a[c] = self[BULK_NAMES[k]];
      if (k === 0 || k === 2) this._a[c + 1] = this._a[c];
    }
  }

  pull(fields: number, first = 0, count = this.count - first): void {
    this.check('pull', fields, first, count);
    const children = this._host._children;
    for (let c = 0; c <= C_TINT; c++) {
      if ((fields & COL_FIELD[c]) === 0) continue;
      const dst = this._a[c] as Column;
      const T = storeOf(c);
      for (let i = first; i < first + count; i++) {
        if (c === C_TINT && this._sprite[i] !== 1) continue;
        dst[this._o[c] + i * this._s[c]] = this._foreign
          ? (children[i] as unknown as Props)[KEYS[c]]
          : T[this._slots[i] * COL_STRIDE[c] + COL_OFF[c]];
      }
    }
  }

  commit(fields: number, first = 0, count = this.count - first): void {
    this.check('commit', fields, first, count);
    if (count > 0) this._copy(fields & ALL_FIELDS, first, first + count);
  }
}

/**
 * M2.5 external columns (ARCHITECTURE §19.1): the container's single reused
 * binding. Keeps references to the caller's arrays; `commit` runs the shared
 * copy path over them.
 */
export class ColumnBindingImpl extends Rows implements ColumnBinding {
  fields = 0;

  rebind(columns: SpriteColumns, options?: BindColumnsOptions): void {
    this._live();
    this.unbind();
    const def = options?.stride ?? 1;
    let fields = 0;
    for (let c = 0; c < 9; c++) {
      const src = columns[KEYS[c]];
      if (!src) {
        if (c < C_ROT) this._bad(c);
        continue;
      }
      const view = ArrayBuffer.isView(src);
      const arr = view ? src : src.array;
      const off = view ? 0 : (src.offset ?? 0);
      const stride = view ? def : (src.stride ?? def);
      if (
        !(arr instanceof (c < C_TINT ? Float32Array : Uint32Array)) ||
        !(stride >= 1 && off >= 0) ||
        stride % 1 ||
        off % 1
      ) {
        this._bad(c);
      }
      this._a[c] = arr;
      this._o[c] = off;
      this._s[c] = stride;
      fields |= COL_FIELD[c];
    }
    if (fields & BulkField.FRAME) {
      this._frames = options?.frames ?? this._bad(C_FRAME);
    }
    this.fields = fields;
  }

  commit(count: number, first = 0, fields = this.fields): void {
    this._live();
    if (this.version !== this._host._childrenVersion) this._snapshot();
    this._range('commit', first, count);
    fields &= this.fields;
    if (count === 0 || fields === 0) return;
    const end = first + count;
    // Every bound column must hold row end - 1.
    for (let c = 0; c < 9; c++) {
      const src = this._a[c];
      if (src && this._o[c] + (end - 1) * this._s[c] >= src.length) {
        throw new CozyGPUError(
          'INVALID_ARGUMENT',
          `commit: column ${KEYS[c]} < ${end} rows`,
        );
      }
    }
    if ((fields & BulkField.FRAME) !== 0) this._frameRows(first, end);
    this._copy(fields, first, end);
  }

  unbind(): void {
    this.fields = 0;
    this._a.fill(null);
    this._frames = [];
  }

  private _live(): void {
    if (this._host._destroyed) {
      throw new CozyGPUError('DESTROYED', 'container destroyed');
    }
  }

  private _bad(c: number): never {
    this.unbind();
    throw new CozyGPUError('INVALID_ARGUMENT', `bindColumns: bad ${KEYS[c]}`);
  }
}
