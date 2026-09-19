/**
 * cozygpu public entry. EXPORTS ONLY — no side effects (package.json
 * "sideEffects": false).
 *
 *   import * as GPU from 'cozygpu';
 *   const renderer = await GPU.createRenderer({ canvas });
 *
 * Rule: nothing exported here may expose WebGPU/WebGL types.
 */

// ─── Renderer ────────────────────────────────────────────────────────────────
export { createRenderer } from './renderer/createRenderer';
export type {
  PickHit,
  Renderer,
  RendererOptions,
  RendererInfo,
  RendererStats,
} from './types/renderer';
// M2.5 integration hooks (types only; ARCHITECTURE §19)
export type { EventName, Events, EventSink } from './types/events';
export type {
  ExternalInstanceBuffer,
  ExternalInstanceBufferDesc,
  ExternalLayout,
  RendererInterop,
} from './types/interop';

// ─── Scene graph (tier 1) ────────────────────────────────────────────────────
export { Container, Sprite, Texture, loadTexture } from './scene';
export { BulkField } from './scene/types';
export type {
  BindColumnsOptions,
  BulkChildren,
  ColumnBinding,
  ColumnSource,
  ContainerOptions,
  ContainerNode,
  DestroyOptions,
  NodeKind,
  NodeOptions,
  SceneNode,
  SpriteColumns,
  SpriteNode,
  SpriteOptions,
  TextureFrame,
  TextureHandle,
  TextureInput,
  TextureOptions,
} from './scene';

// ─── Swarm (tier 2) ──────────────────────────────────────────────────────────
export { Swarm, behaviors, defineBehavior } from './swarm';
/** WebGL2 swarm ceilings: refuse above MAX, warn once above WARN (§14.2). */
export { SWARM_GL_MAX_CAPACITY, SWARM_GL_WARN_CAPACITY } from './swarm';
export type {
  Behavior,
  BehaviorDefinition,
  BuiltinBehaviors,
  ParamSpec,
  ParamType,
  ParamValue,
  ParamValues,
  Range,
  SpawnOptions,
  SwarmExternalSource,
  SwarmNode,
  SwarmOptions,
} from './swarm';

// ─── Assets (M2) ─────────────────────────────────────────────────────────────
// Types only. The implementation is reached through `renderer.assets`
// (configured with `RendererOptions.assets`), which lazily imports its own
// chunk — exporting the class here would pin it into every program (§18.1).
export type {
  AssetDescriptor,
  AssetFormat,
  AssetHandle,
  AssetKind,
  AssetSource,
  AssetState,
  AssetsApi,
  AssetsOptions,
  AssetsStats,
  BundleHandle,
  HitMask,
  LoadOptions,
  LoadProgress,
  SpritesheetAsset,
  TextureAsset,
  TextureAssetOptions,
  TextureTranscoder,
  TranscodedTexture,
  TranscodeRequest,
  TranscodeTarget,
} from './assets';

// ─── Ticker (optional) ───────────────────────────────────────────────────────
export { ticker } from './ticker';
export type { Ticker, TickerCallback, TickerOptions } from './ticker';

// ─── Utilities & shared types ────────────────────────────────────────────────
export { packRGBA8, packHex, toPackedColor } from './math/color';
export type { ColorSource, PackedColor } from './math/types';
/** Byte layouts for Swarm.write() and custom WGSL (see docs/ARCHITECTURE.md §4). */
export * as layouts from './types/layouts';
export type {
  BackendKind,
  BackendPreference,
  BlendMode,
  Capabilities,
  ShaderLanguage,
} from './backend/types';
export { CozyGPUError } from './types/errors';
export type { CozyGPUErrorCode } from './types/errors';

export const VERSION = '0.0.1';
