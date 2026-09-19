/**
 * Owner: "assets". Pure format detection (ARCHITECTURE §15.2): the URL
 * extension gives a first guess, the first bytes confirm or override it.
 * Kept compact: the `renderer.assets` proxy imports it statically.
 */
import type { AssetFormat } from './types';

/** Magic bytes (as latin1) → format; first match wins. */
const MAGIC: readonly (readonly [RegExp, AssetFormat])[] = [
  [/^\x89PNG\r\n\x1a\n/, 'png'],
  [/^\xff\xd8\xff/, 'jpeg'],
  [/^GIF8/, 'gif'],
  [/^RIFF[^]{4}WEBP/, 'webp'],
  [/^[^]{4}ftypavi[fs]/, 'avif'],
  [/^\xabKTX 20\xbb\r\n\x1a\n/, 'ktx2'],
  [/^sB/, 'basis'],
  [/^(\xef\xbb\xbf)?\s*[{[]/, 'json'],
];

/** Lower-case extension of the URL path (query and hash stripped), or ''. */
export function urlExtension(url: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(url.split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
}

function extensionFormat(ext: string): AssetFormat | undefined {
  ext = ext.toLowerCase();
  if (ext === 'jpg') return 'jpeg';
  if (/^(txt|csv|xml|svg)$/.test(ext)) return 'text';
  return /^(png|jpeg|webp|avif|gif|ktx2|basis|json)$/.test(ext)
    ? (ext as AssetFormat)
    : undefined;
}

/** Format from magic bytes only; undefined when nothing matches. */
export function sniffFormat(head: Uint8Array): AssetFormat | undefined {
  let text = '';
  for (let i = 0; i < head.length && i < 16; i++) {
    text += String.fromCharCode(head[i]);
  }
  for (const [re, format] of MAGIC) if (re.test(text)) return format;
  return undefined;
}

export function detectFormat(url: string, head?: Uint8Array): AssetFormat {
  const data = /^data:(\w+)\/(x-)?(\w+)/.exec(url);
  const guess = data
    ? data[1] === 'text'
      ? 'text'
      : extensionFormat(data[3])
    : extensionFormat(urlExtension(url));
  const sniffed = head && sniffFormat(head);
  // Binary magic always wins; a '{' inside a .txt / .csv stays text.
  if (sniffed && !(sniffed === 'json' && guess === 'text')) return sniffed;
  return guess ?? 'binary';
}

export function isImageFormat(format: AssetFormat): boolean {
  return /^(png|jpeg|webp|avif|gif)$/.test(format);
}
