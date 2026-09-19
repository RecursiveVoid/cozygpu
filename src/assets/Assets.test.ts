import {
  Op,
  TEXTURE_MIP_LEVELS_SHIFT,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
import type { TextureProvider } from '../scene/types';
import type { CozyGPUError } from '../types/errors';
import { Assets } from './Assets';
import {
  type Cmd,
  FakeHost,
  type FakeServer,
  FakeTexture,
  createFakeServer,
  fakePng,
  fakeRenderer,
  filled,
  installFakeImageDecoder,
  installFakeTextures,
  settle,
  writeKtx2,
} from './assets.testutil';
import { createAssetsProxy } from './proxy';
import type {
  AssetHandle,
  AssetsOptions,
  SpritesheetAsset,
  TextureAsset,
} from './types';

const BASE = 'https://cdn.test/';
const MIB = 1024 * 1024;

let restoreTextures: () => void;
let decoder: ReturnType<typeof installFakeImageDecoder>;
let warn: jest.SpyInstance;

beforeEach(() => {
  restoreTextures = installFakeTextures();
  decoder = installFakeImageDecoder();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  restoreTextures();
  decoder.restore();
  warn.mockRestore();
});

function setup(
  options: AssetsOptions = {},
  caps?: ConstructorParameters<typeof FakeHost>[0],
) {
  const server = createFakeServer();
  const host = new FakeHost(caps);
  const assets = new Assets(fakeRenderer(host), {
    baseUrl: BASE,
    fetch: server.fetch,
    ...options,
  });
  return { server, host, assets };
}

function serve(
  server: FakeServer,
  path: string,
  body: Uint8Array | string | ArrayBuffer,
) {
  server.files.set(
    BASE + path,
    body instanceof ArrayBuffer ? new Uint8Array(body) : body,
  );
}

const provider = (t: TextureAsset) => (t.texture as FakeTexture).provider;
const ops = (cmds: Cmd[]) => cmds.map(c => c.op);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as CozyGPUError).code;
  }
  return 'resolved';
};

