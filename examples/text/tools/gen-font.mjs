/**
 * Generates the small distance-field font this repository ships for the text
 * example and the text unit tests:
 *
 *   node examples/text/tools/gen-font.mjs
 *   → examples/text/font/cozy.json  (msdf-atlas-gen layout)
 *   → examples/text/font/cozy.png   (the atlas page)
 *
 * The font is a monospaced stroke design: every glyph is a set of polylines
 * on a 10 × 12 unit grid, so the exact signed distance to the stroke is a
 * closed-form min over segments. Writing that distance into R, G and B makes
 * `median(r, g, b)` equal to it, which is what the sprite shader's MSDF
 * branch samples — a plain SDF is the degenerate multi-channel field, and
 * round stroke joins lose nothing to the missing corner channels.
 *
 * Nothing here runs at build time or ships in the library; it exists so the
 * committed atlas can be regenerated and reviewed.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Geometry ────────────────────────────────────────────────────────────────

/** px per grid unit. */
const UNIT = 2;
/** em size in px: the size every metric below is expressed at. */
const SIZE = 32;
/** Stroke half width, px. */
const RADIUS = 1.6;
/** Distance field range, px (the shader reads it back through fwidth). */
const RANGE = 4;
/** Pen advance, px (monospace). */
const ADVANCE = 20;

/** Glyph cell, px, as an offset box around the pen at the baseline. */
const BOX_LEFT = -4;
const BOX_RIGHT = 24;
/** y up from the baseline. */
const BOX_TOP = 30;
const BOX_BOTTOM = -14;
const CELL_W = BOX_RIGHT - BOX_LEFT;
const CELL_H = BOX_TOP - BOX_BOTTOM;
const COLUMNS = 10;

const ASCENDER = 24;
const DESCENDER = -7;
const LINE_HEIGHT = 40;

/**
 * Polylines per code point, in grid units (x right, y up from the baseline).
 * An empty list is a blank glyph with an advance (space).
 */
