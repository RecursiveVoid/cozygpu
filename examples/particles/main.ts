// Particle emitters on top of Swarm (ARCHITECTURE §24): presets, over-life
// curves, bursts and a mouse-driven emitter. The CPU never walks a particle —
// per frame each emitter sends at most one SWARM_SPAWN.
//   ?preset=all       'all' (default), 'fire', 'smoke', 'sparks', 'rain',
//                     'confetti'
//   ?scale=1          multiplies every preset's rate and capacity
//   ?worker=1         render in a worker
//   ?backend=webgl2   'auto' (default), 'webgpu', or 'webgl2' (transform
//                     feedback; ring allocation, finite lives — §24.5)
// Move the mouse to drag the sparks, click for a confetti burst, press space
// to pause and resume emission (the simulation keeps running).
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const PRESET = params.get('preset') ?? 'all';
const SCALE = Math.max(0.05, Number(params.get('scale') ?? 1) || 1);
const WORKER = params.get('worker') === '1';
const BACKEND =
  params.get('backend') === 'webgl2'
    ? 'webgl2'
    : params.get('backend') === 'webgpu'
      ? 'webgpu'
      : 'auto';

const wants = (name: string): boolean => PRESET === 'all' || PRESET === name;

/** Scales a preset's capacity and its emitter rates by ?scale. */
function scaled(options: GPU.ParticlesOptions): GPU.ParticlesOptions {
  const emitter = options.emitter as GPU.EmitterOptions | undefined;
  return {
    ...options,
    capacity: Math.max(64, Math.round(options.capacity * SCALE)),
    emitter: emitter
      ? { ...emitter, rate: Math.round((emitter.rate ?? 0) * SCALE) }
      : undefined,
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x07070c,
    powerPreference: 'high-performance',
    backend: BACKEND,
    worker: WORKER ? { url: '/build/examples/cozygpu.worker.js' } : false,
  });
  const caps = renderer.info.capabilities;
  if (!caps.compute && !caps.transformFeedback) {
    hud.textContent =
      'Particles need WebGPU compute or WebGL2 transform feedback';
    return;
  }
  // The compiler chunk loads on its own; preloading means the first frame
  // already emits.
  await GPU.loadParticles();

  const w = canvas.clientWidth || renderer.width;
  const h = canvas.clientHeight || renderer.height;
  const presets = GPU.particlePresets;
  const nodes: GPU.ParticlesNode[] = [];
  const add = (node: GPU.ParticlesNode): GPU.ParticlesNode => {
    renderer.stage.addChild(node);
    nodes.push(node);
    return node;
  };

  // Smoke sits behind the flame it comes from.
  const smoke = wants('smoke')
    ? add(new GPU.Particles(scaled(presets.smoke())))
    : null;
  smoke?.emitter().moveTo(w * 0.5, h * 0.8);

  const fire = wants('fire')
    ? add(new GPU.Particles(scaled(presets.fire())))
    : null;
  fire?.emitter().moveTo(w * 0.5, h * 0.82);

  // A line emitter: rain falls from a segment across the top of the stage.
  const rain = wants('rain')
    ? add(
        new GPU.Particles({
          ...scaled(presets.rain()),
          emitter: {
            rate: Math.round(900 * SCALE),
            shape: { line: { x2: w, y2: 40 } },
            speed: [700, 950],
            direction: [Math.PI * 0.44, Math.PI * 0.5],
            size: [2, 3],
            life: [(h / 950) * 1.1, (h / 700) * 1.1],
          },
        }),
      )
    : null;
  rain?.emitter().moveTo(0, -20);

  // Sparks follow the pointer; a ring emitter puffs around it on click.
  const sparks = wants('sparks')
    ? add(new GPU.Particles(scaled(presets.sparks())))
    : null;
  sparks?.emitter().moveTo(w * 0.5, h * 0.4);

  const confetti = wants('confetti')
    ? add(
        new GPU.Particles({
          ...scaled(presets.confetti()),
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
      )
    : null;
  confetti?.emitter().moveTo(w * 0.5, h * 0.5);

  const pointer = { x: w * 0.5, y: h * 0.4 };
  canvas.addEventListener('pointermove', e => {
    pointer.x = e.offsetX;
    pointer.y = e.offsetY;
    sparks?.emitter().moveTo(pointer.x, pointer.y);
  });
  canvas.addEventListener('pointerdown', e => {
    confetti?.emitter().moveTo(e.offsetX, e.offsetY);
    confetti?.emit(300);
  });
  window.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].playing) nodes[i].pause();
      else nodes[i].play();
    }
  });

  // Frame stats (ring of the last 120 intervals); the HUD is rebuilt twice a
  // second, never per frame.
  const samples = new Float64Array(120);
  let sampleCount = 0;
  let sampleAt = 0;
  let lastNow = performance.now();
  let hudAt = lastNow;
  const stats = { fps: 0, frameMs: 0, cpuMs: 0, packetBytes: 0, alive: -1 };
  let alivePending = false;
  const debug = window as unknown as Record<string, unknown>;
  debug.__particleStats = stats;
  debug.__particles = nodes;
  debug.__renderer = renderer;

  const t = GPU.ticker(renderer);
  t.add(() => {
    const now = performance.now();
    samples[sampleAt] = now - lastNow;
    sampleAt = (sampleAt + 1) % samples.length;
    if (sampleCount < samples.length) sampleCount++;
    lastNow = now;

    if (now - hudAt < 500) return;
    hudAt = now;
    let sum = 0;
    for (let k = 0; k < sampleCount; k++) sum += samples[k];
    stats.frameMs = sampleCount ? sum / sampleCount : 0;
    stats.fps = stats.frameMs ? 1000 / stats.frameMs : 0;
    stats.cpuMs = renderer.stats.cpuMs;
    stats.packetBytes = renderer.stats.packetBytes;
    // aliveCount() is a GPU readback: poll it with the HUD, one at a time.
    const first = nodes[0];
    if (first && !alivePending) {
      alivePending = true;
      first.swarm.aliveCount().then(
        n => {
          stats.alive = n;
          alivePending = false;
        },
        () => {
          alivePending = false;
        },
      );
    }
    let capacity = 0;
    let emitters = 0;
    for (let i = 0; i < nodes.length; i++) {
      capacity += nodes[i].swarm.capacity;
      emitters += nodes[i].emitters.length;
    }
    hud.textContent =
      `particles · ${PRESET}${WORKER ? ' · worker' : ''}\n` +
      `${renderer.info.backend} · ${nodes.length} systems · ` +
      `${emitters} emitters · capacity ${capacity.toLocaleString()}\n` +
      `fps ${stats.fps.toFixed(1)} · frame ${stats.frameMs.toFixed(2)} ms · ` +
      `front cpu ${stats.cpuMs.toFixed(3)} ms · packet ${stats.packetBytes} B\n` +
      `${stats.alive >= 0 ? `alive (${nodes.length ? 'first' : 'none'}) ${stats.alive.toLocaleString()} · ` : ''}` +
      `${nodes.length && nodes[0].playing ? 'playing' : 'paused'}\n` +
      'move to drag sparks · click for confetti · space pauses emission';
  });
}

main().catch(err => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = String(err);
});
