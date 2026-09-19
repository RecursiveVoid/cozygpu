/**
 * Owner: "webgl2". Pure RHI → WebGL2 translation tables (no context access,
 * Node-testable).
 */
import type {
  AddressMode,
  BlendMode,
  FilterMode,
  TextureFormat,
  Topology,
  VertexFormat,
} from '../types';
import * as G from './glconst';

/** How a texture format is stored and uploaded. */
export interface GLTextureFormat {
  /** Sized internal format for texStorage2D / renderbufferStorage. */
  readonly internal: number;
  /** Pixel transfer format (0 for compressed). */
  readonly format: number;
  /** Pixel transfer type (0 for compressed). */
  readonly type: number;
  /** Extension that must be enabled, or '' for core WebGL2. */
  readonly ext: string;
  /** 1 = unsigned integer, 2 = float, 3 = depth, 0 = normalized / compressed. */
  readonly kind: number;
}

export const FormatKind = { NORM: 0, UINT: 1, FLOAT: 2, DEPTH: 3 } as const;

const S3TC = 'WEBGL_compressed_texture_s3tc';
const S3TC_SRGB = 'WEBGL_compressed_texture_s3tc_srgb';
const RGTC = 'EXT_texture_compression_rgtc';
const BPTC = 'EXT_texture_compression_bptc';
const ETC = 'WEBGL_compressed_texture_etc';
const ASTC = 'WEBGL_compressed_texture_astc';

function f(
  internal: number,
  format: number,
  type: number,
  kind = 0,
  ext = '',
): GLTextureFormat {
  return { internal, format, type, ext, kind };
}

function c(internal: number, ext: string): GLTextureFormat {
  return { internal, format: 0, type: 0, ext, kind: 0 };
}

/**
 * WebGL has no BGRA storage: bgra8unorm(-srgb) are stored as RGBA. The
 * WebGL2 backend reports `canvasFormat: 'rgba8unorm'`, so BGRA is never the
 * canvas format there.
 */
export const GL_TEXTURE_FORMATS: Record<TextureFormat, GLTextureFormat> = {
  rgba8unorm: f(G.RGBA8, G.RGBA, G.UNSIGNED_BYTE),
  'rgba8unorm-srgb': f(G.SRGB8_ALPHA8, G.RGBA, G.UNSIGNED_BYTE),
  bgra8unorm: f(G.RGBA8, G.RGBA, G.UNSIGNED_BYTE),
  'bgra8unorm-srgb': f(G.SRGB8_ALPHA8, G.RGBA, G.UNSIGNED_BYTE),
  r8unorm: f(G.R8, G.RED, G.UNSIGNED_BYTE),
  rgba16float: f(G.RGBA16F, G.RGBA, G.HALF_FLOAT, FormatKind.FLOAT),
  rgba32float: f(G.RGBA32F, G.RGBA, G.FLOAT, FormatKind.FLOAT),
  r32uint: f(G.R32UI, G.RED_INTEGER, G.UNSIGNED_INT, FormatKind.UINT),
  rg32uint: f(G.RG32UI, G.RG_INTEGER, G.UNSIGNED_INT, FormatKind.UINT),
  'bc1-rgba-unorm': c(G.COMPRESSED_RGBA_S3TC_DXT1_EXT, S3TC),
  'bc1-rgba-unorm-srgb': c(G.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT, S3TC_SRGB),
  'bc3-rgba-unorm': c(G.COMPRESSED_RGBA_S3TC_DXT5_EXT, S3TC),
  'bc3-rgba-unorm-srgb': c(G.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT, S3TC_SRGB),
  'bc4-r-unorm': c(G.COMPRESSED_RED_RGTC1_EXT, RGTC),
  'bc5-rg-unorm': c(G.COMPRESSED_RED_GREEN_RGTC2_EXT, RGTC),
  'bc7-rgba-unorm': c(G.COMPRESSED_RGBA_BPTC_UNORM_EXT, BPTC),
  'bc7-rgba-unorm-srgb': c(G.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT, BPTC),
  'etc2-rgb8unorm': c(G.COMPRESSED_RGB8_ETC2, ETC),
  'etc2-rgb8unorm-srgb': c(G.COMPRESSED_SRGB8_ETC2, ETC),
  'etc2-rgba8unorm': c(G.COMPRESSED_RGBA8_ETC2_EAC, ETC),
  'etc2-rgba8unorm-srgb': c(G.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC, ETC),
  'eac-r11unorm': c(G.COMPRESSED_R11_EAC, ETC),
  'eac-rg11unorm': c(G.COMPRESSED_RG11_EAC, ETC),
  'astc-4x4-unorm': c(G.COMPRESSED_RGBA_ASTC_4x4_KHR, ASTC),
  'astc-4x4-unorm-srgb': c(G.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR, ASTC),
  depth24plus: f(
    G.DEPTH_COMPONENT24,
    G.DEPTH_COMPONENT,
    G.UNSIGNED_INT,
    FormatKind.DEPTH,
  ),
  'depth24plus-stencil8': f(
    G.DEPTH24_STENCIL8,
    G.DEPTH_STENCIL,
    G.UNSIGNED_INT_24_8,
    FormatKind.DEPTH,
  ),
  depth32float: f(
    G.DEPTH_COMPONENT32F,
    G.DEPTH_COMPONENT,
    G.FLOAT,
    FormatKind.DEPTH,
  ),
};