const GLYPHS = {
  ' ': [],
  '!': [[5, 11, 5, 3], [5, 1, 5, 0.8]],
  '"': [[3.5, 11, 3.5, 8.5], [6.5, 11, 6.5, 8.5]],
  '#': [
    [3, 11, 2, 0],
    [7, 11, 6, 0],
    [1, 7.5, 8.5, 7.5],
    [0.5, 3.5, 8, 3.5],
  ],
  $: [
    [8, 9.5, 6.5, 11, 3.5, 11, 2, 9.5, 2, 8, 3, 7, 7, 6, 8, 5, 8, 3, 6.5, 1.5,
      3.5, 1.5, 2, 3],
    [5, 12, 5, -1],
  ],
  '%': [
    [2, 11, 8, 0],
    [2, 11, 3.5, 11, 3.5, 9, 2, 9, 2, 11],
    [6.5, 2, 8, 2, 8, 0, 6.5, 0, 6.5, 2],
  ],
  '&': [
    [9, 0, 3, 6, 2, 8, 2.5, 10, 4.5, 11, 6.5, 10, 6.5, 8, 1.5, 4, 1.5, 1.5, 3,
      0, 5.5, 0, 8, 2.5],
  ],
  "'": [[5, 11, 5, 8.5]],
  '(': [[6.5, 12, 4, 8.5, 4, 2.5, 6.5, -1]],
  ')': [[3.5, 12, 6, 8.5, 6, 2.5, 3.5, -1]],
  '*': [
    [5, 9.5, 5, 4.5],
    [2.8, 8.2, 7.2, 5.8],
    [7.2, 8.2, 2.8, 5.8],
  ],
  '+': [
    [5, 9, 5, 2],
    [1.5, 5.5, 8.5, 5.5],
  ],
  ',': [[5.5, 1, 4, -1.5]],
  '-': [[1.5, 5.5, 8.5, 5.5]],
  '.': [[5, 0.6, 5, 0.4]],
  '/': [[1.5, -1, 8.5, 12]],
  0: [
    [3.5, 0, 2, 2, 2, 9, 3.5, 11, 6.5, 11, 8, 9, 8, 2, 6.5, 0, 3.5, 0],
    [3, 2.5, 7, 8.5],
  ],
  1: [
    [3, 9, 5, 11, 5, 0],
    [3, 0, 7, 0],
  ],
  2: [[2, 9.5, 3.5, 11, 6.5, 11, 8, 9.5, 8, 7.5, 2, 0, 8.5, 0]],
  3: [[2, 11, 8, 11, 5, 7, 7.5, 7, 8.5, 5.5, 8.5, 2, 7, 0, 3.5, 0, 2, 1.5]],
  4: [[7, 0, 7, 11, 1.5, 3.5, 9, 3.5]],
  5: [
    [8, 11, 2.5, 11, 2, 6, 3.5, 7, 6.5, 7, 8.5, 5.5, 8.5, 2.5, 7, 0, 3.5, 0, 2,
      1.5],
  ],
  6: [
    [8, 10, 6, 11, 4, 11, 2, 9, 1.8, 4, 3.5, 6.5, 6.5, 6.5, 8.2, 5, 8, 2, 6.5,
      0, 4, 0, 2, 2],
  ],
  7: [[2, 11, 8.5, 11, 4.5, 0]],
  8: [
    [3.5, 11, 6.5, 11, 8, 9.5, 8, 8, 6.5, 6.5, 3.5, 6.5, 2, 8, 2, 9.5, 3.5, 11],
    [3.5, 6.5, 2, 5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5, 8, 5, 6.5, 6.5],
  ],
  9: [
    [2, 1, 4, 0, 6, 0, 8, 2, 8.2, 7, 6.5, 4.5, 3.5, 4.5, 1.8, 6, 2, 9, 3.5, 11,
      6, 11, 8, 9],
  ],
  ':': [
    [5, 7, 5, 6.8],
    [5, 0.6, 5, 0.4],
  ],
  ';': [
    [5, 7, 5, 6.8],
    [5.5, 1, 4, -1.5],
  ],
  '<': [[8, 10, 2, 5.5, 8, 1]],
  '=': [
    [1.5, 7, 8.5, 7],
    [1.5, 4, 8.5, 4],
  ],
  '>': [[2, 10, 8, 5.5, 2, 1]],
  '?': [
    [2, 9.5, 3.5, 11, 6.5, 11, 8, 9.5, 8, 7.5, 5, 5.5, 5, 3],
    [5, 0.6, 5, 0.4],
  ],
  '@': [
    [7, 4, 6, 5.5, 4, 5.5, 3, 4, 3.5, 2.5, 5.5, 2.5, 6.5, 4, 6.5, 7, 9, 6.5, 9,
      3, 7, 0.5, 4, 0, 2, 1.5, 1.5, 4, 2, 8, 4.5, 11, 7.5, 11, 9, 9.5],
  ],
  A: [
    [1, 0, 5, 11, 9, 0],
    [2.5, 4, 7.5, 4],
  ],
  B: [
    [2, 0, 2, 11, 6.5, 11, 8, 9.5, 8, 7, 6.5, 5.5, 2, 5.5],
    [6.5, 5.5, 8.2, 4, 8.2, 1.5, 6.5, 0, 2, 0],
  ],
  C: [[8.5, 9.5, 6.5, 11, 4, 11, 2, 9, 2, 2, 4, 0, 6.5, 0, 8.5, 1.5]],
  D: [[2, 0, 2, 11, 6, 11, 8.2, 9, 8.2, 2, 6, 0, 2, 0]],
  E: [
    [8.5, 11, 2, 11, 2, 0, 8.5, 0],
    [2, 5.5, 7, 5.5],
  ],
  F: [
    [8.5, 11, 2, 11, 2, 0],
    [2, 5.5, 7, 5.5],
  ],
  G: [
    [8.5, 9.5, 6.5, 11, 4, 11, 2, 9, 2, 2, 4, 0, 6.5, 0, 8.5, 1.5, 8.5, 4.5, 6,
      4.5],
  ],
  H: [
    [2, 11, 2, 0],
    [8, 11, 8, 0],
    [2, 5.5, 8, 5.5],
  ],
  I: [
    [5, 11, 5, 0],
    [3, 11, 7, 11],
    [3, 0, 7, 0],
  ],
  J: [[7.5, 11, 7.5, 2.5, 6, 0, 3.5, 0, 2, 2]],
  K: [
    [2, 11, 2, 0],
    [8.2, 11, 2, 5],
    [4, 6.8, 8.5, 0],
  ],
  L: [[2, 11, 2, 0, 8.2, 0]],
  M: [[2, 0, 2, 11, 5, 5, 8, 11, 8, 0]],
  N: [[2, 0, 2, 11, 8, 0, 8, 11]],
  O: [[3.8, 11, 6.2, 11, 8.2, 9, 8.2, 2, 6.2, 0, 3.8, 0, 1.8, 2, 1.8, 9, 3.8, 11]],
  P: [[2, 0, 2, 11, 6.5, 11, 8.2, 9.5, 8.2, 6.5, 6.5, 5, 2, 5]],
  Q: [
    [3.8, 11, 6.2, 11, 8.2, 9, 8.2, 2, 6.2, 0, 3.8, 0, 1.8, 2, 1.8, 9, 3.8, 11],
    [6, 3, 8.8, -1],
  ],
  R: [
    [2, 0, 2, 11, 6.5, 11, 8.2, 9.5, 8.2, 6.5, 6.5, 5, 2, 5],
    [5.5, 5, 8.5, 0],
  ],
  S: [
    [8.2, 9.5, 6.5, 11, 3.5, 11, 2, 9.5, 2, 7.5, 3.2, 6.3, 6.8, 5.3, 8, 4, 8,
      1.8, 6.5, 0, 3.5, 0, 1.8, 1.5],
  ],
  T: [
    [1.5, 11, 8.5, 11],
    [5, 11, 5, 0],
  ],
  U: [[2, 11, 2, 2, 4, 0, 6, 0, 8, 2, 8, 11]],
  V: [[1.5, 11, 5, 0, 8.5, 11]],
  W: [[1.2, 11, 3, 0, 5, 7, 7, 0, 8.8, 11]],
  X: [
    [2, 11, 8, 0],
    [8, 11, 2, 0],
  ],
  Y: [
    [1.8, 11, 5, 5.5, 8.2, 11],
    [5, 5.5, 5, 0],
  ],
  Z: [[2, 11, 8.2, 11, 2, 0, 8.2, 0]],
  '[': [[6.5, 12, 4, 12, 4, -1, 6.5, -1]],
  '\\': [[1.5, 12, 8.5, -1]],
  ']': [[3.5, 12, 6, 12, 6, -1, 3.5, -1]],
  '^': [[2, 8, 5, 11, 8, 8]],
  _: [[1.5, -1.5, 8.5, -1.5]],
  '`': [[3.5, 11.5, 5.5, 9.5]],
  a: [
    [8, 7, 8, 0],
    [8, 5.5, 6.5, 7, 3.5, 7, 2, 5.5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5],
  ],
  b: [
    [2, 11, 2, 0],
    [2, 5.5, 3.5, 7, 6.5, 7, 8, 5.5, 8, 1.5, 6.5, 0, 3.5, 0, 2, 1.5],
  ],
  c: [[8, 5.5, 6.5, 7, 3.5, 7, 2, 5.5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5]],
  d: [
    [8, 11, 8, 0],
    [8, 5.5, 6.5, 7, 3.5, 7, 2, 5.5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5],
  ],
  e: [[2, 3.5, 8, 3.5, 8, 5.5, 6.5, 7, 3.5, 7, 2, 5.5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.2]],
  f: [
    [7, 11.5, 5.5, 11.5, 4.5, 10.5, 4.5, 0],
    [2.5, 7, 7, 7],
  ],
  g: [
    [8, 7, 8, -2, 6.5, -3.5, 3.5, -3.5, 2.2, -2.5],
    [8, 5.5, 6.5, 7, 3.5, 7, 2, 5.5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5],
  ],
  h: [
    [2, 11, 2, 0],
    [2, 5.5, 3.5, 7, 6.5, 7, 8, 5.5, 8, 0],
  ],
  i: [
    [5, 7, 5, 0],
    [5, 9.6, 5, 9.4],
  ],
  j: [
    [6, 7, 6, -2, 4.5, -3.5, 2.5, -3.5],
    [6, 9.6, 6, 9.4],
  ],
  k: [
    [2, 11, 2, 0],
    [7.8, 7, 2.5, 2.5],
    [4.5, 4.2, 8, 0],
  ],
  l: [[4.5, 11, 4.5, 1.2, 5.5, 0]],
  m: [
    [2, 7, 2, 0],
    [2, 5.8, 3, 7, 4.3, 7, 5, 5.8, 5, 0],
    [5, 5.8, 6, 7, 7.3, 7, 8, 5.8, 8, 0],
  ],
  n: [
    [2, 7, 2, 0],
    [2, 5.5, 3.5, 7, 6.5, 7, 8, 5.5, 8, 0],
  ],
  o: [[3.5, 7, 6.5, 7, 8, 5.5, 8, 1.5, 6.5, 0, 3.5, 0, 2, 1.5, 2, 5.5, 3.5, 7]],
  p: [
    [2, 7, 2, -3.5],
    [2, 5.5, 3.5, 7, 6.5, 7, 8, 5.5, 8, 1.5, 6.5, 0, 3.5, 0, 2, 1.5],
  ],
  q: [
    [8, 7, 8, -3.5],
    [8, 5.5, 6.5, 7, 3.5, 7, 2, 5.5, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5],
  ],
  r: [
    [2.5, 7, 2.5, 0],
    [2.5, 4.5, 4, 6.5, 6, 7, 7.5, 7],
  ],
  s: [
    [8, 6, 6.5, 7, 3.5, 7, 2.2, 6, 2.2, 4.6, 3.5, 4, 6.5, 3, 7.8, 2.4, 7.8, 1,
      6.5, 0, 3.5, 0, 2, 1],
  ],
  t: [
    [4.5, 11, 4.5, 1.2, 5.5, 0, 7, 0],
    [2.5, 7, 7, 7],
  ],
  u: [
    [2, 7, 2, 1.5, 3.5, 0, 6.5, 0, 8, 1.5],
    [8, 7, 8, 0],
  ],
  v: [[2, 7, 5, 0, 8, 7]],
  w: [[1.6, 7, 3, 0, 5, 4.5, 7, 0, 8.4, 7]],
  x: [
    [2, 7, 8, 0],
    [8, 7, 2, 0],
  ],
  y: [
    [2, 7, 5, 0],
    [8, 7, 4, -3.5, 2.5, -3.5],
  ],
  z: [
    [2, 7, 8, 7, 2, 0, 8, 0],
  ],
  '{': [[6.8, 12, 5.2, 11, 5.2, 7, 3.5, 5.5, 5.2, 4, 5.2, 0, 6.8, -1]],
  '|': [[5, 12, 5, -1]],
  '}': [[3.2, 12, 4.8, 11, 4.8, 7, 6.5, 5.5, 4.8, 4, 4.8, 0, 3.2, -1]],
  '~': [[1.8, 5, 3.3, 6.5, 5, 5, 6.7, 3.5, 8.2, 5]],
  '…': [
    [2, 0.6, 2, 0.4],
    [5, 0.6, 5, 0.4],
    [8, 0.6, 8, 0.4],
  ],
};

