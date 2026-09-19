/**
 * Tester (logic, M2). Edge cases for the pure asset helpers: KTX2 container
 * validation (truncated / corrupt / unsupported files), the skyline packer's
 * geometric invariants, the intrusive LRU list, the fetch job queue, and the
 * two byte-size tables that must agree (assets/formats.ts vs backend/utils.ts).
 */
import type { TextureFormat } from '../backend/types';
import { bytesPerTexel, textureByteLength } from '../backend/utils';
import { blockBytes, levelByteLength } from './formats';
import { SkylinePacker } from './packer';
import { LruList, type LruNode } from './lru';
import { JobQueue } from './queue';
import { parseKtx2 } from './ktx2';
import { writeKtx2, filled } from './assets.testutil';

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('packer no-overlap property', () => {
  it('random rects never overlap and stay inside', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry(seed);
      const pad = seed % 4;
      const p = new SkylinePacker(128, 128, pad);
      const rects: number[][] = [];
      for (let i = 0; i < 200; i++) {
        const w = 1 + Math.floor(rnd() * 30);
        const h = 1 + Math.floor(rnd() * 30);
        if (!p.pack(w, h)) continue;
        const r = [p.x - pad, p.y - pad, w + 2 * pad, h + 2 * pad];
        expect(r[0]).toBeGreaterThanOrEqual(0);
        expect(r[1]).toBeGreaterThanOrEqual(0);
        expect(r[0] + r[2]).toBeLessThanOrEqual(128);
        expect(r[1] + r[3]).toBeLessThanOrEqual(128);
        for (const o of rects) {
          const overlap =
            r[0] < o[0] + o[2] &&
            o[0] < r[0] + r[2] &&
            r[1] < o[1] + o[3] &&
            o[1] < r[1] + r[3];
          if (overlap) {
            throw new Error(
              `seed ${seed} pad ${pad}: ${JSON.stringify(r)} overlaps ${JSON.stringify(o)}`,
            );
          }
        }
        rects.push(r);
      }
    }
  });
});

describe('lru', () => {
  const mk = (): LruNode & { name: string } => ({
    lruPrev: null,
    lruNext: null,
    lruLinked: false,
    name: 'n',
  });
  it('size stays right through touch/remove', () => {
    const l = new LruList<LruNode & { name: string }>();
    const a = mk(),
      b = mk(),
      c = mk();
    l.touch(a);
    l.touch(b);
    l.touch(c);
    expect(l.size).toBe(3);
    l.touch(a);
    expect(l.size).toBe(3);
    expect(l.head).toBe(b);
    expect(l.tail).toBe(a);
    l.remove(b);
    expect(l.size).toBe(2);
    l.remove(b);
    expect(l.size).toBe(2);
    // touch the tail again (early return path)
    l.touch(a);
    expect(l.size).toBe(2);
  });
});

