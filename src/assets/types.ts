/**
 * Asset loader public API (M2), implemented in src/assets/**. Spec: docs/ARCHITECTURE.md
 * §15 and docs/API.md "Assets".
 *
 * Design decisions (normative):
 *  - Loading, parsing and the cache live on the FRONT (main thread) in both
 *    renderer modes. Images are decoded with createImageBitmap (off the main
 *    thread's decode path) and the ImageBitmap / KTX2 level ArrayBuffers are
 *    TRANSFERRED to the core with the frame packet. The front keeps sizes and
 *    metadata only: textures are GPU-only unless `keepPixels` / `hitMask`.
 *  - Device loss: GPU-only textures are reloaded from their URL (HTTP cache)
 *    by the asset manager after `deviceRestored`; sprites keep their handles.
 *  - No WebGPU/WebGL types; no bundled WASM. Basis/UASTC and zstd go through
 *    the optional, lazily loaded `TextureTranscoder` hook.
 */
import type { TextureFormat } from '../backend/types';
import type { TextureHandle } from '../scene/types';

// ─── Formats ──────────────────────────────────────────────────────────────────

/** Detected container/format (extension first, confirmed or overridden by magic bytes). */
export type AssetFormat =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'avif'
  | 'gif'
  | 'ktx2'
  | 'basis'
  | 'json'
  | 'text'
  | 'binary';

/** What a loaded asset is. */
export type AssetKind =
  /** GPU texture (value: TextureAsset). */
  | 'texture'
  /** TexturePacker-style JSON + its page image (value: SpritesheetAsset). */
  | 'spritesheet'
  /** Parsed JSON kept in memory (value: unknown). */
  | 'json'
  | 'text'
  /** ArrayBuffer kept in memory. */
  | 'binary'
  /** M3. MSDF font: atlas JSON + page image (value: FontAsset, src/text/types.ts). */
  | 'font';

/** Compressed / uncompressed targets a transcoder may emit. */
export type TranscodeTarget =
  | 'astc-4x4-unorm'
  | 'bc7-rgba-unorm'
  | 'bc3-rgba-unorm'
  | 'bc1-rgba-unorm'
  | 'etc2-rgba8unorm'
  | 'etc2-rgb8unorm'
  | 'rgba8unorm';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface TextureAssetOptions {
  /** Nearest-neighbour sampling. Default false. */
  nearest?: boolean;
  /** Repeat addressing (never atlas-packed). Default false. */
  repeat?: boolean;
  /**
   * Mip chain. Images: generated on the GPU after upload. KTX2: the levels in
   * the file are used; a single-level uncompressed KTX2 is GPU-generated.
   * Compressed single-level files cannot be generated (warns once).
   * Default: AssetsOptions.mipmaps (false).
   */
  mipmaps?: boolean;
  /** Pixels are already premultiplied (KTX2 KHR_DF_FLAG_ALPHA_PREMULTIPLIED sets it). */
  premultiplied?: boolean;
  /** Keep straight RGBA8 pixels on the CPU (`TextureAsset.pixels`). Default false. */
  keepPixels?: boolean;
  /**
   * Keep a 1-bit alpha mask on the CPU for `TextureAsset.hitTest` (1/32 of the
   * RGBA size). `true` = alpha >= 128. Default false.
   */
  hitMask?: boolean | { threshold: number };
  /**
   * Allow packing into a shared atlas page when small enough
   * (AssetsOptions.atlas). Default true. Ignored for repeat, KTX2 and
   * keepPixels textures.
   */
  atlas?: boolean;
}

export interface AssetDescriptor {
  /** Relative URLs resolve against AssetsOptions.baseUrl. */
  url: string;
  /** Cache key; default the resolved URL. Aliases must be unique per manager. */
  alias?: string;
  /** Override detection (e.g. extension-less URLs). */
  kind?: AssetKind;
  texture?: TextureAssetOptions;
  /** M3. Options for `kind: 'font'`. */
  font?: FontAssetOptions;
}

/** M3. How a font atlas page is loaded (ARCHITECTURE §23.3). */
export interface FontAssetOptions {
  /**
   * Page image URL. Default: the atlas JSON's own `pages[0]`, resolved
   * against the JSON's URL.
   */
  page?: string;
  /** Texture options for the page. Default: linear, no mipmaps, not atlased. */
  texture?: TextureAssetOptions;
}

export type AssetSource = string | AssetDescriptor;

export interface LoadOptions {
  /** Aborting rejects with CozyGPUError('ABORTED') and releases what this call acquired. */
  signal?: AbortSignal;
  /** Called with monotonically increasing progress (bundles: across all entries). */
  onProgress?: (progress: LoadProgress) => void;
}

export interface LoadProgress {
  readonly loaded: number;
  readonly total: number;
  /** loaded / total, 0..1. */
  readonly ratio: number;
}

/** Hook for Basis Universal (ETC1S/UASTC) and zstd-supercompressed KTX2. */
export interface TextureTranscoder {
  /**
   * `targets` is ordered by preference from the renderer's caps
   * (astc > bc7 > etc2 > bc3/bc1 > rgba8). May run in the transcoder's own
   * worker; must transfer, not copy, level buffers where possible.
   */
  transcode(request: TranscodeRequest): Promise<TranscodedTexture>;
}

export interface TranscodeRequest {
  readonly data: ArrayBuffer;
  readonly container: 'ktx2' | 'basis';
  readonly targets: readonly TranscodeTarget[];
  readonly signal?: AbortSignal;
}

