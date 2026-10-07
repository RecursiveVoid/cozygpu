/**
 * `GPU.GraphicsContext` (ARCHITECTURE §26.2): the recorded vector content,
 * shareable between any number of `Graphics` nodes.
 *
 * Recording is synchronous and cheap: each call appends an opcode and its
 * numbers to growable typed arrays and bumps `version`. Classification into
 * SDF shapes and mesh parts, tessellation and upload happen later, in the
 * lazily loaded chunks, and only when a frame draws the context.
 *
 * This module is in every program that imports `Graphics`, so it holds the
 * recorder and nothing else (target: the shell, this file plus Graphics.ts,
 * stays under 2.5 KB min+gzip).
 *
 * Recorded format (named in compileFormat.ts, which the chunks import; this
 * file writes the same numbers as literals, because a value the chunks
 * imported from here would put a shared chunk on the path of every program
 * that imports the library):
 *   - `_o[0 .. _on)`: one opcode per call: 0 transform, 1 moveTo, 2 lineTo,
 *     3 quadratic, 4 bezier, 5 arc, 6 arcTo, 7 closePath, 8 rect,
 *     9 roundRect, 10 ellipse / circle, 11 polygon, 12 fill, 13 stroke,
 *     14 cut, 15 beginPath;
 *   - `_a[0 .. _an)`: each opcode's numbers in call order (counts in
 *     `G_ARGS`; a polygon has n, closed, then n points); an arc stores its
 *     signed sweep, already resolved from end angle and direction;
 *   - opcode 0 (a, b, c, d, tx, ty) is written lazily, right before the first
 *     path call after the transform changed; compile starts from identity;
 *   - fill / stroke carry a resolved style of 16 numbers: packed colour
 *     (alpha included), texture slot in `_tex` (-1: none), global texture
 *     space, has matrix, matrix (6), width, join (0 miter, 1 round,
 *     2 bevel), cap (0 butt, 1 round, 2 square), miter limit, alignment,
 *     pixel line.
 */
import { toPackedColor } from '../math/color';
import type { ColorSource } from '../math/types';
import type { TextureHandle } from '../scene/types';
import type {
  FillStyle,
  GraphicsBounds,
  GraphicsContextApi,
  GraphicsContextOptions,
  GraphicsInfo,
  PolygonPoints,
  StrokeStyle,
} from './types';

/** Default curve tolerance, device px (§26.4). */
export const GRAPHICS_DEFAULT_TOLERANCE = 0.25;

const TAU = Math.PI * 2;
/** Saved state: transform (6) + fill style (16) + stroke style (16). */
const SAVED = 38;
const NONE: StrokeStyle = {};
const JOINS = ['miter', 'round', 'bevel'];
const CAPS = ['butt', 'round', 'square'];

/** Resolves a style into the 16 numbers of `o`; returns its texture or null. */
function resolve(
  o: Float64Array,
  s: ColorSource | StrokeStyle | undefined,
  alpha = 1,
): TextureHandle | null {
  const st = typeof s === 'object' && s !== null ? s : NONE;
  const m = st.matrix;
  o[0] = toPackedColor(
    st === NONE
      ? ((s as ColorSource | undefined) ?? 0xffffff)
      : (st.color ?? 0xffffff),
    alpha * (st.alpha ?? 1),
  );
  o[1] = -1;
  o[2] = st.textureSpace === 'global' ? 1 : 0;
  o[3] = m ? 1 : 0;
  for (let i = 0; i < 6; i++) o[4 + i] = m ? m[i] : 0;
  o[10] = st.width ?? 1;
  o[11] = JOINS.indexOf(st.join!);
  o[12] = CAPS.indexOf(st.cap!);
  o[13] = st.miterLimit ?? 10;
  o[14] = st.alignment ?? 0.5;
  o[15] = st.pixelLine ? 1 : 0;
  return st.texture ?? null;
}

function empty(b: Float64Array): void {
  b[0] = b[1] = Infinity;
  b[2] = b[3] = -Infinity;
}

