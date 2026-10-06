/**
 * Front half of filter chains (ARCHITECTURE §22.5).
 * Loaded lazily by `Group` the first time a chain is set; it registers the
 * core system, which travels in the same chunk (`filter-core`).
 *
 * It resolves every `Filter` to a program (loading the built-ins chunk when
 * the chain uses one), decides whether the chain is cheap enough to compile
 * into the sprite batch effect instead of a render target (§22.7), keeps the
 * uniform mirrors, and emits FILTER_DEFINE / FILTER_SET_UNIFORMS /
 * FILTER_BEGIN / FILTER_END. Zero allocations per frame.
 */
import { BlendModeId } from '../backend/types';
import type { ShaderLanguage } from '../backend/types';
import {
  FILTER_MAP_MASK,
  FILTER_MAP_SHIFT,
  FilterFlag,
  Op,
  OpcodeRange,
  CommandFlag,
  FilterOp,
} from '../commands/opcodes';
import { utf8ByteLength } from '../commands/utf8';
import { registerCoreSystemFactory } from '../renderer/lazySystems';
import { ensureTextureUploaded } from '../scene/Texture';
import type { ContainerNode } from '../scene/types';
import { createIdAllocator } from '../types/ids';
import type { FrontFrame } from '../types/core';
import { CozyGPUError } from '../types/errors';
import { FILTER_MAX_PASSES, SPRITE_EFFECT_BYTES } from '../types/layouts';
import { createFilterCoreSystem } from './core';
import {
  concatColorMatrix,
  glslParamMembers,
  identityColorMatrix,
  packSpriteEffect,
  wgslParamMembers,
} from './layout';
import type { FilterInternal } from './presets';
import type { Filter, FilterBinding, FilterOptions } from './types';

registerCoreSystemFactory(OpcodeRange.FILTER, createFilterCoreSystem);

const filterIds = createIdAllocator();
const effectIds = createIdAllocator();

/** The built-ins chunk, once something asked for a built-in program. */
type BuiltinModule = typeof import('./builtin');
let builtins: BuiltinModule | null = null;
let builtinsLoading: Promise<void> | null = null;

/**
 * The built-in programs are a chunk of their own (`filters-builtin`): a
 * chain of only custom filters never fetches them.
 */
export function loadBuiltinFilters(): Promise<typeof import('./builtin')> {
  return import('./builtin');
}

function requestBuiltins(): void {
  if (builtins || builtinsLoading) return;
  builtinsLoading = loadBuiltinFilters().then(
    module => {
      builtins = module;
      builtinsLoading = null;
    },
    () => {
      builtinsLoading = null;
    },
  );
}

// ─── Shader composition (ARCHITECTURE §22.3) ──────────────────────────────────

const WGSL_PRELUDE_MEMBERS =
  '  @size(8) texel: vec2f,\n' +
  '  @size(8) size: vec2f,\n' +
  '  @size(16) area: vec4f,\n' +
  '  @size(4) time: f32,\n' +
  '  @size(4) passIndex: u32,\n' +
  '  @size(8) unit: vec2f,\n';

const GLSL_PRELUDE_MEMBERS =
  '  vec2 texel;\n' +
  '  vec2 size;\n' +
  '  vec4 area;\n' +
  '  float time;\n' +
  '  uint passIndex;\n' +
  '  vec2 unit;\n';

const GLSL_HEAD =
  '#version 300 es\nprecision highp float;\nprecision highp int;\n' +
  'uniform sampler2D G1_B0;\nuniform sampler2D G3_B0;\n' +
  'layout(std140) uniform G2_B0 {\n';

const GLSL_TAIL =
  '} fpass;\nin vec2 vUv;\nlayout(location = 0) out vec4 fragColor;\n' +
  'vec4 cozySample(vec2 uv) { return texture(G1_B0, vec2(uv.x, 1.0 - uv.y)); }\n' +
  'vec4 cozySampleAux(vec2 uv) { return texture(G3_B0, vec2(uv.x, 1.0 - uv.y)); }\n';

/**
 * Composes a filter's fragment source for `language`: the pass uniform block
 * (prelude + the filter's params) followed by its body, with `$params.` bound
 * to the block. Runs once per program, never per frame.
 */
