/**
 * GLSL ES 3.0 swarm composer (WebGL2 transform feedback,
 * ARCHITECTURE §14.2). `installGlslComposer()` registers it with
 * `composeSwarmShaders(…, 'glsl300es')` (an explicit call, not an import side
 * effect, so `sideEffects`-aware bundlers keep it). Swarm loads this module
 * with a dynamic import only when a renderer lacks compute, so WebGPU bundles
 * never carry the GLSL templates.
 *
 * Output (swarm-internal format, parsed by ./coreGl.ts with `glslStage`):
 *   compute: `//@STAGE step`, `//@STAGE spawn`, `//@STAGE spawnCold`
 *   render:  `//@STAGE vertex`, `//@STAGE fragment`, `//@STAGE pickFragment`
 * Each section is a complete program source starting with `#version 300 es`.
 *
 * Params: one std140 block `G2_B3 { P_<name> b_<name>; … } params;` whose
 * member offsets equal the WGSL layout (std140 rounds struct alignment and
 * size to 16 exactly like layoutParams does), so SWARM_SET_PARAMS bytes are
 * backend-agnostic.
 */
import prelude from '../shaders/swarm/prelude.glsl';
import fragmentTemplate from '../shaders/swarm/render.frag.glsl';
import vertexTemplate from '../shaders/swarm/render.vert.glsl';
import spawnTemplate from '../shaders/swarm/spawn.glsl';
import stepTemplate from '../shaders/swarm/step.glsl';
import { CozyGPUError } from '../types/errors';
import { PICK_ALPHA_THRESHOLD, SwarmRenderFlag } from '../types/layouts';
import {
  behaviorBlock,
  PARAM_TYPE_INFO,
  registerGlslComposer,
  rewriteParams,
} from './composer';
import type { ComposeInput } from './composer';
import { SWARM_GL_MAX_FRAMES } from './constants';
import type { ParamType } from './types';

const GLSL_TYPE: Readonly<Record<ParamType, string>> = {
  f32: 'float',
  i32: 'int',
  u32: 'uint',
  vec2f: 'vec2',
  vec3f: 'vec3',
  vec4f: 'vec4',
};

const VERSION = '#version 300 es\n';

function marker(src: string, name: string, text: string): string {
  const re = new RegExp(`^[ \\t]*${name}[ \\t]*$`, 'm');
  if (!re.test(src)) {
    throw new CozyGPUError(
      'SHADER_COMPILE',
      `swarm GLSL template marker ${name} missing`,
    );
  }
  return src.replace(re, () => text);
}

/** std140 declarations for the params block (offsets = layoutParams). */
export function glslParams(input: ComposeInput): string {
  const { behaviors, layout } = input;
  const structs: string[] = [];
  const members: string[] = [];
  for (let b = 0; b < behaviors.length; b++) {
    const def = behaviors[b];
    const field = layout.fields.get(def.name);
    if (!field) continue;
    const lines: string[] = [];
    const keys = Object.keys(def.params);
    for (let k = 0; k < keys.length; k++) {
      const type = def.params[keys[k]];
      if (!PARAM_TYPE_INFO[type]) continue;
      lines.push(`  ${GLSL_TYPE[type]} ${keys[k]};`);
    }
    structs.push(`struct P_${def.name} {\n${lines.join('\n')}\n};`);
    members.push(`  P_${def.name} ${field};`);
  }
  if (members.length === 0) members.push('  uint _pad;');
  return (
    `${structs.join('\n')}\n` +
    `layout(std140) uniform G2_B3 {\n${members.join('\n')}\n} params;`
  );
}

function flagConsts(renderFlags: number): string {
  const flag = (bit: number): string =>
    (renderFlags & bit) !== 0 ? 'true' : 'false';
  return [
    `const bool RF_FADE_OUT = ${flag(SwarmRenderFlag.FADE_OUT)};`,
    `const bool RF_SHRINK = ${flag(SwarmRenderFlag.SHRINK)};`,
    `const bool RF_ALIGN = ${flag(SwarmRenderFlag.ALIGN_TO_VELOCITY)};`,
    `const bool RF_CIRCLE = ${flag(SwarmRenderFlag.CIRCLE)};`,
    `const bool RF_CURVES = ${flag(SwarmRenderFlag.CURVES)};`,
  ].join('\n');
}

export function composeGlsl(input: ComposeInput): {
  compute: string;
  render: string;
} {
  const { behaviors, renderFlags, layout } = input;
  const helpers: string[] = [];
  const body: string[] = [];
  for (let b = 0; b < behaviors.length; b++) {
    const def = behaviors[b];
    const glsl = def.glsl!;
    const field = layout.fields.get(def.name);
    if (glsl.helpers) {
      helpers.push(
        `// helpers: ${def.name}\n${rewriteParams(glsl.helpers, field)}`,
      );
    }
    body.push(
      behaviorBlock(def.name, rewriteParams(glsl.update, field), def.groups),
    );
  }

  let step = marker(stepTemplate, '//@PARAMS', glslParams(input));
  step = marker(step, '//@HELPERS', helpers.join('\n\n'));
  step = marker(step, '//@BEHAVIORS', body.join('\n'));

  const flags = flagConsts(renderFlags);
  const circle = (renderFlags & SwarmRenderFlag.CIRCLE) !== 0;
  const vertex = marker(vertexTemplate, '//@FLAGS', flags);
  let fragment = marker(fragmentTemplate, '//@FLAGS', flags);
  fragment = marker(
    fragment,
    '//@COLOR',
    circle
      ? [
          '  float d = length(v_uv);',
          '  float w = max(fwidth(d), 1e-4);',
          '  float coverage = clamp((1.0 - d) / w + 0.5, 0.0, 1.0);',
          '  if (coverage <= 0.0) { discard; }',
          '  return v_color * coverage;',
        ].join('\n')
      : '  return texture(G1_B0, v_uv) * v_color;',
  );
  const colorMain = marker(
    fragment,
    '//@MAIN',
    [
      'layout(location = 0) out vec4 outColor;',
      'void main() {',
      '  outColor = swarm_color();',
      '}',
    ].join('\n'),
  );
  const pickMain = marker(
    fragment,
    '//@MAIN',
    [
      'layout(std140) uniform G2_B5 {',
      '  uint id;',
      '  uint _pad0;',
      '  uint _pad1;',
      '  uint _pad2;',
      '} swarmPick;',
      'layout(location = 0) out uvec4 outPick;',
      'void main() {',
      '  vec4 color = swarm_color();',
      `  if (color.a < ${PICK_ALPHA_THRESHOLD.toFixed(3)}) { discard; }`,
      '  outPick = uvec4(swarmPick.id, v_slot + 1u, v_user, 0u);',
      '}',
    ].join('\n'),
  );

  const program = (defines: string, src: string): string =>
    `${VERSION}${defines}${prelude}\n${src}`;
  const frames = `#define SWARM_GL_FRAMES ${SWARM_GL_MAX_FRAMES}\n`;
  return {
    compute:
      `//@STAGE step\n${program('', step)}\n` +
      `//@STAGE spawn\n${program('', spawnTemplate)}\n` +
      `//@STAGE spawnCold\n${program('#define SWARM_SPAWN_COLD 1\n', spawnTemplate)}\n`,
    render:
      `//@STAGE vertex\n${program(frames, vertex)}\n` +
      `//@STAGE fragment\n${program('', colorMain)}\n` +
      `//@STAGE pickFragment\n${program('', pickMain)}\n`,
  };
}

/** Registers the GLSL composer (idempotent). */
export function installGlslComposer(): void {
  registerGlslComposer(composeGlsl);
}
