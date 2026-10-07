// Retained rendering (docs/ARCHITECTURE.md §27, docs/API.md "Rendering at
// scale"). One page, two scenes:
//
//   ?scene=map        a static tile map (`container.static`): ?tiles=200 →
//                     200 × 200 sprite tiles plus roads and houses drawn with
//                     Graphics, baked once. The camera pans and zooms the
//                     container (32 bytes per frame); units walk on top
//                     (ordinary sprites, uploads only). ?static=0 draws the
//                     same map without baking, for comparison.
//                     ?camera=pan|fade|still  what moves the container
//                     ?units=200              moving sprites on top
//                     ?edit=1                 one tile moves every frame, so
//                                             the map re-bakes every frame
//   ?scene=shapes     ?count=10000 Graphics nodes that never change (the G1
//                     benchmark): one unified draw recorded once and replayed
//                     (RETAIN_DRAW) every frame.
//
// Query flags (every scene):
//   ?backend=auto|webgpu|webgl2   backend preference (default auto)
//   ?worker=1                     render from a Web Worker (OffscreenCanvas)
//   ?retained=0                   RendererOptions.retained = false
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const backendParam = params.get('backend');
const preference: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const sceneName = params.get('scene') === 'shapes' ? 'shapes' : 'map';
const hud = document.getElementById('hud') as HTMLElement;

/** Read by headless checks as `globalThis.__retained`. */
const status = {
  scene: sceneName,
  backend: '',
  worker: params.get('worker') === '1',
  frames: 0,
  ready: false,
  errors: [] as string[],
  cpuMs: 0,
  /** Mean render() ms since frame 120 (benchmarks/graphics/static.mjs). */
  cpuAvg: 0,
  drawCalls: 0,
  packetBytes: 0,
};
(globalThis as { __retained?: typeof status }).__retained = status;

let seed = 11;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Four 16×16 tiles (grass, water, sand, rock) in one 64×16 atlas. */
function tileAtlas(): GPU.Texture {
  const colors = [
    [74, 128, 64],
    [52, 101, 164],
    [214, 196, 136],
    [120, 116, 110],
  ];
  const px = new Uint8Array(64 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 64; x++) {
      const c = colors[x >> 4];
      const edge = (x & 15) === 0 || y === 0 ? 0.85 : 1;
      const o = (y * 64 + x) * 4;
      px[o] = c[0] * edge;
      px[o + 1] = c[1] * edge;
      px[o + 2] = c[2] * edge;
      px[o + 3] = 255;
    }
  }
  return GPU.Texture.fromPixels(64, 16, px);
}

interface SceneRun {
  update(dt: number, time: number): void;
  hud(): string;
}

function mapScene(renderer: GPU.Renderer): SceneRun {
  const n = Math.max(8, Number(params.get('tiles') ?? 200) || 200);
  const baked = params.get('static') !== '0';
  const camera = params.get('camera') ?? 'pan';
  const unitCount = Math.max(0, Number(params.get('units') ?? 200) || 0);
  const edit = params.get('edit') === '1';
  const tileNodes: GPU.Sprite[] = [];
  const atlas = tileAtlas();
  const tiles = [0, 1, 2, 3].map(i => atlas.sub(i * 16, 0, 16, 16));
  const map = new GPU.Container({ static: baked });
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const h = Math.sin(x * 0.07) + Math.cos(y * 0.05) + rnd() * 0.3;
      const tile = h > 1.2 ? 3 : h > 0.4 ? 0 : h > 0.1 ? 2 : 1;
      tileNodes.push(
        map.addChild(
          new GPU.Sprite({ texture: tiles[tile], x: x * 16, y: y * 16 }),
        ),
      );
    }
  }
  // Roads: one Graphics per road (polylines, stroke).
  for (let r = 0; r < Math.max(4, n / 10); r++) {
    const road = new GPU.Graphics();
    road.moveTo(rnd() * n * 16, 0);
    for (let k = 1; k <= 8; k++) road.lineTo(rnd() * n * 16, (k / 8) * n * 16);
    road.stroke({ color: 0x6b5b45, width: 6, join: 'round', cap: 'round' });
    map.addChild(road);
  }
  // Houses: a roof star and a body rect per node, sharing two contexts.
  const house = new GPU.GraphicsContext()
    .rect(-6, -4, 12, 10)
    .fill(0xd6d3d1)
    .stroke({ color: 0x292524, width: 1 })
    .star(0, -7, 3, 7, 4)
    .fill(0xb91c1c);
  for (let i = 0; i < n * 4; i++) {
    const g = new GPU.Graphics(house);
    g.setPosition(rnd() * n * 16, rnd() * n * 16);
    map.addChild(g);
  }
  renderer.stage.addChild(map);

  // Units: ordinary sprites on top, moved every frame.
  const unitTex = GPU.Texture.fromPixels(2, 2, new Uint8Array(16).fill(255));
  const units: GPU.Sprite[] = [];
  for (let i = 0; i < unitCount; i++) {
    const s = new GPU.Sprite({
      texture: unitTex,
      tint: 0xfde047,
      x: rnd() * renderer.width,
      y: rnd() * renderer.height,
    });
    s.setScale(4, 4);
    renderer.stage.addChild(s);
    units.push(s);
  }
  let frame = 0;
  const still = 0.6;
  map.setScale(still, still);
  map.setPosition(
    renderer.width / 2 - ((n * 16) / 2) * still,
    renderer.height / 2 - ((n * 16) / 2) * still,
  );
  return {
    update(dt, time) {
      frame++;
      if (camera === 'pan') {
        const zoom = 0.6 + 0.25 * Math.sin(time * 0.3);
        map.setScale(zoom, zoom);
        map.setPosition(
          renderer.width / 2 -
            ((n * 16) / 2) * zoom +
            Math.cos(time * 0.2) * 200,
          renderer.height / 2 -
            ((n * 16) / 2) * zoom +
            Math.sin(time * 0.17) * 150,
        );
      } else if (camera === 'fade') {
        map.alpha = 0.75 + 0.25 * Math.sin(time * 2);
      }
      if (edit) {
        const t = tileNodes[(frame * 7919) % tileNodes.length];
        t.y += frame & 1 ? 1 : -1;
      }
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        u.x = (u.x + (20 + (i % 7) * 10) * dt) % renderer.width;
      }
    },
    hud: () =>
      `map ${n}×${n} tiles · ${n / 10} roads · ${n * 4} houses · ` +
      `${baked ? 'static (baked)' : 'not static'} · camera ${camera}` +
      `${edit ? ' · a tile moves every frame' : ''} · ${unitCount} units`,
  };
}

