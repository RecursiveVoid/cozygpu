#!/usr/bin/env node
/**
 * Browser stress tests for cozygpu (real WebGPU, system Chrome, puppeteer-core).
 *
 *   node tests/browser/stress.mjs                      all scenarios, main + worker
 *   node tests/browser/stress.mjs --only=swarm,loss    subset (swarm,burst,sprites,
 *     resize,dpr,loss,recreate,regress,assets,pick,gpualloc,ring,soak; M2.5 hooks:
 *     columns,pickuid,events,fallback,pickalloc,external; M3: m3masks,m3filters,
 *     m3text,m3particles,m3loss — --m3-seconds=N churn length, --m3-particles=N)
 *   node tests/browser/stress.mjs --mode=main          main | worker | both (default both)
 *   node tests/browser/stress.mjs --backend=webgl2     webgpu | webgl2 | both (default both)
 *   node tests/browser/stress.mjs --quick              short durations (burst 10 s, sprites 5 s)
 *   node tests/browser/stress.mjs --burst-seconds=60 --sprite-seconds=20 --cycles=20 --headful
 *   node tests/browser/stress.mjs --out=/path/report.json
 *   node tests/browser/stress.mjs --only=swarm --swarm-caps=100000000   one capacity case
 *   node tests/browser/stress.mjs --only=regress --crash-test=browser   harness self-test: a
 *     deliberately crashing scenario (browser = SIGKILL Chrome, renderer = chrome://crash)
 *     runs first; it must be reported as FAIL and the rest must still run
 *
 * Wrap with a hard timeout, e.g. `perl -e 'alarm 900; exec @ARGV' node tests/browser/stress.mjs`.
 *
 * What it does: bundles tests/browser/stress-page.js and src/worker/entry.ts
 * with esbuild (a banner wraps GPUAdapter.requestDevice to count uncaptured
 * GPU errors and track devices in both the page and the worker), serves them
 * on 127.0.0.1:4200 with COOP/COEP (so worker mode gets SharedArrayBuffer),
 * launches system Chrome with WebGPU flags, runs the scenarios, prints a
 * PASS/FAIL table and exits 1 on any failure. Chrome and the server are
 * always shut down (also on SIGINT/SIGTERM and uncaught errors).
 *
 * If Chrome (or the page's renderer/GPU process) crashes, the scenario fails
 * with a "browser crashed" check, Chrome is relaunched and the remaining
 * scenarios continue. While a scenario runs, JS heap (page + workers) and the
 * RSS of every Chrome process (by type: browser/gpu/renderer/...) plus, on
 * macOS, the phys_footprint of the GPU and renderer processes (which includes
 * Metal buffer memory) are sampled
 * every --mem-interval ms (default 2000) and summarized (peak/last) in the
 * notes, so an OOM can be told apart from a library fault.
 */
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = Number(process.env.STRESS_PORT || 4200);
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const QUICK = !!argv.quick;
const ALL = ['swarm', 'burst', 'sprites', 'resize', 'dpr', 'loss', 'recreate', 'regress', 'assets', 'pick', 'gpualloc', 'ring', 'soak', 'columns', 'pickuid', 'events', 'fallback', 'pickalloc', 'external', 'm3masks', 'm3filters', 'm3text', 'm3particles', 'm3loss'];
const ONLY = argv.only ? String(argv.only).split(',') : ALL;
const MODES = argv.mode && argv.mode !== 'both' ? [String(argv.mode)] : ['main', 'worker'];
/** M2: every scenario runs on both backends unless one is named. */
const BACKENDS = argv.backend && argv.backend !== 'both' ? [String(argv.backend)] : ['webgpu', 'webgl2'];
const BURST_S = Number(argv['burst-seconds'] ?? (QUICK ? 10 : 60));
const SPRITE_S = Number(argv['sprite-seconds'] ?? (QUICK ? 5 : 20));
const CYCLES = Number(argv.cycles ?? 20);
const HEADFUL = !!argv.headful;
const MEM_INTERVAL = Number(argv['mem-interval'] ?? 2000);
// M2 scenario sizes.
const ASSET_BUDGET_MB = Number(argv['asset-budget-mb'] ?? 24);
const PICK_SPRITES = Number(argv['pick-sprites'] ?? (QUICK ? 10_000 : 100_000));
const PICK_SWARM = Number(argv['pick-swarm'] ?? (QUICK ? 10_000 : 200_000));
const GPU_ALLOC_S = Number(argv['gpu-alloc-seconds'] ?? (QUICK ? 8 : 60));
const GPU_ALLOC_CAP = Number(argv['gpu-alloc-capacity'] ?? 200_000);
const RING_S = Number(argv['ring-seconds'] ?? (QUICK ? 4 : 10));
const SOAK_S = Number(argv['soak-seconds'] ?? (QUICK ? 30 : 300));
const SOAK_HEAP_MB = Number(argv['soak-heap-mb'] ?? 5);
// M2.5 scenario sizes.
const COLUMNS_N = Number(argv['columns-count'] ?? 100_000);
const COLUMNS_S = Number(argv['columns-seconds'] ?? (QUICK ? 6 : 20));
const UID_ROUNDS = Number(argv['uid-rounds'] ?? (QUICK ? 4 : 15));
const UID_SWARM_N = Number(argv['uid-swarm'] ?? (QUICK ? 20_000 : 200_000));
const PICK_ALLOC_S = Number(argv['pick-alloc-seconds'] ?? (QUICK ? 6 : 20));
const PICK_SOAK_S = Number(argv['pick-soak-seconds'] ?? (QUICK ? 8 : 30));
const EXT_N = Number(argv['external-count'] ?? (QUICK ? 200_000 : 1_000_000));
/** Chrome flags for uncapped frames (as in benchmarks/run.mjs). */
const UNCAP_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

// ─── Result bookkeeping ──────────────────────────────────────────────────────
const results = [];
const report = { startedAt: new Date().toISOString(), options: { ONLY, MODES, BACKENDS, BURST_S, SPRITE_S, CYCLES, GPU_ALLOC_S, RING_S, SOAK_S, COLUMNS_N, COLUMNS_S, UID_ROUNDS, UID_SWARM_N, PICK_ALLOC_S, PICK_SOAK_S, EXT_N }, scenarios: [] };
let current = null;

function check(name, ok, detail) {
  const r = { scenario: current?.name ?? '?', check: name, ok: !!ok, detail };
  results.push(r);
  current?.checks.push(r);
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return !!ok;
}
function note(name, data) {
  current?.notes.push({ name, data });
  console.log(`  [info] ${name}: ${JSON.stringify(data)}`);
}

// ─── Build ───────────────────────────────────────────────────────────────────
const BANNER = `(() => {
  const g = globalThis;
  if (g.__stress) return;
  // M2.5 fallback checks: ?nogpu=1 hides WebGPU (ARCHITECTURE §13.5 trigger),
  // ?noadapter=1 makes requestAdapter() resolve null. The page passes its query
  // on to the worker URL, so both realms see the same thing.
  const q = (g.location && g.location.search) || '';
  if (/[?&]nogpu=1/.test(q)) {
    const P = typeof WorkerNavigator !== 'undefined' && typeof document === 'undefined' ? WorkerNavigator.prototype : typeof Navigator !== 'undefined' ? Navigator.prototype : null;
    try { if (P) delete P.gpu; } catch {}
    try { Object.defineProperty(g.navigator, 'gpu', { get: () => undefined, configurable: true }); } catch {}
  } else if (/[?&]noadapter=1/.test(q) && g.navigator && g.navigator.gpu) {
    g.navigator.gpu.requestAdapter = async () => null;
  }
  const S = (g.__stress = { gpuErrors: [], gpuErrorCount: 0, devices: [] });
  if (typeof GPUAdapter === 'undefined') return;
  const orig = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (desc) {
    const d = await orig.call(this, desc);
    const rec = { ref: new WeakRef(d), destroyed: false, lost: null, t: performance.now() };
    S.devices.push(rec);
    d.addEventListener('uncapturederror', e => {
      S.gpuErrorCount++;
      const m = String((e.error && e.error.message) || e.error).slice(0, 400);
      if (S.gpuErrors.length < 50) S.gpuErrors.push(m);
      console.error('[stress:gpu-error] ' + m.split('\\n')[0]);
    });
    const od = d.destroy;
    d.destroy = function () { rec.destroyed = true; return od.call(this); };
    d.lost.then(i => { rec.lost = i.reason + ': ' + i.message; });
    return d;
  };
})();`;

// ─── Asset fixtures (M2) ─────────────────────────────────────────────────────
// Solid-colour PNGs whose colour is a pure function of the index, so a
// screenshot proves *which* file a texture came from (eviction + reload).
const ICONS = 32;
const BIGS = 24;
const ICON_PX = 32;
const BIG_PX = 512;

/** Deterministic, well-separated, never dark. */
function colorFor(i) {
  return [60 + ((i * 47) % 190), 60 + ((i * 93) % 190), 60 + ((i * 151) % 190)];
}
const near = (got, want, tol = 26) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    for (let x = 0; x < w; x++) {
      const i = off + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeAssetFiles(dir) {
  const files = path.join(dir, 'files');
  await mkdir(files, { recursive: true });
  for (let i = 0; i < ICONS; i++) {
    await writeFile(path.join(files, `icon-${i}.png`), solidPng(ICON_PX, ICON_PX, colorFor(i)));
  }
  for (let i = 0; i < BIGS; i++) {
    await writeFile(path.join(files, `big-${i}.png`), solidPng(BIG_PX, BIG_PX, colorFor(1000 + i)));
  }
  await writeFile(
    path.join(files, 'data.json'),
    JSON.stringify({ hello: 'cozygpu', spawns: [1, 2, 3, 4] }),
  );
}

async function bundle(outDir) {
  const common = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    sourcemap: 'inline',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    banner: { js: BANNER },
    logLevel: 'warning',
    plugins: [
      {
        name: 'cozygpu-alias',
        setup(b) {
          b.onResolve({ filter: /^cozygpu$/ }, () => ({ path: path.join(ROOT, 'src/index.ts') }));
        },
      },
    ],
  };
  await build({ ...common, entryPoints: [path.join(HERE, 'stress-page.js')], outfile: path.join(outDir, 'page.js') });
  await build({ ...common, entryPoints: [path.join(ROOT, 'src/worker/entry.ts')], outfile: path.join(outDir, 'cozygpu.worker.js') });
  await writeFile(
    path.join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>cozygpu stress</title>
<style>html,body{margin:0;background:#222;overflow:hidden;width:100%;height:100%}</style></head>
<body><script type="module" src="/page.js"></script></body></html>`,
  );
  await writeAssetFiles(outDir);
  // M3 text: the example MSDF font, served at /font/.
  await mkdir(path.join(outDir, 'font'), { recursive: true });
  for (const f of ['cozy.json', 'cozy.png']) await writeFile(path.join(outDir, 'font', f), await readFile(path.join(ROOT, 'examples/text/font', f)));
}

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = url.pathname;
      if (p === '/') p = '/index.html';
      // ?delay=N makes a fetch slow enough to abort mid-flight.
      const delay = Number(url.searchParams.get('delay') ?? 0);
      if (delay > 0) await new Promise(r => setTimeout(r, Math.min(delay, 10000)));
      const file = path.join(dir, path.normalize(p));
      if (!file.startsWith(dir)) throw new Error('forbidden');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(body);
    } catch {
      // The client may already be gone (an aborted fetch).
      try {
        res.writeHead(404).end();
      } catch {}
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ─── Browser plumbing ────────────────────────────────────────────────────────
let browser = null;
let server = null;
let outDir = null;
let launches = 0;
/** Set when the current browser disconnected unexpectedly (crash). */
let browserCrash = null;
/** Extra Chrome flags for the next launches (M2.5: uncapped frames for pickalloc). */
let launchExtraArgs = [];

async function launchBrowser() {
  launches++;
  browserCrash = null;
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADFUL,
    protocolTimeout: 600000,
    // A fresh profile per launch: a crashed Chrome may leave its profile locked.
    userDataDir: path.join(outDir, `chrome-profile-${launches}`),
    args: [
      '--enable-unsafe-webgpu',
      '--use-angle=metal',
      // One GPU reset (e.g. an ANGLE out-of-memory context loss) otherwise makes
      // Chrome block WebGL/WebGPU for the origin, failing every later scenario.
      '--disable-domain-blocking-for-3d-apis',
      '--disable-gpu-process-crash-limit',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1000,700',
      ...launchExtraArgs,
    ],
  });
  b.on('disconnected', () => {
    if (browser === b && !b.__closing) {
      browserCrash = browserCrash ?? `browser disconnected at ${new Date().toISOString()}`;
      console.error(`  [crash] ${browserCrash}`);
    }
  });
  browser = b;
  console.log(`chrome ${await b.version()} (launch #${launches}, pid ${b.process()?.pid})${launchExtraArgs.length ? ` extra flags: ${launchExtraArgs.join(' ')}` : ''}`);
  return b;
}

async function closeBrowser() {
  const b = browser;
  browser = null;
  if (!b) return;
  b.__closing = true;
  try {
    await Promise.race([b.close(), new Promise(r => setTimeout(r, 5000))]);
  } catch {}
  try {
    b.process()?.kill('SIGKILL');
  } catch {}
}

/** Relaunches Chrome if it is gone (crash) so the next scenario can run. */
async function ensureBrowser() {
  if (browser && browser.connected && !browserCrash) return;
  if (browser) {
    console.log('  [info] relaunching Chrome after a crash');
    await closeBrowser();
  }
  await launchBrowser();
}

/** RSS (MB) of the Chrome processes of the current launch, grouped by --type. */
async function chromeProcessMemory() {
  const pid = browser?.process()?.pid;
  if (!pid) return null;
  const { execFile } = await import('node:child_process');
  const out = await new Promise(res =>
    execFile('ps', ['-axo', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 << 20 }, (err, stdout) => res(err ? '' : stdout)),
  );
  const rows = out
    .split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], rssKB: +m[3], cmd: m[4] }));
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r);
  }
  const byType = {};
  const footprintPids = [];
  const stack = rows.filter(r => r.pid === pid);
  while (stack.length) {
    const r = stack.pop();
    const type = (r.cmd.match(/--type=([\w-]+)/)?.[1] ?? (r.pid === pid ? 'browser' : 'other')) + (r.cmd.includes('--utility-sub-type=') ? `:${r.cmd.match(/--utility-sub-type=([\w.-]+)/)[1].split('.').pop()}` : '');
    byType[type] = +((byType[type] ?? 0) + r.rssKB / 1024).toFixed(1);
    if (process.platform === 'darwin' && (type === 'gpu-process' || type === 'renderer')) footprintPids.push([type, r.pid]);
    stack.push(...(children.get(r.pid) ?? []));
  }
  // RSS misses Metal/IOSurface allocations on Apple Silicon; phys_footprint
  // (macOS `footprint`) includes them, so GPU buffers show up here.
  for (const [type, fpid] of footprintPids) {
    const fp = await new Promise(res =>
      execFile('footprint', ['--noCategories', '-f', 'bytes', '-p', String(fpid)], { timeout: 5000 }, (err, stdout) => res(err ? '' : stdout)),
    );
    const m = fp.match(/phys_footprint:\s+(\d+)/);
    if (m) byType[`footprint:${type}`] = +((byType[`footprint:${type}`] ?? 0) + +m[1] / 1048576).toFixed(1);
  }
  return byType;
}

/** Periodic memory sampler for one scenario; stop() returns a peak/last summary. */
function startMemorySampler(p) {
  if (!(MEM_INTERVAL > 0)) return { stop: async () => null };
  const samples = [];
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = Date.now();
      const heap = await withTimeout(p.cdp.send('Runtime.getHeapUsage'), 2000, 'heap').catch(() => null);
      let workerMB = 0;
      for (const w of p.page.workers()) {
        const client = w.client;
        const u = client
          ? await withTimeout(client.send('Runtime.getHeapUsage'), 2000, 'worker heap').then(h => h.usedSize, () => 0)
          : 0;
        workerMB += u / 1048576;
      }
      const procs = await chromeProcessMemory().catch(() => null);
      samples.push({ t, pageHeapMB: heap ? +(heap.usedSize / 1048576).toFixed(1) : null, workerHeapMB: +workerMB.toFixed(1), procs });
      if (samples.length > 2000) samples.splice(0, 1000);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, MEM_INTERVAL);
  tick();
  return {
    samples,
    async stop() {
      clearInterval(timer);
      if (!samples.length) return null;
      const peak = {};
      const add = (k, v) => {
        if (typeof v === 'number') peak[k] = Math.max(peak[k] ?? 0, v);
      };
      for (const s of samples) {
        add('pageHeapMB', s.pageHeapMB);
        add('workerHeapMB', s.workerHeapMB);
        for (const [k, v] of Object.entries(s.procs ?? {})) add(k.startsWith('footprint:') ? k : `rss:${k}`, v);
      }
      const first = samples[0];
      const last = samples[samples.length - 1];
      return { samples: samples.length, spanS: +((last.t - first.t) / 1000).toFixed(1), peak, first: { pageHeapMB: first.pageHeapMB, workerHeapMB: first.workerHeapMB, procs: first.procs }, last: { pageHeapMB: last.pageHeapMB, workerHeapMB: last.workerHeapMB, procs: last.procs } };
    },
  };
}

async function cleanup() {
  await closeBrowser();
  if (server) {
    server.closeAllConnections?.();
    await new Promise(r => server.close(() => r()));
    server = null;
  }
  if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGALRM']) {
  process.on(sig, async () => {
    console.error(`\n${sig}: cleaning up`);
    await cleanup();
    process.exit(2);
  });
}

