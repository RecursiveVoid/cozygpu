/**
 * A1 asset set for the benchmarks (no dependencies), written into
 * benchmarks/dist/a1/ by build.mjs:
 *   png/img-000.png … img-199.png    64×64 RGBA PNGs (opaque, distinct content)
 *   ktx2/img-000.ktx2 … img-199.ktx2 the same pixels as BC1 KTX2 (1 level,
 *                                    no supercompression → no transcoder)
 *   ktx/img-000.ktx  … img-199.ktx   the same BC1 blocks as KTX 1.1: Pixi's
 *                                    KTX2 loader only reads RGBA8 or Basis
 *                                    KTX2, its KTX1 loader reads BC1
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export const A1_COUNT = 200;
export const A1_SIZE = 64;

// ─── PNG ─────────────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── KTX2 (BC1, one level) ───────────────────────────────────────────────────
function ktx2(vkFormat, w, h, level) {
  const dfdOffset = 80 + 24;
  const dfdBytes = 44;
  const dataOffset = Math.ceil((dfdOffset + dfdBytes) / 8) * 8;
  const out = Buffer.alloc(dataOffset + level.length);
  Buffer.from([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).copy(out, 0);
  out.writeUInt32LE(vkFormat, 12);
  out.writeUInt32LE(1, 16); // typeSize
  out.writeUInt32LE(w, 20);
  out.writeUInt32LE(h, 24);
  out.writeUInt32LE(1, 36); // faceCount
  out.writeUInt32LE(1, 40); // levelCount
  out.writeUInt32LE(dfdOffset, 48);
  out.writeUInt32LE(dfdBytes, 52);
  out.writeUInt32LE(dataOffset, 80);
  out.writeUInt32LE(level.length, 88);
  out.writeUInt32LE(level.length, 96);
  out.writeUInt32LE(dfdBytes, dfdOffset);
  out.writeUInt16LE(2, dfdOffset + 8); // versionNumber
  out.writeUInt16LE(40, dfdOffset + 10); // descriptorBlockSize
  out[dfdOffset + 12] = 128; // KHR_DF_MODEL_BC1A
  out[dfdOffset + 13] = 1; // BT709
  out[dfdOffset + 14] = 1; // linear
  out[dfdOffset + 15] = 0;
  out[dfdOffset + 16] = 3; // texelBlockDimension 4×4 (stored minus one)
  out[dfdOffset + 17] = 3;
  out[dfdOffset + 20] = 8; // bytesPlane0
  // One sample: bitOffset 0, bitLength 64-1, channel 0 (colour), full range.
  out.writeUInt16LE(0, dfdOffset + 28);
  out[dfdOffset + 30] = 63;
  out[dfdOffset + 31] = 0;
  out.writeUInt32LE(0, dfdOffset + 36);
  out.writeUInt32LE(0xffffffff, dfdOffset + 40);
  Buffer.from(level.buffer, level.byteOffset, level.length).copy(
    out,
    dataOffset,
  );
  return out;
}

// ─── KTX 1.1 (BC1 = COMPRESSED_RGB_S3TC_DXT1_EXT, one level) ────────────────
function ktx1(glInternalFormat, glBaseInternalFormat, w, h, level) {
  const out = Buffer.alloc(64 + 4 + level.length);
  Buffer.from([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).copy(out, 0);
  const fields = [
    0x04030201, // endianness
    0, // glType (compressed)
    1, // glTypeSize
    0, // glFormat (compressed)
    glInternalFormat,
    glBaseInternalFormat,
    w,
    h,
    0, // pixelDepth
    0, // numberOfArrayElements
    1, // numberOfFaces
    1, // numberOfMipmapLevels
    0, // bytesOfKeyValueData
  ];
  fields.forEach((v, i) => out.writeUInt32LE(v, 12 + i * 4));
  out.writeUInt32LE(level.length, 64);
  Buffer.from(level.buffer, level.byteOffset, level.length).copy(out, 68);
  return out;
}

const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = c => [
  (((c >> 11) & 31) * 255) / 31,
  (((c >> 5) & 63) * 255) / 63,
  ((c & 31) * 255) / 31,
];
/** Minimal BC1 encoder: luminance min/max endpoints, 4-colour mode. */
function bc1(px, w, h) {
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  const out = new Uint8Array(bw * bh * 8);
  const view = new DataView(out.buffer);
  const lum = t => t[0] * 0.3 + t[1] * 0.59 + t[2] * 0.11;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const texels = [];
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const i = ((by * 4 + y) * w + bx * 4 + x) * 4;
          texels.push([px[i], px[i + 1], px[i + 2]]);
        }
      }
      let lo = texels[0];
      let hi = texels[0];
      for (const t of texels) {
        if (lum(t) < lum(lo)) lo = t;
        if (lum(t) > lum(hi)) hi = t;
      }
      let c0 = to565(...hi);
      let c1 = to565(...lo);
      if (c0 < c1) [c0, c1] = [c1, c0];
      const at = (by * bw + bx) * 8;
      view.setUint16(at, c0, true);
      view.setUint16(at + 2, c1, true);
      if (c0 === c1) continue;
      const p0 = from565(c0);
      const p1 = from565(c1);
      const pal = [
        p0,
        p1,
        p0.map((v, k) => (2 * v + p1[k]) / 3),
        p0.map((v, k) => (v + 2 * p1[k]) / 3),
      ];
      let bits = 0;
      texels.forEach((t, i) => {
        let best = 0;
        let bestD = Infinity;
        pal.forEach((p, j) => {
          const d =
            (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        });
        bits |= best << (2 * i);
      });
      view.setUint32(at + 4, bits >>> 0, true);
    }
  }
  return out;
}

