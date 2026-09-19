/**
 * Tester (logic, M2). Asset cache lifecycle (ARCHITECTURE §15.4-§15.7):
 * reference counting, LRU eviction under the GPU budget, reload after
 * eviction (and the texture-id recycling rule that makes it safe), atlas page
 * lifetime, abort and the concurrency limiter.
 */
import { Assets } from './Assets';
import {
  FakeHost,
  type FakeServer,
  FakeTexture,
  createFakeServer,
  fakePng,
  fakeRenderer,
  installFakeImageDecoder,
  installFakeTextures,
  settle,
} from './assets.testutil';
import type { AssetsOptions, TextureAsset } from './types';
import type { CozyGPUError } from '../types/errors';
import { Op } from '../commands/opcodes';

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

function setup(options: AssetsOptions = {}) {
  const server = createFakeServer();
  const host = new FakeHost();
  const assets = new Assets(fakeRenderer(host), {
    baseUrl: BASE,
    fetch: server.fetch,
    ...options,
  });
  return { server, host, assets };
}
const serve = (s: FakeServer, p: string, b: Uint8Array | string) =>
  s.files.set(BASE + p, b);
const provider = (t: TextureAsset) => (t.texture as FakeTexture).provider;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as CozyGPUError).code;
  }
  return 'resolved';
};

describe('refcount + eviction', () => {
  it('two handles on one key: only the second release lets it be evicted', async () => {
    const { server, host, assets } = setup({ atlas: false, gpuBudgetMB: 0 });
    serve(server, 'a.png', fakePng(64, 64));
    const h1 = await assets.load<TextureAsset>('a.png');
    const h2 = await assets.load<TextureAsset>('a.png');
    expect(h1.value.texture).toBe(h2.value.texture);
    expect(assets.stats.referenced).toBe(1);
    h1.release();
    expect(assets.stats.referenced).toBe(1);
    assets.trim(0);
    expect(assets.has('a.png')).toBe(true); // still referenced by h2
    h2.release();
    expect(assets.stats.referenced).toBe(0);
    assets.trim(0);
    expect(assets.has('a.png')).toBe(false);
    expect(assets.stats.evictions).toBe(1);
    host.render();
  });

  it('release() is idempotent per handle and never double-counts', async () => {
    const { server, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(8, 8));
    const h = await assets.load<TextureAsset>('a.png');
    h.release();
    h.release();
    h.release();
    expect(assets.stats.referenced).toBe(0);
    const h2 = await assets.load<TextureAsset>('a.png');
    expect(assets.stats.referenced).toBe(1);
    h2.release();
    expect(assets.stats.referenced).toBe(0);
  });

  it('reload after eviction refetches; the id is only recycled after the destroy is encoded', async () => {
    const { server, host, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(32, 32));
    const h1 = await assets.load<TextureAsset>('a.png');
    const id1 = provider(h1.value).id;
    host.render(provider(h1.value)); // encodes TEXTURE_CREATE(id1)
    h1.release();
    assets.trim(0);
    expect(h1.state).toBe('released');
    // TEXTURE_DESTROY(id1) is queued but not encoded yet, so a new
    // texture must NOT reuse that id or the queued destroy would kill it.
    const h2 = await assets.load<TextureAsset>('a.png');
    expect(provider(h2.value).id).not.toBe(id1);
    expect(server.requests.filter(u => u.endsWith('a.png')).length).toBe(2);
    const { cmds } = host.render(provider(h2.value));
    const destroy = cmds.find(c => c.op === Op.TEXTURE_DESTROY);
    const create = cmds.find(c => c.op === Op.TEXTURE_CREATE);
    expect(destroy!.u32[0]).toBe(id1);
    expect(create!.u32[0]).toBe(provider(h2.value).id);
    // The destroy is encoded before the new texture's create.
    expect(cmds.indexOf(destroy!)).toBeLessThan(cmds.indexOf(create!));
  });

  it('LRU order: the least recently touched unreferenced unit goes first', async () => {
    const { server, host, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(64, 64));
    serve(server, 'b.png', fakePng(64, 64));
    const a = await assets.load<TextureAsset>('a.png');
    const b = await assets.load<TextureAsset>('b.png');
    const pa = provider(a.value);
    const pb = provider(b.value);
    a.release();
    b.release();
    // Draw `a` so it becomes most recently used.
    host.render(pa, pb);
    host.render(pa);
    const bytes = assets.stats.gpuBytes;
    assets.trim(bytes - 1);
    expect(assets.has('b.png')).toBe(false);
    expect(assets.has('a.png')).toBe(true);
  });

  it('unload() throws on a referenced asset and drops an unreferenced one', async () => {
    const { server, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(8, 8));
    const h = await assets.load<TextureAsset>('a.png');
    expect(() => assets.unload('a.png')).toThrow(/referenced/);
    h.release();
    assets.unload('a.png');
    expect(assets.has('a.png')).toBe(false);
  });

  it('an atlas page survives while any packed image is referenced', async () => {
    const { server, assets } = setup({
      atlas: { pageSize: 256, maxImageSize: 64, padding: 1 },
    });
    serve(server, 'a.png', fakePng(32, 32));
    serve(server, 'b.png', fakePng(32, 32));
    const a = await assets.load<TextureAsset>('a.png');
    const b = await assets.load<TextureAsset>('b.png');
    expect(a.value.packed).toBe(true);
    expect(provider(a.value)).toBe(provider(b.value));
    a.release();
    assets.trim(0);
    expect(assets.has('a.png')).toBe(true);
    expect(assets.stats.atlasPages).toBe(1);
    b.release();
    assets.trim(0);
    expect(assets.stats.atlasPages).toBe(0);
    expect(assets.has('a.png')).toBe(false);
    expect(assets.has('b.png')).toBe(false);
  });
});

