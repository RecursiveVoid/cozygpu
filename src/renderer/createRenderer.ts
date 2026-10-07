/**
 * Public entry point.
 *  main-thread: createLocalTransport(canvas, coreOptions) → new RendererImpl(...)
 *  worker:      import('../worker/WorkerTransport') (a separate chunk, §18.1),
 *               createWorkerTransport(canvas, coreOptions, url, size) → new RendererImpl(...)
 */
import type { CoreInitOptions } from '../types/core';
import { CozyGPUError } from '../types/errors';
import type { Renderer, RendererOptions } from '../types/renderer';
import type { Transport } from '../types/transport';
import { createLocalTransport } from '../worker/LocalTransport';
import { RendererImpl, type RendererConfig } from './Renderer';

function isHTMLCanvas(canvas: unknown): canvas is HTMLCanvasElement {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    canvas instanceof HTMLCanvasElement
  );
}

function defaultWorkerUrl(): URL {
  return new URL('./cozygpu.worker.js', import.meta.url);
}

/** Resolves defaults and the initial CSS size (never touches canvas.width/height). */
export function resolveRendererConfig(
  options: RendererOptions,
): RendererConfig {
  const canvas = options.canvas;
  if (!canvas) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      'createRenderer: canvas is required',
    );
  }
  const html = isHTMLCanvas(canvas);
  const worker = !!options.worker;
  const autoResize = options.autoResize ?? html;
  const resolutionOption = options.resolution ?? 'device';
  if (
    resolutionOption !== 'device' &&
    !(typeof resolutionOption === 'number' && resolutionOption > 0)
  ) {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `resolution must be a positive number or 'device', got ${String(resolutionOption)}`,
    );
  }
  const resolution =
    resolutionOption === 'device'
      ? (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1
      : resolutionOption;

  let cssWidth = options.width;
  let cssHeight = options.height;
  if (cssWidth === undefined || cssHeight === undefined) {
    let w = 0;
    let h = 0;
    if (html && autoResize) {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
    }
    if (w === 0 || h === 0) {
      // Canvas attributes are device pixels; convert back to CSS pixels.
      w = canvas.width / (html && autoResize ? resolution : 1);
      h = canvas.height / (html && autoResize ? resolution : 1);
    }
    cssWidth ??= w;
    cssHeight ??= h;
  }

  return {
    canvas,
    worker,
    cssWidth,
    cssHeight,
    resolution: resolutionOption,
    autoResize,
    background: options.background ?? 0x000000,
    backgroundAlpha: Math.min(1, Math.max(0, options.backgroundAlpha ?? 1)),
    onDeviceLost: options.onDeviceLost,
    onDeviceRestored: options.onDeviceRestored,
    assets: options.assets,
    events: options.events,
    retained: options.retained,
  };
}

export async function createRenderer(
  options: RendererOptions,
): Promise<Renderer> {
  const config = resolveRendererConfig(options);
  const coreOptions: CoreInitOptions = {
    backend: options.backend ?? 'auto',
    powerPreference: options.powerPreference,
    limits: options.limits ?? 'default',
    alphaMode: 'premultiplied',
    antialias: options.antialias ?? false,
  };
  if (options.debug !== undefined) coreOptions.debug = options.debug;

  let transport: Transport;
  if (config.worker) {
    const canvas = config.canvas;
    if (!isHTMLCanvas(canvas)) {
      throw new CozyGPUError(
        'INVALID_ARGUMENT',
        'worker mode needs an HTMLCanvasElement',
      );
    }
    if (typeof canvas.transferControlToOffscreen !== 'function') {
      throw new CozyGPUError(
        'UNSUPPORTED',
        'OffscreenCanvas is not supported in this browser; use worker: false',
      );
    }
    const workerOption = options.worker;
    const url =
      typeof workerOption === 'object' && workerOption.url
        ? workerOption.url
        : defaultWorkerUrl();
    const resolution =
      config.resolution === 'device'
        ? (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1
        : config.resolution;
    // Dynamic import: main-thread programs never load the worker transport.
    const { createWorkerTransport } = await import('../worker/WorkerTransport');
    transport = await createWorkerTransport(canvas, coreOptions, url, {
      cssWidth: config.cssWidth,
      cssHeight: config.cssHeight,
      resolution,
    });
  } else {
    transport = await createLocalTransport(config.canvas, coreOptions);
  }

  try {
    return new RendererImpl(transport, config);
  } catch (err) {
    transport.destroy();
    throw err;
  }
}
