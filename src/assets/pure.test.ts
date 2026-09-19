import { CozyGPUError } from '../types/errors';
import { detectFormat, sniffFormat, urlExtension } from './detect';
import { levelByteLength, supportsFormat, transcodeTargets } from './formats';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import { filled, writeKtx2 } from './assets.testutil';
import { parseKtx2, sliceKtx2Levels } from './ktx2';
import { LruList, type LruNode } from './lru';
import { SkylinePacker } from './packer';
import { JobQueue } from './queue';
import {
  buildHitMask,
  checkSheet,
  parseSpritesheet,
  testHitMask,
} from './spritesheet';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

describe('detectFormat', () => {
  it('uses the extension without query or hash', () => {
    expect(urlExtension('a/b.c/img.PNG?x=1#y')).toBe('png');
    expect(urlExtension('a.dir/noext')).toBe('');
    expect(detectFormat('img/hero.png')).toBe('png');
    expect(detectFormat('img/hero.JPG?v=2')).toBe('jpeg');
    expect(detectFormat('x.webp')).toBe('webp');
    expect(detectFormat('x.avif')).toBe('avif');
    expect(detectFormat('x.gif#frag')).toBe('gif');
    expect(detectFormat('t.ktx2')).toBe('ktx2');
    expect(detectFormat('t.basis')).toBe('basis');
    expect(detectFormat('d.json')).toBe('json');
    expect(detectFormat('d.txt')).toBe('text');
    expect(detectFormat('d.bin')).toBe('binary');
    expect(detectFormat('noext')).toBe('binary');
  });

  it('lets magic bytes override the extension', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
    expect(detectFormat('photo.jpg', png)).toBe('png');
    expect(detectFormat('x', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(detectFormat('x', ascii('GIF89a'))).toBe('gif');
    expect(detectFormat('x', ascii('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe(
      'webp',
    );
    expect(detectFormat('x', ascii('\x00\x00\x00\x1cftypavif'))).toBe('avif');
    expect(detectFormat('x', ascii('\x00\x00\x00\x1cftypavis'))).toBe('avif');
    expect(detectFormat('x', ascii('\x00\x00\x00\x1cftypheic'))).toBe('binary');
    const ktx = writeKtx2({
      vkFormat: 37,
      width: 1,
      height: 1,
      levels: [filled(4, 1)],
    });
    expect(detectFormat('tex.png', new Uint8Array(ktx, 0, 16))).toBe('ktx2');
    expect(detectFormat('x', ascii('sB\x13\x00'))).toBe('basis');
    expect(detectFormat('level', ascii('  \n{"a":1}'))).toBe('json');
    expect(
      detectFormat('list', bytes(0xef, 0xbb, 0xbf, 0x5b, 0x31, 0x5d)),
    ).toBe('json');
    expect(sniffFormat(ascii('hello'))).toBeUndefined();
  });

  it('keeps text files that start with a brace as text', () => {
    expect(detectFormat('notes.txt', ascii('{not json'))).toBe('text');
    expect(detectFormat('unknown', ascii('{"a":1}'))).toBe('json');
  });

  it('reads data URLs', () => {
    expect(detectFormat('data:image/png;base64,AAAA')).toBe('png');
    expect(detectFormat('data:image/jpg;base64,AAAA')).toBe('jpeg');
    expect(detectFormat('data:application/json,{}')).toBe('json');
    expect(detectFormat('data:text/plain,hi')).toBe('text');
  });
});

describe('KTX2 parser', () => {
  it('parses an RGBA8 file with a mip chain and DFD flags', () => {
    const file = writeKtx2({
      vkFormat: 37,
      width: 4,
      height: 2,
      levels: [filled(32, 1), filled(8, 2), filled(4, 3)],
      premultiplied: true,
    });
    const info = parseKtx2(file);
    expect(info.format).toBe('rgba8unorm');
    expect(info.levelCount).toBe(3);
    expect(info.levels.map(l => [l.width, l.height, l.byteLength])).toEqual([
      [4, 2, 32],
      [2, 1, 8],
      [1, 1, 4],
    ]);
    expect(info.premultiplied).toBe(true);
    expect(info.needsTranscoder).toBe(false);
    const levels = sliceKtx2Levels(file, info);
    expect(Array.from(new Uint8Array(levels[1]))).toEqual(new Array(8).fill(2));
    expect(new Uint8Array(levels[2])[0]).toBe(3);
  });

  it('maps compressed vkFormats and checks level sizes', () => {
    const bc7 = parseKtx2(
      writeKtx2({
        vkFormat: 145,
        width: 8,
        height: 8,
        levels: [filled(64, 0), filled(16, 0), filled(16, 0), filled(16, 0)],
      }),
    );
    expect(bc7.format).toBe('bc7-rgba-unorm');
    expect(bc7.levelCount).toBe(4);
    expect(
      parseKtx2(
        writeKtx2({
          vkFormat: 131,
          width: 4,
          height: 4,
          levels: [filled(8, 0)],
        }),
      ).format,
    ).toBe('bc1-rgba-unorm');
    expect(
      parseKtx2(
        writeKtx2({
          vkFormat: 152,
          width: 4,
          height: 4,
          levels: [filled(16, 0)],
        }),
      ).format,
    ).toBe('etc2-rgba8unorm-srgb');
    expect(
      parseKtx2(
        writeKtx2({
          vkFormat: 157,
          width: 4,
          height: 4,
          levels: [filled(16, 0)],
        }),
      ).format,
    ).toBe('astc-4x4-unorm');
    expect(() =>
      parseKtx2(
        writeKtx2({
          vkFormat: 131,
          width: 8,
          height: 8,
          levels: [filled(8, 0)],
        }),
      ),
    ).toThrow(/level 0 is 8 B, expected 32 B/);
  });

  it('flags generate-mips (levelCount 0) and transcoder needs', () => {
    const info = parseKtx2(
      writeKtx2({
        vkFormat: 37,
        width: 2,
        height: 2,
        levels: [filled(16, 0)],
        headerLevelCount: 0,
      }),
    );
    expect(info.generateMips).toBe(true);
    expect(info.levelCount).toBe(1);
    const basis = parseKtx2(
      writeKtx2({
        vkFormat: 0,
        width: 4,
        height: 4,
        levels: [filled(10, 0)],
        supercompression: 1,
        colorModel: 163,
      }),
    );
    expect(basis.needsTranscoder).toBe(true);
    expect(basis.format).toBeUndefined();
    const zstd = parseKtx2(
      writeKtx2({
        vkFormat: 37,
        width: 4,
        height: 4,
        levels: [filled(10, 0)],
        supercompression: 2,
      }),
    );
    expect(zstd.needsTranscoder).toBe(true);
  });

  it('rejects broken and unsupported files with stable codes', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as CozyGPUError).code;
      }
      return 'none';
    };
    expect(code(() => parseKtx2(new ArrayBuffer(10)))).toBe('LOAD_FAILED');
    expect(code(() => parseKtx2(new Uint8Array(100).buffer))).toBe(
      'LOAD_FAILED',
    );
    const good = writeKtx2({
      vkFormat: 37,
      width: 2,
      height: 2,
      levels: [filled(16, 0)],
    });
    expect(code(() => parseKtx2(good.slice(0, good.byteLength - 4)))).toBe(
      'LOAD_FAILED',
    );
    expect(
      code(() =>
        parseKtx2(
          writeKtx2({
            vkFormat: 37,
            width: 1,
            height: 1,
            levels: [filled(4, 0)],
            faces: 6,
          }),
        ),
      ),
    ).toBe('UNSUPPORTED');
    expect(
      code(() =>
        parseKtx2(
          writeKtx2({
            vkFormat: 1000,
            width: 1,
            height: 1,
            levels: [filled(4, 0)],
          }),
        ),
      ),
    ).toBe('UNSUPPORTED');
    expect(
      code(() =>
        parseKtx2(
          writeKtx2({
            vkFormat: 37,
            width: 2,
            height: 2,
            levels: [filled(16, 0), filled(4, 0), filled(4, 0)],
          }),
        ),
      ),
    ).toBe('LOAD_FAILED');
  });
});