/** Fresh page per scenario, with console capture from the page and its workers. */
async function openPage(query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  const logs = [];
  const push = (source, type, text) => {
    if (logs.length < 5000) logs.push({ source, type, text: text.slice(0, 500) });
  };
  page.on('console', m => push('page', m.type(), m.text()));
  page.on('pageerror', e => push('page', 'pageerror', String(e?.message ?? e)));
  page.on('error', e => {
    // Renderer process crash ("Page crashed!").
    push('page', 'crash', String(e?.message ?? e));
    browserCrash = browserCrash ?? `page crashed: ${String(e?.message ?? e)}`;
    console.error(`  [crash] ${browserCrash}`);
  });
  page.on('workercreated', w => {
    w.on('console', m => push('worker', m.type(), m.text()));
  });
  await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'load' });
  await page.waitForFunction('globalThis.__stressReady === true', { timeout: 15000 });
  const cdp = await page.createCDPSession();
  return { page, logs, cdp };
}

async function closePage(p) {
  await p.page.close().catch(() => {});
}

async function heapMB(cdp) {
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => null);
  return { usedMB: +(usedSize / 1048576).toFixed(2), nodes: dom?.nodes, listeners: dom?.jsEventListeners };
}

async function shot(p, ctxId) {
  const rect = await p.page.evaluate(id => stress.canvasRect(id), ctxId);
  if (!(rect.width >= 1 && rect.height >= 1)) return { lit: 0, empty: true };
  const b64 = await p.page.screenshot({ encoding: 'base64', clip: rect, captureBeyondViewport: false });
  return p.page.evaluate((b, ) => stress.analyzePng(b), b64);
}

function summarizeLogs(logs, since = 0) {
  const map = new Map();
  for (let i = since; i < logs.length; i++) {
    const l = logs[i];
    if (l.type !== 'error' && l.type !== 'warn' && l.type !== 'warning' && l.type !== 'pageerror') continue;
    if (l.text.includes('Failed to load resource') && l.text.includes('404')) continue; // favicon
    const key = `${l.source}:${l.type}:${l.text.split('\n')[0].slice(0, 220)}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([k, n]) => `${n}× ${k}`);
}
// `[cozygpu:CODE]` lines are the library reporting an error itself; cozyErrors()
// covers those, and their text ("… needs WebGPU compute …") must not be read as
// a driver-level GPU error.
const isGpuError = l => !l.text.includes('[cozygpu:') && /\[stress:gpu-error\]|WebGPU|GPUValidationError|Invalid (Buffer|Texture|CommandBuffer|BindGroup)|\[Invalid/i.test(l.text);
function gpuErrorLines(logs, since = 0) {
  return logs.slice(since).filter(l => (l.type === 'error' || l.type === 'warn' || l.type === 'warning') && isGpuError(l));
}
function cozyErrors(logs, since = 0, code) {
  return logs.slice(since).filter(l => l.text.includes(code ? `[cozygpu:${code}]` : '[cozygpu:'));
}

async function scenario(name, fn, opts = {}) {
  current = { name, checks: [], notes: [] };
  report.scenarios.push(current);
  console.log(`\n▶ ${name}`);
  const t0 = Date.now();
  let p = null;
  let mem = null;
  try {
    await ensureBrowser();
    p = await openPage(opts.query ?? '');
    mem = startMemorySampler(p);
    current.adapter = await p.page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      if (!a) return null;
      const info = a.info ?? {};
      return { vendor: info.vendor, architecture: info.architecture, maxBufferSize: a.limits.maxBufferSize, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize, maxTextureDimension2D: a.limits.maxTextureDimension2D };
    });
    // A crash can leave a pending page.evaluate() hanging until the protocol
    // timeout: stop waiting as soon as the crash is noticed.
    let crashTimer = null;
    const crashed = new Promise((_, rej) => {
      crashTimer = setInterval(() => {
        if (browserCrash || !browser?.connected) rej(new Error(`browser crashed: ${browserCrash ?? 'disconnected'}`));
      }, 500);
    });
    crashed.catch(() => {});
    try {
      await Promise.race([fn(p), crashed]);
    } finally {
      clearInterval(crashTimer);
    }
  } catch (e) {
    let where = null;
    if (p) {
      where = await withTimeout(p.page.evaluate(() => ({ phase: __stress.phase ?? null, frames: __stress.frameCounter ?? null })), 5000, 'phase probe').catch(err => `page unresponsive (${err.message})`);
    }
    const crashed = browserCrash || (browser && !browser.connected);
    if (crashed) {
      check('browser did not crash', false, { crash: browserCrash ?? 'disconnected', error: String(e?.message ?? e).slice(0, 300) });
    } else {
      check('scenario completed without harness exception', false, { error: String(e?.message ?? e).slice(0, 300), where });
    }
  } finally {
    const memory = await mem?.stop().catch(() => null);
    if (memory) {
      current.memory = memory;
      note('memory (peak over scenario)', memory.peak);
    }
    if (browserCrash || (browser && !browser.connected)) {
      current.crash = browserCrash ?? 'disconnected';
      if (memory) note('memory at last sample before crash', memory.last);
      current.logTail = p?.logs.slice(-30);
      if (p) {
        current.logSummary = summarizeLogs(p.logs);
        if (current.logSummary.length) note('console errors/warnings (deduped)', current.logSummary.slice(0, 25));
      }
      if (p) note('console tail before crash', p.logs.slice(-15).map(l => `${l.source}:${l.type}: ${l.text.slice(0, 200)}`));
      await closeBrowser(); // relaunched lazily by the next scenario
      p = null;
    }
    if (p) {
      current.logSummary = summarizeLogs(p.logs);
      if (current.logSummary.length) note('console errors/warnings (deduped)', current.logSummary.slice(0, 25));
      await closePage(p);
      // A GPU-side failure (ANGLE out of memory, a real context loss, a GPU
      // process that can no longer create contexts) poisons the GPU process for
      // later scenarios: start them on a fresh Chrome so failures stay local.
      const poisoned = p.logs.find(l => /GL_OUT_OF_MEMORY|GL_CONTEXT_LOST_KHR|Failed to create WebGPU Context Provider|GPU process/i.test(l.text));
      if (poisoned) {
        note('GPU process poisoned: relaunching Chrome for the next scenario', poisoned.text.slice(0, 200));
        await closeBrowser();
      }
    }
    current.ms = Date.now() - t0;
  }
}

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms: ${label}`)), ms))]);

// ─── Scenarios ───────────────────────────────────────────────────────────────

async function runSwarm(mode, backend) {
  const worker = mode === 'worker';
  // WebGL2 simulates every slot with transform feedback and refuses more than
  // SWARM_GL_MAX_CAPACITY (4M), so it gets its own ladder (ARCHITECTURE §14.1).
  const glCases = [
    { capacity: 250_000, limits: 'default', expect: 'ok' },
    { capacity: 1_000_000, limits: 'default', expect: 'ok', frameCount: 120 },
    { capacity: 4_000_000, limits: 'default', expect: 'ok-or-graceful', frameCount: 60, warmFrames: 10, readTimeoutMs: 30000, perf: false },
    { capacity: 5_000_000, limits: 'default', expect: 'graceful', frameCount: 30, warmFrames: 5 },
  ];
  const cases = backend === 'webgl2' ? glCases : [
    { capacity: 1_000_000, limits: 'default', expect: 'ok' },
    { capacity: 1_000_000, limits: 'max', expect: 'ok' },
    { capacity: 3_000_000, limits: 'default', expect: 'ok-or-graceful' },
    { capacity: 3_000_000, limits: 'max', expect: 'ok' },
    { capacity: 4_000_000, limits: 'default', expect: 'graceful' },
    // 100M = 4 GB hot + 1.6 GB cold + 0.4 GB draw. On adapters whose binding
    // limit is ~4 GiB (Apple Silicon) this is accepted and must at least not
    // corrupt anything; elsewhere it must fail with OUT_OF_CAPACITY. Few frames:
    // it runs at ~1 fps on a 16 GB M4.
    { capacity: 100_000_000, limits: 'max', expect: 'ok-or-graceful', frameCount: 8, warmFrames: 4, readTimeoutMs: 60000, perf: false },
  ];
  const capFilter = argv['swarm-caps'] ? String(argv['swarm-caps']).split(',').map(Number) : null;
  for (const c of cases) {
    if (capFilter && !capFilter.includes(c.capacity)) continue;
    await scenario(`swarm ${c.capacity.toLocaleString('en')} limits=${c.limits} [${backend}/${mode}]`, async p => {
      const since = p.logs.length;
      const r = await withTimeout(p.page.evaluate(o => stress.swarmCapacity(o), { worker, backend, capacity: c.capacity, limits: c.limits, frameCount: c.frameCount, warmFrames: c.warmFrames, readTimeoutMs: c.readTimeoutMs }), 300000, 'swarmCapacity');
      await new Promise(res => setTimeout(res, 300));
      const img = r.ctxId ? await shot(p, r.ctxId) : null;
      const ooc = cozyErrors(p.logs, since, 'OUT_OF_CAPACITY');
      const gpu = gpuErrorLines(p.logs, since);
      note('result', { fps: r.stats?.fps, p99: r.stats?.frameMsP99, cpuMsAvg: r.stats?.cpuMsAvg, packet: r.packetBytes, spawnFrontMs: r.spawnFrontMs, aliveHead: r.aliveHead, aliveTail: r.aliveTail, caps: r.caps, createError: r.createError, frontError: r.frontError, readError: r.readError, readHeadMs: r.readHeadMs, img });
      check('createRenderer resolved', !r.createError, r.createError);
      if (r.createError) return;
      check('renderer not destroyed', !r.rendererDestroyed);
      const hotBytes = c.capacity * 40;
      const fits = backend === 'webgl2' ? c.capacity <= 4_000_000 : hotBytes <= Math.min(r.caps.maxStorageBufferBindingSize, r.caps.maxBufferSize);
      check('renderer still draws (marker sprite on top visible)', (img?.red ?? 0) > 1000, img);
      const graceful = c.expect === 'graceful' || (c.expect === 'ok-or-graceful' && ooc.length > 0);
      note('path', graceful ? 'graceful (swarm rejected)' : `accepted (hot ${hotBytes} B ${fits ? '<=' : '>'} binding limit)`);
      if (!graceful) {
        check('no OUT_OF_CAPACITY error when the buffers fit', ooc.length === 0, ooc.map(l => l.text));
        check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
        check('swarm readback: first slots alive', r.aliveHead === r.readN, `${r.aliveHead}/${r.readN}`);
        check('swarm readback: last slots alive (whole capacity spawned)', r.aliveTail === r.readN, `${r.aliveTail}/${r.readN}`);
        check('swarm visible on screen', (img?.blue ?? 0) > 5000, img);
        check('packet < 1 KB steady state', r.packetBytes < 1024, r.packetBytes);
        if (c.perf === false) note('fps (informational, over-budget capacity)', r.stats);
        else if (backend === 'webgl2') {
          if (c.capacity === 250_000) check('webgl2: 250k swarm ≥ 30 fps (headless rAF)', r.stats.fps >= 30, r.stats);
          else if (c.capacity === 1_000_000) check('webgl2: 1M swarm ≥ 10 fps (transform feedback, above the warn cap)', r.stats.fps >= 10, r.stats);
          if (c.capacity > 1_000_000) {
            const warn = p.logs.slice(since).filter(l => l.text.includes('[cozygpu]') && l.text.includes('transform feedback'));
            check('webgl2: a capacity above SWARM_GL_WARN_CAPACITY warns once', warn.length === 1, warn.map(l => l.text.slice(0, 120)));
          }
        }
        else if (c.capacity === 1_000_000) check('1M swarm ≥ 55 fps (headless rAF)', r.stats.fps >= 55, r.stats);
        else if (c.capacity === 3_000_000) check('3M swarm ≥ 20 fps (headless rAF, full-screen overdraw)', r.stats.fps >= 20, r.stats);
      } else {
        const reported = cozyErrors(p.logs, since).filter(l => !l.text.includes('[cozygpu:webgpu]'));
        check(`graceful failure reported as a CozyGPU error (${fits ? 'within limits but too big to allocate' : `${hotBytes} B > binding limit`})`, reported.length > 0, summarizeLogs(p.logs, since).slice(0, 5));
        check('graceful: no uncaptured GPU validation errors', gpu.length === 0, { count: gpu.length, first: gpu.slice(0, 2).map(l => l.text) });
        check('graceful: no page exceptions', !p.logs.slice(since).some(l => l.type === 'pageerror'));
        await p.page.evaluate(id => stress.removeSwarm(id), r.ctxId);
        const img2 = await shot(p, r.ctxId);
        check('graceful: renderer draws again after swarm.destroy()', (img2?.red ?? 0) > 1000, img2);
      }
      const dropErr = await p.page.evaluate(id => stress.dropCtx(id), r.ctxId);
      check('destroy() after capacity test did not throw', !dropErr, dropErr);
    });
  }
}

async function runBurst(mode, backend) {
  const worker = mode === 'worker';
  const capacity = backend === 'webgl2' ? 300_000 : 1_000_000;
  await scenario(`spawn bursts ${BURST_S}s [${backend}/${mode}]`, async p => {
    const r = await withTimeout(p.page.evaluate(o => stress.spawnBurst(o), { worker, backend, seconds: BURST_S, capacity }), BURST_S * 1000 + 90000, 'spawnBurst');
    const gpu = gpuErrorLines(p.logs);
    const gpuCount = await p.page.evaluate(() => __stress.gpuErrorCount);
    note('result', { ...r, throws: undefined });
    check('no exceptions from spawn/kill/clear/setBehaviors/render', r.throws.length === 0, r.throws);
    check('no GPU errors during bursts', gpu.length === 0 && gpuCount === 0, gpu.slice(0, 5).map(l => l.text));
    check('no cozygpu errors reported', cozyErrors(p.logs).length === 0, cozyErrors(p.logs).slice(0, 5).map(l => l.text));
    check('activeCount stayed within [0, capacity]', r.badActive === 0, r.maxActive);
    check('front cpu stayed bounded', r.stats.cpuMsP99 < 20, r.stats.cpuMsP99);
    check('manual allocator hit full and recovered', r.manualFull > 0);
    check('behavior swaps happened under load', r.swaps >= Math.floor(BURST_S / 7) - 1, r.swaps);
    check('frame p99 < 50 ms', r.stats.frameMsP99 < 50, r.stats);
    check('front cpu avg < 2 ms', r.stats.cpuMsAvg < 2, r.stats.cpuMsAvg);
    check('simulation still correct after storm (1000/1000 alive)', r.postAlive === 1000, r.postAlive);
    if (worker) check('worker skipped < 20% of frames', r.skippedFrames < r.stats.frames * 0.2, `${r.skippedFrames}/${r.stats.frames}`);
    await p.page.evaluate(id => stress.dropCtx(id), r.ctxId);
  });
}

async function runSprites(mode, backend) {
  const worker = mode === 'worker';
  for (const variant of ['atlas', 'mixed']) {
    const seconds = variant === 'atlas' ? SPRITE_S : Math.min(SPRITE_S, 5);
    await scenario(`sprites 200k churn (${variant}) ${seconds}s [${backend}/${mode}]`, async p => {
      const h0 = await heapMB(p.cdp);
      const r = await withTimeout(p.page.evaluate(o => stress.spriteChurn(o), { worker, backend, seconds, variant }), seconds * 1000 + 180000, 'spriteChurn');
      const img = await shot(p, r.ctxId);
      const h1 = await heapMB(p.cdp);
      const gpu = gpuErrorLines(p.logs);
      note('result', { ...r, throws: undefined, img, heapBefore: h0, heapLive: h1 });
      check('no exceptions during add/remove/render', r.throws.length === 0, r.throws);
      check('no GPU errors', gpu.length === 0, gpu.slice(0, 5).map(l => l.text));
      check('no cozygpu errors reported', cozyErrors(p.logs).length === 0, cozyErrors(p.logs).slice(0, 5).map(l => l.text));
      check('no device/context loss during the churn', r.lost === 0, { lost: r.lost, restored: r.restored, gl: p.logs.filter(l => /GL_OUT_OF_MEMORY|CONTEXT_LOST/.test(l.text)).slice(0, 2).map(l => l.text.slice(0, 200)) });
      check('child count stable at 200k', r.finalChildren === r.count, r.finalChildren);
      check('sprites visible', img.lit > 20000, img);
      if (variant === 'atlas') {
        check('atlas: one texture source + one blend → ≤ 2 draw calls', r.maxDrawCalls <= 2, r.maxDrawCalls);
        check('atlas: render() cpu avg < 16 ms (2k add, 2k remove, 10k moves / frame; full repack of 200k)', r.stats.cpuMsAvg < 16, r.stats);
        check(`atlas: fps ≥ ${backend === 'webgl2' ? 12 : 25}`, r.stats.fps >= (backend === 'webgl2' ? 12 : 25), r.stats.fps);
      } else {
        check('mixed: render() cpu avg < 45 ms even with ~200k draw calls', r.stats.cpuMsAvg < 45, { cpu: r.stats.cpuMsAvg, drawCalls: r.maxDrawCalls });
      }
      await p.page.evaluate(id => stress.dropCtx(id), r.ctxId);
      await new Promise(res => setTimeout(res, worker ? 800 : 100));
      const h2 = await heapMB(p.cdp);
      note('heap after destroy', h2);
      check('heap returns within 10 MB of baseline after destroy', h2.usedMB - h0.usedMB < 10, { before: h0.usedMB, live: h1.usedMB, afterDestroy: h2.usedMB });
    });
  }
}

