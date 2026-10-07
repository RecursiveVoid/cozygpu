// Showcase page controller: one stage, eight demos, each loaded on demand.
// Every demo gets a fresh canvas (a canvas keeps the first context type it
// was given, so switching between WebGPU and WebGL2 needs a new one).
import type { BackendChoice, DemoHandle, DemoStart } from './demos/types';

interface DemoDef {
  id: string;
  title: string;
  blurb: string;
  hint: string;
  source: string;
  load: () => Promise<{ start: DemoStart }>;
  /** Slider stops; omitted when the demo has no count to change. */
  stops?: number[];
  unit?: 'count' | 'scale';
  defaultIndex?: (mobile: boolean) => number;
  /** Mode buttons; the first is the default. */
  modes?: { id: string; label: string }[];
}

const REPO = 'https://github.com/RecursiveVoid/cozygpu/blob/main/';

const DEMOS: DemoDef[] = [
  {
    id: 'swarm',
    title: 'Swarm',
    blurb:
      'Up to two million objects simulated entirely on the GPU: compute shaders on WebGPU, transform feedback on WebGL2. The CPU sends a few bytes per frame.',
    hint: 'The attractor wanders on its own; hold the pointer down on the stage to take it over.',
    source: 'examples/swarm/main.ts',
    load: () => import('./demos/swarm'),
    stops: [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000],
    unit: 'count',
    defaultIndex: mobile => (mobile ? 3 : 5),
  },
  {
    id: 'sprites',
    title: 'Sprites',
    blurb:
      'Bunnymark: ordinary Sprite objects bouncing under gravity, updated on the CPU every frame through the bulk position writer. One atlas, one draw call.',
    hint: 'Move the slider to add or remove sprites without restarting.',
    source: 'examples/sprites/main.ts',
    load: () => import('./demos/sprites'),
    stops: [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000, 300_000],
    unit: 'count',
    defaultIndex: mobile => (mobile ? 2 : 5),
  },
  {
    id: 'layer',
    title: '1 million sprites',
    blurb:
      'A SpriteLayer draws millions of sprites in one draw call: no object per sprite, just compact GPU streams (8 bytes per sprite for positions, 20 with rotation, frame and colour). Static: written once, then nothing per frame. Columns: positions live in a plain Float32Array that a CPU loop moves, as an ECS would, and the layer uploads it straight from that memory.',
    hint: 'The slider stops at what this device can hold. Switch between static and columns-driven to compare the frame cost.',
    source: 'examples/spritelayer/main.ts',
    load: () => import('./demos/layer'),
    stops: [
      100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000,
      16_000_000,
    ],
    unit: 'count',
    defaultIndex: mobile => (mobile ? 1 : 3),
    modes: [
      { id: 'static', label: 'Static' },
      { id: 'columns', label: 'Columns' },
    ],
  },
  {
    id: 'graphics',
    title: 'Graphics',
    blurb:
      'Vector shapes with a Pixi-style API. Circles, rounded rects, arcs and lines are drawn analytically on the GPU, one 64-byte instance each, so thousands can be redrawn every frame; curves, stars and holes are tessellated once and reused.',
    hint: 'The slider sets how many shapes are redrawn every frame. The gauges and the chart are live; the emblems are cached meshes.',
    source: 'examples/graphics/main.ts',
    load: () => import('./demos/graphics'),
    stops: [1_000, 2_500, 5_000, 10_000, 20_000, 40_000],
    unit: 'count',
    defaultIndex: mobile => (mobile ? 1 : 2),
  },
  {
    id: 'particles',
    title: 'Particles',
    blurb:
      'Fire, smoke, rain, sparks and confetti presets with over-life curves, running on top of Swarm. Emitters cost one spawn command per frame.',
    hint: 'Move the pointer to drag the sparks, click for confetti.',
    source: 'examples/particles/main.ts',
    load: () => import('./demos/particles'),
    stops: [0.25, 0.5, 1, 2, 4],
    unit: 'scale',
    defaultIndex: mobile => (mobile ? 1 : 2),
  },
  {
    id: 'text',
    title: 'MSDF text',
    blurb:
      'Signed distance field fonts through the asset loader, word wrapping, justified paragraphs, a counter rewritten every frame and a Canvas2D fallback for system fonts.',
    hint: 'Resize the window: the paragraph re-wraps.',
    source: 'examples/text/main.ts',
    load: () => import('./demos/text'),
  },
  {
    id: 'filters',
    title: 'Filters',
    blurb:
      'Filter chains on a Group: an in-batch color matrix, blur, glow, a custom pixelate filter written in WGSL and GLSL, and a mixed hue + blur chain.',
    hint: 'Panels: none, sepia, blur, glow, pixelate, hue + blur.',
    source: 'examples/filters/main.ts',
    load: () => import('./demos/filters'),
  },
  {
    id: 'masking',
    title: 'Masking',
    blurb:
      'Rect masks become a scissor, shape masks use the stencil buffer where the backend can, and feathered masks render through an alpha target.',
    hint: 'Left: rect mask. Middle: turning disc. Right: soft mask.',
    source: 'examples/masking/main.ts',
    load: () => import('./demos/masking'),
  },
];

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const mobile =
  matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, 900) < 700;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = $<HTMLDivElement>('stage');
