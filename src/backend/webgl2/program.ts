/**
 * Owner: "webgl2". GLSL ES 3.0 program compile + link (ARCHITECTURE §13.3).
 *
 * - Async: with KHR_parallel_shader_compile the link status is polled via
 *   COMPLETION_STATUS_KHR, otherwise the (blocking) status query runs in a
 *   later task so pipeline creation never stalls the caller synchronously.
 * - Bindings come from the naming convention, not reflection tables: uniform
 *   block `G{g}_B{b}` → UBO binding point, `uniform sampler2D G{g}_B{b}` →
 *   texture unit; a 'sampler' entry at (g, b) applies to the texture unit of
 *   binding b - 1. Names the linker optimized out are skipped.
 */
import { CozyGPUError } from '../../types/errors';
import { glVaryingBytes } from './formats';
import * as G from './glconst';
import type {
  GLBindGroupLayout,
  GLProgram,
  GLProgramBinding,
} from './resources';
import type { GLState } from './state';

/** Fragment stage for transform-feedback-only programs. */
export const FEEDBACK_FRAGMENT =
  '#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(0.0); }\n';

export interface LinkRequest {
  label: string | undefined;
  vertex: string;
  fragment: string;
  /** Transform feedback varyings (INTERLEAVED_ATTRIBS), or null. */
  varyings: readonly string[] | null;
  layouts: readonly GLBindGroupLayout[];
}

export async function linkProgram(
  gl: WebGL2RenderingContext,
  state: GLState,
  parallel: boolean,
  req: LinkRequest,
): Promise<GLProgram> {
  const program = gl.createProgram();
  const vs = gl.createShader(G.VERTEX_SHADER);
  const fs = gl.createShader(G.FRAGMENT_SHADER);
  if (!program || !vs || !fs) {
    throw new CozyGPUError(
      'DEVICE_LOST',
      `program "${req.label ?? ''}": WebGL context lost`,
    );
  }
  gl.shaderSource(vs, req.vertex);
  gl.compileShader(vs);
  gl.shaderSource(fs, req.fragment);
  gl.compileShader(fs);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  if (req.varyings) {
    gl.transformFeedbackVaryings(
      program,
      req.varyings as string[],
      G.INTERLEAVED_ATTRIBS,
    );
  }
  gl.linkProgram(program);

  await new Promise<void>(resolve => {
    const poll = (): void => {
      if (
        !parallel ||
        gl.isContextLost() ||
        gl.getProgramParameter(program, G.COMPLETION_STATUS_KHR)
      ) {
        resolve();
      } else {
        setTimeout(poll, 4);
      }
    };
    setTimeout(poll, 0);
  });

  if (gl.isContextLost()) {
    throw new CozyGPUError(
      'DEVICE_LOST',
      `program "${req.label ?? ''}": WebGL context lost`,
    );
  }
  if (!gl.getProgramParameter(program, G.LINK_STATUS)) {
    let details =
      shaderLog(gl, vs, req.vertex, 'vertex') +
      shaderLog(gl, fs, req.fragment, 'fragment');
    if (!details) details = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new CozyGPUError(
      'SHADER_COMPILE',
      `program "${req.label ?? ''}" failed to link:\n${details}`,
    );
  }
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // Bindings (needs the program current for uniform1i).
  state.useProgram(program);
  const groups: GLProgramBinding[][] = [];
  let ubo = 0;
  let unit = 0;
  for (let g = 0; g < req.layouts.length; g++) {
    const list: GLProgramBinding[] = [];
    const textureUnits: number[] = [];
    const entries = req.layouts[g].entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const name = `G${g}_B${e.binding}`;
      if (e.type.kind === 'uniform') {
        const index = gl.getUniformBlockIndex(program, name);
        if (index === G.INVALID_INDEX) continue;
        gl.uniformBlockBinding(program, index, ubo);
        list.push({ kind: 0, binding: e.binding, unit: ubo++ });
      } else if (e.type.kind === 'texture') {
        const location = gl.getUniformLocation(program, name);
        if (!location) continue;
        gl.uniform1i(location, unit);
        textureUnits[e.binding] = unit;
        list.push({ kind: 1, binding: e.binding, unit: unit++ });
      }
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type.kind !== 'sampler') continue;
      const target = textureUnits[e.binding - 1];
      if (target !== undefined)
        list.push({ kind: 2, binding: e.binding, unit: target });
    }
    groups.push(list);
  }

  let recordBytes = 0;
  if (req.varyings) {
    for (let i = 0; i < req.varyings.length; i++) {
      const info = gl.getTransformFeedbackVarying(program, i);
      if (info) recordBytes += glVaryingBytes(info.type, info.size);
    }
  }
  return { program, groups, recordBytes };
}

/** Info log of a failed shader with the offending source lines. */
function shaderLog(
  gl: WebGL2RenderingContext,
  shader: WebGLShader,
  source: string,
  stage: string,
): string {
  if (gl.getShaderParameter(shader, G.COMPILE_STATUS)) return '';
  const log = gl.getShaderInfoLog(shader) ?? '';
  const lines = source.split('\n');
  let out = `${stage}: ${log.trim()}\n`;
  const re = /ERROR:\s*\d+:(\d+):/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    const n = Number(m[1]);
    if (n > 0 && n <= lines.length) out += `  ${n} | ${lines[n - 1]}\n`;
  }
  return out;
}