async function runResize(mode, backend) {
  const worker = mode === 'worker';
  for (const manual of [false, true]) {
    await scenario(`resize storm ${manual ? 'renderer.resize()' : 'CSS + ResizeObserver'} [${backend}/${mode}]`, async p => {
      const { ctxId } = await p.page.evaluate(o => stress.liveScene(o), { worker, backend, swarmCount: 50_000, autoResize: manual ? false : undefined });
      const since = p.logs.length;
      const r = await withTimeout(p.page.evaluate((id, o) => stress.resizeStorm(id, o), ctxId, { steps: 600, manual }), 120000, 'resizeStorm');
      await new Promise(res => setTimeout(res, 500));
      const s = await p.page.evaluate(id => stress.liveState(id), ctxId);
      const img = await shot(p, ctxId);
      const gpu = gpuErrorLines(p.logs, since);
      note('result', { huge: r.huge, zero: r.zero, stormMs: r.stormMs, state: s, img, adapter: current.adapter });
      check('no exceptions during storm', r.throws.length === 0 && s.loopThrows.length === 0, [...r.throws, ...s.loopThrows]);
      check('no GPU errors (incl. sizes > maxTextureDimension2D)', gpu.length === 0, { count: gpu.length, first: gpu.slice(0, 3).map(l => l.text) });
      check('renderer alive after storm', !s.destroyed);
      check('settled CSS size 640×480', s.width === 640 && s.height === 480, `${s.width}×${s.height}`);
      if (!worker) check('canvas backing store = CSS × resolution', s.canvasWidth === Math.round(640 * s.resolution) && s.canvasHeight === Math.round(480 * s.resolution), `${s.canvasWidth}×${s.canvasHeight} res ${s.resolution}`);
      check('scene visible after storm', img.lit > 5000 && img.blue > 1000, img);
      await p.page.evaluate(id => stress.dropCtx(id), ctxId);
    });
  }
}

async function runDpr(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`devicePixelRatio changes [${backend}/${mode}]`, async p => {
    const { ctxId } = await p.page.evaluate(o => stress.liveScene(o), { worker, backend, swarmCount: 20_000 });
    const seq = [2, 3, 1.5, 1.25, 1, 2];
    let pureDprMisses = 0;
    for (const dpr of seq) {
      await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: dpr, mobile: false });
      await new Promise(res => setTimeout(res, 500));
      const pure = await p.page.evaluate(id => stress.liveState(id), ctxId);
      pureDprMisses += Math.abs(pure.resolution - dpr) < 1e-3 ? 0 : 1;
      // Headless CDP emulation fires neither matchMedia('(resolution)') change nor
      // ResizeObserver on a DSF change, so nudge the CSS box to get an RO callback.
      await p.page.evaluate(id => stress.nudgeCanvas(id, 641, 480), ctxId);
      await p.page.evaluate(id => stress.nudgeCanvas(id, 640, 480), ctxId);
      await new Promise(res => setTimeout(res, 300));
      const s = await p.page.evaluate(id => stress.liveState(id), ctxId);
      const img = await shot(p, ctxId);
      check(`dpr ${dpr}: renderer.resolution follows`, Math.abs(s.resolution - dpr) < 1e-3, `resolution ${s.resolution}, devicePixelRatio ${s.dpr}`);
      check(`dpr ${dpr}: CSS size unchanged`, s.width === 640 && s.height === 480, `${s.width}×${s.height}`);
      if (!worker) check(`dpr ${dpr}: canvas backing store = round(640·dpr)`, s.canvasWidth === Math.round(640 * dpr) && s.canvasHeight === Math.round(480 * dpr), `${s.canvasWidth}×${s.canvasHeight}`);
      check(`dpr ${dpr}: scene visible`, img.lit > 3000 * dpr * dpr * 0.5, img);
    }
    note('DPR changes without a CSS resize picked up (CDP emulation fires no events, informational)', `${seq.length - pureDprMisses}/${seq.length}`);
    const gpu = gpuErrorLines(p.logs);
    check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    await p.cdp.send('Emulation.clearDeviceMetricsOverride');
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

async function simulateLoss(p, worker) {
  if (!worker) return p.page.evaluate(() => stress.simulateLossHere());
  const w = p.page.workers().at(-1);
  if (!w) return 'no worker';
  return w.evaluate(() => {
    const core = globalThis.__COZYGPU_CORE__;
    if (!core) return 'no __COZYGPU_CORE__';
    core.backend.simulateDeviceLoss();
    return 'ok';
  });
}

async function doubleLoss(p, worker) {
  const src = await p.page.evaluate(() => stress.doubleLossSource);
  if (!worker) return p.page.evaluate(src);
  const w = p.page.workers().at(-1);
  if (!w) return 'no worker';
  return w.evaluate(src);
}

async function waitState(p, ctxId, pred, ms) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await p.page.evaluate(id => stress.liveState(id), ctxId);
    if (pred(s)) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  return s;
}

