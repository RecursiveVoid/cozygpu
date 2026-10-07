// Generates the example's asset files (no dependencies):
//   node examples/assets/generate.mjs
// Writes examples/assets/files/: PNG icons (atlas packing), a hero PNG, a
// TexturePacker spritesheet, KTX2 textures (RGBA8 with mips, BC1 with mips)
// and large PNGs for the GPU budget / eviction demo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'files');
mkdirSync(OUT, { recursive: true });

// ─── PNG ─────────────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
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
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function image(width, height, fn) {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = fn(x, y);
      px.set(c, (y * width + x) * 4);
    }
  }
  return px;
}
const hsv = (h, s, v) => {
  const f = n => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
};

// ─── KTX2 ────────────────────────────────────────────────────────────────────
function ktx2(vkFormat, width, height, levels, { premultiplied = false } = {}) {
  const n = levels.length;
  const dfdOffset = 80 + n * 24;
  const dfdBytes = 44;
  let cursor = dfdOffset + dfdBytes;
  const offsets = [];
  for (let i = n - 1; i >= 0; i--) {
    cursor = Math.ceil(cursor / 8) * 8;
    offsets[i] = cursor;
    cursor += levels[i].length;
  }
  const out = Buffer.alloc(cursor);
  Buffer.from([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).copy(out, 0);
  out.writeUInt32LE(vkFormat, 12);
  out.writeUInt32LE(1, 16);
  out.writeUInt32LE(width, 20);
  out.writeUInt32LE(height, 24);
  out.writeUInt32LE(1, 36); // faceCount
  out.writeUInt32LE(n, 40);
  out.writeUInt32LE(dfdOffset, 48);
  out.writeUInt32LE(dfdBytes, 52);
  for (let i = 0; i < n; i++) {
    const at = 80 + i * 24;
    out.writeUInt32LE(offsets[i], at);
    out.writeUInt32LE(levels[i].length, at + 8);
    out.writeUInt32LE(levels[i].length, at + 16);
    Buffer.from(levels[i].buffer, levels[i].byteOffset, levels[i].length).copy(
      out,
      offsets[i],
    );
  }
  out.writeUInt32LE(dfdBytes, dfdOffset);
  out.writeUInt16LE(2, dfdOffset + 8);
  out.writeUInt16LE(40, dfdOffset + 10);
  out[dfdOffset + 12] = 1; // KHR_DF_MODEL_RGBSDA
  out[dfdOffset + 13] = 1; // BT709
  out[dfdOffset + 14] = 1; // linear
  out[dfdOffset + 15] = premultiplied ? 1 : 0;
  return out;
}
function downsample(px, w, h) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx);
            const sy = Math.min(h - 1, y * 2 + dy);
            sum += px[(sy * w + sx) * 4 + c];
          }
        }
        out[(y * nw + x) * 4 + c] = sum >> 2;
      }
    }
  }
  return out;
}
function mipChain(px, w, h, tintLevels) {
  const levels = [];
  let cur = px;
  let cw = w;
  let ch = h;
  for (let level = 0; ; level++) {
    let data = cur;
    if (tintLevels && level > 0) {
      // Tint each mip so minification is visible.
      data = cur.slice();
      const [r, g, b] = hsv(level / 9, 0.7, 1);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (data[i] + r) >> 1;
        data[i + 1] = (data[i + 1] + g) >> 1;
        data[i + 2] = (data[i + 2] + b) >> 1;
      }
    }
    levels.push({ data, w: cw, h: ch });
    if (cw === 1 && ch === 1) break;
    cur = downsample(cur, cw, ch);
    cw = Math.max(1, cw >> 1);
    ch = Math.max(1, ch >> 1);
  }
  return levels;
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
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const texels = [];
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const sx = Math.min(w - 1, bx * 4 + x);
          const sy = Math.min(h - 1, by * 4 + y);
          const i = (sy * w + sx) * 4;
          texels.push([px[i], px[i + 1], px[i + 2]]);
        }
      }
      const lum = t => t[0] * 0.3 + t[1] * 0.59 + t[2] * 0.11;
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
      if (c0 === c1) continue; // indices 0
      const p0 = from565(c0);
      const p1 = from565(c1);
      const palette = [
        p0,
        p1,
        p0.map((v, k) => (2 * v + p1[k]) / 3),
        p0.map((v, k) => (v + 2 * p1[k]) / 3),
      ];
      let bits = 0;
      texels.forEach((t, i) => {
        let best = 0;
        let bestD = Infinity;
        palette.forEach((p, j) => {
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

// ─── Files ───────────────────────────────────────────────────────────────────
const written = [];
const save = (name, bytes) => {
  writeFileSync(join(OUT, name), bytes);
  written.push(`${name} (${bytes.length} B)`);
};

// 48 small icons → packed into one atlas page.
for (let i = 0; i < 48; i++) {
  const [r, g, b] = hsv(i / 48, 0.65, 1);
  const shape = i % 3;
  save(
    `icon-${String(i).padStart(2, '0')}.png`,
    png(
      32,
      32,
      image(32, 32, (x, y) => {
        const dx = x - 15.5;
        const dy = y - 15.5;
        const inside =
          shape === 0
            ? Math.hypot(dx, dy) < 14
            : shape === 1
              ? Math.abs(dx) + Math.abs(dy) < 15
              : Math.max(Math.abs(dx), Math.abs(dy)) < 12;
        const edge = Math.hypot(dx, dy) < 5;
        return inside
          ? edge
            ? [255, 255, 255, 255]
            : [r, g, b, 255]
          : [0, 0, 0, 0];
      }),
    ),
  );
}

// Hero: 384×384 soft radial gradient with alpha.
save(
  'hero.png',
  png(
    384,
    384,
    image(384, 384, (x, y) => {
      const d = Math.hypot(x - 191.5, y - 191.5) / 192;
      const a = Math.max(0, Math.min(1, (1 - d) * 3));
      const [r, g, b] = hsv(
        (Math.atan2(y - 191.5, x - 191.5) / (2 * Math.PI) + 1) % 1,
        0.5 + d * 0.5,
        1,
      );
      return [r, g, b, Math.round(a * 255)];
    }),
  ),
);

// Spritesheet: 4 × 64² frames of a spinning bar.
const FRAMES = 4;
const sheet = image(64 * FRAMES, 64, (x, y) => {
  const f = Math.floor(x / 64);
  const lx = (x % 64) - 31.5;
  const ly = y - 31.5;
  const angle = (f / FRAMES) * Math.PI;
  const along = lx * Math.cos(angle) + ly * Math.sin(angle);
  const across = -lx * Math.sin(angle) + ly * Math.cos(angle);
  const on = Math.abs(along) < 26 && Math.abs(across) < 6;
  const ring = Math.abs(Math.hypot(lx, ly) - 29) < 2;
  return on ? [255, 200, 80, 255] : ring ? [120, 160, 255, 255] : [0, 0, 0, 0];
});
save('spinner.png', png(64 * FRAMES, 64, sheet));
const frames = {};
for (let f = 0; f < FRAMES; f++) {
  frames[`spin-${f}`] = {
    frame: { x: f * 64, y: 0, w: 64, h: 64 },
    rotated: false,
    trimmed: false,
  };
}
save(
  'spinner.json',
  Buffer.from(
    JSON.stringify(
      {
        frames,
        animations: { spin: Object.keys(frames) },
        meta: {
          image: 'spinner.png',
          size: { w: 64 * FRAMES, h: 64 },
          scale: '1',
        },
      },
      null,
      2,
    ),
  ),
);

// KTX2: 256² checkerboard with a full mip chain (each level tinted).
const checker = image(256, 256, (x, y) =>
  ((x >> 5) + (y >> 5)) % 2 ? [240, 240, 240, 255] : [40, 50, 90, 255],
);
const chain = mipChain(checker, 256, 256, true);
const small = mipChain(
  image(128, 128, (x, y) =>
    ((x >> 4) + (y >> 4)) % 2 ? [240, 240, 240, 255] : [90, 40, 60, 255],
  ),
  128,
  128,
  true,
);
save(
  'checker-rgba8.ktx2',
  ktx2(
    37,
    128,
    128,
    small.map(l => l.data),
    { premultiplied: true },
  ),
);
save(
  'checker-bc1.ktx2',
  ktx2(
    131,
    256,
    256,
    chain.map(l => bc1(l.data, l.w, l.h)),
  ),
);

// Budget demo: 1024² images (4 MiB each on the GPU).
for (let i = 0; i < 8; i++) {
  const [r, g, b] = hsv(i / 8, 0.6, 0.9);
  save(
    `big-${i}.png`,
    png(
      1024,
      1024,
      image(1024, 1024, (x, y) => {
        const stripe = ((x + y + i * 64) >> 6) % 2;
        return stripe ? [r, g, b, 255] : [r >> 2, g >> 2, b >> 2, 255];
      }),
    ),
  );
}

console.log(
  `wrote ${written.length} files to ${OUT}\n  ${written.slice(-12).join('\n  ')}`,
);
