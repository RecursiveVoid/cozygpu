// renderer.assets demo (ARCHITECTURE §15):
//   - a bundle (48 small PNG icons packed into one atlas page, a hero PNG and
//     a TexturePacker spritesheet) with a progress bar,
//   - KTX2: RGBA8 with a mip chain (every GPU) and BC1 (when caps allow),
//   - GPU budget: 1024² images loaded in a loop and released, so LRU
//     eviction keeps the estimate under `gpuBudgetMB`.
//
//   ?worker=1      render in a worker (loading stays on the main thread)
//   ?budget=32     GPU budget in MiB (default 32: the 2048² atlas page takes 16,
//                  each big image 4)
//   ?atlas=0       disable atlas packing (one draw call per icon texture)
//   ?backend=webgl2  force the WebGL2 backend
//
// Asset files come from `node examples/assets/generate.mjs`.
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const useWorker = params.get('worker') === '1';
const budgetMB = Math.max(0, Number(params.get('budget') ?? 32));
const atlas = params.get('atlas') !== '0';
const backend = (params.get('backend') ?? 'auto') as
  | 'auto'
  | 'webgpu'
  | 'webgl2';

const ICONS = 48;
const BIG = 8;

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const bar = document.getElementById('bar') as HTMLElement;

  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x10131c,
    backend,
    worker: useWorker ? { url: '/build/examples/cozygpu.worker.js' } : false,
    assets: {
      baseUrl: new URL('./files/', location.href).href,
      gpuBudgetMB: budgetMB,
      atlas: atlas ? undefined : false,
    },
  });
  // Dev handle for the headless verification driver (examples only).
  (globalThis as { __renderer?: unknown }).__renderer = renderer;
  const assets = renderer.assets;
  const world = new GPU.Container();
  renderer.stage.addChild(world);
  const ticker = GPU.ticker(renderer);

  // ── Bundle with progress ──────────────────────────────────────────────────
  const ui: Record<string, GPU.AssetSource> = {
    hero: 'hero.png',
    spinner: 'spinner.json',
  };
  for (let i = 0; i < ICONS; i++)
    ui[`icon${i}`] = `icon-${String(i).padStart(2, '0')}.png`;
  assets.addBundle('ui', ui);
  const bundle = await assets.loadBundle('ui', {
    onProgress: p => {
      bar.style.width = `${Math.round(p.ratio * 100)}%`;
    },
  });
  bar.parentElement?.remove();

  const hero = bundle.get<GPU.TextureAsset>('hero').value;
  world.addChild(
    new GPU.Sprite({
      texture: hero.texture,
      x: 420,
      y: 220,
      anchor: 0.5,
      scale: 0.8,
    }),
  );

  let packedIcons = 0;
  for (let i = 0; i < ICONS; i++) {
    const icon = bundle.get<GPU.TextureAsset>(`icon${i}`).value;
    if (icon.packed) packedIcons++;
    world.addChild(
      new GPU.Sprite({
        texture: icon.texture,
        x: 24 + (i % 8) * 36,
        y: 40 + Math.floor(i / 8) * 36,
        anchor: 0.5,
      }),
    );
  }

  const sheet = bundle.get<GPU.SpritesheetAsset>('spinner').value;
  const spinFrames = sheet.animations.spin;
  const spinner = world.addChild(
    new GPU.Sprite({ texture: spinFrames[0], x: 420, y: 220, anchor: 0.5 }),
  );

  // ── KTX2 ──────────────────────────────────────────────────────────────────
  const formats: string[] = [];
  const rgba8 = await assets.load<GPU.TextureAsset>({
    url: 'checker-rgba8.ktx2',
    texture: { mipmaps: true },
  });
  formats.push(`rgba8.ktx2 → ${rgba8.value.format}`);
  for (let i = 0; i < 4; i++) {
    const scale = [1, 0.5, 0.25, 0.125][i];
    world.addChild(
      new GPU.Sprite({
        texture: rgba8.value.texture,
        x: 24 + [0, 140, 216, 256][i],
        y: 330,
        scale,
      }),
    );
  }
  try {
    const bc1 = await assets.load<GPU.TextureAsset>('checker-bc1.ktx2');
    formats.push(`bc1.ktx2 → ${bc1.value.format}`);
    world.addChild(
      new GPU.Sprite({ texture: bc1.value.texture, x: 24, y: 470, scale: 0.5 }),
    );
    world.addChild(
      new GPU.Sprite({
        texture: bc1.value.texture,
        x: 160,
        y: 470,
        scale: 0.125,
      }),
    );
  } catch (error) {
    formats.push(`bc1.ktx2 → ${(error as GPU.CozyGPUError).code ?? error}`);
  }

  // ── Budget / eviction loop ────────────────────────────────────────────────
  const bigSprite = world.addChild(
    new GPU.Sprite({ x: 620, y: 40, scale: 0.25 }),
  );
  let bigHandle: GPU.AssetHandle<GPU.TextureAsset> | null = null;
  let bigIndex = 0;
  let loadsDone = 0;
  const cycle = async () => {
    const next = await assets.load<GPU.TextureAsset>(
      `big-${bigIndex % BIG}.png`,
    );
    bigIndex++;
    loadsDone++;
    bigSprite.texture = next.value.texture;
    bigHandle?.release();
    bigHandle = next;
  };
  await cycle();
  const timer = setInterval(() => {
    cycle().catch(e => console.error(e));
  }, 250);

  // ── Frame loop + HUD ──────────────────────────────────────────────────────
  let spinTime = 0;
  let hudTime = 0;
  ticker.add(dt => {
    spinTime += dt;
    spinner.texture = spinFrames[Math.floor(spinTime * 8) % spinFrames.length];
    hudTime += dt;
    if (hudTime < 0.25) return;
    hudTime = 0;
    const s = assets.stats;
    hud.textContent =
      `backend ${renderer.info.backend}  worker ${renderer.info.worker}  fps ${ticker.fps.toFixed(0)}  draw calls ${renderer.stats.drawCalls}\n` +
      `icons packed ${packedIcons}/${ICONS}  atlas pages ${s.atlasPages}\n` +
      `${formats.join('  ')}\n` +
      `entries ${s.entries}  referenced ${s.referenced}  in flight ${s.inFlight}  queued ${s.queued}\n` +
      `GPU ${(s.gpuBytes / 1048576).toFixed(1)} / ${(s.gpuBudgetBytes / 1048576).toFixed(0)} MiB  evictions ${s.evictions}  big loads ${loadsDone}`;
  });

  // Machine-readable summary for headless checks.
  setTimeout(() => {
    const s = assets.stats;
    console.log(
      'ASSETS_SUMMARY ' +
        JSON.stringify({
          backend: renderer.info.backend,
          worker: renderer.info.worker,
          packedIcons,
          atlasPages: s.atlasPages,
          formats,
          gpuMiB: +(s.gpuBytes / 1048576).toFixed(2),
          budgetMiB: s.gpuBudgetBytes / 1048576,
          evictions: s.evictions,
          bigLoads: loadsDone,
          drawCalls: renderer.stats.drawCalls,
          entries: s.entries,
        }),
    );
  }, 2500);

  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    ticker.destroy();
    renderer.destroy();
  });
}

main().catch(error => {
  console.error(error);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = String(error);
});
