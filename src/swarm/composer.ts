/**
 * Pure shader composition (unit-testable without a GPU).
 *
 * `composeSwarmShaders(behaviors, renderFlags, language)` builds, for WGSL:
 *  - compute: prelude + params structs + helpers + cs_step (behaviors inlined
 *    in order) + cs_spawn/cs_spawn_pop + cs_kill + cs_count + cs_free_init
 *    (+ cs_cull when the CULL or GPU_ALLOC internal flag is set)
 *  - render:  prelude + vs_main/fs_main/fs_pick specialized for the flags
 * For 'glsl300es' (WebGL2) the GLSL composer in ./glsl.ts produces
 * `//@STAGE` sectioned programs. It is registered when ./glsl is imported
 * (Swarm loads it with a dynamic import only on WebGL2 renderers), so WebGPU
 * bundles never carry the GLSL templates.
 *
 * Params layout (ARCHITECTURE §6.3): f32/i32/u32 size 4 align 4; vec2f size 8
 * align 8; vec3f size 12 align 16; vec4f size 16 align 16. Every behavior
 * with params gets `struct P_<name>` (size rounded up to 16) as field
 * `b_<name>` of `Params`, starting on a 16-byte boundary; `$params` in its
 * snippet becomes `params.b_<name>`. Behaviors without params get no field;
 * an empty Params gets `_pad: u32` (16 bytes).
 *
 * The layout is pinned in the WGSL with explicit `@size` on every member, so
 * it never depends on implementation layout rules (the old uniform rule
 * "a member after a struct starts on a multiple of 16" was dropped from WGSL
 * and Chrome no longer applies it).
 */
import computeTemplate from '../shaders/swarm/compute.wgsl';
import cullSource from '../shaders/swarm/cull.wgsl';
import prelude from '../shaders/swarm/prelude.wgsl';
import renderTemplate from '../shaders/swarm/render.wgsl';
import { SwarmRenderFlag } from '../types/layouts';
import { CozyGPUError } from '../types/errors';
import { SwarmInternalRenderFlag } from './constants';
import type {
  BehaviorDefinition,
  ComposedSwarmShaders,
  ParamLayoutEntry,
  ParamType,
  SwarmShaderComposer,
} from './types';

const NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const hasOwn = (o: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

/** WGSL keywords and reserved words (WGSL spec §15.2, §15.3). */
const WGSL_RESERVED_SRC =
  'alias break case const const_assert continue continuing default diagnostic ' +
  'discard else enable false fn for if let loop override requires return ' +
  'struct switch true var while NULL Self abstract active alignas alignof as ' +
  'asm asm_fragment async attribute auto await become cast catch class ' +
  'co_await co_return co_yield coherent column comptime concept constexpr ' +
  'constinit crate debugger decltype delete demote demote_to_helper do ' +
  'dynamic_cast enum explicit export extends extern external fallthrough ' +
  'filter final finally friend from fxgroup get goto groupshared highp impl ' +
  'implements import inline instanceof interface layout lowp macro ' +
  'macro_rules match mediump meta mod module move mut mutable namespace new ' +
  'nil noexcept noinline nointerpolation non_coherent noncoherent ' +
  'noperspective null nullptr of operator package packoffset partition pass ' +
  'patch pixelfragment precise precision premerge priv protected pub public ' +
  'readonly ref regardless register reinterpret_cast require resource ' +
  'restrict self set shared sizeof smooth snorm static static_assert ' +
  'static_cast std subroutine super target template this thread_local throw ' +
  'trait try type typedef typeid typename typeof union unless unorm unsafe ' +
  'unsized use using varying virtual volatile wgsl where with writeonly yield';

/**
 * GLSL ES 3.00 keywords and reserved words (spec §3.8) that WGSL allows:
 * param names become GLSL struct members on WebGL2 (swarm/glsl.ts).
 */
const GLSL_RESERVED_SRC =
  'uniform centroid flat in out inout float int void bool invariant mat2 ' +
  'mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 ' +
  'mat4x4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uint uvec2 ' +
  'uvec3 uvec4 sampler2D sampler3D samplerCube sampler2DShadow ' +
  'samplerCubeShadow sampler2DArray sampler2DArrayShadow isampler2D ' +
  'isampler3D isamplerCube isampler2DArray usampler2D usampler3D ' +
  'usamplerCube usampler2DArray atomic_uint sample common long short ' +
  'double half fixed unsigned superp input output hvec2 hvec3 hvec4 ' +
  'dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 sampler3DRect image1D image2D ' +
  'image3D imageCube iimage1D iimage2D iimage3D iimageCube uimage1D ' +
  'uimage2D uimage3D uimageCube image1DArray image2DArray iimage1DArray ' +
  'iimage2DArray uimage1DArray uimage2DArray imageBuffer iimageBuffer ' +
  'uimageBuffer sampler1D sampler1DShadow sampler1DArray ' +
  'sampler1DArrayShadow isampler1D isampler1DArray usampler1D ' +
  'usampler1DArray sampler2DRect sampler2DRectShadow isampler2DRect ' +
  'usampler2DRect samplerBuffer isamplerBuffer usamplerBuffer ' +
  'sampler2DMS isampler2DMS usampler2DMS sampler2DMSArray ' +
  'isampler2DMSArray usampler2DMSArray buffer';

/** Declarations anywhere in a WGSL source (conservative: includes locals). */
const DECL_RE =
  /\b(?:fn|struct|alias|const|override|var(?:<[^>]*>)?)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

let reservedWords: Set<string> | null = null;
let reservedNames: Set<string> | null = null;
let paramReserved: Set<string> | null = null;
/** WGSL keywords and reserved words (valid for no identifier). */
function keywords(): Set<string> {
  return (reservedWords ??= new Set(WGSL_RESERVED_SRC.split(' ')));
}
/** Keywords of either shading language (param names reach both). */
function paramKeywords(): Set<string> {
  if (paramReserved) return paramReserved;
  const set = new Set(keywords());
  const glsl = GLSL_RESERVED_SRC.split(' ');
  for (let i = 0; i < glsl.length; i++) set.add(glsl[i]);
  return (paramReserved = set);
}
/**
 * Keywords plus every name the prelude and templates declare (module scope,
 * so helpers must not reuse them). Built once, at compose time.
 */
function reserved(): Set<string> {
  if (reservedNames) return reservedNames;
  const set = new Set(keywords());
  const srcs = [prelude, computeTemplate, cullSource, renderTemplate];
  for (let k = 0; k < srcs.length; k++) {
    const src = srcs[k].replace(/\/\/[^\n]*/g, '');
    DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DECL_RE.exec(src)) !== null) set.add(m[1]);
  }
  reservedNames = set;
  return set;
}

/** Top-level helper declarations; they start at column 0 by convention. */
const HELPER_DECL_RE =
  /^(?:fn|struct|alias|const|override|var(?:<[^>]*>)?)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

/** Names of the top-level declarations in `helpers`. */
function helperNames(helpers: string): string[] {
  const out: string[] = [];
  HELPER_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HELPER_DECL_RE.exec(helpers)) !== null) out.push(m[1]);
  return out;
}

interface TypeInfo {
  readonly size: number;
  readonly align: number;
  /** Number of scalar components. */
  readonly arity: number;
}

export const PARAM_TYPE_INFO: Readonly<Record<ParamType, TypeInfo>> = {
  f32: { size: 4, align: 4, arity: 1 },
  i32: { size: 4, align: 4, arity: 1 },
  u32: { size: 4, align: 4, arity: 1 },
  vec2f: { size: 8, align: 8, arity: 2 },
  vec3f: { size: 12, align: 16, arity: 3 },
  vec4f: { size: 16, align: 16, arity: 4 },
};

/**
 * GLSL helper declarations at column 0 (functions, consts, structs). Used for
 * the prefix rule only; the GLSL compiler reports everything else.
 */
const GLSL_HELPER_DECL_RE =
  /^(?:const\s+)?(?:struct|void|bool|float|int|uint|[biu]?vec[234]|mat[234]|SwarmHot|SwarmCold)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

const roundUp = (value: number, align: number): number =>
  Math.ceil(value / align) * align;

function fail(behavior: string, message: string): never {
  throw new CozyGPUError(
    'INVALID_ARGUMENT',
    `swarm behavior "${behavior}": ${message}`,
  );
}

/**
 * Validates one behavior definition (name, params, defaults, `$params` use,
 * helper prefixes). Throws CozyGPUError('INVALID_ARGUMENT').
 */
