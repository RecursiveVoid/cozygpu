/**
 * M2.5 review: WebGL2 readback ring reuse and wraparound, the fence watch
 * and pacing only while a ring slot is in flight (ARCHITECTURE §19.5,
 * §19.6).
 */
import { ReadbackState, TextureUsage } from '../types';
import { createFakeGL, type FakeGL } from './fakeGL.testutil';
import * as G from './glconst';
import { GLReadbackRing, type GLRingHost } from './readbackRing';
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

  it('the watch stands down while a frame is held and resumes when it goes', async () => {
    const { fake, backend } = await makeBackend();
    const landed = jest.fn();
    // A host that is "holding a frame": the ring must not start its own
    // timer, because the backend's catch-up timer polls the same fences.
    const host: GLRingHost & { frameHeld: boolean } = {
      gl: backend.gl,
      lost: false,
      epoch: backend.epoch,
      frameSerial: 1,
      rings: [],
      onReadbackLanded: landed,
      frameHeld: true,
      bindTargetFramebuffer: (texture, depth) =>
        backend.bindTargetFramebuffer(texture, depth),
    };
    const ring = new GLReadbackRing(host, 1, 16, 'test');
    const s = ring.acquire();
    fake.syncResults.push(
      ...Array.from({ length: 80 }, () => G.TIMEOUT_EXPIRED),
    );
    ring.copyTexture(backend.beginCommands(), s, target(backend), 0, 0, 1, 1);
    fake.clear();
    await wait(10);
    expect(fake.calls.filter(c => c.startsWith('clientWaitSync'))).toEqual([]);
    expect(landed).not.toHaveBeenCalled();

    // The frame went: the watch picks the still-pending slot up again.
    host.frameHeld = false;
    ring.resumeWatch();
    await wait(10);
    expect(
      fake.calls.filter(c => c.startsWith('clientWaitSync')).length,
    ).toBeGreaterThan(0);
    fake.syncResults.length = 0;
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
    // Submitted frames, each followed by the pacing check the core makes:
    // the queue-depth probe (§7.1) keeps up, so only the readback half of
    // pacing can speak here.
    for (let i = 0; i < 50; i++) {
      backend.beginCommands().submit();
      expect(backend.backlogged()).toBe(false); // nothing in flight
    }
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

  it('holds when the GPU is QUEUE_FRAMES frames and QUEUE_MS behind, with no readback at all', async () => {
    const { fake, backend } = await makeBackend();
    // M5: the fence must also be QUEUE_MS (20 ms) old.
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    // Frames whose fence never signals: the GPU falls behind without end.
    // Well past QUEUE_IDLE_FRAMES, so the depth is measured and allowed to
    // speak (it only starts counting once the idle stretch is over).
    for (let i = 0; i < 48; i++) {
      fake.syncResults.push(G.TIMEOUT_EXPIRED);
      backend.beginCommands().submit();
      fake.syncResults.length = 0;
    }
    // One probe is armed and unsignalled, so the depth is the frame count;
    // it holds only once the fence is QUEUE_MS old.
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(false);
    fake.syncResults.length = 0;
    now.mockReturnValue(1000);
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(true);
    fake.syncResults.length = 0;

    // A frame held on depth alone is released once the fence signals.
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    const held = jest.fn();
    backend.whenCaughtUp(held);
    fake.syncResults.length = 0;
    expect(held).not.toHaveBeenCalled();
    for (let i = 0; i < 30 && held.mock.calls.length === 0; i++) await wait(2);
    expect(held).toHaveBeenCalledTimes(1);
    expect(backend.backlogged()).toBe(false);
    now.mockRestore();
  });

  it('holds frames once PACE_FRAMES frames ran during a readback', async () => {
    const { fake, backend } = await makeBackend();
    const ring = backend.createReadbackRing({ slots: 1, slotBytes: 16 });
    const s = ring.acquire();
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    ring.copyTexture(backend.beginCommands(), s, target(backend), 0, 0, 1, 1);
    for (let i = 0; i < 6; i++) {
      fake.syncResults.push(G.TIMEOUT_EXPIRED, G.TIMEOUT_EXPIRED);
      backend.beginCommands().submit();
      // The queue stays under QUEUE_FRAMES here, so this is the readback
      // half of pacing on its own: it holds from the third frame on.
      expect(backend.backlogged()).toBe(i >= 2);
      fake.syncResults.length = 0;
    }
    ring.destroy();
  });

  it('never holds on depth in a display-paced loop, and arms few fences', async () => {
    const { fake, backend } = await makeBackend();
    fake.clear();
    // The fake signals every fence at once: the GPU is never behind.
    for (let i = 0; i < 120; i++) {
      backend.beginCommands().submit();
      expect(backend.backlogged()).toBe(false);
    }
    // One fence per QUEUE_PROBE frames at most, not one per frame.
    const fences = fake.calls.filter(c => c.startsWith('fenceSync'));
    expect(fences.length).toBeLessThanOrEqual(120 / 8 + 1);
  });

  it('stops holding on depth when the context is lost', async () => {
    const { fake, backend } = await makeBackend();
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    for (let i = 0; i < 48; i++) {
      fake.syncResults.push(G.TIMEOUT_EXPIRED);
      backend.beginCommands().submit();
      fake.syncResults.length = 0;
    }
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(false); // arms the fence at 0 ms
    fake.syncResults.length = 0;
    now.mockReturnValue(1000);
    fake.syncResults.push(G.TIMEOUT_EXPIRED);
    expect(backend.backlogged()).toBe(true);
    fake.syncResults.length = 0;
    fake.fire('webglcontextlost');
    expect(backend.backlogged()).toBe(false);
    now.mockRestore();
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