function shapesScene(renderer: GPU.Renderer): SceneRun {
  const count = Math.max(1, Number(params.get('count') ?? 10_000) || 10_000);
  for (let i = 0; i < count; i++) {
    const g = new GPU.Graphics();
    const size = 6 + (i % 8);
    switch (i & 3) {
      case 0:
        g.rect(0, 0, size, size).fill(0x38bdf8);
        break;
      case 1:
        g.circle(0, 0, size / 2)
          .fill(0xf472b6)
          .stroke({ color: 0xffffff, width: 1 });
        break;
      case 2:
        g.roundRect(0, 0, size, size, 2).fill(0xa3e635);
        break;
      default:
        g.star(0, 0, 5, size / 2)
          .fill(0xfacc15)
          .stroke({ color: 0x78350f, width: 1 });
    }
    g.setPosition(rnd() * renderer.width, rnd() * renderer.height);
    renderer.stage.addChild(g);
  }
  return {
    update() {},
    hud: () => `${count} static Graphics nodes (G1)`,
  };
}

async function run(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = await GPU.createRenderer({
    canvas,
    backend: preference,
    background: 0x0f172a,
    retained: params.get('retained') !== '0',
    worker: status.worker
      ? { url: '/build/examples/cozygpu.worker.js' }
      : false,
    events: {
      emit(name: string, payload: unknown) {
        if (name === 'error') {
          status.errors.push(JSON.stringify(payload));
          console.warn('[retained]', payload);
        }
      },
    },
  });
  (globalThis as { __renderer?: unknown }).__renderer = renderer;
  status.backend = renderer.info.backend;
  await GPU.loadGraphics();
  const scene =
    sceneName === 'map' ? mapScene(renderer) : shapesScene(renderer);

  let hudTimer = 0;
  let cpu = 0;
  let frames = 0;
  let cpuTotal = 0;
  let cpuFrames = 0;
  GPU.ticker(renderer).add((dt, time) => {
    scene.update(dt, time);
    status.frames++;
    status.ready = true;
    const s = renderer.stats;
    cpu += s.cpuMs;
    frames++;
    if (status.frames > 120) {
      cpuTotal += s.cpuMs;
      status.cpuAvg = cpuTotal / ++cpuFrames;
    }
    hudTimer += dt;
    if (hudTimer > 0.5) {
      status.cpuMs = cpu / frames;
      status.drawCalls = s.drawCalls;
      status.packetBytes = s.packetBytes;
      hud.textContent =
        `retained · ${sceneName} · ${renderer.info.backend} · ` +
        `${status.worker ? 'worker' : 'main thread'} · ` +
        `${renderer.width}×${renderer.height}@${renderer.resolution}\n` +
        `${scene.hud()}\n` +
        `render() ${status.cpuMs.toFixed(3)} ms · draws ${s.drawCalls} · ` +
        `${s.packetBytes} B`;
      hudTimer = 0;
      cpu = 0;
      frames = 0;
    }
  });
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  status.errors.push(message);
  hud.textContent = message;
  console.error(err);
});