describe('Assets: images', () => {
  it('loads an image GPU-only, uploads it once by transfer and closes the bitmap', async () => {
    const { server, host, assets } = setup({ atlas: false });
    serve(server, 'img/hero.png', fakePng(300, 200));
    const handle = await assets.load<TextureAsset>('img/hero.png');
    expect(handle.state).toBe('loaded');
    expect(handle.kind).toBe('texture');
    expect(handle.key).toBe(BASE + 'img/hero.png');
    const tex = handle.value;
    expect([tex.width, tex.height, tex.format, tex.packed, tex.pixels]).toEqual(
      [300, 200, 'rgba8unorm', false, null],
    );
    expect(tex.gpuBytes).toBe(300 * 200 * 4);
    expect(() => tex.hitTest(0, 0)).toThrow(/hitMask/);

    const p = provider(tex);
    const first = host.render(p);
    expect(ops(first.cmds)).toEqual([
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_BITMAP,
    ]);
    expect(first.ready).toEqual([true]);
    const second = host.render(p);
    expect(ops(second.cmds)).toEqual([]);
    expect(decoder.bitmaps[0].closed).toBe(true);
    expect(assets.stats.gpuBytes).toBe(300 * 200 * 4);
  });

  it('encodes TEXTURE_CREATE + TEXTURE_UPLOAD_BITMAP in the frame hook with transfer', async () => {
    const { server, host, assets } = setup({ atlas: false, mipmaps: true });
    serve(server, 'a.png', fakePng(64, 32));
    const tex = (
      await assets.load<TextureAsset>({
        url: 'a.png',
        texture: { nearest: true },
      })
    ).value;
    const { cmds } = host.render();
    expect(ops(cmds)).toEqual([Op.TEXTURE_CREATE, Op.TEXTURE_UPLOAD_BITMAP]);
    const [id, w, h, formatId, flags] = cmds[0].u32;
    expect(id).toBe(provider(tex).id);
    expect([w, h, formatId]).toEqual([64, 32, TextureFormatId.rgba8unorm]);
    expect(flags & TextureFlag.RETAIN_SOURCE).toBe(0);
    expect(flags & (TextureFlag.NEAREST | TextureFlag.MIPMAPS)).toBe(
      TextureFlag.NEAREST | TextureFlag.MIPMAPS,
    );
    expect(host.encoder.transferList).toContain(decoder.bitmaps[0]);
    expect(tex.gpuBytes).toBe(Math.ceil((64 * 32 * 4 * 4) / 3));
  });

  it('shares one fetch between concurrent loads and counts references', async () => {
    const { server, assets } = setup();
    serve(server, 'a.png', fakePng(8, 8));
    const [h1, h2] = await Promise.all([
      assets.load('a.png'),
      assets.load(BASE + 'a.png'),
    ]);
    const h3 = await assets.load('a.png');
    expect(server.requests.length).toBe(1);
    expect(assets.stats.referenced).toBe(1);
    expect(assets.has('a.png')).toBe(true);
    expect(assets.get<TextureAsset>('a.png')).toBe(h1.value);
    h1.release();
    h1.release();
    expect(h1.state).toBe('released');
    expect(() => h1.value).toThrow(/released/);
    h2.release();
    expect(assets.stats.referenced).toBe(1);
    expect(() => assets.unload('a.png')).toThrow(/referenced/);
    h3.release();
    expect(assets.stats.referenced).toBe(0);
    expect(assets.has('a.png')).toBe(true); // GPU assets stay cached
    assets.unload('a.png');
    expect(assets.has('a.png')).toBe(false);
  });

  it('rejects with LOAD_FAILED on HTTP errors and decode failures, and forgets the entry', async () => {
    const { server, assets } = setup();
    expect(await code(assets.load('missing.png'))).toBe('LOAD_FAILED');
    serve(server, 'broken.png', new Uint8Array([1, 2, 3]));
    expect(await code(assets.load('broken.png'))).toBe('LOAD_FAILED');
    expect(assets.stats.entries).toBe(0);
    serve(server, 'missing.png', fakePng(2, 2));
    expect(await code(assets.load('missing.png'))).toBe('resolved');
  });

  it('builds hit masks on the CPU (OffscreenCanvas read)', async () => {
    const g = globalThis as { OffscreenCanvas?: unknown };
    g.OffscreenCanvas = class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        const w = this.width;
        const h = this.height;
        return {
          drawImage() {},
          getImageData() {
            const data = new Uint8ClampedArray(w * h * 4);
            data[3] = 255; // only (0, 0) opaque
            return { data };
          },
        };
      }
    };
    try {
      const { server, assets } = setup();
      serve(server, 'btn.png', fakePng(4, 4));
      const tex = (
        await assets.load<TextureAsset>({
          url: 'btn.png',
          texture: { hitMask: true },
        })
      ).value;
      expect(tex.hitTest(0, 0)).toBe(true);
      expect(tex.hitTest(1, 0)).toBe(false);
      expect(tex.pixels).toBeNull();
      expect(tex.hitMask?.bits.length).toBe(2);
      serve(server, 'px.png', fakePng(4, 4));
      const kept = (
        await assets.load<TextureAsset>({
          url: 'px.png',
          texture: { keepPixels: true },
        })
      ).value;
      expect(kept.pixels?.length).toBe(64);
      expect(kept.packed).toBe(false);
      expect(kept.hitTest(0, 0)).toBe(true);
    } finally {
      delete g.OffscreenCanvas;
    }
  });
});