export class GraphicsContext implements GraphicsContextApi {
  readonly tolerance: number;
  readonly sdf: boolean;
  /** @internal Bumped by every recording call and by clear(). */
  _version = 0;
  /** @internal */
  _destroyed = false;
  /** @internal Opcodes / numbers / textures (see the file header). */
  _o = new Uint8Array(32);
  _on = 0;
  _a = new Float64Array(128);
  _an = 0;
  _tex: TextureHandle[] = [];
  /** @internal Compiled state, owned by the `graphics` chunk. */
  _c: { dispose(): void } | null = null;
  /** @internal Set by the last compile / tessellation (GraphicsInfo). */
  _ns = 0;
  _nv = 0;
  _nt = 0;
  /** Current transform, styles and their textures; `_t` is fill(style) scratch. */
  private _m = new Float64Array([1, 0, 0, 1, 0, 0]);
  private _mDirty = false;
  private _fs = new Float64Array(16);
  private _ss = new Float64Array(16);
  private _t = new Float64Array(16);
  private _ft: TextureHandle | null = null;
  private _st: TextureHandle | null = null;
  private _stack = new Float64Array(SAVED * 4);
  private _sp = 0;
  private _stackTex: (TextureHandle | null)[] = [];
  /** The next path call starts a new path (after a paint, cut or begin). */
  private _fresh = true;
  /** Bounds of everything painted (b) and of the current path (p). */
  private _b = new Float64Array(4);
  private _p = new Float64Array(4);

  constructor(options?: GraphicsContextOptions) {
    this.tolerance = options?.tolerance ?? GRAPHICS_DEFAULT_TOLERANCE;
    this.sdf = options?.sdf ?? true;
    resolve(this._fs, undefined);
    resolve(this._ss, undefined);
    empty(this._b);
    empty(this._p);
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get info(): GraphicsInfo {
    return {
      sdfShapes: this._ns,
      meshVertices: this._nv,
      meshTriangles: this._nt,
      version: this._version,
    };
  }

  get bounds(): GraphicsBounds {
    const b = this._b;
    return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
  }

  // ─── Recording internals ───────────────────────────────────────────────────

  /** Appends opcode `op` with `n` numbers; returns where they go in `_a`. */
  private _rec(op: number, n: number): number {
    // Path calls (1..11) start a new path after a paint and carry the
    // transform when it changed.
    if (op > 0 && op < 12) {
      if (this._fresh) {
        this._fresh = false;
        empty(this._p);
      }
      if (this._mDirty) {
        this._mDirty = false;
        this._a.set(this._m, this._rec(0, 6));
      }
    }
    if (this._on === this._o.length) {
      const o = new Uint8Array(this._on * 2);
      o.set(this._o);
      this._o = o;
    }
    const at = this._an;
    if (at + n > this._a.length) {
      const a = new Float64Array(Math.max(this._a.length * 2, at + n));
      a.set(this._a);
      this._a = a;
    }
    this._o[this._on++] = op;
    this._an = at + n;
    this._version++;
    return at;
  }

  /** Writes `x, y` at `_a[at]` and grows the path bounds by M·(x, y) ± r. */
  private _pt(at: number, x: number, y: number, r = 0): void {
    const m = this._m;
    const p = this._p;
    this._a[at] = x;
    this._a[at + 1] = y;
    const X = m[0] * x + m[2] * y + m[4];
    const Y = m[1] * x + m[3] * y + m[5];
    // A circle of radius r through the transform.
    const rx = r * Math.hypot(m[0], m[2]);
    const ry = r * Math.hypot(m[1], m[3]);
    p[0] = Math.min(p[0], X - rx);
    p[1] = Math.min(p[1], Y - ry);
    p[2] = Math.max(p[2], X + rx);
    p[3] = Math.max(p[3], Y + ry);
  }

  private _xy(op: number, x: number, y: number): this {
    this._pt(this._rec(op, 2), x, y);
    return this;
  }

  /** Records fill (12) / stroke (13) with `style`, and grows the bounds. */
  private _paint(
    op: number,
    style: Float64Array,
    t: TextureHandle | null,
  ): this {
    const at = this._rec(op, 16);
    const a = this._a;
    a.set(style, at);
    if (t) {
      a[at + 1] = this._tex.length;
      this._tex.push(t);
    }
    // A stroke reaches past the path by its outer band.
    const w = op === 13 ? style[10] * Math.max(style[14], 1 - style[14]) : 0;
    const p = this._p;
    const b = this._b;
    b[0] = Math.min(b[0], p[0] - w);
    b[1] = Math.min(b[1], p[1] - w);
    b[2] = Math.max(b[2], p[2] + w);
    b[3] = Math.max(b[3], p[3] + w);
    this._fresh = true;
    return this;
  }

  /** rect (8) / roundRect (9): x, y, w, h; bounds from all four corners. */
  private _box(
    op: number,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): this {
    const at = this._rec(op, op === 9 ? 5 : 4);
    this._pt(at, x + w, y);
    this._pt(at, x, y + h);
    this._pt(at, x + w, y + h);
    this._pt(at, x, y);
    this._a[at + 2] = w;
    this._a[at + 3] = h;
    this._a[at + 4] = r;
    return this;
  }

  // ─── Shapes ────────────────────────────────────────────────────────────────

  rect(x: number, y: number, w: number, h: number): this {
    return this._box(8, x, y, w, h, 0);
  }

  roundRect(x: number, y: number, w: number, h: number, radius = 20): this {
    return this._box(9, x, y, w, h, radius);
  }

  circle(x: number, y: number, radius: number): this {
    return this.ellipse(x, y, radius, radius);
  }

  ellipse(x: number, y: number, rx: number, ry: number): this {
    const at = this._rec(10, 4);
    this._pt(at, x, y, Math.max(Math.abs(rx), Math.abs(ry)));
    this._a[at + 2] = rx;
    this._a[at + 3] = ry;
    return this;
  }

  poly(points: PolygonPoints, close = true): this {
    const flat = typeof points[0] === 'number';
    const n = flat ? points.length >> 1 : points.length;
    const at = this._rec(11, 2 + 2 * n);
    this._a[at] = n;
    this._a[at + 1] = close ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const p = (points as readonly { x: number; y: number }[])[i];
      const f = points as ArrayLike<number>;
      this._pt(
        at + 2 + 2 * i,
        flat ? f[2 * i] : p.x,
        flat ? f[2 * i + 1] : p.y,
      );
    }
    return this;
  }