async function runLoss(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`device loss + recovery [${backend}/${mode}]`, async p => {
    const { ctxId } = await p.page.evaluate(o => stress.liveScene(o), { worker, backend, debug: true, swarmCount: 100_000 });
    let s0 = await p.page.evaluate(id => stress.liveState(id), ctxId);
    const img0 = await shot(p, ctxId);
    note('before', { img0, lost: s0.lost.length });
    for (let k = 1; k <= 5; k++) {
      const before = await p.page.evaluate(id => stress.liveState(id), ctxId);
      if (k === 2) await p.page.evaluate(id => stress.startPendingReadback(id), ctxId);
      // loss #3 loses the device again right after restore() installs a new one
      const res = k === 3 ? await doubleLoss(p, worker) : await simulateLoss(p, worker);
      if (!check(`loss #${k}: ${k === 3 ? 'double loss during restore' : 'simulateDeviceLoss()'} triggered`, res === 'ok', res)) return;
      const s = await waitState(p, ctxId, x => x.restored > before.restored && x.lost.length > before.lost.length, 15000);
      await new Promise(r => setTimeout(r, 1500));
      const settled = await p.page.evaluate(id => stress.liveState(id), ctxId);
      check(`loss #${k}: onDeviceLost(willRestore: true) then onDeviceRestored`, s.lost.length > before.lost.length && s.restored > before.restored && s.lost.every(l => l.willRestore), { lost: s.lost.length, restored: s.restored });
      check(`loss #${k}: exactly one onDeviceRestored per onDeviceLost once settled`, settled.lost.length === settled.restored, { lost: settled.lost.length, restored: settled.restored, onRestore: settled.onRestoreCalls });
      check(`loss #${k}: renderer not destroyed`, !s.destroyed);
      const s2 = await p.page.evaluate(id => stress.liveState(id), ctxId);
      const alive = await p.page.evaluate(id => stress.readSwarmAlive(id, 64), ctxId);
      const img = await shot(p, ctxId);
      check(`loss #${k}: Swarm onRestore called (coalesced per render)`, s2.onRestoreCalls > before.onRestoreCalls && s2.onRestoreCalls <= s2.restored, { onRestore: s2.onRestoreCalls, restored: s2.restored });
      check(`loss #${k}: swarm re-spawned (readback 64/64 alive)`, alive === 64, alive);
      check(`loss #${k}: frames keep flowing`, s2.frameId > s.frameId, `${s.frameId} → ${s2.frameId}`);
      check(`loss #${k}: sprites + swarm visible again`, img.lit > img0.lit * 0.6 && img.blue > img0.blue * 0.5, { img, img0 });
      if (k === 2) {
        const pr = await p.page.evaluate(id => stress.pendingRead(id), ctxId);
        check('readback in flight during loss settles (resolve or reject, no hang)', pr !== 'pending', pr);
      }
      check(`loss #${k}: no render() throws`, s2.loopThrows.length === 0, s2.loopThrows);
    }
    const prFinal = await p.page.evaluate(id => stress.pendingRead(id), ctxId);
    check('readback started before loss #2 has settled by the end of the scenario', prFinal !== 'pending', prFinal);
    const gpu = gpuErrorLines(p.logs).filter(l => !/destroyed|lost/i.test(l.text));
    check('no GPU errors other than lost-device noise', gpu.length === 0, gpu.slice(0, 5).map(l => l.text));
    check('no INTERNAL errors', cozyErrors(p.logs, 0, 'INTERNAL').length === 0, cozyErrors(p.logs, 0, 'INTERNAL').slice(0, 3).map(l => l.text));
    if (!worker && backend === 'webgl2') {
      // An *external* WEBGL_lose_context, i.e. not through simulateDeviceLoss().
      const pre = p.logs.length;
      const ext = await withTimeout(p.page.evaluate(id => stress.rawContextLose(id), ctxId), 60000, 'rawContextLose');
      const img = await shot(p, ctxId);
      note('external WEBGL_lose_context', { ...ext, img, logs: summarizeLogs(p.logs, pre).slice(0, 5) });
      check('external context loss: reported to the app', ext.lostDelta > 0, ext);
      check('external context loss: restored', ext.restoredDelta > 0, ext);
      check('external context loss: frames flow again', ext.frameDelta > 0, ext);
      check('external context loss: no render() throws', (ext.loopThrows ?? []).length === 0, ext.loopThrows);
      check('external context loss: scene visible again', (img?.lit ?? 0) > 3000, img);
    }
    if (!worker && backend !== 'webgl2') {
      const pre = p.logs.length;
      const s3 = await p.page.evaluate(id => stress.rawDeviceDestroy(id), ctxId);
      const post = summarizeLogs(p.logs, pre);
      const img = await shot(p, ctxId);
      note('raw GPUDevice.destroy() (outside the library)', { lostDelta: s3.lostDelta, restored: s3.restored, destroyed: s3.destroyed, readback: s3.readback, loopThrows: s3.loopThrows, img, logs: post.slice(0, 8) });
      check('raw device.destroy(): render() does not throw', (s3.loopThrows ?? []).length === 0, s3.loopThrows);
      check('raw device.destroy(): console not flooded', p.logs.length - pre < 50, p.logs.length - pre);
      check('raw device.destroy(): app is told (onDeviceLost) or rendering continues (red background visible)', s3.lostDelta > 0 || img.red > img.w * img.h * 0.3, { lostDelta: s3.lostDelta, img });
      check('raw device.destroy(): swarm readback settles (no hang)', s3.readback !== 'timeout', s3.readback);
    }
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

async function runRecreate(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`destroy()/re-create ×${CYCLES} [${backend}/${mode}]`, async p => {
    const heaps = [];
    const cycles = [];
    const base = await heapMB(p.cdp);
    for (let i = 0; i < CYCLES; i++) {
      const r = await withTimeout(p.page.evaluate(o => stress.recreateCycle(o), { worker, backend }), 60000, `cycle ${i}`);
      cycles.push(r);
      const h = await heapMB(p.cdp);
      heaps.push(h.usedMB);
      if (i === 1 || i === CYCLES - 1) note(`cycle ${i + 1}`, { ...r, heap: h, workers: p.page.workers().length });
      if (r.destroyThrow || r.alive !== 32) {
        check(`cycle ${i + 1} healthy`, false, r);
      }
    }
    const h1 = heaps[Math.min(1, heaps.length - 1)];
    const hN = heaps[heaps.length - 1];
    note('heap MB per cycle', heaps);
    check('all cycles: swarm readback alive', cycles.every(c => c.alive === 32), cycles.map(c => c.alive));
    check('all cycles: destroy() + post-destroy calls do not throw', cycles.every(c => !c.destroyThrow), cycles.map(c => c.destroyThrow).filter(Boolean));
    check('all cycles: readback pending at destroy() settles (no hang)', cycles.every(c => c.pendingResult !== 'hang'), [...new Set(cycles.map(c => c.pendingResult))]);
    check(`JS heap growth cycle 2 → ${CYCLES} < 5 MB`, hN - h1 < 5, { base: base.usedMB, cycle2: h1, last: hN, growth: +(hN - h1).toFixed(2) });
    const final = await heapMB(p.cdp);
    check('DOM nodes did not accumulate', (final.nodes ?? 0) - (base.nodes ?? 0) < 50, { base: base.nodes, final: final.nodes });
    if (!worker) {
      const alive = await p.page.evaluate(() => stress.aliveDevices());
      check('main thread: no live GPUDevice left after destroy()', alive === 0, alive);
    } else {
      await new Promise(r => setTimeout(r, 1000));
      check('worker mode: all workers terminated', p.page.workers().length === 0, p.page.workers().length);
    }
    const createMs = cycles.map(c => c.createMs);
    note('createRenderer ms', createMs);
    const gpu = gpuErrorLines(p.logs);
    check('no GPU errors', gpu.length === 0, gpu.slice(0, 5).map(l => l.text));
    check('no cozygpu errors reported', cozyErrors(p.logs).length === 0, cozyErrors(p.logs).slice(0, 5).map(l => l.text));

    if (!worker) {
      // Re-create on the SAME canvas (allowed in main-thread mode).
      const reuse = [];
      for (let i = 0; i < 5; i++) reuse.push(await p.page.evaluate(o => stress.recreateCycle(o), { worker: false, backend, reuseCanvasId: 1, sprites: 2000, swarmCount: 10000 }));
      check('same canvas re-used 5×: every cycle works', reuse.every(c => c.alive === 32 && !c.destroyThrow), reuse.map(c => ({ alive: c.alive, err: c.destroyThrow })));
    }
  });
}

/** Pixel-level regression checks for bugs fixed in round 1 (see stress-page.js regressStep). */
async function runRegress(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`fixed-bug regressions [${backend}/${mode}]`, async p => {
    const step = async (name, ctxId) => {
      const r = await withTimeout(p.page.evaluate(o => stress.regressStep(o), { worker, backend, step: name, ctxId }), 30000, name);
      check(`${name}: no throws`, r.throws.length === 0, r.throws);
      return r;
    };
    const px = async (ctxId, pts) => {
      await new Promise(res => setTimeout(res, 150));
      const rect = await p.page.evaluate(id => stress.canvasRect(id), ctxId);
      const b64 = await p.page.screenshot({ encoding: 'base64', clip: rect, captureBeyondViewport: false });
      return p.page.evaluate((b, q) => stress.samplePng(b, q), b64, pts);
    };
    const isRed = c => c[0] > 180 && c[1] < 80 && c[2] < 80;
    const isGreen = c => c[1] > 180 && c[0] < 80 && c[2] < 80;
    const isBlack = c => c[0] < 40 && c[1] < 40 && c[2] < 40;
    const rowPts = Array.from({ length: 8 }, (_, i) => [45 + 70 * i, 45]);

    const { ctxId } = await step('init');
    let c = await px(ctxId, rowPts);
    check('init: 8 red sprites', c.every(isRed), c);

    await step('tail', ctxId);
    c = await px(ctxId, rowPts);
    check('hide tail → recolor → show: all 8 green (no stale tail instance bytes)', c.every(isGreen), c);

    await step('odd', ctxId);
    c = await px(ctxId, rowPts);
    check('hide odd sprites: odd black, even green', c.every((v, i) => (i % 2 ? isBlack(v) : isGreen(v))), c);

    await step('texreuse', ctxId);
    c = await px(ctxId, [[45, 145]]);
    check('new texture after destroying another (id reuse) draws its own pixels (green)', isGreen(c[0]), c);

    await step('reassign', ctxId);
    c = await px(ctxId, [[45, 225]]);
    check('sprite that held a destroyed texture draws the new texture after reassignment (green)', isGreen(c[0]), c);

    const rd = await step('readd', ctxId);
    c = await px(ctxId, [[45, 305]]);
    check('addChild(existing child): count unchanged, moved to end', rd.childCount === 2 && rd.lastIsGreen, rd);
    check('addChild(existing child): re-added sprite drawn on top (green)', isGreen(c[0]), c);

    const gpu = gpuErrorLines(p.logs);
    check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    check('no cozygpu errors reported', cozyErrors(p.logs).length === 0, cozyErrors(p.logs).slice(0, 3).map(l => l.text));
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

// ─── M2 scenarios ────────────────────────────────────────────────────────────

/** RGB at canvas-relative CSS points of a fresh screenshot. */
async function samplePoints(p, ctxId, pts, settleMs = 200) {
  await new Promise(r => setTimeout(r, settleMs));
  const rect = await p.page.evaluate(id => stress.canvasRect(id), ctxId);
  const b64 = await p.page.screenshot({ encoding: 'base64', clip: rect, captureBeyondViewport: false });
  return p.page.evaluate((b, q) => stress.samplePng(b, q), b64, pts);
}

const ICON_PTS = Array.from({ length: 8 }, (_, i) => [36 + i * 40, 36]);
const RELOAD_PT = [100, 460];

async function runAssets(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`assets: bundle, LRU eviction, reload, abort, device loss [${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const init = await withTimeout(
      p.page.evaluate(o => stress.assetsInit(o), { worker, backend, budgetMB: ASSET_BUDGET_MB, debug: true }),
      90000,
      'assetsInit',
    );
    const id = init.ctxId;
    note('init', init);
    // stats before the first load come from the lazy proxy (all zeros).
    note('assets.stats before the implementation chunk loads', init.stats);

    // 1. Bundle with progress.
    const b = await withTimeout(p.page.evaluate((i, o) => stress.assetsBundle(i, o), id, { count: ICONS }), 180000, 'assetsBundle');
    note('bundle', { ...b, progress: `${b.progress.length} events`, stats: b.stats });
    check('bundle: loaded every entry', !b.error && b.handles === ICONS + 1, { error: b.error, handles: b.handles });
    check('bundle: progress is monotonic and ends at 1', !!b.monotonic && b.lastRatio === 1 && b.lastLoaded === b.total, {
      monotonic: b.monotonic,
      last: b.lastRatio,
      loaded: b.lastLoaded,
      total: b.total,
    });
    check('bundle: JSON entry parsed', b.levelOk === true);
    check('bundle: small icons packed into an atlas page', b.packed === ICONS && b.stats.atlasPages >= 1, {
      packed: b.packed,
      of: ICONS,
      pages: b.stats.atlasPages,
    });
    let px = await samplePoints(p, id, ICON_PTS);
    const iconWant = ICON_PTS.map((_, i) => colorFor(i));
    check(
      'bundle: the 8 drawn icons show their own colours',
      px.every((c, i) => near(c, iconWant[i])),
      { got: px, want: iconWant },
    );
    check('bundle: atlas-packed icons batch into few draw calls', b.drawCalls <= 3, b.drawCalls);
    check('assets: the manager reports the requested budget', b.stats.budgetMB === ASSET_BUDGET_MB, b.stats);

    // 2. Budget churn: load far more than the budget, releasing as we go.
    const bc = await withTimeout(p.page.evaluate((i, o) => stress.assetsBudgetChurn(i, o), id, { count: BIGS }), 240000, 'assetsBudgetChurn');
    note('budget churn', { ...bc, samples: bc.samples.length ? [bc.samples[0], bc.samples[bc.samples.length - 1]] : [] });
    check('budget: every big texture loaded', bc.loaded === BIGS, { loaded: bc.loaded, errors: bc.errors });
    check('budget: LRU eviction happened', bc.stats.evictions > 0, bc.stats.evictions);
    check(
      'budget: GPU estimate stayed within the budget (+1 texture of slack)',
      bc.maxGpuMB <= ASSET_BUDGET_MB + 1.5,
      { maxGpuMB: bc.maxGpuMB, budgetMB: ASSET_BUDGET_MB },
    );
    check(
      `budget: ${BIGS} loads of 1 MiB each did not accumulate (LRU, not a leak)`,
      bc.stats.evictions >= BIGS - Math.ceil((ASSET_BUDGET_MB - 16) / 1.34) - 2,
      { evictions: bc.stats.evictions, loads: BIGS, gpuMB: bc.stats.gpuMB },
    );
    check('budget: the first (oldest, released) texture was evicted', bc.stillCached0 === false, bc.stillCached0);
    check('budget: no throws in the render loop', bc.loopThrows.length === 0, bc.loopThrows);

    // 3. Reload an evicted texture from its URL — the pixels must be that file's.
    const rl = await withTimeout(p.page.evaluate((i, o) => stress.assetsReload(i, o), id, { index: 0 }), 90000, 'assetsReload');
    note('reload', rl);
    check('reload: the evicted entry was really gone before the reload', rl.before.cached === false, rl.before);
    check('reload: re-load succeeded', !rl.error, rl.error);
    px = await samplePoints(p, id, [RELOAD_PT]);
    check('reload: the reloaded texture shows big-0 colours', near(px[0], colorFor(1000)), { got: px[0], want: colorFor(1000) });

    // 4. Abort mid-load.
    const ab = await withTimeout(p.page.evaluate((i, o) => stress.assetsAbort(i, o), id, { count: 6, delayMs: 900 }), 90000, 'assetsAbort');
    note('abort', ab);
    check('abort: loadAll rejected with ABORTED', ab.outcome === 'ABORTED', ab.outcome);
    check('abort: downloads were in flight when we aborted', ab.during.inFlight + ab.during.queued > 0, ab.during);
    check('abort: nothing left in flight or queued afterwards', ab.settled.inFlight === 0 && ab.settled.queued === 0, ab.settled);
    check('abort: aborted loads did not add GPU bytes', ab.settled.gpuMB <= ab.during.gpuMB + 0.1, {
      during: ab.during.gpuMB,
      settled: ab.settled.gpuMB,
    });
    check('abort: rendering continued', ab.loopThrows.length === 0, ab.loopThrows);
    check('abort: no unhandled page errors', p.logs.slice(since).every(l => l.type !== 'pageerror'), summarizeLogs(p.logs, since).slice(0, 5));

    // 5. Device loss: referenced textures reload from their URLs.
    const lossSince = p.logs.length;
    const ls = await withTimeout(p.page.evaluate(i => stress.assetsLoss(i), id), 120000, 'assetsLoss');
    note('device loss', ls);
    if (check('loss: simulateDeviceLoss triggered', ls.trigger === 'ok', ls.trigger)) {
      check('loss: onDeviceLost + onDeviceRestored fired', ls.lost >= 1 && ls.restored >= 1, { lost: ls.lost, restored: ls.restored });
      px = await samplePoints(p, id, [...ICON_PTS, RELOAD_PT], 500);
      check(
        'loss: every referenced texture is back with its own pixels',
        px.slice(0, 8).every((c, i) => near(c, iconWant[i])) && near(px[8], colorFor(1000)),
        { icons: px.slice(0, 8), reload: px[8] },
      );
      check('loss: no throws in the render loop', ls.loopThrows.length === 0, ls.loopThrows);
      const gpuAfter = gpuErrorLines(p.logs, lossSince).filter(l => !/lost|destroyed/i.test(l.text));
      check('loss: no GPU errors beyond lost-device noise', gpuAfter.length === 0, gpuAfter.slice(0, 3).map(l => l.text));
    }

    // 6. Teardown.
    const td = await withTimeout(p.page.evaluate(i => stress.assetsTeardown(i), id), 60000, 'assetsTeardown');
    note('teardown', td);
    check('teardown: release/trim/destroy did not throw', td.throws.length === 0, td.throws);
    check('teardown: destroy() dropped every cached texture', (td.afterDestroy?.gpuMB ?? 1) === 0 && td.afterDestroy.entries === 0, td.afterDestroy);
    const err = cozyErrors(p.logs, since).filter(l => !/DEVICE_LOST|device lost/i.test(l.text));
    check('assets: no unexpected cozygpu errors', err.length === 0, err.slice(0, 5).map(l => l.text));
    const dropErr = await p.page.evaluate(i => stress.dropCtx(i), id);
    check('assets: renderer.destroy() did not throw', !dropErr, dropErr);
  });
}

async function runPick(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`picking under load (100k sprites + swarm) [${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const r = await withTimeout(
      p.page.evaluate(o => stress.pickScene(o), { worker, backend, count: PICK_SPRITES, swarmCount: PICK_SWARM }),
      180000,
      'pickScene',
    );
    const id = r.ctxId;
    note('scene', { count: r.count, backend: r.backend, swarm: r.swarm ? r.swarm.capacity : null });

    const targets = Array.from({ length: 5 }, (_, i) => [70 + i * 120, 500, i]);
    const cases = [
      ...targets,
      [630, 50, 100], // opaque half of the alpha sprite
      [690, 50, null], // transparent half: nothing there
      [340, 190, 201], // topmost of a stacked pair
      [500, 190, 301], // the sprite under a pickable:false one
      [760, 420, null], // empty background (no sprite, no swarm object there)
    ];
    // A lone pick per frame is the normal app case (one pointerdown → one pick).
    const diag = await withTimeout(p.page.evaluate((i, x, y) => stress.pickDiag(i, x, y), id, 70, 500), 120000, 'pickDiag');
    note('pick batching diagnostic at (70,500), expected id 0 everywhere', diag);
    check('pick: a single pick issued on its own frame resolves', diag.single.every(v => v === 0), diag.single);
    check('pick: batches of 1..5 picks in one frame all resolve', diag.batches.every(b => b.got.every(v => v === 0)), diag.batches);
    const sameOrder = d => d && d.got.every((v, i) => v === d.want[i]);
    check('pick: distinct points in one frame each answer for their own coordinates', sameOrder(diag.forward), diag.forward);
    check('pick: the same distinct points in reverse order still answer per coordinate', sameOrder(diag.reverse), diag.reverse);

    const res = await withTimeout(p.page.evaluate((i, pts) => stress.pickBatch(i, pts), id, cases), 180000, 'pickBatch');
    const bad = res.filter(x => x.got !== x.expect);
    note('picks', res.map(x => ({ at: [x.x, x.y], want: x.expect, got: x.got, frames: x.frames, ms: x.ms })));
    check('pick: every sprite case resolved to the right node', bad.length === 0, bad);
    check('pick: no pick timed out or threw', res.every(x => !x.timeout && !x.error), res.filter(x => x.timeout || x.error));
    const maxFrames = Math.max(...res.map(x => x.frames ?? 0));
    check('pick: resolves within 3 frames', maxFrames <= 3, { maxFrames, frames: res.map(x => x.frames) });

    if (r.swarm) {
      const swarmCases = r.swarm.points.map(([x, y]) => [x, y, 'swarm']);
      const sres = await withTimeout(p.page.evaluate((i, pts) => stress.pickBatch(i, pts), id, swarmCases), 120000, 'pickBatch swarm');
      note('swarm picks', sres.map(x => ({ at: [x.x, x.y], got: x.got, instance: x.instance, frames: x.frames })));
      check('pick: swarm objects are picked (node is the Swarm)', sres.every(x => x.got === 'swarm'), sres.map(x => x.got));
      check(
        'pick: swarm instance is the spawned slot (0..4 in spawn order)',
        sres.every((x, i) => x.instance === i),
        sres.map(x => x.instance),
      );
    } else {
      note('swarm picking skipped', `swarm unsupported at ${PICK_SWARM} on ${r.backend}`);
    }

    const conc = await withTimeout(
      p.page.evaluate((i, pts) => stress.pickConcurrent(i, pts), id, targets.map(([x, y]) => [x, y])),
      120000,
      'pickConcurrent',
    );
    note('concurrent picks', conc);
    check(
      'pick: 5 picks issued in one frame all resolve correctly',
      conc.results.every((x, i) => x.got === i),
      conc.results,
    );

    const dn = await withTimeout(p.page.evaluate(i => stress.pickDestroyedNode(i, 610, 500), id), 60000, 'pickDestroyedNode');
    note('pick of a node destroyed before it resolves', dn);
    check('pick: node destroyed before the pick resolves → null, no throw', dn.got === null && !dn.error && !dn.timeout, dn);

    const gpu = gpuErrorLines(p.logs, since);
    check('pick: no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    check('pick: no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));

    const ad = await withTimeout(p.page.evaluate(i => stress.pickAfterDestroy(i, 70, 500), id), 60000, 'pickAfterDestroy');
    note('pick after destroy()', ad);
    check('pick: after destroy() it rejects with DESTROYED (no hang)', ad.rejected === 'DESTROYED', ad);
    await p.page.evaluate(i => stress.dropCtx(i), id);
  });
}

async function runGpuAlloc(mode, backend) {
  const worker = mode === 'worker';
  const webgl2 = backend === 'webgl2';
  await scenario(`swarm allocation:'gpu' free-list churn ${GPU_ALLOC_S}s [${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const h0 = await heapMB(p.cdp);
    const r = await withTimeout(
      p.page.evaluate(o => stress.gpuAllocChurn(o), { worker, backend, seconds: GPU_ALLOC_S, capacity: GPU_ALLOC_CAP }),
      GPU_ALLOC_S * 1000 + 180000,
      'gpuAllocChurn',
    );
    const img = r.ctxId ? await shot(p, r.ctxId) : null;
    const unsupported = cozyErrors(p.logs, since, 'UNSUPPORTED');
    note('result', { ...r, aliveSamples: r.aliveSamples, img, heapBefore: h0 });
    check('no exceptions from spawn/kill/render', r.throws.length === 0, r.throws);
    check('renderer still draws (marker sprite visible)', (img?.red ?? 0) > 500, img);

    if (webgl2) {
      check("webgl2: allocation 'gpu' is refused with a reported UNSUPPORTED error", unsupported.length > 0, summarizeLogs(p.logs, since).slice(0, 5));
      check('webgl2: no page exceptions from the refused swarm', p.logs.slice(since).every(l => l.type !== 'pageerror'));
      const gl = gpuErrorLines(p.logs, since);
      check('webgl2: no GL errors', gl.length === 0, gl.slice(0, 3).map(l => l.text));
    } else {
      check('no UNSUPPORTED error on WebGPU', unsupported.length === 0, unsupported.slice(0, 3).map(l => l.text));
      check('aliveCount() readbacks all resolved', r.aliveErrors.length === 0, r.aliveErrors.slice(0, 3));
      check('aliveCount() was sampled during the churn', r.aliveSamples.length >= Math.max(2, Math.floor(GPU_ALLOC_S / 3) - 1), { samples: r.aliveSamples.length, seconds: GPU_ALLOC_S });
      const alive = r.aliveSamples.map(s => s[1]);
      check('alive stayed inside [1, capacity] the whole time', alive.every(v => v > 0 && v <= GPU_ALLOC_CAP), alive);
      check(
        'alive did not pin at the capacity (free list recycles dead slots)',
        alive.length > 0 && alive[alive.length - 1] < GPU_ALLOC_CAP,
        { last: alive[alive.length - 1], capacity: GPU_ALLOC_CAP },
      );
      check('spawn() returns 0 for gpu allocation', r.spawnReturns.every(v => v === 0), r.spawnReturns);
      check('after the drain almost nothing is alive', typeof r.aliveAfterDrain === 'number' && r.aliveAfterDrain < GPU_ALLOC_CAP * 0.05, r.aliveAfterDrain);
      check('freed slots are reusable: 10k immortal objects spawn and stay alive', r.aliveAfterRespawn === 10000, r.aliveAfterRespawn);
      check('clear() empties the swarm', r.aliveAfterClear === 0, r.aliveAfterClear);
      check('front cpu avg < 2 ms', r.stats.cpuMsAvg < 2, r.stats.cpuMsAvg);
      check('fps ≥ 30 under constant spawn/kill', r.stats.fps >= 30, r.stats);
      check('packet < 1 KB steady state', r.packetBytes < 1024, r.packetBytes);
      const gpu = gpuErrorLines(p.logs, since);
      check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    }
    await p.page.evaluate(i => stress.dropCtx(i), r.ctxId);
    await new Promise(res => setTimeout(res, worker ? 800 : 200));
    const h1 = await heapMB(p.cdp);
    note('heap', { before: h0, after: h1 });
    check('heap returns within 10 MB of the baseline after destroy', h1.usedMB - h0.usedMB < 10, { before: h0.usedMB, after: h1.usedMB });
  });
}

async function runRing(backend) {
  for (const ring of [true, false]) {
    await scenario(`worker command ring ${ring ? 'on' : 'off'}: wraparound, growth, backpressure [${backend}/worker]`, async p => {
      const since = p.logs.length;
      const r = await withTimeout(
        p.page.evaluate(o => stress.ringStress(o), { backend, ring, seconds: RING_S }),
        RING_S * 1000 + 240000,
        'ringStress',
      );
      const img = r.ctxId ? await shot(p, r.ctxId) : null;
      note('result', { ...r, img });
      check('page is crossOriginIsolated (SharedArrayBuffer available)', r.crossOriginIsolated === true);
      check(`transport ring is ${ring ? 'active' : 'off'} as requested`, r.ringActive === ring, { active: r.ringActive, sharedMemory: r.sharedMemory });
      check('no exceptions from render()', r.throws.length === 0 && r.loopThrows.length === 0, [...r.throws, ...r.loopThrows]);

      const w = r.phases.wrap;
      check('wraparound: thousands of packets go through the 2-slot ring', w.submitted > 500, w);
      check('wraparound: no frame was lost to an error', w.submitted + w.skipped === w.calls, w);

      const g = r.phases.grow;
      check('growth: a packet larger than the 64 KiB ring slot is handled', g.maxPacketBytes > 64 * 1024, g);
      // 120k draw commands per frame (alternating blend modes): WebGPU encodes
      // them at ~28 fps, WebGL2 (one GL draw + blend switch each, ANGLE/Metal)
      // at ~2 fps. The check is that big packets keep flowing, not their rate.
      check(
        `growth: frames kept being submitted (≥ ${backend === 'webgl2' ? '1' : '2.5'} per second)`,
        g.submitted >= (g.ms / 1000) * (backend === 'webgl2' ? 1 : 2.5),
        g,
      );
      note('growth: 3.3 MB packets per second', +((g.submitted * 1000) / g.ms).toFixed(1));

      const s = r.phases.shrink;
      check('after growth: small packets again and the ring is still in use', s.lastPacketBytes < 64 * 1024 && s.ringActive === ring, s);
      check('growth did not break the frame flow', s.submitted > 10 && r.throws.length === 0, s);

      const pr = r.phases.pressure;
      check('backpressure: render() bursts are skipped, not blocked or thrown', pr.skipped > 0 && pr.submitted > 0, pr);
      check('backpressure: frames still reach the core while skipping', pr.submitted > 30, pr);
      const c = r.phases.cool;
      check('after the load drops, almost every render() is submitted again', c.submitted > c.calls * 0.5, c);
      check('scene still visible at the end', (img?.lit ?? 0) > 2000 && (img?.red ?? 0) > 500, img);
      const gpu = gpuErrorLines(p.logs, since);
      check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
      check('no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));
      await p.page.evaluate(i => stress.dropCtx(i), r.ctxId);
    });
  }
}

/** Page + worker JS heap after a forced GC. */
async function heapBoth(p) {
  const page = await heapMB(p.cdp);
  let worker = 0;
  let workers = 0;
  for (const w of p.page.workers()) {
    const client = w.client;
    if (!client) continue;
    workers++;
    await client.send('HeapProfiler.collectGarbage').catch(() => {});
    const u = await client.send('Runtime.getHeapUsage').then(h => h.usedSize, () => 0);
    worker += u / 1048576;
  }
  return { pageMB: page.usedMB, workerMB: +worker.toFixed(2), workers, nodes: page.nodes, listeners: page.listeners };
}

async function runSoak(backend) {
  await scenario(`heap soak ${SOAK_S}s in worker ring mode [${backend}/worker]`, async p => {
    const since = p.logs.length;
    const start = await withTimeout(
      p.page.evaluate(o => stress.heapSoakStart(o), { worker: true, backend, ring: true }),
      120000,
      'heapSoakStart',
    );
    const id = start.ctxId;
    note('scene', start);
    check('ring mode is active for the soak', start.ringActive === true, start);
    const samples = [];
    const t0 = Date.now();
    const step = Math.max(15000, Math.round((SOAK_S * 1000) / 10));
    while (Date.now() - t0 < SOAK_S * 1000) {
      await new Promise(r => setTimeout(r, Math.min(step, SOAK_S * 1000 - (Date.now() - t0))));
      const st = await withTimeout(p.page.evaluate(i => stress.soakState(i), id), 30000, 'soakState');
      const heap = await heapBoth(p);
      samples.push({ s: Math.round((Date.now() - t0) / 1000), ...heap, frameId: st.frameId, skipped: st.skipped, packetBytes: st.packetBytes, cpuMs: st.cpuMs, throws: st.loopThrows.length });
      if (browserCrash) break;
    }
    note('heap samples', samples);
    const st = await p.page.evaluate(i => stress.soakState(i), id);
    note('final state', st);
    if (samples.length >= 2) {
      const base = samples[0];
      const last = samples[samples.length - 1];
      const spanMin = (last.s - base.s) / 60;
      check(
        `page heap growth after the first sample < ${SOAK_HEAP_MB} MB over ${spanMin.toFixed(1)} min`,
        last.pageMB - base.pageMB < SOAK_HEAP_MB,
        { first: base.pageMB, last: last.pageMB, growth: +(last.pageMB - base.pageMB).toFixed(2) },
      );
      check(
        `worker heap growth < ${SOAK_HEAP_MB} MB over ${spanMin.toFixed(1)} min`,
        last.workerMB - base.workerMB < SOAK_HEAP_MB,
        { first: base.workerMB, last: last.workerMB, growth: +(last.workerMB - base.workerMB).toFixed(2) },
      );
      check('frames kept flowing for the whole soak', last.frameId > base.frameId + 100, { first: base.frameId, last: last.frameId });
      check('packet size stayed stable', Math.abs(last.packetBytes - base.packetBytes) < 4096, { first: base.packetBytes, last: last.packetBytes });
      check('no frames were skipped in steady state', last.skipped - base.skipped < (last.frameId - base.frameId) * 0.1, {
        skipped: last.skipped - base.skipped,
        frames: last.frameId - base.frameId,
      });
    } else {
      check('soak produced at least two heap samples', false, samples.length);
    }
    check('no throws in the render loop', st.loopThrows.length === 0, st.loopThrows);
    check('no device loss during the soak', st.lost === 0, st.lost);
    const gpu = gpuErrorLines(p.logs, since);
    check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    check('no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));
    await p.page.evaluate(i => stress.dropCtx(i), id);
  });
}

// ─── M2.5 scenarios (integration hooks, ARCHITECTURE §19) ────────────────────

/** Region pixel counts of a fresh canvas screenshot (rects in canvas CSS px). */
async function regions(p, ctxId, rects, settleMs = 250) {
  await new Promise(r => setTimeout(r, settleMs));
  const rect = await p.page.evaluate(id => stress.canvasRect(id), ctxId);
  const b64 = await p.page.screenshot({ encoding: 'base64', clip: rect, captureBeyondViewport: false });
  return p.page.evaluate((b, q) => stress.regionStats(b, q), b64, rects);
}

/** CDP sessions whose JS allocations are measured: the page, plus its workers. */
function allocTargets(p) {
  const out = [['page', p.cdp]];
  for (const w of p.page.workers()) if (w.client) out.push(['worker', w.client]);
  return out;
}

/**
 * Sampling heap profiler over a window, counting objects collected by minor
 * and major GCs too, so the sum is (an estimate of) every byte allocated in
 * that realm, not only what survived.
 */
async function allocStart(p, interval = 256) {
  const targets = allocTargets(p);
  for (const [, c] of targets) {
    await c.send('HeapProfiler.enable').catch(() => {});
    await c.send('HeapProfiler.collectGarbage').catch(() => {});
    await c.send('HeapProfiler.startSampling', { samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  }
  return targets;
}
/** First bundle line of the stress page's own code (page.js); library code is above it. */
let pageCodeLine = null;
async function pageCodeStart() {
  if (pageCodeLine !== null) return pageCodeLine;
  const src = await readFile(path.join(outDir, 'page.js'), 'utf8');
  const i = src.split('\n').findIndex(l => l.includes('__stress_page_code_begins__'));
  pageCodeLine = i >= 0 ? i + 1 : Infinity;
  return pageCodeLine;
}
/**
 * Call sites whose allocations are WebGPU API objects created per frame
 * (command encoder, pass encoder, swap texture + view, command buffer):
 * unavoidable wrappers (ARCHITECTURE §7), reported apart from library JS.
 */
const API_OBJECT_SITES = /^(beginRenderPass|beginComputePass|requireEncoder|beginCommands|canvasView|getCurrentTexture|createView|submit|finish)$/;

/**
 * Stops the profilers. Per realm: total sampled bytes, split into
 * `library` (library JS), `api` (WebGPU API objects, see above), `driver`
 * (this page's own code) and `native` (V8/runtime frames without JS source).
 */
async function allocStop(targets) {
  const boundary = await pageCodeStart();
  const out = {};
  for (const [kind, c] of targets) {
    const { profile } = await c.send('HeapProfiler.stopSampling');
    const acc = { bytes: 0, library: 0, api: 0, driver: 0, native: 0 };
    const by = new Map();
    const walk = n => {
      if (n.selfSize > 0) {
        const f = n.callFrame;
        const file = path.basename(f.url || '');
        const fn = f.functionName || '(anonymous)';
        let cls;
        if (!file) cls = 'native';
        else if (file === 'page.js' && f.lineNumber + 1 >= boundary) cls = 'driver';
        else if (API_OBJECT_SITES.test(fn)) cls = 'api';
        else cls = 'library';
        acc.bytes += n.selfSize;
        acc[cls] += n.selfSize;
        const key = `${cls} ${fn} ${file || '(native)'}:${f.lineNumber + 1}`;
        by.set(key, (by.get(key) ?? 0) + n.selfSize);
      }
      for (const ch of n.children) walk(ch);
    };
    walk(profile.head);
    const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${(v / 1024).toFixed(1)} KB ${k}`);
    const prev = out[kind];
    if (prev) {
      for (const k of ['bytes', 'library', 'api', 'driver', 'native']) prev[k] += acc[k];
      prev.top = prev.top.concat(top);
    } else out[kind] = { ...acc, top };
  }
  return out;
}
/** Bytes per unit (frame or pick) for each class, rounded. */
function perUnit(a, units) {
  if (!a) return null;
  const u = Math.max(1, units);
  return { total: +(a.bytes / u).toFixed(1), library: +(a.library / u).toFixed(1), api: +(a.api / u).toFixed(1), driver: +(a.driver / u).toFixed(1), native: +(a.native / u).toFixed(1) };
}

async function runColumns(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`columns churn ${COLUMNS_N.toLocaleString('en')} sprites ${COLUMNS_S}s with re-binds [${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const h0 = await heapBoth(p);
    const r = await withTimeout(p.page.evaluate(o => stress.columnsChurn(o), { worker, backend, count: COLUMNS_N, seconds: COLUMNS_S }), COLUMNS_S * 1000 + 120000, 'columnsChurn');
    const id = r.ctxId;
    note('churn', { ...r, validation: undefined });
    note('validation', r.validation);
    const v = r.validation;
    check('validation: commit past the child count → INVALID_ARGUMENT', v.commitPastChildren === 'INVALID_ARGUMENT' && v.commitFirstPastChildren === 'INVALID_ARGUMENT', v);
    check('validation: stride 0, frame without frames, wrong array type → INVALID_ARGUMENT', v.strideZero === 'INVALID_ARGUMENT' && v.frameWithoutFrames === 'INVALID_ARGUMENT' && v.wrongArrayType === 'INVALID_ARGUMENT', v);
    check('validation: a column too short for the committed rows → INVALID_ARGUMENT (rows that fit are fine)', v.shortColumnCommit === 'INVALID_ARGUMENT' && v.shortColumnCommitFits === 'ok' && v.stridedShort === 'INVALID_ARGUMENT' && v.strided === 'ok', v);
    check('bindColumns returns the container\'s single reused binding', v.sameObject === true, v.sameObject);
    check('binding recovers after the failed binds (rebind + commit ok, all fields bound)', v.rebindOk === 'ok' && v.commitOk === 'ok' && v.fields === v.allFields, { rebind: v.rebindOk, commit: v.commitOk, fields: v.fields, all: v.allFields });
    check('no exceptions during commit/grow/shrink/rebind/unbind/render', r.throws.length === 0, r.throws);
    check('rows stayed 1:1 with children through the churn', r.rows === r.children, { rows: r.rows, children: r.children });
    check('structural churn happened (grows, shrinks, re-binds, unbinds, partial commits)', r.grows > 3 && r.shrinks > 3 && r.unbinds >= 1 && r.partials > 3, { grows: r.grows, shrinks: r.shrinks, rebinds: r.rebinds, unbinds: r.unbinds, partials: r.partials });
    check('columns scene draws in ≤ 2 draw calls (one texture source)', r.drawCalls <= 2, r.drawCalls);
    check(`churn: fps ≥ ${backend === 'webgl2' ? 20 : 30}`, r.stats.fps >= (backend === 'webgl2' ? 20 : 30), r.stats);

    // Steady window: the §19.1 budget and zero allocations per frame.
    await p.page.evaluate(i => stress.columnsSteadyStart(i), id);
    await new Promise(res => setTimeout(res, 3000)); // warm (optimized code, first allocations)
    const targets = await allocStart(p);
    const f0 = await p.page.evaluate(i => stress.loopFrames(i), id);
    await new Promise(res => setTimeout(res, 6000));
    const f1 = await p.page.evaluate(i => stress.loopFrames(i), id);
    const alloc = await allocStop(targets);
    const st = await p.page.evaluate(i => stress.columnsSteadyStop(i), id);
    st.frames = f1.frames - f0.frames;
    const perFrame = Object.fromEntries(Object.entries(alloc).map(([k, a]) => [k, perUnit(a, st.frames)]));
    note('steady (move + commit + render)', { ...st, allocBytesPerFrame: perFrame });
    note('steady: top allocation sites', Object.fromEntries(Object.entries(alloc).map(([k, a]) => [k, a.top])));
    check('steady: no exceptions', st.throws.length === 0, st.throws);
    check(`steady: commit() of ${r.rows.toLocaleString('en')} rows × 8 columns avg < 3 ms`, st.commitMsAvg < 3, { commitAvg: st.commitMsAvg, commitP99: st.commitMsP99 });
    check('steady: commit + render() front CPU avg < 6 ms (budget: 100k moving sprites)', st.commitMsAvg + st.stats.cpuMsAvg < 6, { commit: st.commitMsAvg, render: st.stats.cpuMsAvg });
    // Budget (ARCHITECTURE §10): 0 per frame, "< 1 KB per 600 frames" ≈ 1.7 B/frame.
    // WebGPU API wrapper objects are reported apart (unavoidable, §7).
    check('steady: library JS allocations on the page < 1 KB per 600 frames (0 per frame budget)', perFrame.page.library * 600 < 1024, perFrame.page);
    if (worker) check('steady: library JS allocations in the worker < 1 KB per 600 frames', (perFrame.worker?.library ?? 0) * 600 < 1024, perFrame.worker);

    // Pixels + picks of the fixed probe rows (driven only through the columns).
    const pr = await withTimeout(p.page.evaluate(i => stress.columnsProbes(i), id), 60000, 'columnsProbes');
    note('probes', pr);
    const px = await samplePoints(p, id, pr.probes.map(q => q.center));
    const want = pr.probes.map(q => [(q.tint >> 16) & 255, (q.tint >> 8) & 255, q.tint & 255]);
    check('probe rows show their column tints (x, y, scale, tint, frame from columns)', px.every((c, i) => near(c, want[i], 40)), { got: px, want });
    check('SceneNode.userId of every probe child = its userId column', pr.probes.every(q => q.nodeUserId === q.userId), pr.probes.map(q => [q.userId, q.nodeUserId]));
    const picks = await withTimeout(p.page.evaluate(i => stress.columnsPickProbes(i), id), 60000, 'columnsPickProbes');
    note('probe picks', picks);
    check('pick on each probe → that child, hit.userId = column value', picks.every(x => x.nodeOk && x.got === x.want), picks);

    const gpu = gpuErrorLines(p.logs, since);
    check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    check('no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));
    const dropErr = await p.page.evaluate(i => stress.dropCtx(i), id);
    check('destroy() did not throw', !dropErr, dropErr);
    await new Promise(res => setTimeout(res, worker ? 800 : 200));
    const h1 = await heapBoth(p);
    note('heap', { before: h0, afterDestroy: h1 });
    check('page heap returns within 10 MB of the baseline after destroy', h1.pageMB - h0.pageMB < 10, { before: h0.pageMB, after: h1.pageMB });
  });
}

async function runPickUid(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`pick userId under load (columns ${COLUMNS_N.toLocaleString('en')} + swarm ${UID_SWARM_N.toLocaleString('en')}) [${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const r = await withTimeout(p.page.evaluate(o => stress.uidScene(o), { worker, backend, count: COLUMNS_N, swarmCount: UID_SWARM_N }), 180000, 'uidScene');
    const id = r.ctxId;
    note('scene', r);
    check('NodeOptions.userId stored (u32, default 0)', JSON.stringify(r.targetUserIds) === JSON.stringify([0xfffffffe, 0, 0x7fffffff, 12345]), r.targetUserIds);
    if (r.swarm) {
      check('swarm fixed objects got slots 0..4', r.swarm.slots.every((s, i) => s === i), r.swarm.slots);
      check('readCold(4) returns the spawned user id (cold.user)', Array.isArray(r.cold4) && r.cold4[3] === 42, r.cold4 ?? r.readColdError);
    }
    const rounds = [];
    for (let k = 1; k <= UID_ROUNDS; k++) {
      rounds.push(await withTimeout(p.page.evaluate((i, n) => stress.uidRound(i, n), id, k), 120000, `uidRound ${k}`));
      if (browserCrash) break;
    }
    const cases = rounds.reduce((a, x) => a + x.cases, 0);
    const bad = rounds.flatMap(x => x.bad.map(b => ({ round: x.round, ...b })));
    const byKind = {};
    for (const b of bad) byKind[`${b.kind}/${b.how}`] = (byKind[`${b.kind}/${b.how}`] ?? 0) + 1;
    note('rounds', rounds.map(x => ({ round: x.round, cases: x.cases, bad: x.bad.length, timeouts: x.timeouts, errors: x.errors.length, maxFrames: Math.max(...x.frames), rows: x.rows })));
    if (bad.length) note('mismatches (first 12)', bad.slice(0, 12));
    note('churn during the rounds', rounds.at(-1)?.churn);
    check(`every pick answered the right node and userId (${cases} cases over ${rounds.length} rounds)`, bad.length === 0, { bad: bad.length, byKind });
    const colBad = bad.filter(b => b.kind === 'column').length;
    const sprBad = bad.filter(b => b.kind === 'sprite').length;
    const swBad = bad.filter(b => b.kind === 'swarm').length;
    check('column probes: userId from the userId column (changed every round, committed in the loop)', colBad === 0, colBad);
    check('stage sprites: NodeOptions.userId, default 0, setter changes', sprBad === 0, sprBad);
    if (r.swarm) check('swarm: hit.userId = cold.user (SpawnOptions.user, write() every round) and instance = slot', swBad === 0, swBad);
    check('no pick timed out or threw', rounds.every(x => x.timeouts === 0 && x.errors.length === 0), rounds.flatMap(x => x.errors).slice(0, 5));
    check('no render-loop throws while picking', rounds.every(x => x.loopThrows.length === 0), rounds.at(-1)?.loopThrows);
    const maxFrames = Math.max(...rounds.flatMap(x => x.frames));
    check('single picks resolve within 3 frames under load', maxFrames <= 3, { maxFrames });
    const gpu = gpuErrorLines(p.logs, since);
    check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    check('no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));
    await p.page.evaluate(i => stress.dropCtx(i), id);
  });
}

const evNames = list => list.map(e => e.name);

async function runEvents(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`events sink: ready, resize, loss/restore, error, assets, throwing sink [${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const init = await withTimeout(p.page.evaluate(o => stress.eventsInit(o), { worker, backend }), 60000, 'eventsInit');
    note('init', init);
    if (!check('createRenderer with an events sink resolved', !init.createError, init.createError)) return;
    const id = init.ctxId;
    const names = evNames(init.log);
    const iReady = names.indexOf('ready');
    const iResolved = names.indexOf('@resolved');
    check('ready emitted exactly once, before createRenderer() resolved', names.filter(n => n === 'ready').length === 1 && iReady >= 0 && iReady < iResolved, names);
    const ready = init.log[iReady]?.payload ?? {};
    check('ready payload matches renderer.info', ready.backend === init.info.backend && ready.worker === init.info.worker && ready.sharedMemory === init.info.sharedMemory && (ready.fallbackReason ?? null) === init.info.fallbackReason, { ready, info: init.info });
    check('no fallback event when the backend was named', !names.includes('fallback'), names);

    const fr = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'frames'), id), 60000, 'frames');
    check('nothing emitted per frame (300 frames of a moving sprite)', fr.events.length === 0, evNames(fr.events));

    const css = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'css'), id), 60000, 'css');
    note('css resize', css);
    const cssResize = css.events.filter(e => e.name === 'resize');
    check('autoResize: one resize event for one CSS change, none for the same size again', cssResize.length === 1 && css.afterFirst === 1, evNames(css.events));
    check('resize payload = new CSS size and resolution', cssResize[0] && cssResize[0].payload.width === 600 && cssResize[0].payload.height === 450 && cssResize[0].payload.resolution === css.state.resolution, { payload: cssResize[0]?.payload, state: css.state });

    const man = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'manual'), id), 60000, 'manual');
    note('manual resize', man);
    const manResize = man.events.filter(e => e.name === 'resize').map(e => e.payload);
    check('renderer.resize(): one event per accepted change (resolution 2, then 1), none for a no-op', manResize.length === 2 && manResize[0].resolution === 2 && manResize[1].resolution === 1 && manResize.every(x => x.width === 600 && x.height === 450), manResize);

    for (let k = 1; k <= 2; k++) {
      const ls = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'loss'), id), 60000, `loss ${k}`);
      note(`loss #${k}`, ls);
      if (!check(`loss #${k}: triggered`, ls.trigger === 'ok', ls.trigger)) break;
      const n = evNames(ls.events);
      check(`loss #${k}: order onDeviceLost → deviceLost → onDeviceRestored → deviceRestored`, JSON.stringify(n.filter(x => x !== 'resize')) === JSON.stringify(['cb:lost', 'deviceLost', 'cb:restored', 'deviceRestored']), n);
      const lost = ls.events.find(e => e.name === 'deviceLost')?.payload;
      const rest = ls.events.find(e => e.name === 'deviceRestored')?.payload;
      check(`loss #${k}: deviceLost {backend, message, willRestore: true}`, lost && lost.backend === init.info.backend && lost.willRestore === true && typeof lost.message === 'string', lost);
      check(`loss #${k}: deviceRestored generation = ${k}`, rest && rest.backend === init.info.backend && rest.generation === k, rest);
      check(`loss #${k}: no render() throws`, ls.loopThrows.length === 0, ls.loopThrows);
    }
    if (!worker && backend === 'webgl2') {
      const gl = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'glLose'), id), 60000, 'glLose');
      note('external WEBGL_lose_context', gl);
      if (check('external WEBGL_lose_context: triggered', gl.trigger === 'ok', gl.trigger)) {
        const n = evNames(gl.events);
        check('external context loss: deviceLost then deviceRestored events (no separate contextLost)', n.includes('deviceLost') && n.includes('deviceRestored') && n.indexOf('deviceLost') < n.indexOf('deviceRestored'), n);
        check('external context loss: deviceRestored generation = 3', gl.events.find(e => e.name === 'deviceRestored')?.payload.generation === 3, gl.events.find(e => e.name === 'deviceRestored')?.payload);
      }
    }

    const er = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'error'), id), 60000, 'error');
    note('error', er);
    const errs = er.events.filter(e => e.name === 'error');
    check(`error event for a non-fatal core error (${er.expectCode})`, errs.some(e => e.payload.code === er.expectCode && typeof e.payload.message === 'string'), er.events);
    const logged = cozyErrors(p.logs, since, er.expectCode);
    check('the error is still logged as [cozygpu:CODE]', logged.length > 0, logged.length);
    check('error events = logged core errors (one each)', errs.length === logged.length, { events: errs.length, logged: logged.length });

    const as = await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'assets'), id), 60000, 'assets');
    note('assets', as);
    const prog = as.events.filter(e => e.name === 'assetProgress').map(e => e.payload);
    const aerr = as.events.filter(e => e.name === 'assetError').map(e => e.payload);
    check('assetProgress for a finished load (key, bundle null, ratio 1)', as.loaded === true && prog.length >= 1 && prog.some(x => x.key.includes('icon-3') && x.bundle === null && x.ratio === 1), { prog, loadError: as.loadError });
    check('assetError for a failed load, same code as the rejection', aerr.length === 1 && aerr[0].code === as.missing && aerr[0].url.includes('missing-'), { aerr, rejected: as.missing });

    const gpu = gpuErrorLines(p.logs, since).filter(l => !/destroyed|lost/i.test(l.text));
    check('no GPU errors beyond lost-device noise', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    await p.page.evaluate(i => stress.dropCtx(i), id);

    // A sink that always throws: caught, logged once per event name, rendering goes on.
    const pre = p.logs.length;
    const th = await withTimeout(p.page.evaluate(o => stress.eventsInit(o), { worker, backend, throwing: true }), 60000, 'eventsInit throwing');
    if (check('throwing sink: createRenderer still resolved', !th.createError, th.createError)) {
      await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'manual'), th.ctxId), 60000, 'manual (throwing)');
      await withTimeout(p.page.evaluate(i => stress.eventsStep(i, 'manual'), th.ctxId), 60000, 'manual (throwing) again');
      const img = await shot(p, th.ctxId);
      const lines = p.logs.slice(pre).filter(l => l.text.includes('events sink threw'));
      const perName = {};
      for (const l of lines) {
        const m = l.text.match(/on "(\w+)"/);
        perName[m?.[1] ?? '?'] = (perName[m?.[1] ?? '?'] ?? 0) + 1;
      }
      note('throwing sink logs', perName);
      check('throwing sink: logged once per event name (ready 1, resize 1 after 4 resizes)', perName.ready === 1 && perName.resize === 1, perName);
      const st = await p.page.evaluate(i => stress.liveState(i), th.ctxId);
      check('throwing sink: frames flow, nothing thrown into the app', st.loopThrows.length === 0 && st.frameId > 20, { throws: st.loopThrows, frameId: st.frameId });
      check('throwing sink: scene visible', img.lit > 1000, img);
      await p.page.evaluate(i => stress.dropCtx(i), th.ctxId);
    }
  });
}