describe('Assets: atlas packing', () => {
  it('packs small images into one page with region uploads and one mip regeneration', async () => {
    const { server, host, assets } = setup({
      atlas: { pageSize: 256, maxImageSize: 64, padding: 1 },
      mipmaps: true,
    });
    for (let i = 0; i < 5; i++) serve(server, `s${i}.png`, fakePng(32, 16));
    serve(server, 'big.png', fakePng(100, 100));
    serve(server, 'rep.png', fakePng(8, 8));
    const handles = await assets.loadAll([
      's0.png',
      's1.png',
      's2.png',
      's3.png',
      's4.png',
    ]);
    const big = (await assets.load<TextureAsset>('big.png')).value;
    const rep = (
      await assets.load<TextureAsset>({
        url: 'rep.png',
        texture: { repeat: true },
      })
    ).value;
    const values = handles.map(h => h.value as TextureAsset);
    expect(values.every(v => v.packed)).toBe(true);
    expect(big.packed).toBe(false);
    expect(rep.packed).toBe(false);
    const page = provider(values[0]);
    expect(values.every(v => provider(v) === page)).toBe(true);
    expect(assets.stats.atlasPages).toBe(1);
    // Sub-frames never overlap.
    const frames = values.map(v => v.texture.frame);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i];
        const b = frames[j];
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
    const { cmds } = host.render();
    const pageCmds = cmds.filter(c => c.u32[0] === page.id);
    expect(ops(pageCmds)).toEqual([
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
      Op.TEXTURE_GENERATE_MIPMAPS,
    ]);
    expect(pageCmds[0].u32.slice(1, 3)).toEqual([256, 256]);
    const region = pageCmds[1].u32;
    expect([region[2], region[3]]).toEqual([frames[0].x, frames[0].y]);
    // Page counted once.
    expect(assets.stats.gpuBytes).toBe(
      Math.ceil((256 * 256 * 4 * 4) / 3) + big.gpuBytes + rep.gpuBytes,
    );
    // Later load on the same page: only a region upload + one mip regen next frame.
    serve(server, 's5.png', fakePng(10, 10));
    await assets.load('s5.png');
    expect(ops(host.render().cmds)).toEqual([
      Op.TEXTURE_UPLOAD_BITMAP_REGION,
      Op.TEXTURE_GENERATE_MIPMAPS,
    ]);
  });

  it('opens a second page when the first is full and keeps sampler variants apart', async () => {
    const { server, assets } = setup({
      atlas: { pageSize: 64, maxImageSize: 64, padding: 0 },
    });
    for (let i = 0; i < 5; i++) serve(server, `q${i}.png`, fakePng(32, 32));
    serve(server, 'n.png', fakePng(8, 8));
    const hs = await assets.loadAll([
      'q0.png',
      'q1.png',
      'q2.png',
      'q3.png',
      'q4.png',
    ]);
    const nearest = (
      await assets.load<TextureAsset>({
        url: 'n.png',
        texture: { nearest: true },
      })
    ).value;
    const pages = new Set(hs.map(h => provider(h.value as TextureAsset)));
    expect(pages.size).toBe(2);
    expect(pages.has(provider(nearest))).toBe(false);
    expect(assets.stats.atlasPages).toBe(3);
  });
});

