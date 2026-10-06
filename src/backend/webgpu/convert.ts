/**
 * Owner: "backend". Pure RHI → WebGPU translation helpers (no device access,
 * Node-testable). Flag constants are numeric literals from the WebGPU spec so
 * this module also loads where `GPUBufferUsage` globals do not exist.
 */
import {
  BlendMode,
  BufferUsage,
  TextureFormat,
  TextureUsage,
  ShaderStage,
} from '../types';
import type { StencilState } from '../types';

export { align4, bytesPerTexel, fullMipLevelCount } from '../utils';

// WebGPU spec values (GPUBufferUsage / GPUTextureUsage / GPUShaderStage).
export const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;

export const GPU_TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const;

export const GPU_SHADER_STAGE = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
} as const;

export function toGPUBufferUsage(usage: number): number {
  let out = 0;
  if (usage & BufferUsage.VERTEX) out |= GPU_BUFFER_USAGE.VERTEX;
  if (usage & BufferUsage.INDEX) out |= GPU_BUFFER_USAGE.INDEX;
  if (usage & BufferUsage.UNIFORM) out |= GPU_BUFFER_USAGE.UNIFORM;
  if (usage & BufferUsage.STORAGE) out |= GPU_BUFFER_USAGE.STORAGE;
  if (usage & BufferUsage.INDIRECT) out |= GPU_BUFFER_USAGE.INDIRECT;
  if (usage & BufferUsage.COPY_SRC) out |= GPU_BUFFER_USAGE.COPY_SRC;
  if (usage & BufferUsage.COPY_DST) out |= GPU_BUFFER_USAGE.COPY_DST;
  if (usage & BufferUsage.MAP_READ) out |= GPU_BUFFER_USAGE.MAP_READ;
  return out;
}

const COLOR_RENDERABLE: Record<TextureFormat, boolean> = {
  rgba8unorm: true,
  'rgba8unorm-srgb': true,
  bgra8unorm: true,
  'bgra8unorm-srgb': true,
  r8unorm: true,
  rgba16float: true,
  rgba32float: true,
  r32uint: true,
  rg32uint: true,
  rgba32uint: true,
  'bc1-rgba-unorm': false,
  'bc1-rgba-unorm-srgb': false,
  'bc3-rgba-unorm': false,
  'bc3-rgba-unorm-srgb': false,
  'bc4-r-unorm': false,
  'bc5-rg-unorm': false,
  'bc7-rgba-unorm': false,
  'bc7-rgba-unorm-srgb': false,
  'etc2-rgb8unorm': false,
  'etc2-rgb8unorm-srgb': false,
  'etc2-rgba8unorm': false,
  'etc2-rgba8unorm-srgb': false,
  'eac-r11unorm': false,
  'eac-rg11unorm': false,
  'astc-4x4-unorm': false,
  'astc-4x4-unorm-srgb': false,
  depth24plus: false,
  'depth24plus-stencil8': false,
  depth32float: false,
};

export function isDepthFormat(format: TextureFormat): boolean {
  return (
    format === 'depth24plus' ||
    format === 'depth24plus-stencil8' ||
    format === 'depth32float'
  );
}

/** True when the format carries a stencil aspect (masks, ARCHITECTURE §21.3). */
export function hasStencilAspect(format: TextureFormat): boolean {
  return format === 'depth24plus-stencil8';
}

/** Full color write mask; 0 for stencil-only draws (`colorWriteDisabled`). */
export const COLOR_WRITE_ALL = 0xf;

/**
 * Depth/stencil state of a render pipeline (M3, masks). Without `stencil` this
 * is the M1 behavior (depth write on, less-equal). With it, depth is inert
 * (cozygpu is 2D) and the stencil face state comes from the RHI defaults:
 * compare 'always', keep/keep/keep, read and write mask 0xff.
 */
