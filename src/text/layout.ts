/**
 * Text layout (ARCHITECTURE §23.4): shaping a string into
 * positioned glyph quads — line breaking (word / char / none), alignment,
 * baseline, letter and word spacing, kerning, ellipsis and `maxLines` — and
 * writing them into the Text's glyph sprites.
 *
 * Layout runs on the FRONT in both renderer modes and uses no DOM, so worker
 * mode needs nothing extra.
 *
 * Partial updates. Shaping is a forward pass over typed arrays that the node
 * keeps and grows, so it never allocates for a string it has already sized
 * for. The result is then written into the glyph sprites through a
 * compare-then-write pass: a sprite whose texture, position, scale or tint is
 * already correct is not touched and not marked dirty, so a counter that
 * changes its last two digits rewrites two sprite instances and moves no
 * batch boundary, whatever the alignment. The glyph child list only grows or
 * shrinks at the tail.
 */
import { Sprite } from '../scene/Sprite';
import { Dirty, markDirty, nodeStore } from '../scene/store';
import type { TextureHandle } from '../scene/types';
import type { GlyphSource, TextMetrics, TextNode, TextStyle } from './types';

/** Code points that never produce a quad. */
const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const ELLIPSIS = 0x2026;

/** Tab advance, in space widths. */
const TAB_SPACES = 4;

/**
 * @internal The layout pass writes into the Text node itself. Only
 * `src/text/Text.ts` implements this; the fields are the node's own storage,
 * kept here so the shell stays small.
 */
export interface TextLayoutHost extends TextNode {
  _text: string;
  _style: TextStyle;
  /** The glyph children, in reading order. Owned by this module. */
  _glyphs: Sprite[];
  /** Reused shaping buffers, grown to the longest string seen. */
  _buffers: LayoutBuffers | null;
}

/** @internal Reused, grown in place; never reallocated for a shorter string. */
export interface LayoutBuffers {
  codes: Int32Array;
  /** Advance of code i (glyph advance + letter/word spacing). */
  adv: Float32Array;
  /** Kerning between code i-1 and i; 0 at index 0. */
  kern: Float32Array;
  /** Prefix sums of adv + kern, length codes.length + 1. */
  cum: Float32Array;
  lineStart: Int32Array;
  lineEnd: Int32Array;
  lineWidth: Float32Array;
  lineSpaces: Int32Array;
  /** 1 when the line was broken by wrapping rather than by \n or the end. */
  lineSoft: Uint8Array;
}

const EMPTY: TextMetrics = {
  width: 0,
  height: 0,
  lines: 0,
  firstBaseline: 0,
  glyphs: 0,
};

function buffers(host: TextLayoutHost, n: number): LayoutBuffers {
  let b = host._buffers;
  const want = Math.max(n, 16);
  if (b === null || b.codes.length < want) {
    const size = b === null ? want : Math.max(want, b.codes.length * 2);
    b = {
      codes: new Int32Array(size),
      adv: new Float32Array(size),
      kern: new Float32Array(size),
      cum: new Float32Array(size + 1),
      lineStart: new Int32Array(size + 1),
      lineEnd: new Int32Array(size + 1),
      lineWidth: new Float32Array(size + 1),
      lineSpaces: new Int32Array(size + 1),
      lineSoft: new Uint8Array(size + 1),
    };
    host._buffers = b;
  }
  return b;
}

/** UTF-16 → code points. `out` must hold `text.length` entries. */
function decode(text: string, out: Int32Array): number {
  let n = 0;
  for (let i = 0; i < text.length; ) {
    const c = text.codePointAt(i) as number;
    out[n++] = c;
    i += c > 0xffff ? 2 : 1;
  }
  return n;
}

/** 0xRRGGBB from a ColorSource; string colors are parsed once per layout. */
function tintOf(fill: number | string | undefined): number {
  if (fill === undefined) return 0xffffff;
  if (typeof fill === 'number') return fill & 0xffffff;
  let hex = fill.trim();
  if (hex.charCodeAt(0) === 35) hex = hex.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    let long = '';
    for (let i = 0; i < 3; i++) long += hex[i] + hex[i];
    hex = long;
  }
  const v = parseInt(hex.slice(0, 6), 16);
  return Number.isFinite(v) ? v & 0xffffff : 0xffffff;
}