export function validateBehavior(def: BehaviorDefinition): void {
  const name = def?.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail(String(name), 'name must match /^[a-z][a-zA-Z0-9_]*$/');
  }
  if (typeof def.update !== 'string') fail(name, '`update` must be a string');
  const params = def.params ?? {};
  const keys = Object.keys(params);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const type = params[key];
    if (
      !PARAM_NAME_RE.test(key) ||
      paramKeywords().has(key) ||
      // GLSL reserves the gl_ prefix and any identifier containing "__".
      key.startsWith('gl_') ||
      key.includes('__')
    ) {
      fail(name, `invalid param name "${key}"`);
    }
    const info = PARAM_TYPE_INFO[type];
    if (!info) fail(name, `param "${key}" has unknown type "${type}"`);
    const value = (def.defaults as Record<string, unknown> | undefined)?.[key];
    if (info.arity === 1) {
      if (typeof value !== 'number') {
        fail(name, `default for "${key}" must be a number`);
      }
    } else if (
      !Array.isArray(value) ||
      value.length !== info.arity ||
      value.some(v => typeof v !== 'number')
    ) {
      fail(name, `default for "${key}" must be ${info.arity} numbers`);
    }
  }
  if (def.groups !== undefined) {
    const g = def.groups;
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 0 || g > 255) {
      fail(name, '`groups` must be an integer bit mask in [0, 255]');
    }
  }
  if (def.glsl !== undefined) {
    if (typeof def.glsl?.update !== 'string') {
      fail(name, '`glsl.update` must be a string');
    }
    const helpers = def.glsl.helpers;
    if (helpers !== undefined) {
      if (typeof helpers !== 'string') {
        fail(name, '`glsl.helpers` must be a string');
      }
      GLSL_HELPER_DECL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = GLSL_HELPER_DECL_RE.exec(helpers)) !== null) {
        if (!m[1].startsWith(`${name}_`)) {
          fail(name, `GLSL helper "${m[1]}" must be prefixed with "${name}_"`);
        }
      }
    }
  }
  const sources =
    def.update +
    '\n' +
    (def.helpers ?? '') +
    '\n' +
    (def.glsl?.update ?? '') +
    '\n' +
    (def.glsl?.helpers ?? '');
  const refs = sources.match(/\$params\b(\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)?/g);
  if (refs) {
    if (keys.length === 0) fail(name, 'uses $params but declares no params');
    for (let r = 0; r < refs.length; r++) {
      const dot = refs[r].indexOf('.');
      if (dot < 0) continue;
      const field = refs[r].slice(dot + 1).trim();
      if (!hasOwn(params, field))
        fail(name, `unknown param "$params.${field}"`);
    }
  }
  if (def.helpers) {
    const names = helperNames(def.helpers);
    const prefix = `${name}_`;
    for (let k = 0; k < names.length; k++) {
      const helper = names[k];
      if (!helper.startsWith(prefix)) {
        fail(name, `helper "${helper}" must be prefixed with "${prefix}"`);
      }
      if (reserved().has(helper)) {
        fail(name, `helper "${helper}" redeclares a built-in name`);
      }
      if (names.indexOf(helper) !== k) {
        fail(name, `helper "${helper}" is declared twice`);
      }
    }
  }
}

export interface ParamsLayout {
  readonly wgsl: string;
  readonly paramsBytes: number;
  readonly params: ParamLayoutEntry[];
  /** Behavior name → Params field name (only behaviors with params). */
  readonly fields: Map<string, string>;
}

/**
 * Prefixes each member with `@size(next offset - own offset)` so WGSL places
 * members exactly at `offsets` and the struct is exactly `total` bytes.
 */
function sized(lines: string[], offsets: number[], total: number): string {
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : total;
    out += `${k ? '\n' : ''}  @size(${end - offsets[k]}) ${lines[k]}`;
  }
  return out;
}

