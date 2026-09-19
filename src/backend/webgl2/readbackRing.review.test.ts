/**
 * M2.5 review: WebGL2 readback ring reuse and wraparound, the fence watch
 * and pacing only while a ring slot is in flight (ARCHITECTURE §19.5,
 * §19.6).
 */
import { ReadbackState, TextureUsage } from '../types';
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

function target(backend: WebGL2Backend, w = 1, h = 1) {
  return backend.createTexture({
    label: 'pick',
    width: w,
    height: h,
    format: 'rgba32uint',
    usage: TextureUsage.RENDER_TARGET | TextureUsage.COPY_SRC,
  });
}

const texel = (...words: number[]) =>
  new Uint8Array(new Uint32Array(words).buffer);

describe('WebGL2 readback ring reuse and wraparound', () => {
  it('400 read cycles over 4 slots: no GL buffer per read, one fence per copy, every sync deleted', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 4, slotBytes: 16 });
    const tex = target(backend);
    const views = [0, 1, 2, 3].map(s => ring.data(s));
    fake.clear();
    let word = 1;
    for (let cycle = 0; cycle < 100; cycle++) {
      const list = backend.beginCommands();
      const slots = [0, 1, 2, 3].map(() => ring.acquire());
      expect(slots).toEqual([0, 1, 2, 3]);
      expect(ring.acquire()).toBe(-1);
      for (const s of slots) ring.copyTexture(list, s, tex, 0, 0, 1, 1);
      // Poll in reverse order; each slot gets its own data.
      for (let k = 3; k >= 0; k--) {
        fake.readData.bytes = texel(word, k, 0, 0);
        expect(ring.poll(k)).toBe(ReadbackState.READY);
        expect(ring.data(k)).toBe(views[k]);
        expect(views[k][0]).toBe(word);
        word++;
      }
      for (const s of [2, 0, 3, 1]) ring.release(s);
    }
    const count = (prefix: string) =>
      fake.calls.filter(c => c.startsWith(prefix)).length;
    expect(count('createBuffer')).toBe(0);
    expect(count('bufferData')).toBe(0);
    expect(count('fenceSync')).toBe(400);
    expect(count('deleteSync')).toBe(400);
    ring.destroy();
  });

  it('release of an in-flight slot deletes its fence; the slot is reusable at once', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const tex = target(backend);
    const list = backend.beginCommands();
    const s = ring.acquire();
    ring.copyTexture(list, s, tex, 0, 0, 1, 1);
    fake.clear();
    ring.release(s);
    expect(fake.calls.filter(c => c.startsWith('deleteSync')).length).toBe(1);
    expect(ring.acquire()).toBe(s);
    ring.copyTexture(list, s, tex, 0, 0, 1, 1);
    fake.readData.bytes = texel(42, 0, 0, 0);
    expect(ring.poll(s)).toBe(ReadbackState.READY);
    expect(ring.data(s)[0]).toBe(42);
    ring.destroy();
  });

  it('flips render-target rows so row 0 is the top row', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 32 });
    const tex = target(backend, 1, 2);
    const s = ring.acquire();
    ring.copyTexture(backend.beginCommands(), s, tex, 0, 0, 1, 2);
    // GL stores render targets bottom-up: the bottom row comes first.
    fake.readData.bytes = texel(5, 6, 7, 8, 1, 2, 3, 4);
    expect(ring.poll(s)).toBe(ReadbackState.READY);
    expect(Array.from(ring.data(s))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    ring.destroy();
  });
});

describe('WebGL2 fence watch and pacing', () => {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('the fence watch runs only while a slot is in flight and calls onReadbackLanded once it lands', async () => {
    const { fake, backend } = await makeBackend();
    const landed = jest.fn();
    backend.onReadbackLanded = landed;
    const ring = backend.createReadbackRing({ slots: 2, slotBytes: 16 });
    const s = ring.acquire();
    fake.syncResults.push(G.TIMEOUT_EXPIRED, G.TIMEOUT_EXPIRED);
    ring.copyTexture(backend.beginCommands(), s, target(backend), 0, 0, 1, 1);
    for (let i = 0; i < 30 && landed.mock.calls.length === 0; i++) {
      await wait(2);
    }
    expect(landed).toHaveBeenCalledTimes(1);
    // Landed: the watch stopped (no further calls without a new copy).
    fake.clear();
    await wait(10);
    expect(fake.calls.filter(c => c.startsWith('clientWaitSync'))).toEqual([]);
    expect(landed).toHaveBeenCalledTimes(1);
    ring.destroy();
  });

  it('without onReadbackLanded no watch timer runs', async () => {
    const { fake, backend } = await makeBackend();
    backend.onReadbackLanded = null;
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const s = ring.acquire();
    ring.copyTexture(backend.beginCommands(), s, target(backend), 0, 0, 1, 1);
    fake.clear();
    await wait(10);
    expect(fake.calls.filter(c => c.startsWith('clientWaitSync'))).toEqual([]);
    ring.destroy();
  });

  it('never paces with idle rings, READY slots or a fresh copy, however many frames ran', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 2, slotBytes: 16 });
    for (let i = 0; i < 50; i++) backend.beginCommands();
    expect(backend.backlogged()).toBe(false); // nothing in flight
    const s = ring.acquire();
    expect(backend.backlogged()).toBe(false); // acquired only
    ring.copyTexture(backend.beginCommands(), s, target(backend), 0, 0, 1, 1);
    // Copied this frame: too recent, the fence is not even checked.
    fake.clear();
    expect(backend.backlogged()).toBe(false);
    expect(fake.calls.filter(c => c.startsWith('clientWaitSync'))).toEqual([]);
    // Polled READY: never lagging again, even with an unsignalled fence queued.
    expect(ring.poll(s)).toBe(ReadbackState.READY);
    for (let i = 0; i < 5; i++) backend.beginCommands();
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(false);
    fake.syncResults.length = 0;
    ring.destroy();
  });

  it('a context loss stops pacing on the old ring', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const s = ring.acquire();
    ring.copyTexture(backend.beginCommands(), s, target(backend), 0, 0, 1, 1);
    for (let i = 0; i < 5; i++) backend.beginCommands();
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(true);
    fake.fire('webglcontextlost');
    fake.syncResults.push(G.TIMEOUT_EXPIRED, G.TIMEOUT_EXPIRED);
    const held = jest.fn();
    backend.whenCaughtUp(held);
    expect(held).toHaveBeenCalledTimes(1); // lost: a held frame goes at once
    fake.syncResults.length = 0;
  });
});
