/**
 * The `kind: 'font'` asset (ARCHITECTURE §23.3, §15.2).
 *
 * A font asset is an atlas JSON plus its page image: this module loads the
 * page through the same `AssetsApi` (so it is cached, refcounted, atlased and
 * budgeted like any texture) and hands both to the MSDF parser. It is reached
 * only through a dynamic import from Assets.ts, so a program without text
 * carries no font code.
 *
 * The page URL comes from `descriptor.font.page`, else from the JSON itself
 * (`pages[0]` / `atlas.image`), else from the JSON's own URL with a `.png`
 * extension. The page is never atlas-packed (a font page is large and its
 * texels are a distance field, not colour) and is uploaded as-is: an MSDF
 * page is opaque, so premultiplying it would only round its channels.
 */
import { parseMsdfFont, msdfPageUrl } from '../text/msdf';
import type { FontAsset } from '../text/types';
import { CozyGPUError } from '../types/errors';
import type {
  AssetDescriptor,
  AssetHandle,
  AssetsApi,
  TextureAsset,
} from './types';

function resolve(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** `fonts/inter.json?v=2` → `fonts/inter.png?v=2`. */
function pageFromJsonUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const tail = cut < 0 ? '' : url.slice(cut);
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return (dot > slash ? path.slice(0, dot) : path) + '.png' + tail;
}

export async function loadFontAsset(
  assets: AssetsApi,
  url: string,
  data: ArrayBuffer,
  descriptor: AssetDescriptor,
  signal?: AbortSignal,
  /**
   * The font entry's child handles. The page is pushed here so unloading the
   * font releases it too; without it the page keeps one reference forever.
   */
  children?: AssetHandle[],
): Promise<FontAsset> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    throw new CozyGPUError(
      'LOAD_FAILED',
      `font ${url}: ${(error as Error).message}`,
    );
  }
  const options = descriptor.font;
  const named = options?.page ?? msdfPageUrl(json);
  const pageUrl =
    named !== null && named !== undefined
      ? resolve(named, url)
      : pageFromJsonUrl(url);
  const handle = await assets.load<TextureAsset>(
    {
      url: pageUrl,
      kind: 'texture',
      texture: { premultiplied: true, atlas: false, ...options?.texture },
    },
    { signal },
  );
  children?.push(handle);
  return parseMsdfFont(json, handle.value.texture);
}