describe('Assets: KTX2', () => {
  const bc7File = () =>
    writeKtx2({
      vkFormat: 145,
      width: 8,
      height: 4,
      levels: [filled(32, 7), filled(16, 8), filled(16, 9), filled(16, 10)],
    });

  it('uploads native compressed levels with an explicit mip count when caps allow', async () => {
    const { server, host, assets } = setup(
      {},
      { textureCompression: { bc: true, bc7: true, etc2: false, astc: false } },
    );
    serve(server, 't.ktx2', bc7File());
    const tex = (await assets.load<TextureAsset>('t.ktx2')).value;
    expect(tex.format).toBe('bc7-rgba-unorm');
    expect(tex.packed).toBe(false);
    expect(tex.gpuBytes).toBe(32 + 16 * 3);
    const { cmds } = host.render();
    expect(ops(cmds)).toEqual([
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_COMPRESSED,
      Op.TEXTURE_UPLOAD_COMPRESSED,
      Op.TEXTURE_UPLOAD_COMPRESSED,
      Op.TEXTURE_UPLOAD_COMPRESSED,
    ]);
    const [, w, h, formatId, flags] = cmds[0].u32;
    expect([w, h, formatId]).toEqual([8, 4, TextureFormatId['bc7-rgba-unorm']]);
    expect(flags >>> TEXTURE_MIP_LEVELS_SHIFT).toBe(4);
    expect(flags & TextureFlag.MIPMAPS).toBe(TextureFlag.MIPMAPS);
    const level2 = cmds[3];
    expect(level2.u32.slice(1, 4)).toEqual([2, 2, 1]);
    const buffer = level2.objects[level2.u32[4]] as ArrayBuffer;
    expect(new Uint8Array(buffer)[0]).toBe(9);
    expect(level2.u32[6]).toBe(16);
    expect(host.encoder.transferList).toContain(buffer);
  });

  it('rejects UNSUPPORTED without caps or transcoder, and transcodes with the hook', async () => {
    const plain = setup();
    serve(plain.server, 't.ktx2', bc7File());
    expect(await code(plain.assets.load('t.ktx2'))).toBe('UNSUPPORTED');

    const transcode = jest.fn(
      async (req: { targets: readonly string[]; container: string }) => ({
        format: req.targets[0] as 'etc2-rgba8unorm',
        width: 4,
        height: 4,
        levels: [new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16)],
      }),
    );
    const factory = jest.fn(async () => ({ transcode }));
    const { server, host, assets } = setup(
      { transcoder: factory },
      {
        textureCompression: { bc: false, bc7: false, etc2: true, astc: false },
      },
    );
    serve(server, 't.ktx2', bc7File());
    serve(server, 'u.basis', new Uint8Array([0x73, 0x42, 1, 2]));
    const a = (await assets.load<TextureAsset>('t.ktx2')).value;
    const b = (await assets.load<TextureAsset>('u.basis')).value;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(transcode.mock.calls[0][0].targets).toEqual([
      'etc2-rgba8unorm',
      'etc2-rgb8unorm',
      'rgba8unorm',
    ]);
    expect(transcode.mock.calls[1][0].container).toBe('basis');
    expect(a.format).toBe('etc2-rgba8unorm');
    expect(b.width).toBe(4);
    const { cmds } = host.render();
    expect(
      ops(cmds).filter(o => o === Op.TEXTURE_UPLOAD_COMPRESSED).length,
    ).toBe(6);
  });

  it('GPU-generates mips for single-level RGBA8 files and warns for compressed ones', async () => {
    const { server, host, assets } = setup(
      {},
      { textureCompression: { bc: true, bc7: true, etc2: false, astc: false } },
    );
    serve(
      server,
      'r.ktx2',
      writeKtx2({
        vkFormat: 37,
        width: 4,
        height: 4,
        levels: [filled(64, 255)],
        headerLevelCount: 0,
      }),
    );
    serve(
      server,
      'c.ktx2',
      writeKtx2({ vkFormat: 131, width: 4, height: 4, levels: [filled(8, 0)] }),
    );
    await assets.load('r.ktx2');
    await assets.load({ url: 'c.ktx2', texture: { mipmaps: true } });
    const { cmds } = host.render();
    expect(ops(cmds)).toEqual([
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_COMPRESSED,
      Op.TEXTURE_GENERATE_MIPMAPS,
      Op.TEXTURE_CREATE,
      Op.TEXTURE_UPLOAD_COMPRESSED,
    ]);
    expect(cmds[0].u32[4] & TextureFlag.MIPMAPS).toBe(TextureFlag.MIPMAPS);
    expect(cmds[0].u32[4] >>> TEXTURE_MIP_LEVELS_SHIFT).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot get GPU mipmaps'),
    );
  });
});