  regularPoly(
    x: number,
    y: number,
    radius: number,
    sides: number,
    rotation = 0,
  ): this {
    return this._star(x, y, Math.max(sides | 0, 3), radius, radius, rotation);
  }

  star(
    x: number,
    y: number,
    points: number,
    radius: number,
    innerRadius = radius / 2,
    rotation = 0,
  ): this {
    return this._star(
      x,
      y,
      2 * Math.max(points | 0, 2),
      radius,
      innerRadius,
      rotation,
    );
  }

  /** Polygon of n corners alternating radius r0 / r1, the first one up. */
  private _star(
    x: number,
    y: number,
    n: number,
    r0: number,
    r1: number,
    rotation: number,
  ): this {
    const at = this._rec(11, 2 + 2 * n);
    this._a[at] = n;
    this._a[at + 1] = 1;
    for (let i = 0; i < n; i++) {
      const r = i % 2 ? r1 : r0;
      const t = (i * TAU) / n - Math.PI / 2 + rotation;
      this._pt(at + 2 + 2 * i, x + r * Math.cos(t), y + r * Math.sin(t));
    }
    return this;
  }

  // ─── Paths ─────────────────────────────────────────────────────────────────

  moveTo(x: number, y: number): this {
    return this._xy(1, x, y);
  }

  lineTo(x: number, y: number): this {
    return this._xy(2, x, y);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): this {
    const at = this._rec(3, 4);
    this._pt(at, cpx, cpy);
    this._pt(at + 2, x, y);
    return this;
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): this {
    const at = this._rec(4, 6);
    this._pt(at, cp1x, cp1y);
    this._pt(at + 2, cp2x, cp2y);
    this._pt(at + 4, x, y);
    return this;
  }