// ─── Distance field ──────────────────────────────────────────────────────────

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}

/** Cell pixels for one glyph: R=G=B=encoded distance, A=255. */
function renderGlyph(polylines, out, stride, originX, originY) {
  for (let row = 0; row < CELL_H; row++) {
    // Pixel centre in px, y up from the baseline.
    const y = BOX_TOP - (row + 0.5);
    for (let col = 0; col < CELL_W; col++) {
      const x = BOX_LEFT + col + 0.5;
      let nearest = Infinity;
      for (let i = 0; i < polylines.length; i++) {
        const line = polylines[i];
        for (let j = 0; j + 3 < line.length; j += 2) {
          const d = segmentDistance(
            x,
            y,
            line[j] * UNIT,
            line[j + 1] * UNIT,
            line[j + 2] * UNIT,
            line[j + 3] * UNIT,
          );
          if (d < nearest) nearest = d;
        }
      }
      const signed = RADIUS - nearest;
      const encoded = Math.max(
        0,
        Math.min(255, Math.round((0.5 + signed / RANGE) * 255)),
      );
      const at = ((originY + row) * stride + originX + col) * 4;
      out[at] = encoded;
      out[at + 1] = encoded;
      out[at + 2] = encoded;
      out[at + 3] = 255;
    }
  }
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Build ───────────────────────────────────────────────────────────────────

// Explicit order: object keys would put the digits first, and a readable
// atlas is worth the constant.
const ORDER =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
  'abcdefghijklmnopqrstuvwxyz{|}~…';
const chars = Array.from(ORDER);
for (const char of chars) {
  if (GLYPHS[char] === undefined) throw new Error(`no outline for "${char}"`);
}
const rows = Math.ceil(chars.length / COLUMNS);
const width = COLUMNS * CELL_W;
const height = rows * CELL_H;
const pixels = Buffer.alloc(width * height * 4);

const glyphs = [];
for (let i = 0; i < chars.length; i++) {
  const char = chars[i];
  const col = i % COLUMNS;
  const row = (i / COLUMNS) | 0;
  const x = col * CELL_W;
  const y = row * CELL_H;
  renderGlyph(GLYPHS[char], pixels, width, x, y);
  const entry = {
    unicode: char.codePointAt(0),
    advance: ADVANCE / SIZE,
  };
  if (GLYPHS[char].length > 0) {
    entry.planeBounds = {
      left: BOX_LEFT / SIZE,
      bottom: BOX_BOTTOM / SIZE,
      right: BOX_RIGHT / SIZE,
      top: BOX_TOP / SIZE,
    };
    entry.atlasBounds = { left: x, top: y, right: x + CELL_W, bottom: y + CELL_H };
  }
  glyphs.push(entry);
}

const json = {
  name: 'cozy stroke',
  pages: ['cozy.png'],
  atlas: {
    type: 'msdf',
    distanceRange: RANGE,
    size: SIZE,
    width,
    height,
    yOrigin: 'top',
  },
  metrics: {
    emSize: 1,
    lineHeight: LINE_HEIGHT / SIZE,
    ascender: ASCENDER / SIZE,
    descender: DESCENDER / SIZE,
    underlineY: -0.1,
    underlineThickness: 0.05,
  },
  glyphs,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'font');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'cozy.json'), JSON.stringify(json, null, 2) + '\n');
writeFileSync(join(out, 'cozy.png'), encodePng(width, height, pixels));
process.stdout.write(
  `cozy font: ${chars.length} glyphs, ${width}x${height} page\n`,
);