/** Writes one glyph quad into glyph sprite `index`, touching only what changed. */
function place(
  host: TextLayoutHost,
  index: number,
  texture: TextureHandle,
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  tint: number,
  flags: number,
): void {
  const list = host._glyphs;
  let sprite = list[index];
  if (sprite === undefined) {
    // A fresh slot already has anchor 0, scale 1 and tint white.
    sprite = new Sprite(texture);
    list.push(sprite);
    host.addChild(sprite);
  } else if (sprite.texture !== texture) {
    sprite.texture = texture;
  }
  if (sprite.x !== x) sprite.x = x;
  if (sprite.y !== y) sprite.y = y;
  if (sprite.scaleX !== scaleX) sprite.scaleX = scaleX;
  if (sprite.scaleY !== scaleY) sprite.scaleY = scaleY;
  if (sprite.tint !== tint) sprite.tint = tint;
  // Instance flag bits (MSDF for a distance-field page). The pick id lives in
  // the upper bits of the same word and is left alone.
  const slot = sprite._slot;
  const words = nodeStore.flags;
  const next = (words[slot] & ~0xff) | flags;
  if (words[slot] !== next) {
    words[slot] = next;
    markDirty(slot, Dirty.SPRITE);
  }
  const user = host.userId;
  if (nodeStore.userId[slot] !== user) nodeStore.userId[slot] = user;
}

/** Drops glyph sprites beyond `count` (the list only shrinks at the tail). */
function trim(host: TextLayoutHost, count: number): void {
  const list = host._glyphs;
  for (let i = list.length - 1; i >= count; i--) {
    const sprite = list[i];
    list.pop();
    sprite.destroy();
  }
}