/** 'auto' with WebGPU hidden: fallback → ready, both before createRenderer() resolves. */
async function runFallback(mode) {
  const worker = mode === 'worker';
  for (const [query, label] of [['?nogpu=1', 'navigator.gpu missing'], ['?noadapter=1', 'requestAdapter() → null']]) {
    await scenario(`events: 'auto' fallback, ${label} [auto/${mode}]`, async p => {
      const init = await withTimeout(p.page.evaluate(o => stress.eventsInit(o), { worker, backend: 'auto', debug: false }), 60000, 'eventsInit auto');
      note('init', init);
      if (!check('createRenderer resolved', !init.createError, init.createError)) return;
      const names = evNames(init.log);
      const fb = init.log.find(e => e.name === 'fallback')?.payload;
      const ready = init.log.find(e => e.name === 'ready')?.payload;
      check('ended on WebGL2', init.info.backend === 'webgl2', init.info);
      check('fallback then ready, both before createRenderer() resolved, once each', JSON.stringify(names.filter(n => n !== 'resize')) === JSON.stringify(['fallback', 'ready', '@resolved']), names);
      check("fallback payload { from: 'webgpu', to: 'webgl2', reason }", fb && fb.from === 'webgpu' && fb.to === 'webgl2' && typeof fb.reason === 'string' && fb.reason.length > 0, fb);
      check('ready.fallbackReason = renderer.info.fallbackReason = fallback.reason', ready && ready.backend === 'webgl2' && ready.fallbackReason === init.info.fallbackReason && ready.fallbackReason === fb?.reason, { ready, info: init.info, fb });
      const img = await shot(p, init.ctxId);
      check('the fallback renderer draws', img.lit > 1000, img);
      await p.page.evaluate(i => stress.dropCtx(i), init.ctxId);
    }, { query });
  }
}

