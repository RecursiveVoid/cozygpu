// Particle presets on top of Swarm: fire, smoke, rain, sparks (follow the
// pointer) and confetti (click). Per frame each emitter sends at most one
// spawn command; the CPU never walks a particle.
// Full example: examples/particles/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

function scaled(
  options: GPU.ParticlesOptions,
  scale: number,
): GPU.ParticlesOptions {
  const emitter = options.emitter as GPU.EmitterOptions | undefined;
  return {
    ...options,
    capacity: Math.max(64, Math.round(options.capacity * scale)),
    emitter: emitter
      ? { ...emitter, rate: Math.round((emitter.rate ?? 0) * scale) }
      : undefined,
  };
}

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const { canvas } = ctx;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x07070c,
    powerPreference: 'high-performance',
    backend: ctx.backend,
    worker: workerOption(ctx),
  });
  const caps = renderer.info.capabilities;
  if (!caps.compute && !caps.transformFeedback) {
    renderer.destroy();
    throw new Error(
      'Particles need WebGPU compute or WebGL2 transform feedback',
    );
  }
  await GPU.loadParticles();

  const presets = GPU.particlePresets;
  let nodes: GPU.ParticlesNode[] = [];
  let sparks: GPU.ParticlesNode | null = null;
  let confetti: GPU.ParticlesNode | null = null;
  const pointer = { x: 0, y: 0 };

  const build = (scale: number): void => {
    for (let i = 0; i < nodes.length; i++) {
      renderer.stage.removeChild(nodes[i]);
      nodes[i].destroy();
    }
    nodes = [];
    const w = canvas.clientWidth || renderer.width;
    const h = canvas.clientHeight || renderer.height;
    pointer.x = w * 0.5;
    pointer.y = h * 0.4;
    const add = (node: GPU.ParticlesNode): GPU.ParticlesNode => {
      renderer.stage.addChild(node);
      nodes.push(node);
      return node;
    };
    add(new GPU.Particles(scaled(presets.smoke(), scale)))
      .emitter()
      .moveTo(w * 0.5, h * 0.8);
    add(new GPU.Particles(scaled(presets.fire(), scale)))
      .emitter()
      .moveTo(w * 0.5, h * 0.82);
    add(
      new GPU.Particles({
        ...scaled(presets.rain(), scale),
        emitter: {
          rate: Math.round(900 * scale),
          shape: { line: { x2: w, y2: 40 } },
          speed: [700, 950],
          direction: [Math.PI * 0.44, Math.PI * 0.5],
          size: [2, 3],
          life: [(h / 950) * 1.1, (h / 700) * 1.1],
        },
      }),
    )
      .emitter()
      .moveTo(0, -20);
    sparks = add(new GPU.Particles(scaled(presets.sparks(), scale)));
    sparks.emitter().moveTo(pointer.x, pointer.y);
    confetti = add(
      new GPU.Particles({
        ...scaled(presets.confetti(), scale),
        emitter: {
          rate: 0,
          shape: { disc: { radius: 40, inner: 26 } },
          speed: [120, 420],
          size: [6, 12],
          life: [1.4, 2.4],
          rotation: [0, Math.PI * 2],
          angularVelocity: [-9, 9],
          color: ['#ff4d6d', '#4dd0ff'],
        },
      }),
    );
    confetti.emitter().moveTo(w * 0.5, h * 0.5);
  };
  build(ctx.count);

  const onMove = (e: PointerEvent): void => {
    pointer.x = e.offsetX;
    pointer.y = e.offsetY;
    sparks?.emitter().moveTo(pointer.x, pointer.y);
  };
  const onDown = (e: PointerEvent): void => {
    confetti?.emitter().moveTo(e.offsetX, e.offsetY);
    confetti?.emit(300);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);

  // Alive counts are GPU readbacks: poll twice a second, one at a time.
  let alive = 0;
  let pending = false;
  let pollAt = 0;
  const poll = async (): Promise<void> => {
    let sum = 0;
    const list = nodes;
    for (let i = 0; i < list.length; i++) {
      sum += await list[i].swarm.aliveCount();
    }
    if (list === nodes) alive = sum;
  };

  const ticker = GPU.ticker(renderer);
  ticker.add((_dt, time) => {
    ctx.tick();
    if (pending || time - pollAt < 0.5) return;
    pollAt = time;
    pending = true;
    poll().then(
      () => {
        pending = false;
      },
      () => {
        pending = false;
      },
    );
  });

  return {
    renderer,
    ticker,
    objects: () => alive,
    setCount: build,
    destroy() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      teardown(ticker, renderer);
    },
  };
}