export function layoutText(text: TextNode, source: GlyphSource): TextMetrics {
  const host = text as TextLayoutHost;
  const style = host._style;
  const font = source.font;
  const size = style.size ?? font.size;
  const scale = font.size > 0 ? size / font.size : 1;
  const value = host._text;
  if (value.length === 0) {
    trim(host, 0);
    return EMPTY;
  }

  const b = buffers(host, value.length);
  const codes = b.codes;
  const n = decode(value, codes);

  const letter = style.letterSpacing ?? 0;
  const word = style.wordSpacing ?? 0;
  const maxWidth = style.maxWidth ?? 0;
  const wrap = style.wrap ?? 'word';
  const align = style.align ?? 'left';
  const maxLines = style.maxLines ?? 0;
  const snap = style.pixelSnap ?? font.kind === 'canvas';
  const lineStep = font.lineHeight * (style.lineHeight ?? 1) * scale;
  const spaceAdvance =
    (source.glyph(SPACE)?.advance ?? font.size * 0.25) * scale;
  const tint = tintOf(style.fill);
  const flags = source.instanceFlags;

  // ── Advances and kerning (one pass, then prefix sums) ──────────────────────
  const adv = b.adv;
  const kern = b.kern;
  const cum = b.cum;
  cum[0] = 0;
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    let a: number;
    if (code === LF || code === CR) {
      a = 0;
    } else if (code === TAB) {
      a = spaceAdvance * TAB_SPACES + letter;
    } else {
      const g = source.glyph(code);
      a = (g === undefined ? 0 : g.advance * scale) + letter;
      if (code === SPACE) a += word;
    }
    adv[i] = a;
    const prev = i > 0 ? codes[i - 1] : 0;
    kern[i] =
      i > 0 && prev !== LF && code !== LF
        ? font.kerning(prev, code) * scale
        : 0;
    cum[i + 1] = cum[i] + a + kern[i];
  }

  // ── Line breaking ─────────────────────────────────────────────────────────
  const lineStart = b.lineStart;
  const lineEnd = b.lineEnd;
  const lineWidth = b.lineWidth;
  const lineSpaces = b.lineSpaces;
  const lineSoft = b.lineSoft;
  const wrapping = wrap !== 'none' && maxWidth > 0;
  let lines = 0;
  let start = 0;
  let truncated = false;
  while (start < n) {
    if (maxLines > 0 && lines === maxLines) {
      truncated = true;
      break;
    }
    let end = n;
    let soft = 0;
    let lastSpace = -1;
    for (let i = start; i < n; i++) {
      const code = codes[i];
      if (code === LF) {
        end = i;
        break;
      }
      if (
        wrapping &&
        i > start &&
        cum[i + 1] - cum[start] - kern[start] - letter > maxWidth
      ) {
        end = wrap === 'word' && lastSpace > start ? lastSpace : i;
        soft = 1;
        break;
      }
      if (code === SPACE || code === TAB) lastSpace = i;
    }
    // Trailing whitespace never counts towards the line's width.
    let visible = end;
    while (visible > start) {
      const code = codes[visible - 1];
      if (code !== SPACE && code !== TAB && code !== CR) break;
      visible--;
    }
    let spaces = 0;
    for (let i = start; i < visible; i++) if (codes[i] === SPACE) spaces++;
    lineStart[lines] = start;
    lineEnd[lines] = visible;
    // `adv` carries letterSpacing after EVERY glyph, including the line's
    // last one, where nothing follows it: that gap is not part of the line.
    lineWidth[lines] =
      visible > start ? cum[visible] - cum[start] - kern[start] - letter : 0;
    lineSpaces[lines] = spaces;
    lineSoft[lines] = soft;
    lines++;
    // Next line: skip the break itself and the whitespace it left behind.
    let next = end;
    if (soft === 0 && next < n && codes[next] === LF) next++;
    else
      while (next < n && (codes[next] === SPACE || codes[next] === TAB)) next++;
    if (next === start) next = start + 1; // never stall on an unbreakable glyph
    start = next;
  }
  if (start < n) truncated = true;

  // ── Ellipsis on the last line ─────────────────────────────────────────────
  const wantEllipsis = !!style.ellipsis && truncated && lines > 0;
  let ellipsisWidth = 0;
  if (wantEllipsis) {
    const g = source.glyph(ELLIPSIS);
    ellipsisWidth =
      (g === undefined ? spaceAdvance : g.advance * scale) + letter;
    const last = lines - 1;
    const s = lineStart[last];
    let e = lineEnd[last];
    if (maxWidth > 0) {
      while (
        e > s &&
        cum[e] - cum[s] - kern[s] + ellipsisWidth - letter > maxWidth
      ) {
        e--;
      }
    }
    lineEnd[last] = e;
    // The ellipsis is the last glyph of the line, so its own trailing
    // letterSpacing goes the same way as any other line's.
    lineWidth[last] =
      (e > s ? cum[e] - cum[s] - kern[s] : 0) + ellipsisWidth - letter;
    lineSpaces[last] = 0;
    lineSoft[last] = 0;
  }

  // ── Block box ─────────────────────────────────────────────────────────────
  let contentWidth = 0;
  for (let i = 0; i < lines; i++) {
    if (lineWidth[i] > contentWidth) contentWidth = lineWidth[i];
  }
  const blockWidth = maxWidth > 0 ? maxWidth : contentWidth;
  const ascender = font.ascender * scale;
  const descender = font.descender * scale;
  const height = (lines - 1) * lineStep + (ascender - descender);
  const baseline = style.baseline ?? 'top';
  let originY = 0;
  if (baseline === 'middle') originY = -height / 2;
  else if (baseline === 'bottom') originY = -height;
  else if (baseline === 'alphabetic') originY = -ascender;
  const firstBaseline = originY + ascender;

  // ── Emit quads ────────────────────────────────────────────────────────────
  let emitted = 0;
  for (let line = 0; line < lines; line++) {
    const s = lineStart[line];
    const e = lineEnd[line];
    const width = lineWidth[line];
    let pen = 0;
    let extraPerSpace = 0;
    if (align === 'center') pen = (blockWidth - width) / 2;
    else if (align === 'right') pen = blockWidth - width;
    else if (
      align === 'justify' &&
      lineSoft[line] === 1 &&
      lineSpaces[line] > 0
    ) {
      extraPerSpace = (blockWidth - width) / lineSpaces[line];
    }
    const baseY = firstBaseline + line * lineStep;
    for (let i = s; i < e; i++) {
      const code = codes[i];
      if (i > s) pen += kern[i];
      const g = source.glyph(code);
      const texture = g === undefined ? null : g.texture;
      if (texture !== null && g !== undefined && g.width > 0) {
        let x = pen + g.offsetX * scale;
        let y = baseY + g.offsetY * scale;
        if (snap) {
          x = Math.round(x);
          y = Math.round(y);
        }
        place(
          host,
          emitted++,
          texture,
          x,
          y,
          (g.width * scale) / texture.width,
          (g.height * scale) / texture.height,
          tint,
          flags,
        );
      }
      pen += adv[i];
      if (code === SPACE) pen += extraPerSpace;
    }
    if (wantEllipsis && line === lines - 1) {
      const g = source.glyph(ELLIPSIS);
      if (g !== undefined && g.texture !== null && g.width > 0) {
        let x = pen + g.offsetX * scale;
        let y = baseY + g.offsetY * scale;
        if (snap) {
          x = Math.round(x);
          y = Math.round(y);
        }
        place(
          host,
          emitted++,
          g.texture,
          x,
          y,
          (g.width * scale) / g.texture.width,
          (g.height * scale) / g.texture.height,
          tint,
          flags,
        );
      }
    }
  }
  trim(host, emitted);

  return {
    width: contentWidth,
    height,
    lines,
    firstBaseline,
    glyphs: emitted,
  };
}