export function composeFilterSource(
  filter: FilterInternal,
  language: ShaderLanguage,
): string {
  const definition =
    filter._definition ??
    (builtins && filter._builtin
      ? builtins.builtinFilterDefinition(filter._builtin)
      : null);
  if (!definition) return '';
  const body = language === 'wgsl' ? definition.wgsl : definition.glsl;
  if (!body) return '';
  const layout = filter._layout;
  const source =
    language === 'wgsl'
      ? 'struct FilterPass {\n' +
        WGSL_PRELUDE_MEMBERS +
        wgslParamMembers(layout) +
        '}\n@group(2) @binding(0) var<uniform> fpass: FilterPass;\n\n' +
        body
      : GLSL_HEAD +
        GLSL_PRELUDE_MEMBERS +
        glslParamMembers(layout) +
        GLSL_TAIL +
        '\n' +
        body;
  const bound = source.split('$params.').join('fpass.');
  if (bound.indexOf('$params') >= 0) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `filter "${filter.name}" uses $params without a member`,
    );
  }
  return bound;
}

// ─── Per-chain state ──────────────────────────────────────────────────────────

/** One resolved program of a chain (a filter instance, not a shader). */
interface Program {
  filter: FilterInternal;
  id: number;
  source: string;
  passes: number;
  flags: number;
  /** Renderer generation the FILTER_DEFINE was sent for (-1 = never). */
  defined: number;
  /** `filter._version` at the last FILTER_SET_UNIFORMS. */
  uploaded: number;
}

const DEFAULT_OPTIONS: FilterOptions = {};

class FilterBindingImpl implements FilterBinding {
  /** Leading run of cheap filters, folded into the sprite batch (§22.7). */
  private readonly cheapRun: FilterInternal[] = [];
  /** The rest of the chain; each one takes passes over a pooled target. */
  private readonly programs: Program[] = [];
  private options: FilterOptions = DEFAULT_OPTIONS;
  private chain: readonly Filter[] | null = null;
  /** Chain structure changed: programs must be rebuilt before the next frame. */
  private stale = true;
  /** Every program has a source for the renderer's language. */
  private resolved = false;
  private language: ShaderLanguage | null = null;
  private generation = -1;

  private effectId = 0;
  private readonly effect = new Float32Array(SPRITE_EFFECT_BYTES >> 2);
  private readonly effectU32 = new Uint32Array(this.effect.buffer);
  private effectVersion = -1;
  private effectUploaded = -1;

  /** FILTER_END's chain, filled on update, never per frame. */
  private idList = new Uint32Array(FILTER_MAX_PASSES);
  private idCount = 0;
  /** Reused scratch for the 4×5 matrix of the cheap run. */
  private readonly matrix = new Float32Array(20);
  private readonly scratch = new Float32Array(20);

  /** Set between emitBegin and emitEnd. */
  private beganCheap = false;
  private beganTarget = false;
  private destroyed = false;

  constructor(private readonly group: ContainerNode) {}

  get cheap(): boolean {
    return this.programs.length === 0 && this.cheapRun.length > 0;
  }

  update(chain: readonly Filter[] | null, options?: FilterOptions): void {
    if (this.destroyed) return;
    this.chain = chain;
    this.options = options ?? DEFAULT_OPTIONS;
    this.stale = true;
    this.resolved = false;
  }

  /** Splits the chain and (re)builds the program list. Never per frame. */
  private rebuild(language: ShaderLanguage): void {
    for (let i = 0; i < this.programs.length; i++) {
      filterIds.free(this.programs[i].id);
    }
    this.programs.length = 0;
    this.cheapRun.length = 0;
    this.stale = false;
    this.resolved = true;
    this.language = language;
    const chain = this.chain;
    if (!chain) return;
    let cheapPrefix = true;
    for (let i = 0; i < chain.length; i++) {
      const f = chain[i] as FilterInternal;
      if (!f.enabled) continue;
      if (cheapPrefix && f.cheap) {
        this.cheapRun.push(f);
        continue;
      }
      cheapPrefix = false;
      if (this.programs.length >= FILTER_MAX_PASSES) break;
      if (f._builtin && !builtins) {
        requestBuiltins();
        this.resolved = false;
        continue;
      }
      const source = composeFilterSource(f, language);
      if (source === '') {
        // No shader for this backend: skip it, the rest of the chain runs.
        reportUnsupported(f.name, language);
        continue;
      }
      const definition =
        f._definition ??
        (builtins && f._builtin
          ? builtins.builtinFilterDefinition(f._builtin)
          : null);
      let flags = 0;
      if (definition?.halfResolution) flags |= FilterFlag.HALF_RESOLUTION;
      const mapAt = f._layout.names.indexOf('map');
      if (mapAt >= 0) {
        flags |=
          (((f._layout.offsets[mapAt] >> 2) + 1) & FILTER_MAP_MASK) <<
          FILTER_MAP_SHIFT;
      }
      this.programs.push({
        filter: f,
        id: filterIds.alloc(),
        source,
        passes: Math.max(
          1,
          Math.min(FILTER_MAX_PASSES, definition?.passes ?? 1),
        ),
        flags,
        defined: -1,
        uploaded: -1,
      });
    }
    if (this.programs.length > this.idList.length) {
      this.idList = new Uint32Array(this.programs.length);
    }
    this.idCount = this.programs.length;
    for (let i = 0; i < this.programs.length; i++) {
      this.idList[i] = this.programs[i].id;
    }
    this.effectVersion = -1;
  }