const tabs = $<HTMLDivElement>('demo-tabs');
const titleEl = $<HTMLElement>('demo-title');
const blurbEl = $<HTMLElement>('demo-blurb');
const hintEl = $<HTMLElement>('demo-hint');
const sourceEl = $<HTMLAnchorElement>('demo-source');
const runBtn = $<HTMLButtonElement>('demo-run');
const slider = $<HTMLInputElement>('demo-count');
const sliderWrap = $<HTMLElement>('demo-count-wrap');
const sliderValue = $<HTMLElement>('demo-count-value');
const sliderLabel = $<HTMLElement>('demo-count-label');
const workerBox = $<HTMLInputElement>('demo-worker');
const modesEl = $<HTMLDivElement>('demo-modes');
const backendBtns = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-backend]'),
);
const notice = $<HTMLElement>('gpu-notice');
const overlay = $<HTMLElement>('stage-overlay');
const hud = {
  backend: $<HTMLElement>('hud-backend'),
  fps: $<HTMLElement>('hud-fps'),
  frame: $<HTMLElement>('hud-frame'),
  objects: $<HTMLElement>('hud-objects'),
  cpu: $<HTMLElement>('hud-cpu'),
  draws: $<HTMLElement>('hud-draws'),
};

const workerUrl = new URL('./cozygpu.worker.js', import.meta.url).href;
const assetBase = new URL('./font/', import.meta.url).href;

let current: DemoDef = DEMOS[0];
let backend: BackendChoice = 'webgpu';
let webgpuOk = false;
let handle: DemoHandle | null = null;
let canvas: HTMLCanvasElement | null = null;
/** Bumped on every start/stop; a start that finishes late sees it moved on. */
let generation = 0;
let wanted = false;
let visible = true;
const sliderIndex = new Map<string, number>();
const modeChoice = new Map<string, string>();

// ─── Frame stats ────────────────────────────────────────────────────────────
const samples = new Float64Array(120);
let sampleCount = 0;
let sampleAt = 0;
let lastNow = 0;
const tick = (): void => {
  const now = performance.now();
  if (lastNow > 0) {
    const d = now - lastNow;
    // Skip gaps (tab hidden, paused) so they do not skew the average.
    if (d < 250) {
      samples[sampleAt] = d;
      sampleAt = (sampleAt + 1) % samples.length;
      if (sampleCount < samples.length) sampleCount++;
    }
  }
  lastNow = now;
};
const resetStats = (): void => {
  sampleCount = 0;
  sampleAt = 0;
  lastNow = 0;
};