describe('Assets: data, spritesheets, bundles', () => {
  it('loads JSON, text and binary into memory and drops them at zero references', async () => {
    const { server, assets } = setup();
    serve(server, 'level.json', '{"spawns":[1,2]}');
    serve(server, 'notes.txt', 'hello');
    serve(server, 'blob', new Uint8Array([1, 2, 3]));
    const json = await assets.load<{ spawns: number[] }>('level.json');
    const text = await assets.load<string>('notes.txt');
    const bin = await assets.load<ArrayBuffer>({ url: 'blob', kind: 'binary' });
    expect(json.value.spawns).toEqual([1, 2]);
    expect(json.kind).toBe('json');
    expect(text.value).toBe('hello');
    expect(text.kind).toBe('text');
    expect(bin.value.byteLength).toBe(3);
    expect(assets.stats.gpuBytes).toBe(0);
    json.release();
    expect(assets.has('level.json')).toBe(false);
    serve(server, 'bad.json', '{nope');
    expect(await code(assets.load('bad.json'))).toBe('LOAD_FAILED');
  });

  it('loads a TexturePacker sheet with frames and animations, holding its page', async () => {
    const { server, assets } = setup();
    serve(
      server,
      'ui/ui.json',
      JSON.stringify({
        frames: {
          up: { frame: { x: 0, y: 0, w: 10, h: 10 } },
          down: { frame: { x: 10, y: 0, w: 10, h: 10 } },
        },
        animations: { press: ['up', 'down'] },
        meta: { image: 'ui.png' },
      }),
    );
    serve(server, 'ui/ui.png', fakePng(20, 10));
    const sheet = await assets.load<SpritesheetAsset>('ui/ui.json');
    expect(sheet.kind).toBe('spritesheet');
    const v = sheet.value;
    expect(v.frames.down.frame).toEqual({ x: 10, y: 0, width: 10, height: 10 });
    expect(v.animations.press[1]).toBe(v.frames.down);
    expect(v.page.packed).toBe(false);
    expect(assets.stats.referenced).toBe(2);
    sheet.release();
    expect(assets.stats.referenced).toBe(0);
    expect(assets.has('ui/ui.json')).toBe(false);
    expect(assets.has('ui/ui.png')).toBe(true);
  });

  it('loads bundles with monotonic progress and releases them', async () => {
    const { server, assets } = setup();
    serve(server, 'bg.png', fakePng(300, 300));
    serve(server, 'data.json', '[1]');
    serve(server, 'theme.bin', new Uint8Array(4));
    assets.addBundle('level1', {
      bg: 'bg.png',
      data: 'data.json',
      music: { url: 'theme.bin', kind: 'binary' },
    });
    expect(() => assets.addBundle('level1', {})).toThrow(/already exists/);
    const seen: number[] = [];
    const bundle = await assets.loadBundle('level1', {
      onProgress: p => seen.push(p.ratio),
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort()).toEqual(seen);
    expect(bundle.get<TextureAsset>('bg').value.width).toBe(300);
    expect(bundle.get('data')).toBe(bundle.get(BASE + 'data.json'));
    expect(bundle.handles.length).toBe(3);
    expect(() => bundle.get('nope')).toThrow(/no entry/);
    bundle.release();
    expect(assets.stats.referenced).toBe(0);
    expect(await code(assets.loadBundle('nope'))).toBe('INVALID_ARGUMENT');
  });

  it('loadAll rejects on the first failure and releases the rest', async () => {
    const { server, assets } = setup();
    serve(server, 'a.png', fakePng(4, 4));
    expect(await code(assets.loadAll(['a.png', 'missing.png']))).toBe(
      'LOAD_FAILED',
    );
    await settle();
    expect(assets.stats.referenced).toBe(0);
  });
});

describe('Assets: concurrency and abort', () => {
  it('runs at most `concurrency` fetches at once', async () => {
    const { server, assets } = setup({ concurrency: 2 });
    for (let i = 0; i < 5; i++) serve(server, `${i}.json`, '1');
    server.hold = true;
    const all = assets.loadAll([
      '0.json',
      '1.json',
      '2.json',
      '3.json',
      '4.json',
    ]);
    await settle();
    expect(server.requests.length).toBe(2);
    expect(assets.stats.queued).toBe(3);
    expect(assets.stats.inFlight).toBe(5);
    while (server.requests.length < 5 || assets.stats.inFlight > 0) {
      server.flush();
      await settle(2);
    }
    expect((await all).length).toBe(5);
  });

  it('aborts: rejects ABORTED, cancels the fetch nobody else waits for', async () => {
    const { server, assets } = setup();
    serve(server, 'a.png', fakePng(4, 4));
    server.hold = true;
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = assets.load('a.png', { signal: c1.signal });
    const p2 = assets.load('a.png', { signal: c2.signal });
    await settle();
    c1.abort();
    expect(await code(p1)).toBe('ABORTED');
    expect(server.aborted).toEqual([]);
    c2.abort();
    expect(await code(p2)).toBe('ABORTED');
    await settle();
    expect(server.aborted).toEqual([BASE + 'a.png']);
    expect(assets.stats.entries).toBe(0);
    expect(
      await code(assets.load('a.png', { signal: AbortSignal.abort() })),
    ).toBe('ABORTED');
  });

  it('aborting a bundle releases what it already acquired', async () => {
    const { server, assets } = setup();
    serve(server, 'fast.json', '1');
    serve(server, 'slow.json', '2');
    const originalFetch = server.fetch;
    server.fetch = (url, init) =>
      url.endsWith('slow.json')
        ? new Promise((_r, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('x')),
            ),
          )
        : originalFetch(url, init);
    const assets2 = new Assets(fakeRenderer(new FakeHost()), {
      baseUrl: BASE,
      fetch: server.fetch,
    });
    assets2.addBundle('b', { f: 'fast.json', s: 'slow.json' });
    const ctrl = new AbortController();
    const p = assets2.loadBundle('b', { signal: ctrl.signal });
    await settle();
    expect(assets2.stats.referenced).toBe(1);
    ctrl.abort();
    expect(await code(p)).toBe('ABORTED');
    await settle();
    expect(assets2.stats.referenced).toBe(0);
    expect(assets2.stats.inFlight).toBe(0);
    void assets;
  });

  it('preload fetches in the background and load reuses the bytes', async () => {
    const { server, assets } = setup();
    serve(server, 'p.json', '{"x":1}');
    assets.preload(['p.json']);
    await settle();
    expect(server.requests.length).toBe(1);
    expect(assets.has('p.json')).toBe(false);
    const h = await assets.load<{ x: number }>('p.json');
    expect(h.value.x).toBe(1);
    expect(server.requests.length).toBe(1);
  });
});

