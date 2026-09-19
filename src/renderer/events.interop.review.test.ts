/**
 * M2.5 review: the events sink in worker mode (a real WorkerTransport over
 * a fake worker) and `renderer.interop()` refusing worker mode
 * (ARCHITECTURE §19.2, §19.4).
 */
import type { CoreInterop, RenderCore } from '../types/core';
import type { CoreMessage, Transport } from '../types/transport';
import { LocalTransport } from '../worker/LocalTransport';
import {
  connectWorkerTransport,
  type WorkerLike,
} from '../worker/WorkerTransport';
import { RendererImpl, type RendererConfig } from './Renderer';
import { FAKE_CAPS } from './testing/fakeBackend';

/** A worker that answers `init` with `ready` and lets the test post more. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  constructor(private readonly fallbackReason?: string) {}
  postMessage(message: unknown): void {
    if ((message as { type?: string }).type === 'init') {
      queueMicrotask(() =>
        this.send({
          type: 'ready',
          caps: { ...FAKE_CAPS, backend: 'webgl2' },
          fallbackReason: this.fallbackReason,
        } as CoreMessage),
      );
    }
  }
  send(message: CoreMessage): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function config(overrides: Partial<RendererConfig> = {}): RendererConfig {
  return {
    canvas: { width: 300, height: 150 } as unknown as OffscreenCanvas,
    worker: true,
    cssWidth: 300,
    cssHeight: 150,
    resolution: 1,
    autoResize: false,
    background: 0,
    backgroundAlpha: 1,
    ...overrides,
  };
}

async function workerRenderer(
  events: RendererConfig['events'],
  fallbackReason?: string,
): Promise<{
  renderer: RendererImpl;
  worker: FakeWorker;
  transport: Transport;
}> {
  const worker = new FakeWorker(fallbackReason);
  const transport = await connectWorkerTransport(
    worker,
    {} as OffscreenCanvas,
    { backend: 'auto', antialias: false },
    { cssWidth: 300, cssHeight: 150, resolution: 1 },
  );
  const renderer = new RendererImpl(transport, config({ events }));
  return { renderer, worker, transport };
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe('events sink in worker mode', () => {
  it('emits fallback then ready (worker: true) before the renderer is handed out', async () => {
    const seen: [string, unknown][] = [];
    const { renderer } = await workerRenderer(
      { emit: (name, payload) => seen.push([name, payload]) },
      'navigator.gpu missing',
    );
    expect(seen).toEqual([
      [
        'fallback',
        { from: 'webgpu', to: 'webgl2', reason: 'navigator.gpu missing' },
      ],
      [
        'ready',
        {
          backend: 'webgl2',
          worker: true,
          sharedMemory: renderer.info.sharedMemory,
          fallbackReason: 'navigator.gpu missing',
        },
      ],
    ]);
    renderer.destroy();
  });

  it('forwards the worker core messages as deviceLost / deviceRestored / error, in order', async () => {
    const seen: [string, unknown][] = [];
    const { renderer, worker } = await workerRenderer({
      emit: (name, payload) => seen.push([name, payload]),
    });
    seen.length = 0;
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    worker.send({ type: 'deviceLost', message: 'context lost' });
    worker.send({ type: 'deviceRestored' });
    worker.send({ type: 'error', code: 'INTERNAL', message: 'x' });
    await flush(); // the transport delivers queued messages asynchronously
    log.mockRestore();
    expect(seen).toEqual([
      [
        'deviceLost',
        { backend: 'webgl2', message: 'context lost', willRestore: true },
      ],
      ['deviceRestored', { backend: 'webgl2', generation: 1 }],
      ['error', { code: 'INTERNAL', message: 'x' }],
    ]);
    renderer.destroy();
  });

  it('every payload is a fresh object (a sink may keep it)', async () => {
    const payloads: unknown[] = [];
    const { renderer } = await workerRenderer({
      emit: (_name, payload) => payloads.push(payload),
    });
    renderer.resize(10, 10);
    renderer.resize(20, 20);
    expect(payloads.length).toBe(3);
    expect(new Set(payloads).size).toBe(3);
    expect(payloads[1]).toEqual({ width: 10, height: 10, resolution: 1 });
    renderer.destroy();
  });

  it('a renderer without a sink runs the same paths', async () => {
    const { renderer, worker } = await workerRenderer(undefined);
    renderer.resize(10, 10);
    worker.send({ type: 'deviceLost', message: 'm' });
    await flush();
    expect(renderer.destroyed).toBe(false);
    renderer.destroy();
  });
});

describe('renderer.interop() in worker mode', () => {
  it('the worker transport has no interop; interop() rejects UNSUPPORTED every time', async () => {
    const { renderer, transport } = await workerRenderer(undefined);
    expect(transport.interop).toBeUndefined();
    await expect(renderer.interop()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    // Not cached as a handle: still refused.
    await expect(renderer.interop()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    renderer.destroy();
    await expect(renderer.interop()).rejects.toMatchObject({
      code: 'DESTROYED',
    });
  });

  it('the local transport hands its own core to the interop factory', () => {
    const transport = new LocalTransport();
    const core = { caps: FAKE_CAPS } as unknown as RenderCore;
    transport.attach(core);
    let got: RenderCore | null = null;
    const made = {} as CoreInterop;
    expect(
      transport.interop(c => {
        got = c;
        return made;
      }),
    ).toBe(made);
    expect(got).toBe(core);
  });
});