  /** Physical-pixel padding the chain reads outside the group's bounds. */
  private padding(): number {
    let pad = 0;
    for (let i = 0; i < this.programs.length; i++) {
      const p = this.programs[i].filter._padding;
      if (p > pad) pad = p;
    }
    return pad;
  }

  /** Repacks the cheap run into the sprite effect block when it moved. */
  private updateEffect(): void {
    let version = 0;
    for (let i = 0; i < this.cheapRun.length; i++) {
      version = version * 131 + this.cheapRun[i]._version;
    }
    if (version === this.effectVersion) return;
    this.effectVersion = version;
    const m = identityColorMatrix(this.matrix);
    let any = false;
    for (let i = 0; i < this.cheapRun.length; i++) {
      const rows = (this.cheapRun[i] as unknown as { _rows?: Float32Array })
        ._rows;
      if (!rows) continue;
      any = true;
      concatColorMatrix(m, rows, this.scratch);
    }
    packSpriteEffect(this.effect, this.effectU32, 0, any ? m : null, 0, 0, 0);
  }

  emitBegin(
    frame: FrontFrame,
    _world: Float32Array,
    _worldOffset: number,
    worldAlpha: number,
  ): boolean {
    if (this.destroyed || !this.chain) return true;
    if (this.stale || this.language !== frame.caps.shaderLanguage) {
      this.rebuild(frame.caps.shaderLanguage);
    }
    const needsTarget = this.programs.length > 0 || !this.resolved;
    if (needsTarget) {
      if (!this.resolved) {
        // Built-in shaders have not landed yet: the group must not draw
        // unfiltered, so skip the subtree for this frame.
        this.stale = true;
        return false;
      }
      if (!frame.isSystemReady(OpcodeRange.FILTER)) return false;
    }
    if (frame.generation !== this.generation) {
      this.generation = frame.generation;
      for (let i = 0; i < this.programs.length; i++) {
        this.programs[i].defined = -1;
        this.programs[i].uploaded = -1;
      }
      this.effectUploaded = -1;
      if (this.effectId !== 0) {
        effectIds.free(this.effectId);
        this.effectId = 0;
      }
    }

    // 1. Cheap run: one uniform, no pass, no target (ARCHITECTURE §22.7).
    this.beganCheap = false;
    if (this.cheapRun.length > 0) {
      this.updateEffect();
      if (this.effectId === 0) this.effectId = effectIds.alloc();
      const encoder = frame.encoder;
      if (this.effectUploaded !== this.effectVersion) {
        this.effectUploaded = this.effectVersion;
        encoder.begin(Op.SPRITE_DEFINE_EFFECT, 4 + SPRITE_EFFECT_BYTES);
        encoder.u32(this.effectId);
        encoder.bytes(this.effectU32, 0, SPRITE_EFFECT_BYTES);
      }
      encoder.begin(Op.SPRITE_SET_EFFECT, 4, CommandFlag.DRAW);
      encoder.u32(this.effectId);
      this.beganCheap = true;
    }

    // 2. The rest of the chain captures into a pooled target.
    this.beganTarget = false;
    if (this.programs.length === 0) return true;
    const encoder = frame.encoder;
    for (let i = 0; i < this.programs.length; i++) {
      const p = this.programs[i];
      const f = p.filter;
      if (f._map) {
        const texId = ensureTextureUploaded(frame, f._map);
        const at = (p.flags >>> FILTER_MAP_SHIFT) & FILTER_MAP_MASK;
        if (at > 0) {
          f._u32[at - 1] = texId;
          if (p.uploaded === f._version) p.uploaded = -1;
        }
      }
      if (p.defined !== this.generation) {
        p.defined = this.generation;
        p.uploaded = -1;
        const srcBytes = utf8ByteLength(p.source);
        encoder.begin(FilterOp.FILTER_DEFINE, 20 + srcBytes);
        encoder.u32(p.id);
        encoder.u32(p.passes);
        encoder.u32(f._layout.bytes);
        encoder.u32(p.flags);
        encoder.u32(srcBytes);
        encoder.utf8(p.source);
      }
      if (p.uploaded !== f._version) {
        p.uploaded = f._version;
        const bytes = f._layout.bytes;
        encoder.begin(FilterOp.FILTER_SET_UNIFORMS, 12 + bytes);
        encoder.u32(p.id);
        encoder.u32(0);
        encoder.u32(bytes);
        encoder.bytes(f._u32, 0, bytes);
      }
    }

    // Area: the group's bounds are not tracked (no bounds API in M3), so the
    // default is the whole canvas; `filterOptions.area` narrows it.
    const options = this.options;
    const pad = this.padding();
    let x = 0;
    let y = 0;
    let w = frame.cssWidth;
    let h = frame.cssHeight;
    const area = options.area;
    if (area) {
      x = Math.max(0, area.x - pad);
      y = Math.max(0, area.y - pad);
      w = Math.min(frame.cssWidth - x, area.width + pad * 2);
      h = Math.min(frame.cssHeight - y, area.height + pad * 2);
    }
    if (w <= 0 || h <= 0) {
      // The subtree is skipped, so emitEnd never runs: the cheap run's effect
      // would stay bound for the rest of the frame and tint everything after.
      this.endCheap(encoder);
      return false;
    }
    let flags = 0;
    if (options.keepTarget) flags |= FilterFlag.KEEP_TARGET;
    encoder.begin(
      FilterOp.FILTER_BEGIN,
      28,
      CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    encoder.u32(this.group.id);
    encoder.f32(x);
    encoder.f32(y);
    encoder.f32(w);
    encoder.f32(h);
    encoder.f32(options.resolution ?? 1);
    encoder.u32(flags);
    this.alpha = worldAlpha;
    this.beganTarget = true;
    return true;
  }

  private alpha = 1;

  /** Unbinds the cheap run's effect block, once, if it was bound. */
  private endCheap(encoder: FrontFrame['encoder']): void {
    if (!this.beganCheap) return;
    this.beganCheap = false;
    encoder.begin(Op.SPRITE_SET_EFFECT, 4, CommandFlag.DRAW);
    encoder.u32(0);
  }

  emitEnd(frame: FrontFrame): void {
    const encoder = frame.encoder;
    this.endCheap(encoder);
    if (!this.beganTarget) return;
    this.beganTarget = false;
    const count = this.idCount;
    encoder.begin(
      FilterOp.FILTER_END,
      16 + count * 4,
      CommandFlag.DRAW | CommandFlag.PASS_BREAK,
    );
    encoder.u32(this.group.id);
    encoder.u32(BlendModeId[this.options.blendMode ?? 'normal']);
    encoder.f32(this.alpha);
    encoder.u32(count);
    for (let i = 0; i < count; i++) encoder.u32(this.idList[i]);
  }

  destroy(): void {
    this.destroyed = true;
    for (let i = 0; i < this.programs.length; i++) {
      filterIds.free(this.programs[i].id);
    }
    this.programs.length = 0;
    this.cheapRun.length = 0;
    if (this.effectId !== 0) {
      effectIds.free(this.effectId);
      this.effectId = 0;
    }
    this.chain = null;
  }
}

const reported = new Set<string>();
function reportUnsupported(name: string, language: ShaderLanguage): void {
  if (reported.has(name)) return;
  reported.add(name);
  const c = (globalThis as { console?: { warn(...a: unknown[]): void } })
    .console;
  c?.warn(`cozygpu: filter "${name}" has no ${language} shader; skipped`);
}

export function createFilterBinding(group: ContainerNode): FilterBinding {
  return new FilterBindingImpl(group);
}