/** Computes the params uniform layout and its WGSL declarations. */
export function layoutParams(
  behaviors: readonly BehaviorDefinition[],
): ParamsLayout {
  const params: ParamLayoutEntry[] = [];
  const fields = new Map<string, string>();
  const structs: string[] = [];
  const members: string[] = [];
  const structOffsets: number[] = [];
  let offset = 0;
  for (let b = 0; b < behaviors.length; b++) {
    const def = behaviors[b];
    const keys = Object.keys(def.params ?? {});
    if (keys.length === 0) continue;
    const field = `b_${def.name}`;
    fields.set(def.name, field);
    offset = roundUp(offset, 16);
    const base = offset;
    let local = 0;
    const lines: string[] = [];
    const memberOffsets: number[] = [];
    for (let k = 0; k < keys.length; k++) {
      const type = def.params[keys[k]];
      const info = PARAM_TYPE_INFO[type];
      local = roundUp(local, info.align);
      params.push({
        behavior: def.name,
        param: keys[k],
        type,
        offset: base + local,
      });
      memberOffsets.push(local);
      lines.push(`${keys[k]}: ${type}, // @offset ${local}`);
      local += info.size;
    }
    const size = roundUp(local, 16);
    structs.push(
      `struct P_${def.name} { // @size ${size}\n${sized(lines, memberOffsets, size)}\n}`,
    );
    members.push(`${field}: P_${def.name}, // @offset ${base}`);
    structOffsets.push(base);
    offset = base + size;
  }
  if (members.length === 0) {
    members.push('_pad: u32,');
    structOffsets.push(0);
    offset = 4;
  }
  const paramsBytes = Math.max(16, roundUp(offset, 16));
  structs.push(
    `struct Params { // @size ${paramsBytes}\n${sized(members, structOffsets, paramsBytes)}\n}`,
  );
  return { wgsl: structs.join('\n\n'), paramsBytes, params, fields };
}

/**
 * Replaces the line that consists of exactly `marker` (e.g. `//@SLOT`).
 * Line-anchored so `//@SLOT` never matches `//@SLOT_DECL` or a mention in a
 * comment. Uses a function replacer: user WGSL may contain `$` sequences.
 */
const replaceMarker = (src: string, marker: string, text: string): string => {
  const re = new RegExp(`^[ \\t]*${marker}[ \\t]*$`, 'm');
  if (!re.test(src)) {
    throw new CozyGPUError(
      'SHADER_COMPILE',
      `swarm template marker ${marker} missing`,
    );
  }
  return src.replace(re, () => text);
};

/** Composition inputs shared by the WGSL and GLSL composers. */
export interface ComposeInput {
  readonly behaviors: readonly BehaviorDefinition[];
  readonly renderFlags: number;
  readonly layout: ParamsLayout;
}

/** Produces the `//@STAGE` sectioned GLSL programs (./glsl.ts). */
export type GlslComposer = (input: ComposeInput) => {
  compute: string;
  render: string;
};

let glslComposer: GlslComposer | null = null;

/** Called by `installGlslComposer()` in ./glsl.ts. @internal */
export function registerGlslComposer(composer: GlslComposer): void {
  glslComposer = composer;
}

/** True once ./glsl.ts has been loaded in this heap. @internal */
export function isGlslComposerLoaded(): boolean {
  return glslComposer !== null;
}

/** First behavior without a `glsl` variant, or undefined. */
export function firstBehaviorWithoutGlsl(
  behaviors: readonly BehaviorDefinition[],
): string | undefined {
  for (let b = 0; b < behaviors.length; b++) {
    if (!behaviors[b].glsl) return behaviors[b].name;
  }
  return undefined;
}

/**
 * `{ … }` block of one behavior, wrapped in the group test when the behavior
 * has `groups` (ARCHITECTURE §14.4). Same text for WGSL and GLSL.
 */
export function behaviorBlock(
  name: string,
  body: string,
  groups: number | undefined,
): string {
  const block = `  { // behavior: ${name}\n${body}\n  }`;
  if (!groups) return block;
  return (
    `  if (((c.flags >> 8u) & ${groups >>> 0}u) != 0u) {\n` + `${block}\n  }`
  );
}

/** Rewrites `$params` to `params.<field>` (function replacer: `$` safe). */
export function rewriteParams(src: string, field: string | undefined): string {
  return field ? src.replace(/\$params\b/g, () => `params.${field}`) : src;
}

