/**
 * Tester (logic, round 1): effective callback rate under `maxFPS` on common
 * display refresh rates, plus dt/time bookkeeping when frames are throttled.
 */
import { ticker } from './ticker';

const g = globalThis as Record<string, unknown>;
let queue: ((ms: number) => void)[] = [];

beforeEach(() => {
  queue = [];
  g.requestAnimationFrame = (cb: (ms: number) => void) => queue.push(cb);
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

/** Runs `seconds` of a `hz` display; returns callbacks per second and total time. */
function simulate(hz: number, maxFPS: number, seconds = 4) {
  const t = ticker(null, { maxFPS, maxDt: 1 });
  let calls = 0;
  let dtSum = 0;
  t.add(dt => {
    calls++;
    dtSum += dt;
  });
  frame(0);
  const frames = Math.round(hz * seconds);
  for (let i = 1; i <= frames; i++) frame((i * 1000) / hz);
  const time = t.time;
  t.destroy();
  return { rate: calls / seconds, dtSum, time };
}

describe('ticker maxFPS', () => {
  it.each([
    [60, 30, 30],
    [120, 60, 60],
    [120, 30, 30],
    [240, 60, 60],
  ])(
    '%i Hz display, maxFPS %i → %i calls/s (integer divisors)',
    (hz, max, want) => {
      const { rate } = simulate(hz, max);
      expect(rate).toBeGreaterThanOrEqual(want * 0.95);
      expect(rate).toBeLessThanOrEqual(want * 1.02);
    },
  );

  it('time equals the sum of dts and the wall time when throttled (no dt lost)', () => {
    for (const [hz, max] of [
      [144, 60],
      [90, 60],
      [60, 30],
    ]) {
      const { dtSum, time } = simulate(hz, max, 3);
      expect(time).toBeCloseTo(dtSum, 9);
      // skipped rAFs are folded into the next dt, so time tracks wall time
      expect(time).toBeGreaterThan(3 - 1 / max - 0.02);
      expect(time).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it('maxFPS above the display rate does not throttle', () => {
    expect(simulate(60, 144).rate).toBeCloseTo(60, 0);
  });

  // Regression: the throttle phase was not carried over, so on a display
  // whose period does not divide the cap the loop waited a whole extra
  // display frame (maxFPS 60: 48 fps on 144 Hz, 45 on 90 Hz, 55 on 165 Hz).
  it.each([
    [144, 60],
    [90, 60],
    [165, 60],
    [120, 60],
    [60, 60],
    [240, 30],
  ])('%i Hz display, maxFPS %i reaches at least 95%% of the cap', (hz, max) => {
    const { rate } = simulate(hz, max);
    expect(rate).toBeGreaterThanOrEqual(max * 0.95);
    expect(rate).toBeLessThanOrEqual(max * 1.02);
  });
});
