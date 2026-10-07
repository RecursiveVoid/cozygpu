/** Pooled filter render targets (ARCHITECTURE §22.4). */
import type { RhiTexture } from '../backend/types';
import { FakeBackend, FakeTexture } from '../renderer/testing/fakeBackend';
import { FILTER_TARGET_GRANULARITY } from '../types/layouts';
import {
  TARGET_IDLE_FRAMES,
  acquireTargetPool,
  createTargetPool,
  currentPassDesc,
  releaseTargetPool,
  resetTargetPool,
  setCurrentPassDesc,
} from './targets';

function countCreated(backend: FakeBackend): number {
  return backend.calls.filter(c => c.startsWith('createTexture')).length;
}

describe('filter target pool', () => {
  it('rounds the size up to the granularity', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const t = pool.acquire(1000, 700) as FakeTexture;
    expect(t.width % FILTER_TARGET_GRANULARITY).toBe(0);
    expect(t.height % FILTER_TARGET_GRANULARITY).toBe(0);
    expect(t.width).toBeGreaterThanOrEqual(1000);
    expect(t.height).toBeGreaterThanOrEqual(700);
    pool.destroy();
  });

  it('reuses a released target of the same key', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const a = pool.acquire(640, 480);
    pool.release(a);
    const b = pool.acquire(640, 480);
    expect(b).toBe(a);
    expect(countCreated(backend)).toBe(1);
    pool.destroy();
  });

  it('keeps a slightly resized group on the same texture', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const a = pool.acquire(600, 400);
    pool.endFrame();
    const b = pool.acquire(610, 405);
    expect(b).toBe(a);
    expect(countCreated(backend)).toBe(1);
    pool.destroy();
  });

  it('does not hand the same target out twice while it is in use', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const a = pool.acquire(256, 256);
    const b = pool.acquire(256, 256);
    expect(b).not.toBe(a);
    expect(countCreated(backend)).toBe(2);
    pool.destroy();
  });

  it('keys on format and sample count', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const a = pool.acquire(256, 256, 'rgba8unorm');
    pool.release(a);
    const b = pool.acquire(256, 256, 'rgba16float');
    expect(b).not.toBe(a);
    pool.destroy();
  });

  it('allocates nothing in a steady-state frame', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    for (let frame = 0; frame < 10; frame++) {
      const capture = pool.acquire(1280, 720);
      const ping = pool.acquire(1280, 720);
      pool.release(capture);
      const pong = pool.acquire(1280, 720);
      expect(pong).toBe(capture);
      expect(ping).not.toBe(pong);
      pool.endFrame();
    }
    expect(countCreated(backend)).toBe(2);
    pool.destroy();
  });

  it('endFrame releases what a frame forgot', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const a = pool.acquire(128, 128);
    pool.endFrame();
    expect(pool.acquire(128, 128)).toBe(a);
    pool.destroy();
  });

  it('destroys a target left idle for TARGET_IDLE_FRAMES', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const a = pool.acquire(128, 128) as FakeTexture;
    const bytes = pool.bytes;
    expect(bytes).toBeGreaterThan(0);
    for (let i = 0; i <= TARGET_IDLE_FRAMES + 1; i++) pool.endFrame();
    expect(a.destroyed).toBe(true);
    expect(pool.bytes).toBe(0);
    pool.destroy();
  });

  it('announces every texture it destroys, to listeners that stay registered', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const seen: RhiTexture[] = [];
    const listener = (t: RhiTexture): void => void seen.push(t);
    pool.onDestroyed(listener);
    // Registering twice must not announce twice.
    pool.onDestroyed(listener);

    const aged = pool.acquire(128, 128) as FakeTexture;
    for (let i = 0; i <= TARGET_IDLE_FRAMES + 1; i++) pool.endFrame();
    expect(seen).toEqual([aged]);

    const live = pool.acquire(256, 256) as FakeTexture;
    pool.offDestroyed(listener);
    pool.destroy();
    expect(live.destroyed).toBe(true);
    expect(seen).toEqual([aged]);
  });

  it('announces what it still holds when the pool itself is destroyed', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const seen: RhiTexture[] = [];
    pool.onDestroyed(t => void seen.push(t));
    const a = pool.acquire(128, 128) as FakeTexture;
    pool.destroy();
    expect(seen).toEqual([a]);
  });

  it('reports the bytes it holds', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    const t = pool.acquire(200, 200) as FakeTexture;
    expect(pool.bytes).toBe(t.width * t.height * 4);
    pool.destroy();
    expect(pool.bytes).toBe(0);
  });

  it('throws after destroy', () => {
    const backend = new FakeBackend();
    const pool = createTargetPool(backend);
    pool.destroy();
    expect(() => pool.acquire(64, 64)).toThrow(/DESTROYED/);
  });
});

describe('shared pool (filters + masks)', () => {
  it('hands both systems the same pool and destroys it once', () => {
    const backend = new FakeBackend();
    const a = acquireTargetPool(backend);
    const b = acquireTargetPool(backend);
    expect(b).toBe(a);
    const texture = a.acquire(64, 64) as FakeTexture;
    releaseTargetPool(backend);
    expect(texture.destroyed).toBe(false);
    releaseTargetPool(backend);
    expect(texture.destroyed).toBe(true);
  });

  it('tracks the pass a nested effect must reopen', () => {
    const backend = new FakeBackend();
    acquireTargetPool(backend);
    expect(currentPassDesc(backend)).toBeNull();
    const desc = {
      color: { target: 'canvas' as const, load: 'clear' as const },
    };
    setCurrentPassDesc(backend, desc);
    expect(currentPassDesc(backend)).toBe(desc);
    setCurrentPassDesc(backend, null);
    expect(currentPassDesc(backend)).toBeNull();
    releaseTargetPool(backend);
  });

  it("forgets the lost device's targets on a restore without destroying them", () => {
    const backend = new FakeBackend();
    const pool = acquireTargetPool(backend);
    const old = pool.acquire(64, 64) as FakeTexture;
    pool.endFrame();
    expect(pool.bytes).toBeGreaterThan(0);
    setCurrentPassDesc(backend, {
      color: { target: 'canvas', load: 'clear' },
    });
    // The backend object survives a device restore, and so does the shared
    // record: its textures belong to the lost device and must not be reused.
    resetTargetPool(backend);
    expect(pool.bytes).toBe(0);
    expect(currentPassDesc(backend)).toBeNull();
    expect(old.destroyed).toBe(false);
    const fresh = pool.acquire(64, 64);
    expect(fresh).not.toBe(old);
    releaseTargetPool(backend);
    expect(old.destroyed).toBe(false);
  });

  it('can hand out a target of exactly the asked size', () => {
    const pool = createTargetPool(new FakeBackend());
    const t = pool.acquire(640, 480, undefined, 1, true) as FakeTexture;
    expect(t.width).toBe(640);
    expect(t.height).toBe(480);
    // A rounded request does not take the exact target (and vice versa).
    pool.release(t);
    expect(pool.acquire(640, 480)).not.toBe(t);
    pool.destroy();
  });
});
