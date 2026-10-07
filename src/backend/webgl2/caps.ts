/**
 * Capability detection for WebGL2 (ARCHITECTURE §7 table,
 * §13.4). Pure given a context-like object, so it is Node-testable.
 */
import type { Capabilities } from '../types';
import * as G from './glconst';

/** Upper bound reported as `maxBufferSize` (WebGL2 has no queryable limit). */
export const GL_MAX_BUFFER_SIZE = 0x40000000; // 1 GiB

/** The parts of WebGL2RenderingContext capability detection reads. */
export interface GLCapsSource {
  getParameter(pname: number): unknown;
}

export function detectGLCapabilities(
  gl: GLCapsSource,
  has: (extension: string) => boolean,
): Capabilities {
  const bc =
    has('WEBGL_compressed_texture_s3tc') && has('EXT_texture_compression_rgtc');
  return {
    backend: 'webgl2',
    shaderLanguage: 'glsl300es',
    compute: false,
    storageBuffers: false,
    vertexStorage: false,
    indirectDraw: false,
    indirectFirstInstance: false,
    transformFeedback: true,
    instancing: true,
    baseInstance: has('WEBGL_draw_instanced_base_vertex_base_instance'),
    floatRenderTargets: has('EXT_color_buffer_float'),
    integerRenderTargets: true,
    // M3 (ARCHITECTURE §21.3): stencil attachments, pipeline stencil state and
    // `RenderPass.setStencilReference` (masks). The default framebuffer is
    // created with a stencil buffer (see WebGL2Backend.create).
    stencil: true,
    maxSampledTextures:
      Number(gl.getParameter(G.MAX_TEXTURE_IMAGE_UNITS)) || 16,
    timestampQuery: false,
    float32Filterable: has('OES_texture_float_linear'),
    textureCompression: {
      bc,
      bc7: has('EXT_texture_compression_bptc'),
      etc2: has('WEBGL_compressed_texture_etc'),
      astc: has('WEBGL_compressed_texture_astc'),
    },
    maxTextureSize: Number(gl.getParameter(G.MAX_TEXTURE_SIZE)) || 4096,
    maxBufferSize: GL_MAX_BUFFER_SIZE,
    maxStorageBufferBindingSize: 0,
    maxUniformBufferBindingSize:
      Number(gl.getParameter(G.MAX_UNIFORM_BLOCK_SIZE)) || 16384,
    maxComputeWorkgroupSizeX: 0,
    maxComputeInvocationsPerWorkgroup: 0,
    maxComputeWorkgroupsPerDimension: 0,
    canvasFormat: 'rgba8unorm',
  };
}