describe('formats', () => {
  it('computes block sizes', () => {
    expect(levelByteLength('bc1-rgba-unorm', 5, 5)).toBe(4 * 8);
    expect(levelByteLength('bc7-rgba-unorm', 1, 1)).toBe(16);
    expect(levelByteLength('rgba8unorm', 3, 2)).toBe(24);
  });

  it('orders transcode targets by caps', () => {
    expect(transcodeTargets(FAKE_CAPS)).toEqual(['rgba8unorm']);
    const all = {
      ...FAKE_CAPS,
      textureCompression: { bc: true, bc7: true, etc2: true, astc: true },
    };
    expect(transcodeTargets(all)).toEqual([
      'astc-4x4-unorm',
      'bc7-rgba-unorm',
      'etc2-rgba8unorm',
      'etc2-rgb8unorm',
      'bc3-rgba-unorm',
      'bc1-rgba-unorm',
      'rgba8unorm',
    ]);
    expect(supportsFormat(FAKE_CAPS, 'bc7-rgba-unorm')).toBe(false);
    expect(
      supportsFormat(
        {
          ...FAKE_CAPS,
          textureCompression: {
            bc: true,
            bc7: false,
            etc2: false,
            astc: false,
          },
        },
        'bc3-rgba-unorm',
      ),
    ).toBe(true);
  });
});