  arc(
    x: number,
    y: number,
    radius: number,
    start: number,
    end: number,
    ccw = false,
  ): this {
    // Canvas rules: a sweep of at least a full turn draws the full circle.
    let sweep = end - start;
    if (ccw) {
      sweep = sweep <= -TAU ? -TAU : sweep % TAU;
      if (sweep > 0) sweep -= TAU;
    } else {
      sweep = sweep >= TAU ? TAU : sweep % TAU;
      if (sweep < 0) sweep += TAU;
    }
    const at = this._rec(5, 5);
    this._pt(at, x, y, radius);
    this._a[at + 2] = radius;
    this._a[at + 3] = start;
    this._a[at + 4] = sweep;
    return this;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): this {
    const at = this._rec(6, 5);
    this._pt(at, x1, y1);
    this._pt(at + 2, x2, y2);
    this._a[at + 4] = r;
    return this;
  }

  closePath(): this {
    this._rec(7, 0);
    return this;
  }

  beginPath(): this {
    this._rec(15, 0);
    this._fresh = true;
    empty(this._p);
    return this;
  }

  // ─── Paint ─────────────────────────────────────────────────────────────────

  fill(style?: ColorSource | FillStyle, alpha?: number): this {
    return style === undefined
      ? this._paint(12, this._fs, this._ft)
      : this._paint(12, this._t, resolve(this._t, style, alpha));
  }

  stroke(style?: ColorSource | StrokeStyle): this {
    return style === undefined
      ? this._paint(13, this._ss, this._st)
      : this._paint(13, this._t, resolve(this._t, style));
  }

  cut(): this {
    this._rec(14, 0);
    this._fresh = true;
    // The cut path is no longer current: a paint after it draws nothing.
    empty(this._p);
    return this;
  }

  setFillStyle(style: ColorSource | FillStyle): this {
    this._ft = resolve(this._fs, style);
    this._version++;
    return this;
  }

  setStrokeStyle(style: ColorSource | StrokeStyle): this {
    this._st = resolve(this._ss, style);
    this._version++;
    return this;
  }

  // ─── Transform ─────────────────────────────────────────────────────────────

  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
  ): this {
    const m = this._m;
    m[0] = a;
    m[1] = b;
    m[2] = c;
    m[3] = d;
    m[4] = tx;
    m[5] = ty;
    this._mDirty = true;
    this._version++;
    return this;
  }

  resetTransform(): this {
    return this.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Canvas order: current transform × translate. */
  translate(x: number, y: number): this {
    return this._mul(1, 0, 0, 1, x, y);
  }

  rotate(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return this._mul(c, s, -s, c, 0, 0);
  }

  scale(x: number, y = x): this {
    return this._mul(x, 0, 0, y, 0, 0);
  }

  /** transform = transform × (a, b, c, d, tx, ty). */
  private _mul(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
  ): this {
    const m = this._m;
    return this.setTransform(
      m[0] * a + m[2] * b,
      m[1] * a + m[3] * b,
      m[0] * c + m[2] * d,
      m[1] * c + m[3] * d,
      m[0] * tx + m[2] * ty + m[4],
      m[1] * tx + m[3] * ty + m[5],
    );
  }

  save(): this {
    if (this._sp === this._stack.length) {
      const s = new Float64Array(this._sp * 2);
      s.set(this._stack);
      this._stack = s;
    }
    const s = this._stack;
    s.set(this._m, this._sp);
    s.set(this._fs, this._sp + 6);
    s.set(this._ss, this._sp + 22);
    this._sp += SAVED;
    this._stackTex.push(this._ft, this._st);
    return this;
  }

  restore(): this {
    if (this._sp === 0) return this;
    const s = this._stack;
    const at = (this._sp -= SAVED);
    for (let i = 0; i < 16; i++) {
      this._fs[i] = s[at + 6 + i];
      this._ss[i] = s[at + 22 + i];
    }
    this._st = this._stackTex.pop()!;
    this._ft = this._stackTex.pop()!;
    return this.setTransform(
      s[at],
      s[at + 1],
      s[at + 2],
      s[at + 3],
      s[at + 4],
      s[at + 5],
    );
  }

  // ─── Lifetime ──────────────────────────────────────────────────────────────

  clear(): this {
    this._on = this._an = this._tex.length = 0;
    this._fresh = true;
    // The transform stays; compile starts from identity, so re-record it.
    this._mDirty = true;
    empty(this._b);
    empty(this._p);
    this._version++;
    return this;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.clear();
    this._c?.dispose();
    this._c = null;
  }
}
