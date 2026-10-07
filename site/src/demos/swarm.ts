// Swarm: every object is simulated on the GPU (compute on WebGPU, transform
// feedback on WebGL2). The CPU sends a handful of commands per frame.
// While idle an attractor wanders on its own; hold the pointer down to
// take it over. Full example: examples/swarm/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const { canvas } = ctx;
  const renderer = await GPU.createRenderer({
    canvas,
    limits: 'max',
    background: 0x0b0b12,
    powerPreference: 'high-performance',
    backend: ctx.backend,
    worker: workerOption(ctx),
  });
  const caps = renderer.info.capabilities;
  if (!caps.compute && !caps.transformFeedback) {
    renderer.destroy();
    throw new Error('Swarm needs WebGPU compute or WebGL2 transform feedback');
  }

  let w = canvas.clientWidth || renderer.width;
  let h = canvas.clientHeight || renderer.height;
  const point: [number, number] = [w / 2, h / 2];
  const rect: [number, number, number, number] = [0, 0, w, h];
  let strength = 0;
  /** True while the pointer holds the attractor. */
  let held = false;
  const IDLE_STRENGTH = 450;

  let swarm: GPU.Swarm | null = null;
  let count = 0;

  const build = (n: number): void => {
    if (swarm) {
      renderer.stage.removeChild(swarm);
      swarm.destroy();
    }
    count = n;
    const fill = (target: GPU.SwarmNode): void => {
      target.spawn(n, {
        x: [0, w],
        y: [0, h],
        speed: [10, 90],
        angle: [0, Math.PI * 2],
        size: [1, 2.2],
        color: ['#3fa9ff', '#ff5fc8'],
        alpha: [0.08, 0.32],
      });
    };
    swarm = new GPU.Swarm({
      capacity: n,
      shape: 'circle',
      blendMode: 'add',
      onRestore: fill,
      behaviors: [
        GPU.behaviors.velocity(),
        GPU.behaviors.attractor({
          x: point[0],
          y: point[1],
          strength,
          radius: 400,
        }),
        GPU.behaviors.bounds({
          x: 0,
          y: 0,
          width: w,
          height: h,
          mode: 'bounce',
          restitution: 0.9,
        }),
      ],
    });
    renderer.stage.addChild(swarm);
    fill(swarm);
  };
  build(ctx.count);

  const attractor = () =>
    (swarm as GPU.Swarm).behavior<{
      point: 'vec2f';
      strength: 'f32';
      radius: 'f32';
    }>('attractor');

  const onMove = (e: PointerEvent): void => {
    if (!held && e.buttons === 0) return;
    point[0] = e.offsetX;
    point[1] = e.offsetY;
    attractor().set('point', point);
  };
  const onDown = (e: PointerEvent): void => {
    held = true;
    onMove(e);
    strength = 3000;
    attractor().set('strength', strength);
  };
  const onUp = (): void => {
    if (!held) return;
    held = false;
    strength = IDLE_STRENGTH;
    attractor().set('strength', strength);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  const ticker = GPU.ticker(renderer);
  strength = IDLE_STRENGTH;
  attractor().set('strength', strength);
  ticker.add((_dt, time) => {
    ctx.tick();
    if (!held) {
      // Idle: the attractor drifts along a slow figure eight.
      point[0] = w * (0.5 + 0.3 * Math.sin(time * 0.37));
      point[1] = h * (0.5 + 0.28 * Math.sin(time * 0.74));
      attractor().set('point', point);
    }
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if ((cw !== w || ch !== h) && cw > 0 && ch > 0) {
      w = cw;
      h = ch;
      rect[2] = w;
      rect[3] = h;
      (swarm as GPU.Swarm)
        .behavior<{ rect: 'vec4f'; restitution: 'f32' }>('bounds')
        .set('rect', rect);
    }
  });

  return {
    renderer,
    ticker,
    objects: () => count,
    setCount: build,
    destroy() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      teardown(ticker, renderer);
    },
  };
}