describe('Assets: GPU budget and eviction', () => {
  it('evicts zero-reference textures in LRU order and reloads from the URL', async () => {
    // Budget 1 MiB; each 256×256 texture is 256 KiB.
    const { server, host, assets } = setup({ gpuBudgetMB: 1, atlas: false });
    const names = ['t0.png', 't1.png', 't2.png', 't3.png', 't4.png'];
    for (const n of names) serve(server, n, fakePng(256, 256));
    const handles: AssetHandle<TextureAsset>[] = [];
    for (const n of names.slice(0, 4))
      handles.push(await assets.load<TextureAsset>(n));
    expect(assets.stats.gpuBytes).toBe(MIB);
    host.render();
    // Draw t0 and t2 last so t1 and t3 are the least recently used.
    host.render(provider(handles[0].value), provider(handles[2].value));
    const ids = handles.map(h => provider(h.value).id);
    for (const h of handles) h.release();
    expect(assets.stats.evictions).toBe(0);
    await assets.load(names[4]);
    expect(assets.stats.evictions).toBe(1);
    expect(assets.stats.gpuBytes).toBe(MIB);
    expect(assets.has('t1.png')).toBe(false);
    expect(
      assets.has('t0.png') && assets.has('t2.png') && assets.has('t3.png'),
    ).toBe(true);
    const destroy = host.render().cmds.filter(c => c.op === Op.TEXTURE_DESTROY);
    expect(destroy.map(c => c.u32[0])).toEqual([ids[1]]);
    expect(handles[1].state).toBe('released');
    // Reload from URL.
    const again = await assets.load<TextureAsset>('t1.png');
    expect(server.requests.filter(u => u.endsWith('t1.png')).length).toBe(2);
    expect(again.value.width).toBe(256);
    assets.trim(0);
    expect(assets.stats.gpuBytes).toBe(2 * again.value.gpuBytes); // t1 and t4 are referenced
  });

  it('never evicts referenced textures and warns once when they exceed the budget', async () => {
    const { server, assets } = setup({ gpuBudgetMB: 1, atlas: false });
    serve(server, 'a.png', fakePng(512, 512));
    serve(server, 'b.png', fakePng(512, 512));
    const a = await assets.load('a.png');
    const b = await assets.load('b.png');
    expect(assets.stats.evictions).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    a.release();
    expect(assets.stats.evictions).toBe(1);
    expect(assets.stats.gpuBytes).toBe(MIB);
    b.release();
  });

  // Regression: an eviction that releases child handles re-entered
  // enforceBudget(); the nested sweep evicted the unit the outer loop held as
  // `next`, which was then evicted (and counted) a second time. White-box:
  // no public loader gives a GPU entry children today (latent).
  it('does not re-enter the budget sweep through child releases', async () => {
    const { server, host, assets } = setup({ gpuBudgetMB: 64, atlas: false });
    for (const n of ['a.png', 'b.png', 'c.png'])
      serve(server, n, fakePng(256, 256));
    const a = await assets.load<TextureAsset>('a.png');
    const b = await assets.load<TextureAsset>('b.png');
    const c = await assets.load<TextureAsset>('c.png');
    host.render();
    host.render(provider(a.value), provider(b.value), provider(c.value));
    const internals = assets as unknown as {
      cache: Map<string, { children: AssetHandle[] }>;
      budgetBytes: number;
    };
    // `a` holds a second handle on `b`, released when `a` is evicted.
    internals.cache
      .get(BASE + 'a.png')!
      .children.push(await assets.load<TextureAsset>('b.png'));
    a.release();
    b.release();
    c.release();
    expect(assets.stats.evictions).toBe(0);
    internals.budgetBytes = 1; // make the nested (budget) sweep want to evict
    assets.trim(0);
    expect(assets.stats.evictions).toBe(3);
    expect(assets.stats.gpuBytes).toBe(0);
    expect(assets.stats.entries).toBe(0);
  });

  it('evicts an atlas page only when all its images are unreferenced', async () => {
    const { server, host, assets } = setup({
      gpuBudgetMB: 0,
      atlas: { pageSize: 128, maxImageSize: 64, padding: 0 },
    });
    serve(server, 'a.png', fakePng(16, 16));
    serve(server, 'b.png', fakePng(16, 16));
    const a = await assets.load<TextureAsset>('a.png');
    const b = await assets.load<TextureAsset>('b.png');
    host.render();
    const pageId = provider(a.value).id;
    a.release();
    assets.trim(0);
    expect(assets.stats.atlasPages).toBe(1);
    b.release();
    assets.trim(0);
    expect(assets.stats.atlasPages).toBe(0);
    expect(assets.stats.entries).toBe(0);
    expect(assets.stats.gpuBytes).toBe(0);
    expect(host.render().cmds.map(c => [c.op, c.u32[0]])).toEqual([
      [Op.TEXTURE_DESTROY, pageId],
    ]);
  });
});