/**
 * Picking with the frame-rate limit off: one pick always in flight against
 * an uncapped rAF loop (100k sprites + swarm). JS allocations per pick are
 * measured with the sampling heap profiler against a no-pick baseline, and
 * the retained heap must not grow over a longer run.
 */
async function runPickAlloc(mode, backend) {
  const worker = mode === 'worker';
  await closeBrowser();
  launchExtraArgs = UNCAP_FLAGS;
  try {
    await scenario(`uncapped picking without allocation growth (${PICK_SPRITES.toLocaleString('en')} sprites + swarm) [${backend}/${mode}]`, async p => {
      const since = p.logs.length;
      const r = await withTimeout(p.page.evaluate(o => stress.pickScene(o), { worker, backend, count: PICK_SPRITES, swarmCount: PICK_SWARM }), 180000, 'pickScene');
      const id = r.ctxId;
      const pts = Array.from({ length: 5 }, (_, i) => [70 + i * 120, 500, i]);
      // Warm up: first pick loads the pick-client chunk and the readback ring.
      await withTimeout(p.page.evaluate(i => stress.pickAt(i, 70, 500), id), 30000, 'warm pick');
      const f0 = await p.page.evaluate(i => stress.loopFrames(i), id);
      await new Promise(res => setTimeout(res, 3000));
      const f1 = await p.page.evaluate(i => stress.loopFrames(i), id);
      const fps = +(((f1.frames - f0.frames) * 1000) / 3000).toFixed(1);
      note('uncapped loop without picks', { fps, skipped: f1.skipped - f0.skipped, cpuMs: f1.cpuMs });
      if (worker) note('main-thread rAF rate in worker mode (informational)', fps);
      else check('frames are uncapped (> 70 fps without picks)', fps > 70, fps);

      // Baseline: the same loop, no picks.
      let t = await allocStart(p);
      const b0 = await p.page.evaluate(i => stress.loopFrames(i), id);
      await new Promise(res => setTimeout(res, 6000));
      const b1 = await p.page.evaluate(i => stress.loopFrames(i), id);
      const base = await allocStop(t);
      const baseFrames = Math.max(1, b1.frameId - b0.frameId);

      // The first pick after seconds of uncapped submits (known M2.5 open item: queue depth).
      const first = await withTimeout(p.page.evaluate(i => stress.pickAt(i, 190, 500), id), 30000, 'first pick after idle');
      note('first pick after the uncapped no-readback phase (informational, ARCHITECTURE §7.1 open item)', first);

      const h0 = await heapBoth(p);
      t = await allocStart(p);
      await p.page.evaluate((i, q) => stress.pickPumpStart(i, q), id, pts);
      await new Promise(res => setTimeout(res, PICK_ALLOC_S * 1000));
      const mid = await p.page.evaluate(i => stress.pickPumpState(i), id);
      const prof = await allocStop(t);
      // Keep pumping (no profiler) for the retained-heap check.
      await new Promise(res => setTimeout(res, PICK_SOAK_S * 1000));
      const h1 = await heapBoth(p);
      const res = await withTimeout(p.page.evaluate(i => stress.pickPumpStop(i), id), 30000, 'pickPumpStop');
      const picksProf = mid.picks;
      const framesProf = Math.max(1, mid.frameId - b1.frameId);
      const perFrame = {};
      const perPick = {};
      for (const k of Object.keys(prof)) {
        const b = base[k] ?? { bytes: 0, library: 0, api: 0, driver: 0, native: 0 };
        perFrame[k] = { base: perUnit(b, baseFrames), picking: perUnit(prof[k], framesProf) };
        // Extra bytes while picking, over what the same frames cost without picks.
        const extra = {};
        for (const c of ['bytes', 'library', 'api', 'driver', 'native']) extra[c] = prof[k][c] - (b[c] / baseFrames) * framesProf;
        perPick[k] = perUnit(extra, picksProf);
      }
      note('pump', res);
      note('allocations', { baseFrames, framesProf, picksProf, perFrame, perPick });
      note('allocation sites', { base: Object.fromEntries(Object.entries(base).map(([k, a]) => [k, a.top.slice(0, 6)])), picking: Object.fromEntries(Object.entries(prof).map(([k, a]) => [k, a.top])) });
      note('heap before / after the pick soak', { before: h0, after: h1 });

      check('picks kept flowing (> 20 per second with one in flight)', res.picksPerS > 20, { picksPerS: res.picksPerS, framesPerPick: +(res.frames / Math.max(1, res.picks)).toFixed(1) });
      check('every pick answered the right node', res.bad === 0, { bad: res.bad, samples: res.badSamples });
      check('no pick rejected or left hanging', res.errors === 0 && !res.stillPending, { errors: res.errors, samples: res.errSamples, pending: res.stillPending });
      check('uncapped pick latency p99 < 50 ms', res.p99Ms < 50, { p50: res.p50Ms, p99: res.p99Ms, max: res.maxMs, over100: res.over100 });
      check('no pick took longer than 500 ms while picks kept a readback in flight', res.maxMs < 500, { max: res.maxMs, over100: res.over100 });
      check('no render-loop throws', res.loopThrows.length === 0, res.loopThrows);
      // §19.6: no library allocation per pick beyond the promise pick() returns
      // (plus the PickHit it resolves with, and the native mapAsync promise /
      // WebGL2 sync object). 256 B per pick covers those; M2 was ~30 KB per picking frame.
      check('library JS allocations per pick < 256 B on the page', perPick.page.library < 256, perPick.page);
      if (worker) check('library JS allocations per pick < 256 B in the worker', (perPick.worker?.library ?? 0) < 256, perPick.worker);
      check('total page allocations per pick < 1 KB (incl. runtime/native)', perPick.page.total < 1024, perPick.page);
      check(`page heap after GC did not grow over ${PICK_SOAK_S}s of picking (< 1 MB)`, h1.pageMB - h0.pageMB < 1, { before: h0.pageMB, after: h1.pageMB });
      if (worker) check(`worker heap after GC did not grow over ${PICK_SOAK_S}s of picking (< 1 MB)`, h1.workerMB - h0.workerMB < 1, { before: h0.workerMB, after: h1.workerMB });
      const gpu = gpuErrorLines(p.logs, since);
      check('no GPU errors', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
      check('no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));
      await p.page.evaluate(i => stress.dropCtx(i), id);
    });
  } finally {
    await closeBrowser();
    launchExtraArgs = [];
  }
}

const EXT_R = [500, 20, 280, 440];
const EXT_L = [20, 20, 280, 440];
const EXT_RT = [500, 20, 280, 210];
const EXT_RB = [500, 250, 280, 210];
const EXT_P = [630, 520, 40, 40];
const EXT_MARK = [0, 560, 40, 40];

async function runExternal(mode, backend) {
  const worker = mode === 'worker';
  const N = backend === 'webgl2' ? 200_000 : EXT_N;
  await scenario(`external instance buffer (interop) ${worker || backend === 'webgl2' ? '' : `${N.toLocaleString('en')} `}[${backend}/${mode}]`, async p => {
    const since = p.logs.length;
    const step = async (name, o = {}) => {
      const r = await withTimeout(p.page.evaluate(q => stress.extStep(q), { step: name, ctxId: id, ...o }), 180000, `extStep ${name}`);
      if (r.throws?.length || r.loopThrows?.length) check(`${name}: no throws`, false, { throws: r.throws, loopThrows: r.loopThrows });
      return r;
    };
    let id = null;
    const init = await step('init', { worker, backend, count: N });
    id = init.ctxId;
    note('init', init);
    if (worker) {
      check('worker mode: renderer.interop() rejects with UNSUPPORTED', init.interop === 'UNSUPPORTED', init.interop);
      const img = await shot(p, id);
      check('worker mode: the renderer keeps drawing', (img?.red ?? 0) > 500, img);
      check('no cozygpu errors', cozyErrors(p.logs, since).length === 0, cozyErrors(p.logs, since).slice(0, 3).map(l => l.text));
      await p.page.evaluate(i => stress.dropCtx(i), id);
      return;
    }
    if (!check('main thread: renderer.interop() resolves', init.interop === 'ok', init.interop)) return;
    check('interop.backend matches, device is the native object', init.interopBackend === backend && init.deviceKind === (backend === 'webgpu' ? 'GPUDevice' : 'WebGL2RenderingContext'), { backend: init.interopBackend, device: init.deviceKind });

    if (backend === 'webgl2') {
      const pre = p.logs.length;
      const g = await step('webgl2');
      note('webgl2', g);
      check("webgl2: 'sprite-instance' is reserved (UNSUPPORTED)", g.spriteInstance === 'UNSUPPORTED', g.spriteInstance);
      check('webgl2: registering a bound GL buffer as swarm-hot works', g.registerHot === 'ok', g.registerHot);
      check('webgl2: setSource on a swarm that already ran throws UNSUPPORTED', g.setSourceAfterRun === 'UNSUPPORTED', g.setSourceAfterRun);
      const uns = cozyErrors(p.logs, pre, 'UNSUPPORTED');
      check('webgl2: a source set before the first frame disables that swarm with one UNSUPPORTED error; its readback rejects', (g.setSourceBeforeRun === 'ok' && uns.length === 1 && g.s2Read !== 'ok' && g.s2Read !== 'timeout') || g.setSourceBeforeRun === 'UNSUPPORTED', { set: g.setSourceBeforeRun, errors: uns.length, read: g.s2Read });
      const rg = await regions(p, id, [EXT_L, EXT_MARK]);
      check('webgl2: own swarm and marker still draw (invalidateState after outside GL calls)', rg[0].blue > 5000 && rg[1].red > 500, rg);
      const gl = gpuErrorLines(p.logs, since);
      check('webgl2: no GL errors', gl.length === 0, gl.slice(0, 3).map(l => l.text));
      await p.page.evaluate(i => stress.dropCtx(i), id);
      return;
    }

    let rg = await regions(p, id, [EXT_L, EXT_R, EXT_P, EXT_MARK]);
    check('own swarm drawn before a source is set (left lit, right dark)', rg[0].blue > 5000 && rg[1].lit < 200, rg);

    const set = await step('set');
    note('set', set);
    check('registerInstanceBuffer → valid handle', set.valid === true && set.id > 0 && set.layout === 'swarm-hot', set);
    rg = await regions(p, id, [EXT_L, EXT_R, EXT_P, EXT_MARK]);
    check('setSource: external records drawn (right lit), own buffers not drawn (left dark)', rg[1].blue > 5000 && rg[0].lit < 200 && rg[2].blue > 800, rg);

    const rb = await step('readback');
    note('readback', rb);
    check('readHot of the external source returns the records written from outside', rb.headMismatch === 0 && rb.tailMismatch === 0, { head: rb.headMismatch, tail: rb.tailMismatch });
    check(`aliveCount() over the external source = ${N}`, rb.alive === N, rb.alive);
    check('readCold without an external cold: own cold (user 77)', rb.coldUser === 77, rb.coldUser);

    const th = await step('throws');
    check('spawn/kill/killList/write/clear throw INVALID_ARGUMENT while a source is set', Object.values(th.codes).every(c => c === 'INVALID_ARGUMENT'), th.codes);

    await step('count0');
    rg = await regions(p, id, [EXT_R, EXT_P]);
    check('setSourceCount(0): nothing drawn', rg[0].lit < 200 && rg[1].lit < 50, rg);
    await step('countHalf');
    rg = await regions(p, id, [EXT_RT, EXT_RB, EXT_P]);
    check('setSourceCount(N/2): first half (top band) drawn, second half not', rg[0].blue > 3000 && rg[1].lit < 200 && rg[2].blue > 800, rg);
    await step('countFull');
    rg = await regions(p, id, [EXT_RT, EXT_RB]);
    check('setSourceCount(N) (and 2N, clamped): both bands drawn', rg[0].blue > 3000 && rg[1].blue > 3000, rg);

    const pk = await step('pick');
    note('pick', pk);
    check('pick on external record 0 → the swarm, instance 0, userId 77 (own cold)', pk.hit && pk.hit.swarm && pk.hit.instance === 0 && pk.hit.userId === 77, pk.hit);
    check('pick where only (undrawn) own objects are → null', pk.ownHit === null, pk.ownHit);

    const cp = await step('compute', { frames: 240 });
    note('outside compute pass + render', { stats: cp.stats, submits: cp.submits, moved: cp.moved, expected: cp.expectedMove });
    check('outside compute writes are visible to cozygpu (queue order): records moved by submits × dx', Array.isArray(cp.moved) && cp.moved.every(m => Math.abs(m - cp.expectedMove) < 0.05), { moved: cp.moved, expected: cp.expectedMove });
    check(`outside compute + draw of ${N.toLocaleString('en')} external records ≥ 55 fps`, cp.stats.fps >= 55, cp.stats);

    const sim = await step('simulate');
    note('simulate', sim);
    check('simulate: true runs the swarm behaviors on the external buffer (velocity moved x)', Array.isArray(sim.moved) && sim.moved.every(m => m > 5), sim.moved);

    const inv = await step('invalid');
    note('invalid', inv.codes);
    const c = inv.codes;
    check('register: too small / no STORAGE / not a buffer / bad layout → INVALID_ARGUMENT', ['tooSmall', 'noStorage', 'notABuffer', 'badLayout'].every(k => c[k] === 'INVALID_ARGUMENT'), c);
    check("register: 'sprite-instance' → UNSUPPORTED", c.spriteInstance === 'UNSUPPORTED', c.spriteInstance);
    check('setSource: cold layout as hot, hot as cold, count > records, released buffer → INVALID_ARGUMENT', ['coldAsHot', 'hotAsCold', 'countOverRecords', 'releasedSource'].every(k => c[k] === 'INVALID_ARGUMENT'), c);
    check('setSourceCount without a source → INVALID_ARGUMENT', c.countWithoutSource === 'INVALID_ARGUMENT', c.countWithoutSource);
    rg = await regions(p, id, [EXT_R]);
    check('after the rejected calls the swarm still draws source A', rg[0].blue > 5000, rg);

    const nc = await step('nocopysrc');
    check('readHot of a source without COPY_SRC rejects UNSUPPORTED', nc.readHot === 'UNSUPPORTED', nc.readHot);

    const rel = await step('release');
    note('release', rel);
    check('release(): handle invalid', rel.valid === false, rel.valid);
    rg = await regions(p, id, [EXT_L, EXT_R]);
    check('released source in use: the swarm draws nothing', rg[1].lit < 200 && rg[0].lit < 200, rg);
    check('readHot of a released source rejects UNSUPPORTED', rel.readHot === 'UNSUPPORTED', rel.readHot);
    check('aliveCount() while the source is gone waits (does not resolve yet)', rel.pendingAlive === 'pending', rel.pendingAlive);

    const nul = await step('null');
    note('null', nul);
    rg = await regions(p, id, [EXT_L, EXT_R]);
    check('setSource(null): own buffers drawn again with their kept contents', rg[0].blue > 5000 && rg[1].lit < 200, rg);
    check('the waiting aliveCount() resolves once the swarm has buffers again (own alive count)', typeof nul.pendingAlive === 'number' && nul.pendingAlive >= N - 1, nul.pendingAlive);
    check('spawn works again after setSource(null)', nul.spawn === 'ok', nul.spawn);

    const ch = await step('churn', { cycles: 100 });
    check('100 register / setSource / release / destroy cycles', ch.cycles === 100 && ch.throws.length === 0, { cycles: ch.cycles, throws: ch.throws });
    rg = await regions(p, id, [EXT_L]);
    check('after the churn the own swarm draws', rg[0].blue > 5000, rg);
    const gpuBeforeLoss = gpuErrorLines(p.logs, since);
    check('no GPU errors before the device loss (incl. release/destroy of in-use buffers)', gpuBeforeLoss.length === 0, gpuBeforeLoss.slice(0, 3).map(l => l.text));
    const errBeforeLoss = cozyErrors(p.logs, since);
    check('no cozygpu errors before the device loss', errBeforeLoss.length === 0, errBeforeLoss.slice(0, 3).map(l => l.text));

    const lossSince = p.logs.length;
    const ls = await step('loss');
    note('loss', ls);
    if (check('device loss triggered and restored', ls.trigger === 'ok' && ls.restored, ls)) {
      check('after the loss: registration invalid, interop.device replaced', ls.validAfter === false && ls.newDevice === true, ls);
      rg = await regions(p, id, [EXT_R, EXT_MARK]);
      check('after the loss: the swarm with a lost source draws nothing, the rest draws', rg[0].lit < 200 && rg[1].red > 500, rg);
      check('after the loss: readHot of the lost source rejects (no hang)', ls.readHotAfter !== 'ok' && ls.readHotAfter !== 'timeout', ls.readHotAfter);
      const re = await step('reregister');
      note('reregister', re);
      rg = await regions(p, id, [EXT_R, EXT_P]);
      check('new buffer on the new device registers and setSource accepts it (readHot = new records)', re.valid === true && re.headOk === true, re);
      // Draw-only sources take colors / user ids from the swarm's own cold
      // buffer, which the loss emptied: nothing visible until it is refilled.
      note('after re-registering only (own cold records lost with the device)', rg);
      const rc = await step('restoreCold');
      note('restoreCold', rc);
      rg = await regions(p, id, [EXT_R, EXT_P]);
      check('after refilling the own cold records (spawn) + setSource: external records drawn again', rc.spawn === 'ok' && rg[0].blue > 5000 && rg[1].blue > 800, { spawn: rc.spawn, rg });
      check('pick after the restore → swarm, instance 0, userId 77', rc.hit && rc.hit.swarm && rc.hit.instance === 0 && rc.hit.userId === 77, rc.hit);
      const gpu = gpuErrorLines(p.logs, lossSince).filter(l => !/destroyed|lost/i.test(l.text));
      check('no GPU errors after the loss beyond lost-device noise', gpu.length === 0, gpu.slice(0, 3).map(l => l.text));
    }
    await p.page.evaluate(i => stress.dropCtx(i), id);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
// ─── M3 scenarios: masks, filters, text, particles, device loss ─────────────

const M3_S = Number(argv['m3-seconds'] ?? (QUICK ? 4 : 8));
const M3_PARTICLES = Number(argv['m3-particles'] ?? 1_000_000);

async function m3shot(p, ctxId, regions, scale = 0) {
  const rect = await p.page.evaluate(id => stress.canvasRect(id), ctxId);
  const b64 = await p.page.screenshot({ encoding: 'base64', clip: rect, captureBeyondViewport: false });
  return p.page.evaluate((b, r, s) => stress.regionColors(b, r, s), b64, regions, scale);
}
/** Evaluates `src` in the realm that owns the core (page or the last worker). */
async function inCoreRealm(p, worker, src) {
  if (!worker) return p.page.evaluate(src);
  const w = p.page.workers().at(-1);
  return w ? w.evaluate(src) : null;
}
async function poolProbe(p, worker) {
  const src = await p.page.evaluate(() => stress.poolProbeSource);
  return inCoreRealm(p, worker, src).catch(e => `probe failed: ${e.message}`);
}
const m3Info = (p, id) => p.page.evaluate(i => stress.m3LoopInfo(i), id);
async function lossAndWait(p, ctxId, worker, kind = 'single') {
  const before = await m3Info(p, ctxId);
  const res = kind === 'double' ? await doubleLoss(p, worker) : await simulateLoss(p, worker);
  const end = Date.now() + 15000;
  let s = before;
  while (Date.now() < end) {
    s = await m3Info(p, ctxId);
    if (s.restored > before.restored && s.lost > before.lost) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 1500));
  const settled = await m3Info(p, ctxId);
  return { res, before, after: settled, restoredOk: settled.restored > before.restored && settled.lost === settled.restored };
}
/** No GPU errors (other than lost-device noise) and no INTERNAL errors since `since`. */
function m3CleanLogs(p, since = 0, label = '') {
  const gpu = gpuErrorLines(p.logs, since).filter(l => !/destroyed|lost/i.test(l.text));
  check(`${label}no GPU validation errors`, gpu.length === 0, { count: gpu.length, first: gpu.slice(0, 4).map(l => l.text) });
  // WebGL2 reports misuse (e.g. objects of a lost context) as console warnings.
  const gl = p.logs.slice(since).filter(l => /WebGL: (INVALID_|too many errors)/.test(l.text));
  check(`${label}no WebGL errors`, gl.length === 0, { count: gl.length, first: [...new Set(gl.map(l => l.text.slice(0, 120)))].slice(0, 3) });
  const internal = cozyErrors(p.logs, since, 'INTERNAL');
  check(`${label}no INTERNAL errors`, internal.length === 0, internal.slice(0, 3).map(l => l.text));
  const other = cozyErrors(p.logs, since).filter(l => !l.text.includes('[cozygpu:INTERNAL]'));
  if (other.length) note(`${label}cozygpu errors reported`, [...new Set(other.map(l => l.text.slice(0, 200)))].slice(0, 6));
  const pageErr = p.logs.slice(since).filter(l => l.type === 'pageerror');
  check(`${label}no uncaught page errors`, pageErr.length === 0, pageErr.slice(0, 3).map(l => l.text));
}
const fmt = r => ({ lit: r.lit, blue: r.blue, red: r.red, green: r.green, gray: r.gray, mean: r.mean });

function maskChecks(label, img, cfg) {
  const R = img.regions;
  const bad = [];
  for (let i = 0; i < 3; i++) {
    const want = cfg.outerInvert && cfg.innerInvert ? 'none' : cfg.outerInvert ? 'right' : cfg.innerInvert ? 'top' : 'in';
    for (const k of ['in', 'top', 'right']) {
      const r = R[`p${i}.${k}`];
      const ok = k === want ? r.blue > 0.9 : r.lit < 0.02;
      if (!ok) bad.push({ panel: i, region: k, expect: k === want ? 'blue' : 'dark', got: fmt(r) });
    }
  }
  check(`${label}: mask pixels (3 panels × in/top/right)`, bad.length === 0, bad.slice(0, 4));
  check(`${label}: controls unclipped (red before, red after, green in plain group)`, R.ctrlBefore.red > 0.95 && R.ctrlAfter.red > 0.95 && R.ctrlGroup.green > 0.95, { before: fmt(R.ctrlBefore), after: fmt(R.ctrlAfter), group: fmt(R.ctrlGroup) });
}

async function runM3Masks(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`M3 masks: nested/inverted scissor+stencil+alpha under churn, depth limit, loss [${backend}/${mode}]`, async p => {
    const init = await p.page.evaluate(o => stress.maskInit(o), { worker, backend });
    const { ctxId, regions } = init;
    const modes = await p.page.evaluate(id => stress.maskModes(id), ctxId);
    note('resolved modes (panel: scissor, stencil, alpha)', { modes, stencilCap: init.stencilCap });
    check('scissor panel resolves to scissor', modes[0].outer === 'scissor' && modes[0].inner === 'scissor', modes[0]);
    check(`stencil panel resolves to ${backend === 'webgl2' && init.stencilCap ? 'stencil' : 'alpha (no stencil on this backend)'}`, modes[1].inner === (backend === 'webgl2' && init.stencilCap ? 'stencil' : 'alpha'), modes[1]);
    check('alpha panel resolves to alpha', modes[2].outer === 'alpha' && modes[2].inner === 'alpha', modes[2]);
    for (const cfg of [{}, { innerInvert: true }, { outerInvert: true }, { outerInvert: true, innerInvert: true }, {}]) {
      const r = await p.page.evaluate((id, c) => stress.maskSet(id, c), ctxId, cfg);
      if (r.errs.length) check(`set ${JSON.stringify(cfg)}: no throws`, false, r.errs);
      maskChecks(`config ${JSON.stringify(cfg)}`, await m3shot(p, ctxId, regions), cfg);
    }
    const since = p.logs.length;
    const churn = await withTimeout(p.page.evaluate((id, o) => stress.maskChurn(id, o), ctxId, { seconds: M3_S }), 120000, 'maskChurn');
    note('churn', { ops: churn.ops, frames: churn.loopFrames, frameId: churn.frameId });
    check('churn: no API throws', churn.errs.length === 0, churn.errs);
    check('churn: no render() throws', churn.throws.length === 0, churn.throws);
    maskChecks('after churn', await m3shot(p, ctxId, regions), {});
    m3CleanLogs(p, since, 'churn: ');
    for (const dm of ['scissor', 'stencil', 'alpha']) {
      const pre = p.logs.length;
      const d = await p.page.evaluate((id, o) => stress.maskDeep(id, o), ctxId, { mode: dm });
      const img = await m3shot(p, ctxId, d.regions);
      const R = img.regions;
      note(`deep ×9 (${dm})`, { ring1: fmt(R.ring1), ring8: fmt(R.ring8), center: fmt(R.center), outside: fmt(R.outside), errs: d.errs, reported: cozyErrors(p.logs, pre).map(l => l.text.slice(0, 160)).slice(0, 3) });
      check(`deep ×9 (${dm}): no throws`, d.errs.length === 0 && d.loopThrows.length === 0, [...d.errs, ...d.loopThrows]);
      check(`deep ×9 (${dm}): levels 0 and 1 clip (outside + ring1 dark)`, R.outside.lit < 0.02 && R.ring1.lit < 0.02, { outside: fmt(R.outside), ring1: fmt(R.ring1) });
      check(`deep ×9 (${dm}): innermost content visible`, R.center.blue > 0.9, fmt(R.center));
      maskChecks(`deep ×9 (${dm}) leaves panels intact`, await m3shot(p, ctxId, regions), {});
      await p.page.evaluate(id => stress.deepClear(id), ctxId);
    }
    const loss = await lossAndWait(p, ctxId, worker);
    check('device loss: restored once', loss.res === 'ok' && loss.restoredOk, loss);
    await p.page.evaluate((id, c) => stress.maskSet(id, c), ctxId, { innerInvert: true });
    maskChecks('after device loss (inner inverted)', await m3shot(p, ctxId, regions), { innerInvert: true });
    await p.page.evaluate((id, c) => stress.maskSet(id, c), ctxId, {});
    maskChecks('after device loss', await m3shot(p, ctxId, regions), {});
    const fin = await m3Info(p, ctxId);
    check('frames flowing, no render() throws at the end', fin.loopThrows.length === 0 && !fin.destroyed, fin.loopThrows);
    m3CleanLogs(p, 0, 'whole scenario: ');
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

function filterChecks(label, img, { on = true } = {}) {
  const R = img.regions;
  if (on) {
    check(`${label}: cheap grayscale group is gray`, R.gray.lit > 0.9 && R.gray.gray > 0.9, fmt(R.gray));
    check(`${label}: blur spreads past the sprite edge`, R.blurHalo.mean && R.blurHalo.mean[0] > 6, fmt(R.blurHalo));
    check(`${label}: masked+filtered group clipped`, R.maskedIn.blue > 0.5 && R.maskedOut.lit < 0.03, { in: fmt(R.maskedIn), out: fmt(R.maskedOut) });
  } else {
    check(`${label}: no cheap effect left (red stays red)`, R.gray.red > 0.95, fmt(R.gray));
    check(`${label}: no blur left`, R.blurHalo.mean && R.blurHalo.mean[0] <= 2, fmt(R.blurHalo));
    check(`${label}: mask removed (outside visible)`, R.maskedOut.blue > 0.9, fmt(R.maskedOut));
  }
  check(`${label}: effect does not leak to following sprites (ctrl after, plain group, last)`, R.ctrlAfter.red > 0.95 && R.ctrlGroup.red > 0.95 && R.ctrlLast.red > 0.95, { after: fmt(R.ctrlAfter), group: fmt(R.ctrlGroup), last: fmt(R.ctrlLast) });
  check(`${label}: blur center, long chain and nested groups visible`, R.blurCenter.lit > 0.9 && R.chain.lit > 0.3 && R.nested.lit > 0.3, { blur: fmt(R.blurCenter), chain: fmt(R.chain), nested: fmt(R.nested) });
  if (on) check(`${label}: nested (gray inside blur) is gray`, R.nested.gray > 0.8 * R.nested.lit, fmt(R.nested));
}

async function runM3Filters(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`M3 filters: chains, toggling, target-pool growth, resize, DPR, loss [${backend}/${mode}]`, async p => {
    const { ctxId, regions } = await p.page.evaluate(o => stress.filtersInit(o), { worker, backend });
    filterChecks('initial', await m3shot(p, ctxId, regions));
    let since = p.logs.length;
    let t = await p.page.evaluate((id, o) => stress.filtersToggle(id, o), ctxId, { frames: 240, end: 'off' });
    check('toggle ×240: no throws', t.errs.length === 0 && t.loopThrows.length === 0, [...t.errs, ...t.loopThrows]);
    filterChecks('after toggling, ended off', await m3shot(p, ctxId, regions), { on: false });
    t = await p.page.evaluate((id, o) => stress.filtersToggle(id, o), ctxId, { frames: 120, end: 'on' });
    filterChecks('after toggling, ended on', await m3shot(p, ctxId, regions));
    await p.page.evaluate((id, o) => stress.filtersEnabled(id, o), ctxId, { enabled: false });
    const offImg = await m3shot(p, ctxId, regions);
    check('filter.enabled = false: red stays red (cheap uniform reset)', offImg.regions.gray.red > 0.95, fmt(offImg.regions.gray));
    check('filter.enabled = false: no blur', offImg.regions.blurHalo.mean[0] <= 2, fmt(offImg.regions.blurHalo));
    await p.page.evaluate((id, o) => stress.filtersEnabled(id, o), ctxId, { enabled: true });
    filterChecks('re-enabled', await m3shot(p, ctxId, regions));
    m3CleanLogs(p, since, 'toggling: ');

    since = p.logs.length;
    const pool = { base: await poolProbe(p, worker) };
    for (let c = 1; c <= 2; c++) {
      const g = await withTimeout(p.page.evaluate((id, o) => stress.filtersGrow(id, o), ctxId, { frames: 240 }), 120000, 'filtersGrow');
      check(`grow cycle ${c}: no throws`, g.errs.length === 0 && g.loopThrows.length === 0, [...g.errs, ...g.loopThrows]);
      pool[`grown${c}`] = await poolProbe(p, worker);
      await new Promise(r => setTimeout(r, 3000));
      pool[`settled${c}`] = await poolProbe(p, worker);
    }
    note('target pool (bytes / entries)', pool);
    const b = k => (pool[k] && typeof pool[k] === 'object' ? pool[k].bytes : null);
    if (b('grown1') !== null && b('grown1') !== undefined) {
      check('target pool: shrinks after the big captures end (ages out)', b('settled1') <= b('grown1') && b('settled2') <= b('grown2'), { grown1: b('grown1'), settled1: b('settled1'), grown2: b('grown2'), settled2: b('settled2') });
      check('target pool: no accumulation across grow cycles', b('settled2') <= b('settled1') * 1.25 + (1 << 20), { settled1: b('settled1'), settled2: b('settled2') });
      check('target pool: settled size bounded (< 64 MB)', b('settled2') < 64 * 1048576, b('settled2'));
    } else {
      note('target pool probe unavailable', pool);
    }
    filterChecks('after pool growth', await m3shot(p, ctxId, regions));
    m3CleanLogs(p, since, 'pool growth: ');

    since = p.logs.length;
    const rs = await withTimeout(p.page.evaluate((id, o) => stress.filtersResizeStorm(id, o), ctxId, { steps: 300 }), 120000, 'filtersResizeStorm');
    check('resize storm: no render() throws', rs.loopThrows.length === 0, rs.loopThrows);
    check('resize storm: settled 640×480', rs.width === 640 && rs.height === 480, `${rs.width}×${rs.height}`);
    filterChecks('after resize storm', await m3shot(p, ctxId, regions));
    m3CleanLogs(p, since, 'resize storm: ');

    since = p.logs.length;
    for (const dpr of [2, 1.5, 1]) {
      await p.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: dpr, mobile: false });
      await new Promise(res => setTimeout(res, 400));
      await p.page.evaluate(id => stress.nudgeCanvas(id, 641, 480), ctxId);
      await p.page.evaluate(id => stress.nudgeCanvas(id, 640, 480), ctxId);
      await new Promise(res => setTimeout(res, 500));
      const s = await m3Info(p, ctxId);
      check(`dpr ${dpr}: resolution follows`, Math.abs(s.resolution - dpr) < 1e-3, s.resolution);
      filterChecks(`dpr ${dpr}`, await m3shot(p, ctxId, regions));
    }
    await p.cdp.send('Emulation.clearDeviceMetricsOverride');
    m3CleanLogs(p, since, 'dpr: ');

    const loss = await lossAndWait(p, ctxId, worker);
    check('device loss: restored once', loss.res === 'ok' && loss.restoredOk, loss);
    filterChecks('after device loss', await m3shot(p, ctxId, regions));
    pool.afterLoss = await poolProbe(p, worker);
    note('target pool after loss', pool.afterLoss);
    m3CleanLogs(p, 0, 'whole scenario: ');
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

async function runM3Text(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`M3 text: rapid updates (MSDF + canvas pages), font eviction, loss [${backend}/${mode}]`, async p => {
    const init = await p.page.evaluate(o => stress.textInit(o), { worker, backend });
    const { ctxId, regions } = init;
    check('probe metrics: glyphs = non-space characters', init.probe.msdfGlyphs === init.probe.expect, init.probe);
    let img = await m3shot(p, ctxId, regions);
    check('initial: MSDF and canvas probes drawn', img.regions.msdf.lit > 0.03 && img.regions.canvas.lit > 0.03, { msdf: fmt(img.regions.msdf), canvas: fmt(img.regions.canvas) });
    const lit0 = img.regions;
    let since = p.logs.length;
    const c = await withTimeout(p.page.evaluate((id, o) => stress.textChurn(id, o), ctxId, { seconds: M3_S }), 120000, 'textChurn');
    note('churn', { frames: c.loopFrames, cjkSent: c.cjkSent, canvasPages: c.pages, packetBytes: c.packetBytes });
    check('churn: no API throws', c.errs.length === 0, c.errs);
    check('churn: no render() throws', c.throws.length === 0 && c.loopThrows.length === 0, [...c.throws, ...c.loopThrows]);
    check('churn: final metrics consistent ("ok" → 2 glyphs)', c.metricsOk, c.metricsBad);
    check('churn: canvas atlas grew past one page for ~2000 CJK glyphs', c.pages.some(n => n > 1), c.pages);
    img = await m3shot(p, ctxId, regions);
    check('after churn: probes still drawn', img.regions.msdf.lit > lit0.msdf.lit * 0.8 && img.regions.canvas.lit > lit0.canvas.lit * 0.8, { msdf: fmt(img.regions.msdf), canvas: fmt(img.regions.canvas) });
    m3CleanLogs(p, since, 'churn: ');

    since = p.logs.length;
    const e1 = await p.page.evaluate((id, o) => stress.textEvict(id, o), ctxId, { step: 'trimReferenced' });
    img = await m3shot(p, ctxId, regions);
    check('trim(0) while referenced keeps the font', e1.has && !e1.error && img.regions.msdf.lit > lit0.msdf.lit * 0.8, { e1, msdf: fmt(img.regions.msdf) });
    const e2 = await p.page.evaluate((id, o) => stress.textEvict(id, o), ctxId, { step: 'unloadReferenced' });
    check('unload() while referenced throws INVALID_ARGUMENT', e2.unload === 'INVALID_ARGUMENT', e2.unload);
    const e3 = await p.page.evaluate((id, o) => stress.textEvict(id, o), ctxId, { step: 'releaseTrim' });
    await new Promise(r => setTimeout(r, 500));
    img = await m3shot(p, ctxId, regions);
    note('release + trim(0) with texts still on the font', { e3, msdf: fmt(img.regions.msdf), canvas: fmt(img.regions.canvas) });
    check('release + trim(0): font evicted', !e3.has && e3.stats.evictions > e1.stats.evictions, e3.stats);
    check('release + trim(0): frames keep flowing, no throws', !e3.error && e3.loopThrows.length === 0, e3.error ?? e3.loopThrows);
    check('release + trim(0): canvas text unaffected', img.regions.canvas.lit > lit0.canvas.lit * 0.8, fmt(img.regions.canvas));
    const e4 = await p.page.evaluate((id, o) => stress.textEvict(id, o), ctxId, { step: 'reload' });
    await new Promise(r => setTimeout(r, 400));
    img = await m3shot(p, ctxId, regions);
    check('reload + setStyle({ font }): MSDF probe drawn again', !e4.error && img.regions.msdf.lit > lit0.msdf.lit * 0.8, { e4: e4.error, msdf: fmt(img.regions.msdf), lit0: lit0.msdf.lit });
    m3CleanLogs(p, since, 'eviction: ');

    const loss = await lossAndWait(p, ctxId, worker);
    check('device loss: restored once', loss.res === 'ok' && loss.restoredOk, loss);
    await new Promise(r => setTimeout(r, 1000));
    img = await m3shot(p, ctxId, regions);
    check('after device loss: MSDF probe drawn', img.regions.msdf.lit > lit0.msdf.lit * 0.8, fmt(img.regions.msdf));
    check('after device loss: canvas probe drawn (pages re-uploaded)', img.regions.canvas.lit > lit0.canvas.lit * 0.8, fmt(img.regions.canvas));
    m3CleanLogs(p, 0, 'whole scenario: ');
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

async function runM3Particles(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`M3 particles: presets ×9 + ${M3_PARTICLES.toLocaleString('en')} burst system, churn, loss [${backend}/${mode}]`, async p => {
    const init = await withTimeout(p.page.evaluate(o => stress.particlesInit(o), { worker, backend, big: M3_PARTICLES }), 60000, 'particlesInit');
    if (init.unsupported) {
      note('particles unsupported on this backend', init);
      return;
    }
    const { ctxId } = init;
    note('capacities', { total: init.capacity, presets: init.presetCapacity });
    const since = p.logs.length;
    const b = await withTimeout(p.page.evaluate((id, o) => stress.particlesBursts(id, o), ctxId, { seconds: M3_S }), 180000, 'particlesBursts');
    note('bursts', { fill: b.fill, alive: b.alive, frames: b.loopFrames, packetP50: b.packetP50, packetMax: b.packetMax, cpuMs: b.cpuMs });
    check('bursts: no API throws', b.errs.length === 0, b.errs);
    check('bursts: no render() throws', b.throws.length === 0 && b.loopThrows.length === 0, [...b.throws, ...b.loopThrows]);
    const cap = b.caps.big;
    check(`1M system filled by 4 bursts (alive ≥ 90% of ${cap.toLocaleString('en')})`, typeof b.fill[0] === 'number' && b.fill[0] >= cap * 0.9, b.fill);
    const over = Object.entries(b.alive).filter(([k, v]) => typeof v !== 'number' || v > b.caps[k]);
    check('alive counts are numbers within capacity', over.length === 0, { alive: b.alive, caps: b.caps });
    const dead = ['fire', 'smoke', 'sparks', 'rain'].filter(k => !(b.alive[k] > 0));
    check('continuous emitters alive after churn (fire, smoke, sparks, rain)', dead.length === 0, b.alive);
    check('packet stays small (max < 4 KB)', (b.packetMax ?? 0) < 4096, { p50: b.packetP50, max: b.packetMax });
    m3CleanLogs(p, since, 'bursts: ');
    const loss = await lossAndWait(p, ctxId, worker);
    check('device loss: restored once', loss.res === 'ok' && loss.restoredOk, loss);
    await new Promise(r => setTimeout(r, 1000));
    const a = await withTimeout(p.page.evaluate(id => stress.particlesAlive(id), ctxId), 60000, 'particlesAlive');
    note('alive after loss', a.alive);
    const dead2 = ['fire', 'smoke', 'sparks', 'rain'].filter(k => !(a.alive[k] > 0));
    check('after loss: continuous emitters emit again', dead2.length === 0, a.alive);
    const refill = await withTimeout(p.page.evaluate(id => stress.particlesRefill(id), ctxId), 60000, 'particlesRefill');
    check('after loss: 1M system can be refilled', typeof refill === 'number' && refill >= cap * 0.9, refill);
    check('after loss: no render() throws', a.loopThrows.length === 0, a.loopThrows);
    m3CleanLogs(p, 0, 'whole scenario: ');
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

async function runM3Loss(mode, backend) {
  const worker = mode === 'worker';
  await scenario(`M3 device loss ×3 with masks + filters + text + particles [${backend}/${mode}]`, async p => {
    const { ctxId, regions, particles } = await p.page.evaluate(o => stress.comboInit(o), { worker, backend });
    const verify = async label => {
      await new Promise(r => setTimeout(r, 800));
      const img = await m3shot(p, ctxId, regions);
      const R = img.regions;
      const st = await withTimeout(p.page.evaluate(id => stress.comboState(id), ctxId), 30000, 'comboState');
      check(`${label}: scissor mask (single level)`, R.maskIn.blue > 0.9 && R.maskTop.lit < 0.02, { in: fmt(R.maskIn), top: fmt(R.maskTop) });
      check(`${label}: ${st.modes[1]} mask (single level)`, R.maskStencilIn.blue > 0.9 && R.maskStencilTop.lit < 0.02, { in: fmt(R.maskStencilIn), top: fmt(R.maskStencilTop) });
      check(`${label}: cheap filter gray, control red`, R.gray.gray > 0.9 && R.ctrl.red > 0.95, { gray: fmt(R.gray), ctrl: fmt(R.ctrl) });
      check(`${label}: blur filter`, R.blurHalo.mean && R.blurHalo.mean[0] > 6, fmt(R.blurHalo));
      check(`${label}: MSDF + canvas text`, R.msdf.lit > 0.03 && R.canvasText.lit > 0.03, { msdf: fmt(R.msdf), canvas: fmt(R.canvasText) });
      if (particles) check(`${label}: particles alive and drawn`, st.alive > 0 && R.particles.lit > 0.005, { alive: st.alive, px: fmt(R.particles) });
      check(`${label}: no render() throws`, st.loopThrows.length === 0, st.loopThrows);
    };
    await verify('before loss');
    for (const [k, kind] of [[1, 'single'], [2, 'double'], [3, 'single']]) {
      const loss = await lossAndWait(p, ctxId, worker, kind);
      check(`loss #${k} (${kind}): onDeviceLost → onDeviceRestored, paired`, loss.res === 'ok' && loss.restoredOk, { res: loss.res, lost: loss.after.lost, restored: loss.after.restored });
      await verify(`after loss #${k}`);
    }
    m3CleanLogs(p, 0, 'whole scenario: ');
    await p.page.evaluate(id => stress.dropCtx(id), ctxId);
  });
}

async function main() {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'cozygpu-stress-'));
  console.log(`bundling → ${outDir}`);
  await bundle(outDir);
  server = await serve(outDir);
  console.log(`serving http://127.0.0.1:${PORT}/ (COOP/COEP)`);
  await launchBrowser();

  const plan = [
    ['swarm', runSwarm],
    ['burst', runBurst],
    ['sprites', runSprites],
    ['resize', runResize],
    ['dpr', runDpr],
    ['loss', runLoss],
    ['recreate', runRecreate],
    ['regress', runRegress],
    ['assets', runAssets],
    ['pick', runPick],
    ['gpualloc', runGpuAlloc],
    // Worker-only scenarios (the command ring and its heap behaviour).
    ['ring', (mode, backend) => (mode === 'worker' ? runRing(backend) : undefined)],
    ['soak', (mode, backend) => (mode === 'worker' ? runSoak(backend) : undefined)],
    // M2.5 integration hooks.
    ['columns', runColumns],
    ['pickuid', runPickUid],
    ['events', runEvents],
    // 'auto' with WebGPU hidden: once per mode (in the last backend's pass).
    ['fallback', (mode, backend) => (backend === BACKENDS[BACKENDS.length - 1] ? runFallback(mode) : undefined)],
    ['pickalloc', runPickAlloc],
    ['external', runExternal],
    // M3: masks, filters, text, particles.
    ['m3masks', runM3Masks],
    ['m3filters', runM3Filters],
    ['m3text', runM3Text],
    ['m3particles', runM3Particles],
    ['m3loss', runM3Loss],
  ];
  if (argv['crash-test']) {
    const kind = String(argv['crash-test']);
    await scenario(`harness self-test: ${kind} crash`, async p => {
      if (kind === 'renderer') await p.page.goto('chrome://crash').catch(() => {});
      else browser.process()?.kill('SIGKILL');
      await new Promise(res => setTimeout(res, 30000)); // the crash watchdog must cut this short
      check('crash was noticed', false, 'still running after 30 s');
    });
  }
  for (const backend of BACKENDS) {
    for (const mode of MODES) {
      for (const [key, fn] of plan) {
        if (ONLY.includes(key)) await fn(mode, backend);
      }
    }
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error('harness failure:', e);
  exitCode = 2;
} finally {
  await cleanup();
}
const failed = results.filter(r => !r.ok);
report.finishedAt = new Date().toISOString();
report.passed = results.length - failed.length;
report.failed = failed.length;
report.chromeLaunches = launches;
if (argv.out) await writeFile(String(argv.out), JSON.stringify(report, null, 2));
console.log(`\n══ ${results.length - failed.length} passed, ${failed.length} failed (Chrome launched ${launches}×) ══`);
for (const f of failed) console.log(`FAIL  ${f.scenario} :: ${f.check}${f.detail !== undefined ? ` — ${JSON.stringify(f.detail).slice(0, 300)}` : ''}`);
process.exit(exitCode || (failed.length ? 1 : 0));
