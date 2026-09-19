/** Owner: "worker". Shared UTF-8 helpers for the command stream (lazy, one instance per thread). */

let encoder: TextEncoder | null = null;
let decoder: TextDecoder | null = null;

export function sharedTextEncoder(): TextEncoder {
  return encoder ?? (encoder = new TextEncoder());
}

export function sharedTextDecoder(): TextDecoder {
  return decoder ?? (decoder = new TextDecoder());
}

/**
 * Exact UTF-8 byte length of `text` without encoding it (no allocation).
 * Use it to size `CommandWriter.begin()` before `utf8(text)`. Lone surrogates
 * count as 3 bytes (U+FFFD), matching TextEncoder.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Rounds up to the next multiple of 4. */
export function align4(n: number): number {
  return (n + 3) & ~3;
}