describe('SkylinePacker', () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
  }

  it('packs without overlaps, inside the page, with padding gaps', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = rng(seed);
      const size = 512;
      const pad = seed % 3;
      const packer = new SkylinePacker(size, size, pad);
      const rects: [number, number, number, number][] = [];
      for (let i = 0; i < 400; i++) {
        const w = 1 + Math.floor(random() * 64);
        const h = 1 + Math.floor(random() * 64);
        if (!packer.pack(w, h)) continue;
        const { x, y } = packer;
        let ok =
          x - pad >= 0 &&
          y - pad >= 0 &&
          x + w + pad <= size &&
          y + h + pad <= size;
        for (const [ox, oy, ow, oh] of rects) {
          ok &&=
            x >= ox + ow + 2 * pad ||
            ox >= x + w + 2 * pad ||
            y >= oy + oh + 2 * pad ||
            oy >= y + h + 2 * pad;
        }
        if (!ok)
          throw new Error(
            `seed ${seed}: rect ${i} at ${x},${y} ${w}×${h} overlaps or leaves the page`,
          );
        rects.push([x, y, w, h]);
      }
      expect(rects.length).toBeGreaterThan(50);
      expect(packer.fill).toBeGreaterThan(0.6);
    }
  });

  it('fills a page exactly with equal squares and then refuses', () => {
    const packer = new SkylinePacker(64, 64, 0);
    for (let i = 0; i < 16; i++) expect(packer.pack(16, 16)).toBe(true);
    expect(packer.fill).toBe(1);
    expect(packer.pack(1, 1)).toBe(false);
    expect(new SkylinePacker(64, 64, 1).pack(63, 10)).toBe(false);
  });
});

