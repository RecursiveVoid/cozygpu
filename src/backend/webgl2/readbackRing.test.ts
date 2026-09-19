/**
 * M2.5 WebGL2 readback ring, pacing on ring fences and interop
 * (ARCHITECTURE §19.4–§19.6).
 */
import { BufferUsage, ReadbackState, TextureUsage } from '../types';
import { createFakeGL, type FakeGL } from './fakeGL.testutil';
import * as G from './glconst';
import { WebGL2Backend } from './WebGL2Backend';

async function makeBackend(): Promise<{
  fake: FakeGL;
  backend: WebGL2Backend;
}> {
  const fake = createFakeGL();
  const backend = await WebGL2Backend.create(
    fake.canvas as unknown as OffscreenCanvas,
    { preference: 'webgl2' },
  );
  await backend.loadReadbackRing();
  fake.clear();
  return { fake, backend };
}

function pickTarget(backend: WebGL2Backend) {
  return backend.createTexture({
    label: 'pick',
    width: 1,
    height: 1,
    format: 'rgba32uint',
    usage: TextureUsage.RENDER_TARGET | TextureUsage.COPY_SRC,
  });
}

describe('WebGL2 readback ring', () => {
  it('creates its PBOs once and reads a texel after the fence, without blocking', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 2, slotBytes: 16 });
    expect(fake.calls.filter(c => c.startsWith('bufferData(')).length).toBe(2);
    const tex = pickTarget(backend);
    const list = backend.beginCommands();
    const slot = ring.acquire();
    expect(slot).toBe(0);
    expect(ring.poll(slot)).toBe(ReadbackState.PENDING);
    fake.clear();
    ring.copyTexture(list, slot, tex, 0, 0, 1, 1);
    expect(fake.calls).toContain(
      `readPixels(0, 0, 1, 1, ${G.RGBA_INTEGER}, ${G.UNSIGNED_INT}, 0)`,
    );
    expect(fake.calls.some(c => c.startsWith('fenceSync'))).toBe(true);
    // Fence not signalled: PENDING, nothing read.
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    fake.clear();
    expect(ring.poll(slot)).toBe(ReadbackState.PENDING);
    expect(fake.calls.some(c => c.startsWith('getBufferSubData'))).toBe(false);
    // Signalled: READY with the texel in the persistent view.
    fake.readData.bytes = new Uint8Array(new Uint32Array([5, 2, 77, 0]).buffer);
    const view = ring.data(slot);
    expect(ring.poll(slot)).toBe(ReadbackState.READY);
    expect(ring.data(slot)).toBe(view);
    expect(Array.from(view)).toEqual([5, 2, 77, 0]);
    ring.release(slot);
    expect(ring.poll(slot)).toBe(ReadbackState.FREE);
    // No PBO or buffer is created per read.
    expect(fake.calls.some(c => c.startsWith('createBuffer'))).toBe(false);
    // Every slot busy → -1.
    expect([ring.acquire(), ring.acquire(), ring.acquire()]).toEqual([
      0, 1, -1,
    ]);
    ring.destroy();
    expect(backend.rings).toEqual([]);
  });

  it('fails in-flight slots after a context loss', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const slot = ring.acquire();
    ring.copyTexture(
      backend.beginCommands(),
      slot,
      pickTarget(backend),
      0,
      0,
      1,
      1,
    );
    fake.fire('webglcontextlost');
    expect(ring.poll(slot)).toBe(ReadbackState.FAILED);
    ring.release(slot);
    expect(ring.poll(slot)).toBe(ReadbackState.FREE);
  });

  it('rejects copies that do not fit the slot or unreadable textures', async () => {
    const { backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const tex = backend.createTexture({
      width: 2,
      height: 2,
      format: 'rgba32uint',
      usage: TextureUsage.RENDER_TARGET,
    });
    const list = backend.beginCommands();
    const slot = ring.acquire();
    expect(() => ring.copyTexture(list, slot, tex, 0, 0, 2, 2)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => ring.copyTexture(list, slot, tex, 1, 1, 2, 2)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    const half = backend.createTexture({
      width: 1,
      height: 1,
      format: 'rgba16float',
      usage: TextureUsage.RENDER_TARGET,
    });
    expect(() => ring.copyTexture(list, slot, half, 0, 0, 1, 1)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED' }),
    );
  });

  it('paces only while a ring fence lags PACE_FRAMES frames, and releases a held frame on a timer', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const slot = ring.acquire();
    ring.copyTexture(
      backend.beginCommands(),
      slot,
      pickTarget(backend),
      0,
      0,
      1,
      1,
    );
    for (let i = 0; i < 2; i++) {
      backend.beginCommands();
      expect(backend.backlogged()).toBe(false); // too recent: fence not checked
    }
    backend.beginCommands(); // PACE_FRAMES = 3
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(true);
    // Signalled (default): not behind any more, even before the slot is polled.
    expect(backend.backlogged()).toBe(false);
    const held = jest.fn();
    fake.syncResults.push(G.TIMEOUT_EXPIRED, G.TIMEOUT_EXPIRED);
    backend.whenCaughtUp(held);
    expect(held).not.toHaveBeenCalled();
    for (let i = 0; i < 20 && held.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(held).toHaveBeenCalledTimes(1);
    // A signalled but unpolled slot, or no slot at all, never holds.
    ring.release(slot);
    expect(backend.backlogged()).toBe(false);
  });
});

describe('WebGL2 interop', () => {
  it('native() is the context; importBuffer wraps without ownership', async () => {
    const { fake, backend } = await makeBackend();
    expect(backend.native()).toBe(fake.gl);
    const outside = backend.createBuffer({
      size: 64,
      usage: BufferUsage.VERTEX,
    });
    const raw = (outside as unknown as { raw: WebGLBuffer }).raw;
    expect(() =>
      backend.importBuffer(raw, { size: 64, usage: BufferUsage.VERTEX }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    (fake.gl as unknown as { isBuffer: (b: unknown) => boolean }).isBuffer =
      b => b === raw;
    const imported = backend.importBuffer(raw, {
      size: 64,
      usage: BufferUsage.VERTEX,
      label: 'ext',
    });
    expect(imported).toMatchObject({ size: 64, label: 'ext' });
    fake.clear();
    imported.destroy();
    expect(fake.calls.some(c => c.startsWith('deleteBuffer'))).toBe(false);
  });

  it('resetState forgets cached bindings and restores defaults', async () => {
    const { fake, backend } = await makeBackend();
    backend.resetState();
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        `pixelStorei(${G.PACK_ALIGNMENT}, 1)`,
        `bindBuffer(${G.PIXEL_UNPACK_BUFFER}, null)`,
        `bindBuffer(${G.PIXEL_PACK_BUFFER}, null)`,
        `disable(${G.CULL_FACE})`,
        `disable(${G.STENCIL_TEST})`,
        'colorMask(true, true, true, true)',
      ]),
    );
  });
});