export const composeSwarmShaders: SwarmShaderComposer = (
  behaviors,
  renderFlags,
  language = 'wgsl',
): ComposedSwarmShaders => {
  const seen = new Set<string>();
  const helperOwner = new Map<string, string>();
  for (let b = 0; b < behaviors.length; b++) {
    validateBehavior(behaviors[b]);
    const name = behaviors[b].name;
    if (seen.has(name)) fail(name, 'duplicate behavior name');
    seen.add(name);
    const helpers = behaviors[b].helpers;
    if (!helpers) continue;
    // `a` may declare `a_b_x` and `a_b` may too: reject cross-behavior clashes.
    const names = helperNames(helpers);
    for (let k = 0; k < names.length; k++) {
      const owner = helperOwner.get(names[k]);
      if (owner !== undefined) {
        fail(name, `helper "${names[k]}" is already declared by "${owner}"`);
      }
      helperOwner.set(names[k], name);
    }
  }
  const layout = layoutParams(behaviors);

  if (language === 'glsl300es') {
    const missing = firstBehaviorWithoutGlsl(behaviors);
    if (missing !== undefined) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        `swarm behavior "${missing}" has no GLSL variant (\`glsl\`); ` +
          'it runs on WebGPU only',
      );
    }
    if (!glslComposer) {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'the GLSL swarm composer is not installed (installGlslComposer() in ./glsl)',
      );
    }
    const glsl = glslComposer({ behaviors, renderFlags, layout });
    return {
      language,
      compute: glsl.compute,
      render: glsl.render,
      paramsBytes: layout.paramsBytes,
      params: layout.params,
    };
  }
  if (language !== 'wgsl') {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `unknown swarm shader language "${String(language)}"`,
    );
  }

  const helpers: string[] = [];
  const body: string[] = [];
  for (let b = 0; b < behaviors.length; b++) {
    const def = behaviors[b];
    const field = layout.fields.get(def.name);
    if (def.helpers) {
      helpers.push(
        `// helpers: ${def.name}\n${rewriteParams(def.helpers, field)}`,
      );
    }
    body.push(
      behaviorBlock(def.name, rewriteParams(def.update, field), def.groups),
    );
  }

  const cull = (renderFlags & SwarmInternalRenderFlag.CULL) !== 0;
  const gpuAlloc = (renderFlags & SwarmInternalRenderFlag.GPU_ALLOC) !== 0;
  const compact = cull || gpuAlloc;
  let compute = replaceMarker(computeTemplate, '//@PARAMS', layout.wgsl);
  compute = replaceMarker(
    compute,
    '//@CONSTS',
    `const SWARM_GPU_ALLOC: bool = ${gpuAlloc};\n` +
      `const SWARM_CULL_OFFSCREEN: bool = ${cull};`,
  );
  compute = replaceMarker(compute, '//@HELPERS', helpers.join('\n\n'));
  compute = replaceMarker(compute, '//@BEHAVIORS', body.join('\n'));
  compute = replaceMarker(compute, '//@CULL', compact ? cullSource : '');

  const flag = (bit: number): string =>
    (renderFlags & bit) !== 0 ? 'true' : 'false';
  const circle = (renderFlags & SwarmRenderFlag.CIRCLE) !== 0;
  let render = replaceMarker(
    renderTemplate,
    '//@FLAGS',
    [
      `const RF_FADE_OUT: bool = ${flag(SwarmRenderFlag.FADE_OUT)};`,
      `const RF_SHRINK: bool = ${flag(SwarmRenderFlag.SHRINK)};`,
      `const RF_ALIGN: bool = ${flag(SwarmRenderFlag.ALIGN_TO_VELOCITY)};`,
      `const RF_CIRCLE: bool = ${flag(SwarmRenderFlag.CIRCLE)};`,
      `const RF_CURVES: bool = ${flag(SwarmRenderFlag.CURVES)};`,
    ].join('\n'),
  );
  render = replaceMarker(
    render,
    '//@SLOT_DECL',
    compact
      ? '@group(2) @binding(4) var<storage, read> visible: array<u32>;'
      : '',
  );
  render = replaceMarker(
    render,
    '//@SLOT',
    compact ? '  let slot = visible[ii];' : '  let slot = ii;',
  );
  render = replaceMarker(
    render,
    '//@COLOR',
    circle
      ? [
          '  let d = length(in.uv);',
          '  let w = max(fwidth(d), 1e-4);',
          '  let coverage = clamp((1.0 - d) / w + 0.5, 0.0, 1.0);',
          '  if (coverage <= 0.0) { discard; }',
          '  return in.color * coverage;',
        ].join('\n')
      : '  return textureSample(swarmTexture, swarmSampler, in.uv) * in.color;',
  );

  return {
    language: 'wgsl',
    compute: `${prelude}\n${compute}`,
    render: `${prelude}\n${render}`,
    paramsBytes: layout.paramsBytes,
    params: layout.params,
  };
};