// ─── Content ─────────────────────────────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hsv = (h, s, v) => {
  const f = n => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
};
/** Opaque 64×64 icon: hue gradient, a shape, light noise (realistic PNG size). */
function icon(i, size) {
  const r = rng(1000 + i);
  const px = new Uint8Array(size * size * 4);
  const [br, bg, bb] = hsv(i / A1_COUNT, 0.6, 0.9);
  const [fr, fg, fb] = hsv((i / A1_COUNT + 0.5) % 1, 0.4, 1);
  const shape = i % 4;
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const inside =
        shape === 0
          ? Math.hypot(dx, dy) < size * 0.38
          : shape === 1
            ? Math.abs(dx) + Math.abs(dy) < size * 0.42
            : shape === 2
              ? Math.max(Math.abs(dx), Math.abs(dy)) < size * 0.3
              : Math.abs(dx) < size * 0.12 || Math.abs(dy) < size * 0.12;
      const shade = 0.6 + (0.4 * y) / size;
      const n = (r() - 0.5) * 24;
      const o = (y * size + x) * 4;
      const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
      px[o] = clamp((inside ? fr : br * shade) + n);
      px[o + 1] = clamp((inside ? fg : bg * shade) + n);
      px[o + 2] = clamp((inside ? fb : bb * shade) + n);
      px[o + 3] = 255;
    }
  }
  return px;
}

export function generateAssets(outDir) {
  const pngDir = path.join(outDir, 'a1', 'png');
  const ktxDir = path.join(outDir, 'a1', 'ktx2');
  mkdirSync(pngDir, { recursive: true });
  mkdirSync(ktxDir, { recursive: true });
  const ktx1Dir = path.join(outDir, 'a1', 'ktx');
  mkdirSync(ktx1Dir, { recursive: true });
  let pngBytes = 0;
  let ktxBytes = 0;
  for (let i = 0; i < A1_COUNT; i++) {
    const px = icon(i, A1_SIZE);
    const name = `img-${String(i).padStart(3, '0')}`;
    const p = png(A1_SIZE, A1_SIZE, px);
    const blocks = bc1(px, A1_SIZE, A1_SIZE);
    const k = ktx2(131, A1_SIZE, A1_SIZE, blocks);
    writeFileSync(path.join(pngDir, `${name}.png`), p);
    writeFileSync(path.join(ktxDir, `${name}.ktx2`), k);
    writeFileSync(
      path.join(ktx1Dir, `${name}.ktx`),
      ktx1(0x83f0, 0x1907, A1_SIZE, A1_SIZE, blocks),
    );
    pngBytes += p.length;
    ktxBytes += k.length;
  }
  return { count: A1_COUNT, size: A1_SIZE, pngBytes, ktxBytes };
}