describe('ktx2 edges', () => {
  it('rejects a truncated level index', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
    });
    const cut = file.slice(0, 90);
    expect(() => parseKtx2(cut)).toThrow(/truncated level index|not a KTX2/);
  });
  it('rejects a level whose bytes run past EOF', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
    });
    new DataView(file).setUint32(80 + 8, 1 << 20, true);
    expect(() => parseKtx2(file)).toThrow(/out of range/);
  });
  it('reports the real level count when headerLevelCount is 0', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
      headerLevelCount: 0,
    });
    const info = parseKtx2(file);
    expect(info.generateMips).toBe(true);
    expect(info.levelCount).toBe(1);
  });
  it('supercompressed files need a transcoder', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
      supercompression: 2,
    });
    const info = parseKtx2(file);
    expect(info.needsTranscoder).toBe(true);
  });
  it('rejects unknown supercompression schemes', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
      supercompression: 9,
    });
    expect(() => parseKtx2(file)).toThrow(/supercompressionScheme/);
  });
  it('rejects cube maps', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
      faces: 6,
    });
    expect(() => parseKtx2(file)).toThrow(/2D/);
  });
  it('DFD past EOF', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
    });
    new DataView(file).setUint32(48, file.byteLength - 4, true);
    expect(() => parseKtx2(file)).toThrow(/DFD out of range/);
  });
  it('an empty-levels header (levelCount 0 written, 1 stored) still slices', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 8,
      height: 8,
      levels: [filled(256, 1)],
    });
    const info = parseKtx2(file);
    expect(info.levels[0].byteLength).toBe(256);
  });
  it('levelCount over the mip chain length is rejected', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1), filled(16, 1), filled(4, 1)],
    });
    new DataView(file).setUint32(40, 5, true);
    expect(() => parseKtx2(file)).toThrow(/levelCount/);
  });
  it('zero-byte file', () => {
    expect(() => parseKtx2(new ArrayBuffer(0))).toThrow(/not a KTX2/);
  });
  it('identifier ok but header truncated at 79 bytes', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levels: [filled(64, 1)],
    });
    expect(() => parseKtx2(file.slice(0, 79))).toThrow(/not a KTX2/);
  });
});

describe('JobQueue', () => {
  it('release() with nothing queued does not go negative', async () => {
    const q = new JobQueue(2);
    await q.acquire();
    q.release();
    expect(q.running).toBe(0);
  });
  it('aborting a queued waiter frees nothing but keeps order', async () => {
    const q = new JobQueue(1);
    await q.acquire();
    const c1 = new AbortController();
    const order: string[] = [];
    const p1 = q.acquire(c1.signal).then(
      () => order.push('1'),
      () => order.push('1-abort'),
    );
    const p2 = q.acquire().then(() => order.push('2'));
    c1.abort();
    await p1;
    q.release();
    await p2;
    expect(order).toEqual(['1-abort', '2']);
    expect(q.running).toBe(1);
  });
  it('low priority runs after normal even when queued first', async () => {
    const q = new JobQueue(1);
    await q.acquire();
    const order: string[] = [];
    const lo = q.acquire(undefined, true).then(() => order.push('low'));
    const hi = q.acquire().then(() => order.push('normal'));
    q.release();
    await hi;
    q.release();
    await lo;
    expect(order).toEqual(['normal', 'low']);
  });
  it('limit < 1 is clamped', async () => {
    const q = new JobQueue(0);
    expect(q.limit).toBe(1);
  });
});

describe('the asset and backend byte tables agree', () => {
  // Regression: src/assets/formats.ts blockBytes() returned 4 for
  // 'rg32uint' (8 bytes per texel). It now delegates to backend/utils.
  it('blockBytes matches bytesPerTexel / compressedBlockBytes', () => {
    const formats: TextureFormat[] = [
      'rgba8unorm',
      'rgba8unorm-srgb',
      'bgra8unorm',
      'r8unorm',
      'rgba16float',
      'rgba32float',
      'r32uint',
      'rg32uint',
      'bc1-rgba-unorm',
      'bc3-rgba-unorm',
      'bc4-r-unorm',
      'bc5-rg-unorm',
      'bc7-rgba-unorm',
      'etc2-rgb8unorm',
      'etc2-rgba8unorm',
      'eac-r11unorm',
      'eac-rg11unorm',
      'astc-4x4-unorm',
    ];
    for (const f of formats) {
      expect([f, blockBytes(f)]).toEqual([f, bytesPerTexel(f)]);
      expect([f, levelByteLength(f, 16, 8)]).toEqual([
        f,
        textureByteLength(f, 16, 8),
      ]);
    }
  });

  it('compressed level sizes round each dimension up to the 4×4 block grid', () => {
    expect(levelByteLength('bc1-rgba-unorm', 1, 1)).toBe(8);
    expect(levelByteLength('bc7-rgba-unorm', 5, 5)).toBe(4 * 16);
    expect(levelByteLength('rgba8unorm', 3, 5)).toBe(60);
  });
});
