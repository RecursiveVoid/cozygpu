/**
 * Adapter + device acquisition and capability detection.
 * DOM-free (runs in a worker): uses `globalThis.navigator` only.
 */
import { CozyGPUError } from '../../types/errors';
import type { BackendOptions, Capabilities, TextureFormat } from '../types';

export interface AcquiredDevice {
  adapter: GPUAdapter;
  device: GPUDevice;
}

/** Optional features requested when the adapter offers them (never required). */
const OPTIONAL_FEATURES: readonly GPUFeatureName[] = [
  'timestamp-query',
  'float32-filterable',
  'indirect-first-instance',
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
];

export function getGPU(): GPU | undefined {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  return nav && nav.gpu ? nav.gpu : undefined;
}

export async function acquireDevice(
  options: BackendOptions,
  label = 'cozygpu',
): Promise<AcquiredDevice> {
  const gpu = getGPU();
  if (!gpu) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'WebGPU is not available (navigator.gpu is undefined; needs a secure context)',
    );
  }
  const adapter = await gpu.requestAdapter({
    powerPreference: options.powerPreference,
  });
  if (!adapter) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      'navigator.gpu.requestAdapter() returned null: no suitable GPU adapter.',
    );
  }

  const requiredFeatures: GPUFeatureName[] = [];
  for (let i = 0; i < OPTIONAL_FEATURES.length; i++) {
    if (adapter.features.has(OPTIONAL_FEATURES[i])) {
      requiredFeatures.push(OPTIONAL_FEATURES[i]);
    }
  }

  const requiredLimits: Record<string, number> = {};
  if (options.limits === 'max') {
    requiredLimits.maxBufferSize = adapter.limits.maxBufferSize;
    requiredLimits.maxStorageBufferBindingSize =
      adapter.limits.maxStorageBufferBindingSize;
    requiredLimits.maxComputeWorkgroupsPerDimension =
      adapter.limits.maxComputeWorkgroupsPerDimension;
    requiredLimits.maxComputeInvocationsPerWorkgroup =
      adapter.limits.maxComputeInvocationsPerWorkgroup;
    requiredLimits.maxComputeWorkgroupSizeX =
      adapter.limits.maxComputeWorkgroupSizeX;
    requiredLimits.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
  }
  // Vertex-stage storage buffers are what Swarm rendering needs; ask for them
  // explicitly where the adapter reports the (newer) per-stage limit.
  const vsLimit = (
    adapter.limits as { maxStorageBuffersInVertexStage?: number }
  ).maxStorageBuffersInVertexStage;
  if (vsLimit !== undefined && vsLimit > 0) {
    requiredLimits.maxStorageBuffersInVertexStage = Math.min(vsLimit, 8);
  }

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label,
      requiredFeatures,
      requiredLimits,
    });
  } catch (err) {
    throw new CozyGPUError(
      'UNSUPPORTED',
      `adapter.requestDevice() failed: ${(err as Error).message ?? String(err)}`,
    );
  }
  return { adapter, device };
}

export function detectCapabilities(
  device: GPUDevice,
  canvasFormat: TextureFormat,
): Capabilities {
  const f = device.features;
  const l = device.limits;
  const vsStorage = (l as { maxStorageBuffersInVertexStage?: number })
    .maxStorageBuffersInVertexStage;
  return {
    backend: 'webgpu',
    shaderLanguage: 'wgsl',
    compute: true,
    storageBuffers: l.maxStorageBuffersPerShaderStage > 0,
    vertexStorage:
      vsStorage === undefined
        ? l.maxStorageBuffersPerShaderStage > 0
        : vsStorage > 0,
    indirectDraw: true,
    indirectFirstInstance: f.has('indirect-first-instance'),
    transformFeedback: false,
    instancing: true,
    baseInstance: true,
    floatRenderTargets: true,
    integerRenderTargets: true,
    // M3 (ARCHITECTURE §21.3): stencil attachments, `RenderPipelineDesc.stencil`
    // and `RenderPass.setStencilReference` (masks).
    stencil: true,
    maxSampledTextures: l.maxSampledTexturesPerShaderStage,
    timestampQuery: f.has('timestamp-query'),
    float32Filterable: f.has('float32-filterable'),
    textureCompression: {
      bc: f.has('texture-compression-bc'),
      bc7: f.has('texture-compression-bc'),
      etc2: f.has('texture-compression-etc2'),
      astc: f.has('texture-compression-astc'),
    },
    maxTextureSize: l.maxTextureDimension2D,
    maxBufferSize: l.maxBufferSize,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
    maxUniformBufferBindingSize: l.maxUniformBufferBindingSize,
    maxComputeWorkgroupSizeX: l.maxComputeWorkgroupSizeX,
    maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupsPerDimension: l.maxComputeWorkgroupsPerDimension,
    canvasFormat,
  };
}

/** The ONE color format: navigator.gpu.getPreferredCanvasFormat(). */
export function preferredCanvasFormat(gpu: GPU): TextureFormat {
  return gpu.getPreferredCanvasFormat() as TextureFormat;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
