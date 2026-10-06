/**
 * `kind: 'font'` (ARCHITECTURE §23.3): the atlas JSON is parsed here and its
 * page goes through the ordinary texture path, so it is cached, refcounted
 * and budgeted like any other texture.
 */
import { Texture } from '../scene/Texture';
import { loadFontAsset } from './font';
import type { AssetDescriptor, AssetSource, AssetsApi } from './types';

const ATLAS = {
  pages: ['cozy.png'],
  atlas: { size: 32, distanceRange: 4, width: 64, height: 64, yOrigin: 'top' },
  metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.75, descender: -0.25 },
  glyphs: [
    {
      unicode: 65,
      advance: 0.6,
      planeBounds: { left: 0, bottom: 0, right: 0.5, top: 1 },
      atlasBounds: { left: 0, top: 0, right: 16, bottom: 32 },
    },
  ],
};

interface Recorded {
  source: AssetSource;
}

function fakeAssets(): { assets: AssetsApi; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const page = Texture.fromPixels(64, 64, new Uint8Array(64 * 64 * 4));
  const assets = {
    load(source: AssetSource): Promise<unknown> {
      calls.push({ source });
      return Promise.resolve({
        key: 'page',
        kind: 'texture',
        state: 'loaded',
        value: { texture: page, width: 64, height: 64 },
        release(): void {},
      });
    },
  } as unknown as AssetsApi;
  return { assets, calls };
}

function bytes(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

const descriptor = (extra?: Partial<AssetDescriptor>): AssetDescriptor => ({
  url: 'https://x.test/fonts/cozy.json',
  kind: 'font',
  ...extra,
});

describe('loadFontAsset', () => {
  it('loads the page named by the JSON, relative to the JSON', async () => {
    const { assets, calls } = fakeAssets();
    const font = await loadFontAsset(
      assets,
      'https://x.test/fonts/cozy.json',
      bytes(ATLAS),
      descriptor(),
    );
    expect(calls).toHaveLength(1);
    const source = calls[0].source as AssetDescriptor;
    expect(source.url).toBe('https://x.test/fonts/cozy.png');
    expect(source.kind).toBe('texture');
    // A distance field is never atlas-packed and never re-premultiplied.
    expect(source.texture).toEqual({ premultiplied: true, atlas: false });
    expect(font.size).toBe(32);
    expect(font.glyph(65)?.advance).toBeCloseTo(19.2);
  });

  it('prefers an explicit page URL and keeps its texture options', async () => {
    const { assets, calls } = fakeAssets();
    await loadFontAsset(
      assets,
      'https://x.test/fonts/cozy.json',
      bytes(ATLAS),
      descriptor({
        font: { page: '../pages/atlas.png', texture: { nearest: true } },
      }),
    );
    const source = calls[0].source as AssetDescriptor;
    expect(source.url).toBe('https://x.test/pages/atlas.png');
    expect(source.texture?.nearest).toBe(true);
  });

  it('falls back to the JSON URL with a png extension', async () => {
    const { assets, calls } = fakeAssets();
    const atlas = { ...ATLAS, pages: undefined };
    await loadFontAsset(
      assets,
      'https://x.test/fonts/cozy.json?v=2',
      bytes(atlas),
      descriptor(),
    );
    expect((calls[0].source as AssetDescriptor).url).toBe(
      'https://x.test/fonts/cozy.png?v=2',
    );
  });

  it('reports a broken JSON as LOAD_FAILED', async () => {
    const { assets } = fakeAssets();
    const broken = new TextEncoder().encode('{ nope');
    await expect(
      loadFontAsset(
        assets,
        'https://x.test/fonts/cozy.json',
        broken.buffer as ArrayBuffer,
        descriptor(),
      ),
    ).rejects.toThrow(/font https:/);
  });
});