describe('abort + concurrency', () => {
  it('one aborted waiter does not cancel the load another waiter wants', async () => {
    const { server, assets } = setup({ atlas: false });
    server.hold = true;
    serve(server, 'a.png', fakePng(8, 8));
    const c = new AbortController();
    const p1 = assets.load<TextureAsset>('a.png', { signal: c.signal });
    const p2 = assets.load<TextureAsset>('a.png');
    c.abort();
    expect(await code(p1)).toBe('ABORTED');
    server.flush();
    const h2 = await p2;
    expect(h2.value.width).toBe(8);
    expect(server.aborted).toEqual([]);
  });

  it('aborting the last waiter cancels the fetch', async () => {
    const { server, assets } = setup({ atlas: false });
    server.hold = true;
    serve(server, 'a.png', fakePng(8, 8));
    const c = new AbortController();
    const p = assets.load('a.png', { signal: c.signal });
    await settle();
    c.abort();
    expect(await code(p)).toBe('ABORTED');
    await settle();
    expect(server.aborted).toEqual([BASE + 'a.png']);
    expect(assets.stats.inFlight).toBe(0);
  });

  it('a signal aborted after the load resolved changes nothing', async () => {
    const { server, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(8, 8));
    const c = new AbortController();
    const h = await assets.load<TextureAsset>('a.png', { signal: c.signal });
    c.abort();
    await settle();
    expect(h.state).toBe('loaded');
    expect(assets.has('a.png')).toBe(true);
  });

  it('a failed load is forgotten and the next load retries', async () => {
    const { server, assets } = setup({ atlas: false });
    expect(await code(assets.load('missing.png'))).toBe('LOAD_FAILED');
    expect(assets.stats.entries).toBe(0);
    expect(assets.stats.inFlight).toBe(0);
    serve(server, 'missing.png', fakePng(4, 4));
    const h = await assets.load<TextureAsset>('missing.png');
    expect(h.value.width).toBe(4);
  });

  it('loadAll releases the handles it already got when one entry fails', async () => {
    const { server, assets } = setup({ atlas: false });
    serve(server, 'a.png', fakePng(8, 8));
    expect(await code(assets.loadAll(['a.png', 'nope.png']))).toBe(
      'LOAD_FAILED',
    );
    await settle();
    expect(assets.stats.referenced).toBe(0);
  });

  it('never runs more than `concurrency` fetches at once', async () => {
    const { server, assets } = setup({ atlas: false, concurrency: 2 });
    server.hold = true;
    for (let i = 0; i < 6; i++) serve(server, `${i}.png`, fakePng(4, 4));
    const all = assets.loadAll([
      '0.png',
      '1.png',
      '2.png',
      '3.png',
      '4.png',
      '5.png',
    ]);
    await settle();
    expect(server.requests.length).toBe(2);
    server.flush();
    await settle();
    server.flush();
    await settle();
    server.flush();
    await settle();
    const handles = await all;
    expect(handles.length).toBe(6);
  });
});
