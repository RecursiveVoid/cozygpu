/** Tester: ticker timing edge cases (rAF-driven and setTimeout fallback). */
import type { Renderer } from '../types/renderer';
import { ticker } from './ticker';

const g = globalThis as Record<string, unknown>;
let queue: ((ms: number) => void)[] = [];
let cancelled: number[] = [];

function installRaf(): void {
  queue = [];
  cancelled = [];
  g.requestAnimationFrame = (cb: (ms: number) => void) => {
    queue.push(cb);
    return queue.length;
  };
  g.cancelAnimationFrame = (h: number) => void cancelled.push(h);
}

function frame(ms: number): void {
  const cbs = queue;
  queue = [];
  for (const cb of cbs) cb(ms);
}

afterEach(() => {
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
});

describe('ticker timing', () => {
  beforeEach(installRaf);

  it('schedules exactly one rAF per frame and none after stop()', () => {
    const t = ticker(null);
    expect(queue).toHaveLength(1);
    frame(0);
    expect(queue).toHaveLength(1);
    frame(16);
    expect(queue).toHaveLength(1);
    t.stop();
    expect(cancelled).toHaveLength(1);
    expect(t.running).toBe(false);
    t.stop(); // idempotent
    expect(cancelled).toHaveLength(1);
    t.start();
    t.start(); // idempotent
    expect(queue.length).toBeLessThanOrEqual(2);
    t.destroy();
  });

  it('autoStart: false does not schedule; start() re-baselines dt after a pause', () => {
    const dts: number[] = [];
    const t = ticker(null, { autoStart: false, maxDt: 10 });
    t.add(dt => dts.push(dt));
    expect(queue).toHaveLength(0);
    t.start();
    frame(1000);
    frame(1016);
    t.stop();
    queue = []; // cancelled
    t.start();
    frame(9000); // baseline only: a paused ticker must not report 8 s
    frame(9020);
    expect(dts.map(d => Math.round(d * 1000))).toEqual([16, 20]);
    t.destroy();
  });

  it('time accumulates clamped dt; fps is smoothed from raw dt', () => {
    const t = ticker(null, { maxDt: 0.05 });
    frame(0);
    for (let i = 1; i <= 100; i++) frame(i * 10); // 100 fps
    expect(t.time).toBeCloseTo(1.0, 6);
    expect(t.fps).toBeCloseTo(100, 3);
    frame(1000 + 200); // 200 ms hitch: dt clamps, fps dips but is smoothed
    expect(t.dt).toBeCloseTo(0.05, 6);
    expect(t.time).toBeCloseTo(1.05, 6);
    expect(t.fps).toBeGreaterThan(80);
    expect(t.fps).toBeLessThan(100);
    t.destroy();
  });

  it('non-increasing timestamps call nothing and do not corrupt time', () => {
    const calls: number[] = [];
    const t = ticker(null);
    t.add(dt => calls.push(dt));
    frame(100);
    frame(100);
    frame(90);
    expect(calls).toEqual([]);
    expect(t.time).toBe(0);
    expect(Number.isFinite(t.fps)).toBe(true);
    frame(110);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeCloseTo(0.02, 6);
    t.destroy();
  });

  it('maxFPS tolerates display jitter and can be changed at runtime', () => {
    const t = ticker(null, { maxFPS: 60 });
    let n = 0;
    t.add(() => n++);
    frame(0);
    // 60 Hz display with ±0.5 ms jitter: never throttled to 30
    const stamps = [16.2, 33.9, 50.0, 66.1, 83.8, 100.0];
    for (const s of stamps) frame(s);
    expect(n).toBe(stamps.length);
    // 144 Hz display capped to 60: roughly 60 calls per second
    n = 0;
    for (let i = 1; i <= 144; i++) frame(100 + (i * 1000) / 144);
    expect(n).toBeGreaterThanOrEqual(45);
    expect(n).toBeLessThanOrEqual(62);
    t.maxFPS = 0;
    n = 0;
    for (let i = 1; i <= 144; i++) frame(1100 + (i * 1000) / 144);
    expect(n).toBe(144);
    t.destroy();
  });

  it('callbacks: add during iteration runs in insertion order; destroy inside a callback is safe', () => {
    const t = ticker(null);
    const log: string[] = [];
    const late = () => log.push('late');
    t.add(() => {
      log.push('a');
      if (log.length === 1) t.add(late);
    });
    frame(0);
    frame(10);
    frame(20);
    expect(log).toEqual(['a', 'late', 'a', 'late']);
    t.add(() => t.destroy());
    t.add(() => log.push('after-destroy'));
    frame(30);
    expect(t.running).toBe(false);
    frame(40);
    expect(log).not.toContain('after-destroy');
    expect(queue).toHaveLength(0);
  });

  it('a throwing callback propagates but leaves removal bookkeeping sane', () => {
    const t = ticker(null);
    const calls: string[] = [];
    const b = () => calls.push('b');
    t.add(() => {
      t.remove(b);
      throw new Error('boom');
    });
    t.add(b);
    frame(0);
    expect(() => frame(10)).toThrow('boom');
    // removal was compacted in finally; next removal is direct, not deferred
    const c = () => calls.push('c');
    t.add(c);
    t.remove(c);
    expect(() => frame(20)).toThrow('boom');
    expect(calls).toEqual([]);
    expect(queue).toHaveLength(1); // still scheduled
    t.destroy();
  });

  it('the disposer removes only its own registration', () => {
    const t = ticker(null);
    const calls: number[] = [];
    const cb = (dt: number) => calls.push(dt);
    const off1 = t.add(cb);
    t.add(cb);
    off1();
    frame(0);
    frame(10);
    expect(calls).toHaveLength(1);
    t.destroy();
  });

  it('autoRender: renders after callbacks, stops when the renderer is destroyed', () => {
    const order: string[] = [];
    const r = { destroyed: false, render: () => order.push('render') };
    const t = ticker(r as unknown as Renderer);
    t.add(() => order.push('cb'));
    frame(0);
    frame(16);
    expect(order).toEqual(['cb', 'render']);
    r.destroyed = true;
    frame(32);
    expect(t.running).toBe(false);
    expect(order).toEqual(['cb', 'render', 'cb']);
    const manual = ticker(r as unknown as Renderer, { autoRender: false });
    r.destroyed = false;
    order.length = 0;
    frame(40);
    frame(56);
    expect(order).toEqual([]);
    manual.destroy();
  });
});

describe('ticker without requestAnimationFrame', () => {
  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());

  it('falls back to setTimeout and stop() clears the timer', () => {
    expect(g.requestAnimationFrame).toBeUndefined();
    const dts: number[] = [];
    const t = ticker(null);
    t.add(dt => dts.push(dt));
    jest.advanceTimersByTime(1000);
    expect(dts.length).toBeGreaterThan(40);
    expect(dts.length).toBeLessThan(70);
    t.stop();
    const n = dts.length;
    jest.advanceTimersByTime(1000);
    expect(dts.length).toBe(n);
    expect(jest.getTimerCount()).toBe(0);
    t.destroy();
  });
});