export interface TranscodedTexture {
  readonly format: TranscodeTarget;
  readonly width: number;
  readonly height: number;
  /** Level 0 first; each buffer holds exactly one level. */
  readonly levels: readonly ArrayBuffer[];
  readonly premultiplied?: boolean;
}

export interface AssetsOptions {
  /** Base for relative URLs. Default: document base URL (or worker location). */
  baseUrl?: string;
  /** Parallel fetch+decode jobs. Default 6. */
  concurrency?: number;
  /**
   * GPU texture budget in MiB (estimated: texels × bytes per texel × mip
   * factor 4/3). Unreferenced textures are evicted LRU beyond it; referenced
   * ones never are (warns once when those alone exceed it). 0 = unlimited.
   * Default 512.
   */
  gpuBudgetMB?: number;
  /** Default for TextureAssetOptions.mipmaps. Default false. */
  mipmaps?: boolean;
  /**
   * Automatic atlas packing of small images (skyline packer into shared
   * pages, so sprites using them batch). `false` disables. Default
   * `{ pageSize: 2048, maxImageSize: 256, padding: 2 }`.
   */
  atlas?:
    | false
    | { pageSize?: number; maxImageSize?: number; padding?: number };
  /**
   * Lazily called the first time a file needs transcoding. Without it such
   * loads reject with UNSUPPORTED. The library bundles no WASM.
   */
  transcoder?: () => Promise<TextureTranscoder>;
  /** Replaces globalThis.fetch (tests, auth headers). */
  fetch?: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
}

// ─── Values ───────────────────────────────────────────────────────────────────

export interface HitMask {
  readonly width: number;
  readonly height: number;
  /** Bit i = texel i (row-major) is opaque. */
  readonly bits: Uint8Array;
}

/** Value of a 'texture' asset. */
export interface TextureAsset {
  /** Sprite-ready handle (a sub-frame of an atlas page when packed). */
  readonly texture: TextureHandle;
  readonly width: number;
  readonly height: number;
  /** GPU format actually used (e.g. 'bc7-rgba-unorm', 'rgba8unorm'). */
  readonly format: TextureFormat;
  /** Estimated GPU bytes attributed to this asset (its share of a page when packed). */
  readonly gpuBytes: number;
  readonly packed: boolean;
  /** Only with keepPixels: straight RGBA8, row-major, top row first. */
  readonly pixels: Uint8Array | null;
  readonly hitMask: HitMask | null;
  /** Local texel coords. Needs hitMask (or keepPixels); otherwise throws INVALID_ARGUMENT. */
  hitTest(x: number, y: number): boolean;
}

/** Value of a 'spritesheet' asset (TexturePacker JSON hash/array format). */
export interface SpritesheetAsset {
  readonly page: TextureAsset;
  /** Frame name → sub-texture. Rotated frames are unsupported (LOAD_FAILED). */
  readonly frames: Readonly<Record<string, TextureHandle>>;
  /** `animations` from the JSON (frame lists), if any. */
  readonly animations: Readonly<Record<string, readonly TextureHandle[]>>;
  readonly data: unknown;
}

export type AssetState =
  | 'loading'
  | 'loaded'
  | 'failed'
  | 'evicted'
  | 'released';

/**
 * A counted reference. Every successful `load` of the same key returns a new
 * handle and adds one reference; `release()` removes exactly one (idempotent
 * per handle). At zero references GPU assets stay cached (LRU) until evicted
 * or `unload`ed; memory assets are dropped.
 */
export interface AssetHandle<T = unknown> {
  readonly key: string;
  readonly kind: AssetKind;
  readonly state: AssetState;
  /** Throws DESTROYED after release(). */
  readonly value: T;
  release(): void;
}

export interface BundleHandle {
  readonly name: string;
  /** alias (or url) → handle */
  get<T = unknown>(key: string): AssetHandle<T>;
  readonly handles: readonly AssetHandle[];
  /** Releases every handle of this bundle load. */
  release(): void;
}

export interface AssetsStats {
  readonly entries: number;
  readonly referenced: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly gpuBytes: number;
  readonly gpuBudgetBytes: number;
  readonly atlasPages: number;
  readonly evictions: number;
}

/** `renderer.assets` / `new GPU.Assets(renderer, options)`. */
export interface AssetsApi {
  load<T = unknown>(
    source: AssetSource,
    options?: LoadOptions,
  ): Promise<AssetHandle<T>>;
  /** Parallel within the concurrency limit; rejects on the first failure after releasing the rest. */
  loadAll(
    sources: readonly AssetSource[],
    options?: LoadOptions,
  ): Promise<AssetHandle[]>;
  /** Registers a named bundle (alias → source). Re-adding a name throws INVALID_ARGUMENT. */
  addBundle(name: string, entries: Readonly<Record<string, AssetSource>>): void;
  loadBundle(name: string, options?: LoadOptions): Promise<BundleHandle>;
  /** Starts fetching (not uploading) sources in the background at low priority. */
  preload(sources: readonly AssetSource[]): void;
  /** Peek: the cached value if loaded, without adding a reference. */
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  /** Drops a zero-reference entry now (GPU texture destroyed). Throws INVALID_ARGUMENT if referenced. */
  unload(key: string): void;
  /** Evicts zero-reference GPU entries until under `targetBytes` (default: the budget). */
  trim(targetBytes?: number): void;
  readonly stats: AssetsStats;
  /** Pure: detection used by `load` (exposed for tools/tests). */
  detectFormat(url: string, head?: Uint8Array): AssetFormat;
  /** Rejects in-flight loads (ABORTED), destroys every cached GPU texture. */
  destroy(): void;
}