export function toGPUDepthStencil(
  depthFormat: TextureFormat | undefined,
  stencil: StencilState | undefined,
): GPUDepthStencilState | undefined {
  if (!depthFormat) return undefined;
  if (!stencil) {
    return {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
    };
  }
  const face: GPUStencilFaceState = {
    compare: stencil.compare ?? 'always',
    failOp: stencil.failOp ?? 'keep',
    depthFailOp: stencil.depthFailOp ?? 'keep',
    passOp: stencil.passOp ?? 'keep',
  };
  return {
    format: depthFormat,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: stencil.readMask ?? 0xff,
    stencilWriteMask: stencil.writeMask ?? 0xff,
  };
}

/** Pipeline-cache fragment for the stencil state and the color write mask. */
export function stencilKey(
  stencil: StencilState | undefined,
  colorWriteDisabled: boolean | undefined,
): string {
  const w = colorWriteDisabled ? '0' : '';
  if (!stencil) return `|${w}`;
  return `|${stencil.compare ?? ''}${stencil.failOp ?? ''}${
    stencil.depthFailOp ?? ''
  }${stencil.passOp ?? ''}${stencil.readMask ?? 255}/${
    stencil.writeMask ?? 255
  }${w}`;
}

/**
 * RHI texture usage → GPUTextureUsage. RENDER_ATTACHMENT is added implicitly
 * for color-renderable textures that are copy destinations or have mips:
 * WebGPU requires it for `copyExternalImageToTexture` and mip generation.
 */
export function toGPUTextureUsage(
  usage: number,
  format: TextureFormat,
  mipLevelCount: number,
): number {
  let out = 0;
  if (usage & TextureUsage.SAMPLED) out |= GPU_TEXTURE_USAGE.TEXTURE_BINDING;
  if (usage & TextureUsage.STORAGE) out |= GPU_TEXTURE_USAGE.STORAGE_BINDING;
  if (usage & TextureUsage.RENDER_TARGET) {
    out |= GPU_TEXTURE_USAGE.RENDER_ATTACHMENT;
  }
  if (usage & TextureUsage.COPY_SRC) out |= GPU_TEXTURE_USAGE.COPY_SRC;
  if (usage & TextureUsage.COPY_DST) out |= GPU_TEXTURE_USAGE.COPY_DST;
  if (
    COLOR_RENDERABLE[format] &&
    ((usage & TextureUsage.COPY_DST) !== 0 || mipLevelCount > 1)
  ) {
    out |= GPU_TEXTURE_USAGE.RENDER_ATTACHMENT;
  }
  return out;
}

export function toGPUShaderStage(stages: number): number {
  let out = 0;
  if (stages & ShaderStage.VERTEX) out |= GPU_SHADER_STAGE.VERTEX;
  if (stages & ShaderStage.FRAGMENT) out |= GPU_SHADER_STAGE.FRAGMENT;
  if (stages & ShaderStage.COMPUTE) out |= GPU_SHADER_STAGE.COMPUTE;
  return out;
}

// ─── Blend presets (premultiplied alpha, ARCHITECTURE §4) ─────────────────────
// The alpha channel always uses (one, one-minus-src-alpha) so the canvas
// alpha stays a valid premultiplied coverage value for compositing.

const ALPHA_OVER: GPUBlendComponent = {
  operation: 'add',
  srcFactor: 'one',
  dstFactor: 'one-minus-src-alpha',
};

const BLEND_STATES: Record<BlendMode, GPUBlendState | undefined> = {
  normal: { color: ALPHA_OVER, alpha: ALPHA_OVER },
  add: {
    color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
    alpha: ALPHA_OVER,
  },
  multiply: {
    color: {
      operation: 'add',
      srcFactor: 'dst',
      dstFactor: 'one-minus-src-alpha',
    },
    alpha: ALPHA_OVER,
  },
  screen: {
    color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src' },
    alpha: ALPHA_OVER,
  },
  none: undefined,
};

export function toGPUBlendState(
  mode: BlendMode | undefined,
): GPUBlendState | undefined {
  return BLEND_STATES[mode ?? 'normal'];
}