/** Every extension the backend enables at context creation. */
export const GL_EXTENSIONS = [
  'EXT_color_buffer_float',
  'OES_texture_float_linear',
  'KHR_parallel_shader_compile',
  'WEBGL_draw_instanced_base_vertex_base_instance',
  'WEBGL_lose_context',
  S3TC,
  S3TC_SRGB,
  RGTC,
  BPTC,
  ETC,
  ASTC,
] as const;

/** Vertex attribute: component count, GL type, normalized, integer (vertexAttribIPointer). */
export interface GLVertexFormat {
  readonly size: number;
  readonly type: number;
  readonly normalized: boolean;
  readonly integer: boolean;
}

function v(
  size: number,
  type: number,
  normalized = false,
  integer = false,
): GLVertexFormat {
  return { size, type, normalized, integer };
}

export const GL_VERTEX_FORMATS: Record<VertexFormat, GLVertexFormat> = {
  float32: v(1, G.FLOAT),
  float32x2: v(2, G.FLOAT),
  float32x3: v(3, G.FLOAT),
  float32x4: v(4, G.FLOAT),
  uint32: v(1, G.UNSIGNED_INT, false, true),
  uint16x4: v(4, G.UNSIGNED_SHORT, false, true),
  unorm8x4: v(4, G.UNSIGNED_BYTE, true),
  unorm16x4: v(4, G.UNSIGNED_SHORT, true),
};

export const GL_TOPOLOGY: Record<Topology, number> = {
  'triangle-list': G.TRIANGLES,
  'triangle-strip': G.TRIANGLE_STRIP,
  'line-list': G.LINES,
  'point-list': G.POINTS,
};

/**
 * Blend presets (premultiplied, ARCHITECTURE §4) as
 * [srcRGB, dstRGB, srcAlpha, dstAlpha]; null disables blending. The alpha
 * channel always composites "over", like the WebGPU backend.
 */
export const GL_BLEND: Record<BlendMode, readonly number[] | null> = {
  normal: [G.ONE, G.ONE_MINUS_SRC_ALPHA, G.ONE, G.ONE_MINUS_SRC_ALPHA],
  add: [G.ONE, G.ONE, G.ONE, G.ONE_MINUS_SRC_ALPHA],
  multiply: [G.DST_COLOR, G.ONE_MINUS_SRC_ALPHA, G.ONE, G.ONE_MINUS_SRC_ALPHA],
  screen: [G.ONE, G.ONE_MINUS_SRC_COLOR, G.ONE, G.ONE_MINUS_SRC_ALPHA],
  none: null,
};

/** Numeric blend key: index in this list (state cache). */
export const BLEND_KEYS: readonly BlendMode[] = [
  'normal',
  'add',
  'multiply',
  'screen',
  'none',
];

export function glAddressMode(mode: AddressMode | undefined): number {
  return mode === 'repeat'
    ? G.REPEAT
    : mode === 'mirror-repeat'
      ? G.MIRRORED_REPEAT
      : G.CLAMP_TO_EDGE;
}

export function glFilter(mode: FilterMode | undefined): number {
  return mode === 'nearest' ? G.NEAREST : G.LINEAR;
}

/**
 * TEXTURE_MIN_FILTER always uses a mipmap variant, like WebGPU (a 1-level
 * immutable texture is still complete with it).
 */
export function glMinFilter(
  min: FilterMode | undefined,
  mip: FilterMode | undefined,
): number {
  const linear = min !== 'nearest';
  if (mip === 'linear')
    return linear ? G.LINEAR_MIPMAP_LINEAR : G.NEAREST_MIPMAP_LINEAR;
  return linear ? G.LINEAR_MIPMAP_NEAREST : G.NEAREST_MIPMAP_NEAREST;
}

/** Bytes of one transform-feedback varying (active type × array size). */
export function glVaryingBytes(type: number, size: number): number {
  let components: number;
  switch (type) {
    case G.FLOAT:
    case G.INT:
    case G.UNSIGNED_INT:
      components = 1;
      break;
    case G.FLOAT_VEC2:
    case G.INT_VEC2:
    case G.UNSIGNED_INT_VEC2:
      components = 2;
      break;
    case G.FLOAT_VEC3:
    case G.INT_VEC3:
    case G.UNSIGNED_INT_VEC3:
      components = 3;
      break;
    case G.FLOAT_VEC4:
    case G.INT_VEC4:
    case G.UNSIGNED_INT_VEC4:
    case G.FLOAT_MAT2:
      components = 4;
      break;
    case G.FLOAT_MAT3:
      components = 9;
      break;
    case G.FLOAT_MAT4:
      components = 16;
      break;
    default:
      components = 4;
  }
  return components * 4 * Math.max(1, size);
}
