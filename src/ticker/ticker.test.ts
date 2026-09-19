import type { Renderer } from '../types/renderer';
import { ticker } from './ticker';

describe('ticker', () => {
  let queue: ((ms: number) => void)[] = [];
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    queue = [];
    g.requestAnimationFrame = (cb: (ms: number) => void) => {
      queue.push(cb);
      return queue.length;
    };
    g.cancelAnimationFrame = () => undefined;
  });
  afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  function frame(ms: number): void {
    const cbs = queue;
    queue = [];
    for (const cb of cbs) cb(ms);
  }

  it('calls callbacks with clamped dt, then renders', () => {
    const render = jest.fn();
    const r = { render, destroyed: false } as unknown as Renderer;
    const t = ticker(r);
    const seen: number[] = [];
    const off = t.add(dt => seen.push(dt));
    frame(0); // first frame only sets the baseline
    frame(16);
    frame(1016); // 1 s gap clamps to maxDt 0.1
    expect(seen[0]).toBeCloseTo(0.016);
    expect(seen[1]).toBeCloseTo(0.1);
    expect(render).toHaveBeenCalledTimes(2);
    expect(t.time).toBeCloseTo(0.116);
    off();
    frame(1032);
    expect(seen.length).toBe(2);
    t.stop();
    expect(t.running).toBe(false);
  });

  it('supports removal during iteration and maxFPS throttling', () => {
    const t = ticker(null, { maxFPS: 30 });
    const calls: string[] = [];
    const b = () => calls.push('b');
    t.add(() => {
      calls.push('a');
      t.remove(b);
    });
    t.add(b);
    t.add(() => calls.push('c'));
    frame(0);
    frame(16); // throttled (< 33 ms)
    expect(calls).toEqual([]);
    frame(34);
    expect(calls).toEqual(['a', 'c']);
    frame(68);
    expect(calls).toEqual(['a', 'c', 'a', 'c']);
    t.destroy();
  });
});