describe('LruList', () => {
  const node = (name: string) =>
    ({ name, lruPrev: null, lruNext: null, lruLinked: false }) as LruNode & {
      name: string;
    };
  const order = (list: LruList<LruNode & { name: string }>) => {
    const out: string[] = [];
    for (let n = list.head; n; n = list.next(n)) out.push(n.name);
    return out;
  };

  it('moves touched nodes to the tail and unlinks', () => {
    const list = new LruList<LruNode & { name: string }>();
    const [a, b, c] = [node('a'), node('b'), node('c')];
    list.touch(a);
    list.touch(b);
    list.touch(c);
    expect(order(list)).toEqual(['a', 'b', 'c']);
    list.touch(a);
    expect(order(list)).toEqual(['b', 'c', 'a']);
    list.touch(a);
    expect(list.size).toBe(3);
    list.remove(c);
    list.remove(c);
    expect(order(list)).toEqual(['b', 'a']);
    list.remove(b);
    list.remove(a);
    expect(list.head).toBeNull();
    expect(list.tail).toBeNull();
    expect(list.size).toBe(0);
  });
});

describe('JobQueue', () => {
  it('limits concurrency, runs FIFO with low priority last, and aborts waiters', async () => {
    const q = new JobQueue(2);
    const log: string[] = [];
    const run = (name: string, low = false, signal?: AbortSignal) =>
      q.acquire(signal, low).then(
        () => log.push(name),
        e => log.push(`${name}:${(e as CozyGPUError).code}`),
      );
    await run('a');
    await run('b');
    expect(q.running).toBe(2);
    const ctrl = new AbortController();
    const p = [
      run('low', true),
      run('c'),
      run('d', false, ctrl.signal),
      run('e'),
    ];
    expect(q.queued).toBe(4);
    ctrl.abort();
    await Promise.resolve();
    q.release();
    q.release();
    q.release();
    await Promise.all(p);
    expect(log).toEqual(['a', 'b', 'd:ABORTED', 'c', 'e', 'low']);
  });
});

describe('spritesheet + hit mask', () => {
  it('parses hash and array formats with animations', () => {
    const hash = parseSpritesheet({
      frames: {
        'a.png': { frame: { x: 0, y: 0, w: 4, h: 4 } },
        'b.png': { frame: { x: 4, y: 0, w: 4, h: 4 } },
      },
      animations: { walk: ['a.png', 'b.png'] },
      meta: { image: 'sheet.png' },
    });
    expect(hash.image).toBe('sheet.png');
    expect(hash.frames.map(f => f.name)).toEqual(['a.png', 'b.png']);
    expect(hash.animations.walk).toEqual(['a.png', 'b.png']);
    checkSheet(hash, 8, 4);
    expect(() => checkSheet(hash, 6, 4)).toThrow(/outside/);
    const arr = parseSpritesheet({
      frames: [{ filename: 'x', frame: { x: 1, y: 2, w: 3, h: 4 } }],
      meta: { image: 'p.png' },
    });
    expect(arr.frames[0]).toEqual({
      name: 'x',
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(() =>
      parseSpritesheet({
        frames: { r: { frame: { x: 0, y: 0, w: 1, h: 1 }, rotated: true } },
        meta: { image: 'p' },
      }),
    ).toThrow(/rotated/);
    expect(() =>
      checkSheet({ ...hash, animations: { bad: ['zzz'] } }, 8, 4),
    ).toThrow(/unknown frame/);
  });

  it('builds a 1-bit mask', () => {
    const px = new Uint8Array(3 * 2 * 4);
    px[3] = 255; // (0,0)
    px[(1 * 3 + 2) * 4 + 3] = 200; // (2,1)
    px[(1 * 3 + 1) * 4 + 3] = 100; // (1,1) below threshold
    const mask = buildHitMask(px, 3, 2);
    expect(mask.bits.length).toBe(1);
    expect(testHitMask(mask, 0, 0)).toBe(true);
    expect(testHitMask(mask, 2.9, 1.2)).toBe(true);
    expect(testHitMask(mask, 1, 1)).toBe(false);
    expect(testHitMask(mask, 3, 0)).toBe(false);
    expect(testHitMask(buildHitMask(px, 3, 2, 50), 1, 1)).toBe(true);
  });
});