describe('Assets: device loss, destroy, proxy', () => {
  it('reloads referenced textures after a restore and drops unreferenced ones', async () => {
    const { server, host, assets } = setup({
      atlas: { pageSize: 128, maxImageSize: 32, padding: 0 },
    });
    serve(server, 'keep.png', fakePng(100, 100));
    serve(server, 'drop.png', fakePng(100, 100));
    serve(server, 'small.png', fakePng(8, 8));
    const keep = await assets.load<TextureAsset>('keep.png');
    const drop = await assets.load<TextureAsset>('drop.png');
    const small = await assets.load<TextureAsset>('small.png');
    host.render();
    drop.release();
    const p = provider(keep.value);
    const page = provider(small.value);
    expect(host.render(p).ready).toEqual([true]);

    host.restoreDevice();
    expect(host.render(p, page).ready).toEqual([false, false]); // still reloading
    await settle();
    expect(assets.has('drop.png')).toBe(false);
    const { cmds, ready } = host.render(p, page);
    expect(ready).toEqual([true, true]);
    const created = cmds
      .filter(c => c.op === Op.TEXTURE_CREATE)
      .map(c => c.u32[0]);
    expect(created.sort()).toEqual([p.id, page.id].sort());
    expect(ops(cmds)).toContain(Op.TEXTURE_UPLOAD_BITMAP_REGION);
    expect(server.requests.filter(u => u.endsWith('keep.png')).length).toBe(2);
  });

  it('destroy rejects in-flight loads and frees textures; renderer destroy detaches the hook', async () => {
    const { server, host, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(4, 4));
    serve(server, 'b.png', fakePng(4, 4));
    const a = await assets.load<TextureAsset>('a.png');
    host.render();
    server.hold = true;
    const pending = assets.load('b.png');
    await settle();
    assets.destroy();
    assets.destroy();
    expect(await code(pending)).toBe('ABORTED');
    expect((a.value.texture as FakeTexture).destroyed).toBe(true);
    const { cmds } = host.render();
    expect(cmds.map(c => [c.op, c.u32[0]])).toEqual([
      [Op.TEXTURE_DESTROY, provider(a.value).id],
    ]);
    expect(host.hooks.length).toBe(0);
    expect(await code(assets.load('a.png'))).toBe('DESTROYED');

    const second = setup();
    second.host.destroyRenderer();
    expect(second.host.hooks.length).toBe(0);
  });

  it('a user-destroyed texture handle drops the entry', async () => {
    const { server, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(4, 4));
    const a = await assets.load<TextureAsset>('a.png');
    a.value.texture.destroy();
    expect(assets.has('a.png')).toBe(false);
    expect(assets.stats.gpuBytes).toBe(0);
    a.release();
  });

  it('proxy answers empty before the import and forwards after it', async () => {
    const server = createFakeServer();
    const host = new FakeHost();
    serve(server, 'a.json', '{"a":1}');
    const proxy = createAssetsProxy(fakeRenderer(host), {
      baseUrl: BASE,
      fetch: server.fetch,
    });
    expect(proxy.get('a.json')).toBeUndefined();
    expect(proxy.has('a.json')).toBe(false);
    expect(proxy.stats.entries).toBe(0);
    expect(proxy.detectFormat('x.ktx2')).toBe('ktx2');
    proxy.addBundle('b', { a: 'a.json' });
    expect(() => proxy.addBundle('b', {})).toThrow(/already exists/);
    const bundle = await proxy.loadBundle('b');
    expect(bundle.get<{ a: number }>('a').value.a).toBe(1);
    expect(proxy.has('a.json')).toBe(true);
    expect(proxy.stats.entries).toBe(1);
    expect(host.hooks.length).toBe(1);
    proxy.destroy();
    expect(host.hooks.length).toBe(0);
    expect(await code(proxy.load('a.json'))).toBe('DESTROYED');
  });
});

// Keep the type import used (TextureProvider appears in helper signatures).
export type _P = TextureProvider;
