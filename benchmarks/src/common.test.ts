import { BounceSim, circlePixels, readParams, rng } from './common';

describe('benchmark common', () => {
  it('rng is deterministic and in [0, 1)', () => {
    const a = rng(42);
    const b = rng(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('BounceSim is seeded identically and stays inside the stage', () => {
    const s1 = new BounceSim(1000, 320, 200, 7);
    const s2 = new BounceSim(1000, 320, 200, 7);
    expect(Array.from(s1.x)).toEqual(Array.from(s2.x));
    for (let f = 0; f < 600; f++) s1.step(1 / 60);
    for (let i = 0; i < s1.count; i++) {
      expect(s1.x[i]).toBeGreaterThanOrEqual(0);
      expect(s1.x[i]).toBeLessThanOrEqual(320);
      expect(s1.y[i]).toBeGreaterThanOrEqual(0);
      expect(s1.y[i]).toBeLessThanOrEqual(200);
    }
  });

  it('circle texture has opaque center and transparent corners', () => {
    const px = circlePixels(16);
    expect(px[3]).toBe(0);
    expect(px[(8 * 16 + 8) * 4 + 3]).toBe(255);
  });

  it('readParams parses the query string with defaults', () => {
    const p = readParams(
      '?lib=three&renderer=webgpu&variant=compute&scenario=swarm&count=2000000',
    );
    expect(p).toMatchObject({
      lib: 'three',
      renderer: 'webgpu',
      variant: 'compute',
      scenario: 'swarm',
      count: 2_000_000,
      width: 1280,
    });
  });
});