const fmtCount = (n: number): string =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${+(n / 1_000).toFixed(1)}k`
      : String(n);

function updateHud(): void {
  if (!handle) {
    hud.fps.textContent = '–';
    hud.frame.textContent = '–';
    hud.objects.textContent = '–';
    hud.cpu.textContent = '–';
    hud.draws.textContent = '–';
    return;
  }
  let sum = 0;
  for (let i = 0; i < sampleCount; i++) sum += samples[i];
  const ms = sampleCount ? sum / sampleCount : 0;
  hud.fps.textContent = ms ? (1000 / ms).toFixed(0) : '–';
  hud.frame.textContent = ms ? `${ms.toFixed(2)} ms` : '–';
  hud.objects.textContent = handle.objects().toLocaleString('en-US');
  // Without cross-origin isolation the timer resolution is 0.1 ms.
  const cpu = handle.renderer.stats.cpuMs;
  hud.cpu.textContent = cpu < 0.1 ? '< 0.1 ms' : `${cpu.toFixed(1)} ms`;
  hud.draws.textContent = String(handle.renderer.stats.drawCalls);
}
setInterval(updateHud, 500);

// ─── Stage lifecycle ────────────────────────────────────────────────────────
function sliderValueFor(def: DemoDef): number {
  if (!def.stops) return 0;
  const i = sliderIndex.get(def.id) ?? def.defaultIndex?.(mobile) ?? 0;
  return def.stops[Math.min(i, def.stops.length - 1)];
}

function modeFor(def: DemoDef): string {
  return modeChoice.get(def.id) ?? def.modes?.[0].id ?? '';
}

function showOverlay(text: string, isError = false): void {
  overlay.textContent = text;
  overlay.hidden = text === '';
  overlay.classList.toggle('error', isError);
}

function stopDemo(): void {
  generation++;
  wanted = false;
  if (handle) {
    handle.destroy();
    handle = null;
  }
  if (canvas) {
    canvas.remove();
    canvas = null;
  }
  resetStats();
  updateHud();
  hud.backend.textContent = 'stopped';
  runBtn.textContent = 'Start';
  runBtn.setAttribute('aria-pressed', 'false');
  showOverlay('Press Start to run this demo.');
}

async function startDemo(): Promise<void> {
  stopDemo();
  wanted = true;
  const gen = generation;
  const def = current;
  runBtn.textContent = 'Stop';
  runBtn.setAttribute('aria-pressed', 'true');
  showOverlay('Loading…');
  hud.backend.textContent = 'starting';

  const c = document.createElement('canvas');
  c.className = 'stage-canvas';
  c.setAttribute('aria-label', `${def.title} demo`);
  stage.prepend(c);
  canvas = c;
  try {
    const mod = await def.load();
    if (gen !== generation) return;
    const h = await mod.start({
      canvas: c,
      backend,
      worker: workerBox.checked,
      workerUrl,
      assetBase,
      count: sliderValueFor(def),
      mode: modeFor(def),
      tick,
    });
    if (gen !== generation) {
      h.destroy();
      return;
    }
    handle = h;
    syncSlider();
    const info = h.renderer.info;
    hud.backend.textContent =
      (info.backend === 'webgpu' ? 'WebGPU' : 'WebGL2') +
      (info.worker
        ? info.sharedMemory
          ? ' · worker'
          : ' · worker (transfer)'
        : '');
    showOverlay('');
    if (!visible) h.ticker.stop();
  } catch (err) {
    if (gen !== generation) return;
    console.warn('[cozygpu demo]', err);
    const message = err instanceof Error ? err.message : String(err);
    if (canvas) {
      canvas.remove();
      canvas = null;
    }
    hud.backend.textContent = 'error';
    showOverlay(
      `This demo could not start on ${backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}: ${message}`,
      true,
    );
  }
}

// ─── Controls ───────────────────────────────────────────────────────────────
function renderTabs(): void {
  tabs.textContent = '';
  for (const def of DEMOS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.textContent = def.title;
    b.id = `tab-${def.id}`;
    b.setAttribute('aria-selected', String(def === current));
    b.setAttribute('aria-controls', 'stage');
    b.addEventListener('click', () => selectDemo(def, true));
    tabs.append(b);
  }
}

function syncSlider(): void {
  const def = current;
  if (!def.stops) {
    sliderWrap.hidden = true;
    return;
  }
  sliderWrap.hidden = false;
  // A running demo may cap the count at what this device can hold.
  const max = handle?.maxCount;
  let last = def.stops.length - 1;
  while (max !== undefined && last > 0 && def.stops[last] > max) last--;
  const i = Math.min(
    last,
    sliderIndex.get(def.id) ?? def.defaultIndex?.(mobile) ?? 0,
  );
  slider.min = '0';
  slider.max = String(last);
  slider.value = String(i);
  sliderLabel.textContent = def.unit === 'scale' ? 'Emission' : 'Objects';
  sliderValue.textContent = formatStop(def, def.stops[i]);
}

function syncModes(): void {
  const def = current;
  modesEl.textContent = '';
  modesEl.hidden = !def.modes;
  if (!def.modes) return;
  const selected = modeFor(def);
  for (const m of def.modes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m.label;
    b.setAttribute('aria-pressed', String(m.id === selected));
    b.addEventListener('click', () => {
      if (modeFor(def) === m.id) return;
      modeChoice.set(def.id, m.id);
      for (const other of modesEl.querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      if (handle?.setMode && current === def) {
        handle.setMode(m.id);
        resetStats();
      } else if (wanted) {
        void startDemo();
      }
    });
    modesEl.append(b);
  }
}

function formatStop(def: DemoDef, v: number): string {
  return def.unit === 'scale' ? `${v}×` : fmtCount(v);
}

function selectDemo(def: DemoDef, run: boolean): void {
  current = def;
  for (const b of tabs.querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.id === `tab-${def.id}`));
  }
  titleEl.textContent = def.title;
  blurbEl.textContent = def.blurb;
  hintEl.textContent = def.hint;
  sourceEl.href = REPO + def.source;
  sourceEl.textContent = `View source: ${def.source}`;
  // Stop first (synchronously, also inside startDemo), so the slider is not
  // capped by the previous demo's device limit.
  if (run) void startDemo();
  else stopDemo();
  syncSlider();
  syncModes();
}

function setBackend(b: BackendChoice): void {
  backend = b;
  for (const btn of backendBtns) {
    btn.setAttribute('aria-pressed', String(btn.dataset.backend === b));
  }
}

runBtn.addEventListener('click', () => {
  if (wanted) stopDemo();
  else void startDemo();
});

slider.addEventListener('input', () => {
  const def = current;
  if (!def.stops) return;
  sliderValue.textContent = formatStop(def, def.stops[Number(slider.value)]);
});
slider.addEventListener('change', () => {
  const def = current;
  if (!def.stops) return;
  const i = Number(slider.value);
  sliderIndex.set(def.id, i);
  if (handle?.setCount) {
    handle.setCount(def.stops[i]);
    resetStats();
  } else if (wanted) {
    void startDemo();
  }
});

for (const btn of backendBtns) {
  btn.addEventListener('click', () => {
    const b = btn.dataset.backend as BackendChoice;
    if (b === backend || btn.disabled) return;
    setBackend(b);
    if (wanted) void startDemo();
  });
}

workerBox.addEventListener('change', () => {
  if (wanted) void startDemo();
});

// Pause the ticker while the stage is off screen; resume when it is back.
new IntersectionObserver(
  entries => {
    visible = entries[entries.length - 1].isIntersecting;
    if (!handle) return;
    if (visible) handle.ticker.start();
    else handle.ticker.stop();
    resetStats();
  },
  { threshold: 0.15 },
).observe(stage);

// ─── Boot ───────────────────────────────────────────────────────────────────
async function detectWebGPU(): Promise<boolean> {
  const gpu = navigator.gpu as GPU | undefined;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  renderTabs();
  const requested = params.get('backend');
  webgpuOk = await detectWebGPU();
  const webgpuBtn = backendBtns.find(b => b.dataset.backend === 'webgpu');
  if (!webgpuOk) {
    if (webgpuBtn) {
      webgpuBtn.disabled = true;
      webgpuBtn.title = 'WebGPU is not available in this browser';
    }
    notice.hidden = false;
    setBackend('webgl2');
  } else {
    setBackend(requested === 'webgl2' ? 'webgl2' : 'webgpu');
  }
  workerBox.checked = params.get('worker') === '1';
  const first = DEMOS.find(d => d.id === params.get('demo')) ?? DEMOS[0];
  const autostart = params.get('autostart') !== '0' && !reducedMotion;
  selectDemo(first, autostart);
}

void boot();
