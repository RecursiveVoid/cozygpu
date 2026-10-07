/**
 * TexturePacker JSON (hash and array formats) and CPU alpha
 * masks. Pure, Node-tested.
 */
import { CozyGPUError } from '../types/errors';
import type { HitMask } from './types';

export interface SheetFrame {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ParsedSheet {
  readonly image: string;
  readonly frames: readonly SheetFrame[];
  readonly animations: Readonly<Record<string, readonly string[]>>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for `{ frames: …, meta: { image: string } }`. */
export function isSpritesheetJson(data: unknown): boolean {
  return (
    isObject(data) &&
    (isObject(data.frames) || Array.isArray(data.frames)) &&
    isObject(data.meta) &&
    typeof data.meta.image === 'string'
  );
}

function bad(message: string): never {
  throw new CozyGPUError('LOAD_FAILED', `spritesheet: ${message}`);
}

function readFrame(name: string, raw: unknown): SheetFrame {
  if (!isObject(raw) || !isObject(raw.frame))
    bad(`frame "${name}" has no rect`);
  if (raw.rotated === true) bad(`frame "${name}" is rotated (unsupported)`);
  const r = raw.frame;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.w);
  const height = Number(r.h);
  if (!(x >= 0 && y >= 0 && width > 0 && height > 0)) {
    bad(`frame "${name}" has an invalid rect`);
  }
  return { name, x, y, width, height };
}

export function parseSpritesheet(data: unknown): ParsedSheet {
  if (!isSpritesheetJson(data)) bad('missing frames or meta.image');
  const json = data as Json;
  const frames: SheetFrame[] = [];
  const raw = json.frames;
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      const name =
        isObject(entry) && typeof entry.filename === 'string'
          ? entry.filename
          : bad(`frame ${i} has no filename`);
      frames.push(readFrame(name, entry));
    }
  } else {
    const keys = Object.keys(raw as Json);
    for (let i = 0; i < keys.length; i++) {
      frames.push(readFrame(keys[i], (raw as Json)[keys[i]]));
    }
  }
  const animations: Record<string, readonly string[]> = {};
  if (isObject(json.animations)) {
    const names = Object.keys(json.animations);
    for (let i = 0; i < names.length; i++) {
      const list = json.animations[names[i]];
      if (!Array.isArray(list)) bad(`animation "${names[i]}" is not a list`);
      animations[names[i]] = list.map(String);
    }
  }
  return { image: (json.meta as Json).image as string, frames, animations };
}

/**
 * Validates frames against the page size and resolves animation names.
 * Unknown animation frames fail LOAD_FAILED.
 */
export function checkSheet(
  sheet: ParsedSheet,
  pageWidth: number,
  pageHeight: number,
): void {
  const names = new Set<string>();
  for (let i = 0; i < sheet.frames.length; i++) {
    const f = sheet.frames[i];
    if (f.x + f.width > pageWidth || f.y + f.height > pageHeight) {
      bad(`frame "${f.name}" lies outside the ${pageWidth}×${pageHeight} page`);
    }
    names.add(f.name);
  }
  const anims = Object.keys(sheet.animations);
  for (let i = 0; i < anims.length; i++) {
    const list = sheet.animations[anims[i]];
    for (let j = 0; j < list.length; j++) {
      if (!names.has(list[j]))
        bad(`animation "${anims[i]}" uses unknown frame "${list[j]}"`);
    }
  }
}

/** 1-bit mask from straight RGBA8 rows (bit set = alpha >= threshold). */
export function buildHitMask(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 128,
): HitMask {
  const texels = width * height;
  const bits = new Uint8Array((texels + 7) >> 3);
  for (let i = 0; i < texels; i++) {
    if (pixels[i * 4 + 3] >= threshold) bits[i >> 3] |= 1 << (i & 7);
  }
  return { width, height, bits };
}

export function testHitMask(mask: HitMask, x: number, y: number): boolean {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return false;
  const i = iy * mask.width + ix;
  return (mask.bits[i >> 3] & (1 << (i & 7))) !== 0;
}
