#!/usr/bin/env node
/**
 * cozygpu benchmark runner: esbuild bundles → static server (port 4100,
 * COOP/COEP) → system Chrome via puppeteer-core, one fresh browser per case.
 *
 *   node benchmarks/run.mjs [options]
 *
 * Options
 *   --label <name>        results/<name>.json (default: ISO timestamp)
 *   --filter <regex>      only cases whose id matches, e.g. "pixi|three"
 *   --scenarios <list>    s1,s1b,s2,s3,a1,a2,a3 (default all; S4 is derived from S3;
 *                         a1 = a1png + a1ktx2)
 *   --counts <list>       override object counts, e.g. 1000,50000 (debugging)
 *   --duration <sec>      measured seconds per case (default 5)
 *   --warmup <sec>        warmup seconds per case (default 2)
 *   --quick               duration 2, warmup 1
 *   --headful             visible window instead of headless=new
 *   --vsync               keep Chrome's frame-rate limit / vsync (fps capped)
 *   --no-build            reuse benchmarks/dist
 *   --no-sizes            skip bundle-size measurement
 *   --screenshots         save results/shots/<label>/<case>.png after measuring
 *   --timeout <sec>       extra per-case budget on top of warmup+duration (default 120)
 *   --list                print the case matrix and exit
 *   --merge <label>       add/replace these cases in results/<label>.json instead of writing a new file
 *   --report <label>      only regenerate results/latest.md from results/<label>.json
 *   --chrome <path>       Chrome binary (default: system Google Chrome)
 *   --repeat <n>          run the matrix n times (interleaved rounds); report per-metric medians
 *   --compare <label>     baseline for the "since M1" table (default m1-final)
 *
 * Output: benchmarks/results/<label>.json and benchmarks/results/latest.md
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { BENCH_DIR, ROOT, buildBench, measureBundleSizes } from './build.mjs';
import { PORT, startServer } from './serve.mjs';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const quick = flag('quick');
const cfg = {
  label: opt('label', new Date().toISOString().replace(/[:.]/g, '-')),
  filter: opt('filter', null),
  scenarios: opt('scenarios', 's1,s1b,s2,s3,a1,a2,a3')
    .split(',')
    .flatMap(k =>
      k === 'a1' ? ['a1png', 'a1ktx2'] : k === 'a2' ? ['a2', 'a2u'] : [k],
    ),
  compare: opt('compare', 'm1-final'),
  counts: opt('counts', null)?.split(',').map(Number) ?? null,
  duration: Number(opt('duration', quick ? 2 : 5)),
  warmup: Number(opt('warmup', quick ? 1 : 2)),
  headful: flag('headful'),
  vsync: flag('vsync'),
  build: !flag('no-build'),
  sizes: !flag('no-sizes'),
  timeout: Number(opt('timeout', 120)),
  screenshots: flag('screenshots'),
  chrome: opt(
    'chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ),
  repeat: Math.max(1, Number(opt('repeat', 1)) | 0),
  width: 1280,
  height: 720,
};

/**
 * Chrome flags (documented in benchmarks/README.md):
 *  --enable-unsafe-webgpu        WebGPU without origin trial / blocklist checks
 *  --use-angle=metal             macOS: required for WebGPU + WebGL on Metal in headless
 *  --ignore-gpu-blocklist        never fall back to SwiftShader because of a blocklist
 *  --disable-gpu-vsync           don't block presents on the display refresh
 *  --disable-frame-rate-limit    uncap requestAnimationFrame (no 60 fps ceiling)
 *  --enable-precise-memory-info  unquantized performance.memory
 *  --js-flags=--expose-gc        window.gc() for heap measurements
 *  --disable-background-timer-throttling / --disable-renderer-backgrounding /
 *  --disable-backgrounding-occluded-windows   keep rAF running at full speed
 */
const BASE_FLAGS = [
  '--enable-unsafe-webgpu',
  '--use-angle=metal',
  '--ignore-gpu-blocklist',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-first-run',
  '--no-default-browser-check',
  `--window-size=${cfg.width},${cfg.height}`,
];
const UNCAP_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];
const CHROME_FLAGS = [...BASE_FLAGS, ...(cfg.vsync ? [] : UNCAP_FLAGS)];
/** Scenarios with `vsync: true` (A2) keep Chrome's frame-rate limit. */
const flagsFor = c => (c.vsync ? BASE_FLAGS : CHROME_FLAGS);

// ─── Case matrix ──────────────────────────────────────────────────────────────
const E = (lib, renderer, variant) => ({ lib, renderer, variant });
const SPRITE_ENGINES = [
  E('cozygpu', 'webgpu', 'auto'),
  E('cozygpu', 'webgl2', 'auto'),
  E('cozygpu', 'worker', 'auto'),
  E('pixi', 'webgpu', 'sprite'),
  E('pixi', 'webgpu', 'particle'),
  E('pixi', 'webgl', 'sprite'),
  E('pixi', 'webgl', 'particle'),
  E('three', 'webgl', 'instanced'),
  E('three', 'webgpu', 'instanced'),
];
const SWARM_ENGINES = [
  E('cozygpu', 'webgpu', 'auto'),
  E('cozygpu', 'webgl2', 'auto'),
  E('cozygpu', 'worker', 'auto'),
  E('pixi', 'webgpu', 'particle'),
  E('pixi', 'webgl', 'particle'),
  E('three', 'webgl', 'instanced'),
  E('three', 'webgpu', 'instanced'),
  E('three', 'webgpu', 'compute'),
];
const SCENARIOS = {
  s1: {
    id: 'sprites-moving',
    title: 'S1 — moving sprites (CPU-updated, bouncing)',
    counts: [10_000, 100_000, 1_000_000],
    engines: SPRITE_ENGINES,
  },
  s1b: {
    id: 'sprites-moving',
    idSuffix: '-columns',
    title:
      'S1b — moving sprites via bindColumns (M2.5: sim x/y bound once, one commit per frame)',
    counts: [100_000, 1_000_000],
    engines: [
      E('cozygpu', 'webgpu', 'columns'),
      E('cozygpu', 'webgl2', 'columns'),
      E('cozygpu', 'worker', 'columns'),
    ],
  },
  s2: {
    id: 'swarm',
    title: 'S2 — swarm (GPU-simulated where supported, else best CPU path)',
    counts: [1_000_000, 2_000_000],
    engines: SWARM_ENGINES,
  },
  s3: {
    id: 'sprites-static',
    title: 'S3 — static sprites (nothing moves)',
    counts: [100_000],
    engines: SPRITE_ENGINES,
  },
  a1png: {
    id: 'assets-png',
    title: 'A1 — load + upload 200 × 64² PNG',
    counts: [200],
    kind: 'assets',
    // The frame loop only draws 200 sprites; keep it short.
    warmup: 1,
    duration: 2,
    engines: [
      E('cozygpu', 'webgpu', 'auto'),
      E('cozygpu', 'webgpu', 'noatlas'),
      E('cozygpu', 'webgl2', 'auto'),
      E('pixi', 'webgpu', 'sprite'),
      E('pixi', 'webgl', 'sprite'),
    ],
  },
  a1ktx2: {
    id: 'assets-ktx2',
    title: 'A1 — load + upload 200 × 64² KTX2 (BC1, no supercompression)',
    counts: [200],
    kind: 'assets',
    warmup: 1,
    duration: 2,
    engines: [
      E('cozygpu', 'webgpu', 'auto'),
      E('cozygpu', 'webgl2', 'auto'),
      E('pixi', 'webgpu', 'sprite'),
      E('pixi', 'webgl', 'sprite'),
    ],
  },
  a2: {
    id: 'picking',
    title:
      'A2 — picking latency at 100k static sprites (one pick in flight, vsync ON = 60 fps like a real page)',
    counts: [100_000],
    kind: 'picking',
    vsync: true,
    engines: [
      E('cozygpu', 'webgpu', 'auto'),
      E('cozygpu', 'webgl2', 'auto'),
      E('cozygpu', 'worker', 'auto'),
      E('pixi', 'webgpu', 'sprite'),
      E('three', 'webgl', 'instanced'),
    ],
  },
  a2u: {
    id: 'picking',
    idSuffix: '-uncapped',
    title:
      'A2u — picking at 100k, frame-rate limit OFF (stress: async readbacks compete with an uncapped rAF loop)',
    counts: [100_000],
    kind: 'picking',
    engines: [
      E('cozygpu', 'webgpu', 'auto'),
      E('cozygpu', 'webgl2', 'auto'),
      E('cozygpu', 'worker', 'auto'),
      E('pixi', 'webgpu', 'sprite'),
      E('three', 'webgl', 'instanced'),
    ],
  },
  a3: {
    id: 'swarm-churn',
    title:
      'A3 — swarm spawn/kill churn (capacity 1M, 8000 spawns/frame, life 0.5–1.5 s ⇒ ~480k alive)',
    counts: [1_000_000],
    kind: 'churn',
    engines: [
      E('cozygpu', 'webgpu', 'gpu'),
      E('cozygpu', 'webgpu', 'ring'),
      E('cozygpu', 'webgl2', 'ring'),
      E('pixi', 'webgpu', 'particle'),
    ],
  },
};
const SCENARIO_BY_ID = Object.fromEntries(
  Object.values(SCENARIOS).map(s => [s.id, s]),
);
/** Scenario key of a result: runCase stores it; older results fall back to the id. */
const scenarioKeyOf = r =>
  r.scenarioKey ??
  Object.keys(SCENARIOS).find(k => SCENARIOS[k].id === r.params?.scenario);

function engineId(e) {
  return `${e.lib}-${e.renderer}-${e.variant}`;
}

function buildCases() {
  const cases = [];
  for (const key of cfg.scenarios) {
    const s = SCENARIOS[key];
    if (!s) throw new Error(`unknown scenario ${key}`);
    for (const count of cfg.counts ?? s.counts) {
      for (const e of s.engines) {
        const id = `${s.id}${s.idSuffix ?? ''}/${count}/${engineId(e)}`;
        if (cfg.filter && !new RegExp(cfg.filter).test(id)) continue;
        cases.push({ id, key, scenario: s.id, count, vsync: !!s.vsync, ...e });
      }
    }
  }
  return cases;
}

function caseUrl(c) {
  const s = SCENARIOS[c.key];
  const q = new URLSearchParams({
    lib: c.lib,
    renderer: c.renderer,
    variant: c.variant,
    scenario: c.scenario,
    count: String(c.count),
    warmup: String(Math.min(cfg.warmup, s?.warmup ?? Infinity)),
    duration: String(Math.min(cfg.duration, s?.duration ?? Infinity)),
    width: String(cfg.width),
    height: String(cfg.height),
  });
  return `http://127.0.0.1:${PORT}/index.html?${q}`;
}

// ─── Execution ────────────────────────────────────────────────────────────────
const gzCache = new Map();
function gzipSizeOf(urlPath) {
  if (!gzCache.has(urlPath)) {
    try {
      const buf = readFileSync(path.join(BENCH_DIR, urlPath));
      gzCache.set(urlPath, {
        min: buf.length,
        gzip: gzipSync(buf, { level: 9 }).length,
      });
    } catch {
      gzCache.set(urlPath, { min: 0, gzip: 0 });
    }
  }
  return gzCache.get(urlPath);
}

let activeBrowser = null;

/** A page that stops answering CDP evaluates for this long is reported as `hung`. */
const HUNG_MS = 30_000;
const POLL_MS = 500;

const delay = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    delay(ms).then(() => Promise.reject(new Error('evaluate timed out'))),
  ]);

/**
 * Polls `window.__benchResult` (and `__benchPhase` for diagnostics) until the
 * harness reports, the case budget runs out, or the renderer process stops
 * responding for HUNG_MS (e.g. a main thread blocked in a GPU call). A hung
 * page fails fast instead of eating the whole per-case budget.
 */
async function waitForResult(page, budgetMs, onPhase) {
  const deadline = Date.now() + budgetMs;
  let lastAnswer = Date.now();
  while (Date.now() < deadline) {
    try {
      const s = await withTimeout(
        page.evaluate(() => ({
          result: window.__benchResult,
          phase: window.__benchPhase,
        })),
        5_000,
      );
      lastAnswer = Date.now();
      if (s.phase) onPhase(s.phase);
      if (s.result !== undefined) return s.result;
    } catch (err) {
      if (Date.now() - lastAnswer > HUNG_MS) {
        const e = new Error(
          `page unresponsive for ${HUNG_MS / 1000}s (${err.message})`,
        );
        e.hung = true;
        throw e;
      }
    }
    await delay(POLL_MS);
  }
  throw new Error(`no result within ${Math.round(budgetMs / 1000)}s`);
}

async function runCase(c) {
  const started = Date.now();
  const browser = await puppeteer.launch({
    executablePath: cfg.chrome,
    headless: !cfg.headful,
    args: flagsFor(c),
    defaultViewport: {
      width: cfg.width,
      height: cfg.height,
      deviceScaleFactor: 1,
    },
    protocolTimeout: (cfg.timeout + cfg.warmup + cfg.duration * 4 + 60) * 1000,
  });
  activeBrowser = browser;
  const logs = [];
  const scripts = new Set();
  try {
    const page = await browser.newPage();
    page.on('console', m => {
      if (logs.length < 50) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on(
      'pageerror',
      err => logs.length < 50 && logs.push(`pageerror: ${err.message}`),
    );
    page.on('response', r => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('.js')) scripts.add(u.pathname);
    });
    let crashed = null;
    page.on('error', err => {
      crashed = err;
    });
    await page.goto(caseUrl(c), { waitUntil: 'load', timeout: 30_000 });
    const budgetMs = (cfg.timeout + cfg.warmup + cfg.duration * 4) * 1000; // harness may extend measuring up to 4× duration
    let result;
    let lastPhase = 'loading';
    try {
      result = await waitForResult(page, budgetMs, p => {
        lastPhase = p;
      });
      if (cfg.screenshots) {
        const dir = path.join(BENCH_DIR, 'results', 'shots', cfg.label);
        await mkdir(dir, { recursive: true });
        await page
          .screenshot({
            path: path.join(dir, `${c.id.replace(/\//g, '_')}.png`),
          })
          .catch(() => {});
      }
      // Teardown is timed separately so a slow destroy() can't hide the result.
      result.destroyMs = await withTimeout(
        page.evaluate(() =>
          window.__benchDestroy ? window.__benchDestroy() : null,
        ),
        10_000,
      ).catch(err => `failed: ${err.message}`);
    } catch (err) {
      const status = crashed ? 'crashed' : err.hung ? 'hung' : 'timeout';
      result = {
        status,
        error: `${crashed ? crashed.message : err.message} (last phase: ${lastPhase})`,
      };
    }
    let min = 0;
    let gzip = 0;
    for (const s of scripts) {
      const size = gzipSizeOf(s);
      min += size.min;
      gzip += size.gzip;
    }
    return {
      id: c.id,
      scenarioKey: c.key,
      vsync: c.vsync || cfg.vsync,
      ...result,
      params: result.params ?? {
        lib: c.lib,
        renderer: c.renderer,
        variant: c.variant,
        scenario: c.scenario,
        count: c.count,
      },
      loadedJs: { files: scripts.size, min, gzip },
      logs,
      wallMs: Date.now() - started,
    };
  } finally {
    activeBrowser = null;
    await browser.close().catch(() => {});
  }
}

// ─── Repetitions ──────────────────────────────────────────────────────────────
const median = xs => {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
/** Metric groups whose numeric leaves are replaced by the median over ok runs. */
const MEDIAN_GROUPS = ['frame', 'cpu', 'swapWait', 'init', 'heap', 'info'];

/**
 * Folds n runs of one case into a single result: status is `ok` if at least
 * one run was ok; every numeric metric is the median over the ok runs (each
 * metric independently). All runs are kept in `runs` (without logs) so the
 * spread stays inspectable.
 */
function aggregateRuns(runs) {
  if (runs.length === 1) return runs[0];
  const ok = runs.filter(r => r.status === 'ok');
  const base = ok[0] ?? runs[runs.length - 1];
  const out = { ...base };
  if (ok.length) {
    for (const g of MEDIAN_GROUPS) {
      if (!base[g]) continue;
      out[g] = { ...base[g] };
      for (const [k, v] of Object.entries(base[g])) {
        if (typeof v === 'number') out[g][k] = median(ok.map(r => r[g]?.[k]));
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
          // one nested level (e.g. info.pick)
          out[g][k] = { ...v };
          for (const [k2, v2] of Object.entries(v)) {
            if (typeof v2 === 'number')
              out[g][k][k2] = median(ok.map(r => r[g]?.[k]?.[k2]));
          }
        }
      }
    }
    if (typeof base.destroyMs === 'number')
      out.destroyMs = median(ok.map(r => r.destroyMs));
    out.wallMs = median(ok.map(r => r.wallMs));
  }
  const range = (g, k) => {
    const v = ok.map(r => r[g]?.[k]).filter(Number.isFinite);
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  };
  out.reps = {
    n: runs.length,
    ok: ok.length,
    statuses: runs.map(r => r.status),
    range: {
      avgMs: range('frame', 'avgMs'),
      p99Ms: range('frame', 'p99Ms'),
      cpuAvgMs: range('cpu', 'avgMs'),
    },
  };
  out.runs = runs.map(({ logs, ...r }) => r);
  return out;
}

// ─── Reporting ────────────────────────────────────────────────────────────────
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—');
const kb = v =>
  Number.isFinite(v) && v > 0 ? `${(v / 1024).toFixed(1)} KB` : '—';
const cnt = n =>
  n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);

function engineLabel(r) {
  const p = r.params;
  return `${p.lib} · ${p.renderer}`;
}

function destroyCell(r) {
  if (typeof r.destroyMs === 'number') return f1(r.destroyMs);
  return r.destroyMs ? '> 10 s' : '—';
}

function statusCell(r) {
  if (r.status === 'ok') {
    const notes = [];
    if (r.reps && r.reps.ok < r.reps.n)
      notes.push(`${r.reps.ok}/${r.reps.n} runs ok`);
    if (r.info?.skippedFrames) {
      // measuredSkippedFrames: inside the measured window only (A3, §19.5).
      const m = r.info.measuredSkippedFrames;
      notes.push(
        typeof m === 'number'
          ? `${r.info.skippedFrames} skipped, ${m} while measuring`
          : `${r.info.skippedFrames} skipped`,
      );
    }
    return notes.length ? `ok (${notes.join(', ')})` : 'ok';
  }
  const msg = String(r.error ?? '')
    .split('\n')[0]
    .slice(0, 90)
    .replace(/\|/g, '\\|');
  return `**${r.status}**${msg ? `: ${msg}` : ''}`;
}

function markdown(report) {
  const { meta, results, bundles } = report;
  const out = [];
  out.push(`# Benchmark results — ${meta.label}`, '');
  out.push(`- Date: ${meta.date}`);
  out.push(
    `- Machine: ${meta.machine.cpu} · ${meta.machine.memGB} GB · ${meta.machine.platform}`,
  );
  out.push(`- GPU: ${meta.gpu ?? 'unknown'}`);
  out.push(
    `- Chrome: ${meta.chrome} (${meta.headful ? 'headful' : 'headless=new'}, ${meta.vsync ? 'vsync ON' : 'vsync/frame-rate limit OFF'})`,
  );
  out.push(
    `- Libraries: ${Object.entries(meta.versions)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`,
  );
  out.push(
    `- Canvas ${meta.width}×${meta.height} @1x · warmup ${meta.warmupSec}s · measure ${meta.durationSec}s · one fresh browser per case`,
  );
  if ((meta.repeat ?? 1) > 1)
    out.push(
      `- ${meta.repeat} repetitions per case (interleaved rounds); every number is the per-metric **median** over ok runs; "avg range" = min–max of avg frame ms across runs`,
    );
  out.push(
    '- Frame = interval between rAF callbacks (includes GPU backpressure). CPU = time inside the frame callback (sim step + library update + render call).',
  );
  out.push('');

  for (const key of meta.scenarios) {
    const s = SCENARIOS[key];
    const rows = results.filter(r => scenarioKeyOf(r) === key);
    if (!rows.length) continue;
    out.push(`## ${s.title}`, '');
    out.push(
      '| count | engine | tool | fps | avg ms | p99 ms | CPU avg ms | CPU p99 ms | swap wait ms | heap growth B/frame | avg range | status |',
    );
    out.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|');
    for (const r of rows) {
      const rg = r.reps?.range?.avgMs;
      out.push(
        `| ${cnt(r.params.count)} | ${engineLabel(r)} | ${r.tool ?? r.params.variant} | ${f1(r.frame?.fps)} | ${f2(r.frame?.avgMs)} | ${f2(r.frame?.p99Ms)} | ${f2(r.cpu?.avgMs)} | ${f2(r.cpu?.p99Ms)} | ${f2(r.swapWait?.avgMs)} | ${f1(r.heap?.growthPerFrameBytes)} | ${rg ? `${f2(rg[0])}–${f2(rg[1])}` : '—'} | ${statusCell(r)} |`,
      );
    }
    out.push('');
    if (s.kind === 'assets') out.push(...assetsTable(rows), '');
    if (s.kind === 'picking') out.push(...pickingTable(rows), '');
    if (s.kind === 'churn') out.push(...churnTable(rows), '');
  }

  const init = results.filter(
    r => r.params?.scenario === 'sprites-static' && r.init,
  );
  if (init.length) {
    out.push(
      '## S4 — init time and JS heap per object (from S3, 100k static sprites)',
      '',
    );
    out.push(
      '| engine | tool | renderer init ms | populate ms | first frame ms | total ms | heap / object | heap after populate | destroy ms |',
    );
    out.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of init) {
      out.push(
        `| ${engineLabel(r)} | ${r.tool} | ${f1(r.init.rendererMs)} | ${f1(r.init.populateMs)} | ${f1(r.init.firstFrameMs)} | ${f1(r.init.totalMs)} | ${f1(r.heap?.perObjectBytes)} B | ${kb(r.heap?.afterPopulateBytes)} | ${destroyCell(r)} |`,
      );
    }
    out.push('');
    const bigInit = results.filter(r => r.params?.count >= 1_000_000 && r.init);
    if (bigInit.length) {
      out.push('### Init at 1M+ objects (S1/S2)', '');
      out.push(
        '| scenario | count | engine | tool | total init ms | heap / object | destroy ms |',
      );
      out.push('|---|---:|---|---|---:|---:|---:|');
      for (const r of bigInit) {
        out.push(
          `| ${r.params.scenario} | ${cnt(r.params.count)} | ${engineLabel(r)} | ${r.tool} | ${f1(r.init.totalMs)} | ${f1(r.heap?.perObjectBytes)} B | ${destroyCell(r)} |`,
        );
      }
      out.push('');
    }
  }

  if (bundles?.length) {
    out.push('## Bundle size (esbuild, minified, gzip -9)', '');
    out.push(
      '| library | minimal program | chunks | entry min | entry min+gzip | all chunks min | all chunks min+gzip |',
    );
    out.push('|---|---|---:|---:|---:|---:|---:|');
    for (const b of bundles) {
      out.push(
        `| ${b.library} | ${b.program} | ${b.chunks} | ${kb(b.entryMin)} | ${kb(b.entryGzip)} | ${kb(b.totalMin)} | ${kb(b.totalGzip)} |`,
      );
    }
    out.push('');
  }

  const loaded = new Map();
  for (const r of results) {
    // Same bundle for every variant/scenario of one lib + renderer.
    const key = `${r.params?.lib} · ${r.params?.renderer}`;
    if (r.loadedJs?.gzip && !loaded.has(key)) loaded.set(key, r.loadedJs);
  }
  if (loaded.size) {
    out.push(
      '### JS actually loaded by the bench page (min+gzip, includes ~2 KB harness)',
      '',
    );
    out.push('| engine | files | min | min+gzip |');
    out.push('|---|---:|---:|---:|');
    for (const [k, v] of loaded)
      out.push(`| ${k} | ${v.files} | ${kb(v.min)} | ${kb(v.gzip)} |`);
    out.push('');
  }
  if (report.analysis) out.push(...analysisMarkdown(report.analysis));
  return out.join('\n');
}

// ─── M2 tables ────────────────────────────────────────────────────────────────
const mib = v => (Number.isFinite(v) ? `${(v / 2 ** 20).toFixed(2)} MiB` : '—');

/** A1: load (fetch + decode) → first frame (upload), GPU memory, heap. */
function assetsTable(rows) {
  const out = [
    '| engine | tool | load ms (loadAll) | populate ms | first frame (upload) ms | load+upload ms | GPU bytes | atlas pages | formats | JS heap after load | draw calls | status |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|',
  ];
  for (const r of rows) {
    const i = r.info ?? {};
    out.push(
      `| ${engineLabel(r)} | ${r.tool ?? r.params.variant} | ${f1(i.loadMs)} | ${f1(r.init?.populateMs)} | ${f1(r.init?.firstFrameMs)} | ${f1(loadUpload(r))} | ${mib(i.gpuBytes)}${i.gpuBytesEstimated ? ' (est.)' : ''} | ${i.atlasPages ?? '—'} | ${i.formats ?? '—'} | ${kb(r.heap?.afterPopulateBytes - r.heap?.afterInitBytes)} | ${i.drawCalls ?? '—'} | ${statusCell(r)} |`,
    );
  }
  out.push(
    '',
    'GPU bytes: cozygpu = `assets.stats.gpuBytes` (a packed atlas page counts in full); Pixi = estimate from each TextureSource (format × size × mips), since Pixi does not report GPU memory. "JS heap after load" = heap after populate − heap after renderer init (forced GC).',
  );
  return out;
}

function loadUpload(r) {
  return (r.init?.populateMs ?? NaN) + (r.init?.firstFrameMs ?? NaN);
}

/** A2: pick latency. */
function pickingTable(rows) {
  const out = [
    '| engine | tool | picks | hit rate | latency avg ms | p50 | p99 | max | frames avg | frames p99 | frame avg ms (with picks) | status |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const r of rows) {
    const p = r.info?.pick ?? {};
    out.push(
      `| ${engineLabel(r)} | ${r.tool ?? r.params.variant} | ${p.picks ?? '—'} | ${Number.isFinite(p.hitRate) ? `${(p.hitRate * 100).toFixed(0)}%` : '—'} | ${f2(p.latencyAvgMs)} | ${f2(p.latencyP50Ms)} | ${f2(p.latencyP99Ms)} | ${f2(p.latencyMaxMs)} | ${f2(p.framesAvg)} | ${f1(p.framesP99)} | ${f2(r.frame?.avgMs)} | ${statusCell(r)} |`,
    );
  }
  out.push(
    '',
    'Latency = pick call → result in hand. cozygpu is asynchronous (GPU pick pass + readback, resolves 1–2 frames later, so it scales with frame time); Pixi / Three are synchronous CPU hit tests inside the frame (frames = 0, the cost lands in frame time).',
  );
  return out;
}

/** A3: churn extras. */
function churnTable(rows) {
  const out = [
    '| engine | tool | alive at end | spawns/frame | draw calls | front CPU ms | packet B | status |',
    '|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const r of rows) {
    const i = r.info ?? {};
    out.push(
      `| ${engineLabel(r)} | ${r.tool ?? r.params.variant} | ${Number.isFinite(i.aliveAtEnd) ? Math.round(i.aliveAtEnd) : '—'} | ${i.spawnPerFrame ?? '—'} | ${i.drawCalls ?? '—'} | ${f2(i.frontCpuMs)} | ${i.packetBytes ?? '—'} | ${statusCell(r)} |`,
    );
  }
  return out;
}

// ─── Analysis: winners, cozygpu vs best competitor, regressions since M1 ─────
const pct = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && b ? ((a - b) / b) * 100 : NaN;

function metricFor(kind) {
  if (kind === 'assets')
    return { name: 'load+upload ms', get: loadUpload, p99: () => NaN };
  if (kind === 'picking')
    return {
      name: 'pick latency ms',
      get: r => r.info?.pick?.latencyAvgMs,
      p99: r => r.info?.pick?.latencyP99Ms,
    };
  return {
    name: 'frame ms',
    get: r => r.frame?.avgMs,
    p99: r => r.frame?.p99Ms,
  };
}

function analyse(results, baseline) {
  const winners = [];
  const groups = new Map();
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const sk = scenarioKeyOf(r);
    const key = `${SCENARIOS[sk]?.id ?? r.params.scenario}${SCENARIOS[sk]?.idSuffix ?? ''}/${r.params.count}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, rows] of groups) {
    const s = SCENARIOS[scenarioKeyOf(rows[0])];
    const m = metricFor(s?.kind);
    const valid = rows.filter(r => Number.isFinite(m.get(r)));
    if (!valid.length) continue;
    const by = (a, b) => m.get(a) - m.get(b);
    const best = [...valid].sort(by)[0];
    const coz = valid.filter(r => r.params.lib === 'cozygpu').sort(by);
    const comp = valid.filter(r => r.params.lib !== 'cozygpu').sort(by);
    const cozBest = coz[0];
    const compBest = comp[0];
    const byBackend = {};
    for (const b of ['webgpu', 'webgl2', 'worker']) {
      const x = coz.find(r => r.params.renderer === b);
      if (x)
        byBackend[b] = {
          id: x.id,
          avg: m.get(x),
          p99: m.p99(x),
          vsCompetitorPct: compBest ? pct(m.get(x), m.get(compBest)) : NaN,
        };
    }
    const extra = {};
    if (s?.kind === 'assets') {
      for (const r of valid)
        extra[r.id] = { gpuBytes: r.info?.gpuBytes, loadMs: r.info?.loadMs };
    }
    winners.push({
      key,
      metric: m.name,
      winner: best.id,
      winnerTool: best.tool,
      winnerAvg: m.get(best),
      cozygpu: cozBest
        ? { id: cozBest.id, avg: m.get(cozBest), p99: m.p99(cozBest) }
        : null,
      competitor: compBest
        ? {
            id: compBest.id,
            tool: compBest.tool,
            avg: m.get(compBest),
            p99: m.p99(compBest),
          }
        : null,
      avgVsCompetitorPct:
        cozBest && compBest ? pct(m.get(cozBest), m.get(compBest)) : NaN,
      p99VsCompetitorPct:
        cozBest && compBest ? pct(m.p99(cozBest), m.p99(compBest)) : NaN,
      byBackend,
      ...(Object.keys(extra).length ? { extra } : {}),
    });
  }

  const regressions = [];
  if (baseline) {
    const base = new Map(baseline.results.map(r => [r.id, r]));
    for (const r of results) {
      const b = base.get(r.id);
      if (!b || b.status !== 'ok') continue;
      const row = {
        id: r.id,
        status: r.status,
        m1: {
          avg: b.frame?.avgMs,
          p99: b.frame?.p99Ms,
          cpu: b.cpu?.avgMs,
          init: b.init?.totalMs,
          heapPerObj: b.heap?.perObjectBytes,
          range: b.reps?.range?.avgMs,
        },
        m2: {
          avg: r.frame?.avgMs,
          p99: r.frame?.p99Ms,
          cpu: r.cpu?.avgMs,
          init: r.init?.totalMs,
          heapPerObj: r.heap?.perObjectBytes,
          range: r.reps?.range?.avgMs,
        },
      };
      row.avgPct = pct(row.m2.avg, row.m1.avg);
      row.p99Pct = pct(row.m2.p99, row.m1.p99);
      row.cpuPct = pct(row.m2.cpu, row.m1.cpu);
      row.initPct = pct(row.m2.init, row.m1.init);
      // Regression: > 10 % slower AND outside the M1 run-to-run range.
      const outside = row.m1.range ? row.m2.avg > row.m1.range[1] : true;
      row.regressed =
        r.status !== 'ok' || (row.avgPct > 10 && outside) || row.cpuPct > 25;
      regressions.push(row);
    }
  }
  return {
    baseline: baseline?.meta?.label ?? null,
    winners,
    sinceBaseline: regressions,
  };
}

function analysisMarkdown(a) {
  const out = ['## Verdict per scenario (cozygpu best vs best competitor)', ''];
  out.push(
    '| scenario | metric | winner | cozygpu best | avg | p99 | best competitor | avg | p99 | Δavg | Δp99 | cozygpu-webgpu Δ | cozygpu-webgl2 Δ |',
    '|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|',
  );
  const sg = v =>
    Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(0)}%` : '—';
  for (const w of a.winners) {
    out.push(
      `| ${w.key} | ${w.metric} | ${w.winner.split('/')[2]} | ${w.cozygpu?.id.split('/')[2] ?? '—'} | ${f2(w.cozygpu?.avg)} | ${f2(w.cozygpu?.p99)} | ${w.competitor ? `${w.competitor.id.split('/')[2]} (${w.competitor.tool})` : '—'} | ${f2(w.competitor?.avg)} | ${f2(w.competitor?.p99)} | ${sg(w.avgVsCompetitorPct)} | ${sg(w.p99VsCompetitorPct)} | ${sg(w.byBackend.webgpu?.vsCompetitorPct)} | ${sg(w.byBackend.webgl2?.vsCompetitorPct)} |`,
    );
  }
  out.push(
    '',
    'Δ < 0: cozygpu faster (lower is better for every metric here).',
    '',
  );
  if (a.sinceBaseline?.length) {
    out.push(`## Since ${a.baseline} (same case ids)`, '');
    out.push(
      '| case | M1 avg ms | M2 avg ms | Δavg | M1 p99 | M2 p99 | Δp99 | M1 CPU | M2 CPU | ΔCPU | M1 init ms | M2 init ms | regressed? |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    );
    for (const r of a.sinceBaseline) {
      if (!r.id.includes('cozygpu')) continue;
      out.push(
        `| ${r.id} | ${f2(r.m1.avg)} | ${f2(r.m2.avg)} | ${sg(r.avgPct)} | ${f2(r.m1.p99)} | ${f2(r.m2.p99)} | ${sg(r.p99Pct)} | ${f2(r.m1.cpu)} | ${f2(r.m2.cpu)} | ${sg(r.cpuPct)} | ${f1(r.m1.init)} | ${f1(r.m2.init)} | ${r.regressed ? '**yes**' : 'no'} |`,
      );
    }
    out.push(
      '',
      'Regressed = not ok, or avg frame > 10 % slower and above the M1 max run, or CPU > 25 % higher. Competitor rows (Pixi/Three, unchanged code) are in the JSON as a drift control.',
      '',
    );
    const drift = a.sinceBaseline.filter(
      r => !r.id.includes('cozygpu') && Number.isFinite(r.avgPct),
    );
    if (drift.length) {
      const med = median(drift.map(r => r.avgPct));
      out.push(
        `Machine drift control: median Δavg of the ${drift.length} unchanged Pixi/Three cases = ${sg(med)}.`,
        '',
      );
    }
  }
  return out;
}

function chromeVersion() {
  try {
    return execFileSync(cfg.chrome, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function versions() {
  const out = {};
  for (const p of ['pixi.js', 'three', 'puppeteer-core', 'esbuild']) {
    try {
      out[p] = JSON.parse(
        await readFile(
          path.join(ROOT, 'node_modules', p, 'package.json'),
          'utf8',
        ),
      ).version;
    } catch {
      out[p] = 'missing';
    }
  }
  out.cozygpu = JSON.parse(
    await readFile(path.join(ROOT, 'package.json'), 'utf8'),
  ).version;
  return out;
}

async function loadBaseline() {
  if (!cfg.compare || cfg.compare === 'none') return null;
  try {
    return JSON.parse(
      await readFile(
        path.join(BENCH_DIR, 'results', `${cfg.compare}.json`),
        'utf8',
      ),
    );
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cases = buildCases();
  if (flag('list')) {
    for (const c of cases) console.log(c.id);
    console.log(`${cases.length} cases`);
    return;
  }
  const reportLabel = opt('report', null);
  if (reportLabel) {
    const dir = path.join(BENCH_DIR, 'results');
    const report = JSON.parse(
      await readFile(path.join(dir, `${reportLabel}.json`), 'utf8'),
    );
    // Never rewrites results/<label>.json or .md (those may carry hand-written notes).
    report.analysis = analyse(report.results, await loadBaseline());
    await writeFile(path.join(dir, 'latest.md'), markdown(report) + '\n');
    console.log(`wrote benchmarks/results/latest.md from ${reportLabel}.json`);
    return;
  }
  if (cfg.build) {
    console.log('building benchmark bundles…');
    await buildBench();
  }
  const bundles = cfg.sizes ? await measureBundleSizes() : [];
  const server = await startServer(PORT);
  const cleanup = async () => {
    if (activeBrowser) await activeBrowser.close().catch(() => {});
    server.close();
  };
  const onSignal = () => {
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const runsPerCase = cases.map(() => []);
  try {
    console.log(
      `${cases.length} cases × ${cfg.repeat} · warmup ${cfg.warmup}s · measure ${cfg.duration}s · ${cfg.headful ? 'headful' : 'headless'}`,
    );
    // Rounds are interleaved (whole matrix per round) so slow drift in machine
    // load/thermals spreads across all cases instead of biasing one library.
    for (let rep = 0; rep < cfg.repeat; rep++) {
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        process.stdout.write(
          `[r${rep + 1}/${cfg.repeat} ${i + 1}/${cases.length}] ${c.id} … `,
        );
        let r;
        try {
          r = await runCase(c);
        } catch (err) {
          r = {
            id: c.id,
            status: 'error',
            error: err.message,
            params: { ...c },
          };
        }
        runsPerCase[i].push(r);
        const perf = r.frame
          ? `${r.frame.fps.toFixed(1)} fps, p99 ${r.frame.p99Ms.toFixed(2)} ms, cpu ${r.cpu.avgMs.toFixed(2)} ms`
          : String(r.error ?? '')
              .split('\n')[0]
              .slice(0, 120);
        console.log(`${r.status} ${perf}`);
      }
    }
  } finally {
    await cleanup();
  }
  const results = runsPerCase.filter(runs => runs.length).map(aggregateRuns);

  const gpuEnv = results.find(r => r.env?.gpu)?.env.gpu;
  const report = {
    meta: {
      label: cfg.label,
      date: new Date().toISOString(),
      chrome: chromeVersion(),
      chromeFlags: CHROME_FLAGS,
      vsyncScenarios: Object.keys(SCENARIOS).filter(k => SCENARIOS[k].vsync),
      headful: cfg.headful,
      vsync: cfg.vsync,
      warmupSec: cfg.warmup,
      durationSec: cfg.duration,
      repeat: cfg.repeat,
      width: cfg.width,
      height: cfg.height,
      scenarios: cfg.scenarios,
      filter: cfg.filter,
      versions: await versions(),
      gpu: gpuEnv
        ? [gpuEnv.vendor, gpuEnv.architecture, gpuEnv.description]
            .filter(Boolean)
            .join(' ')
        : null,
      machine: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cores: os.cpus().length,
        memGB: Math.round(os.totalmem() / 2 ** 30),
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      },
    },
    bundles,
    results,
  };
  const dir = path.join(BENCH_DIR, 'results');
  await mkdir(dir, { recursive: true });
  const mergeLabel = opt('merge', null);
  if (mergeLabel) {
    // Re-run a subset (e.g. after a library fix) without redoing the matrix.
    const base = JSON.parse(
      await readFile(path.join(dir, `${mergeLabel}.json`), 'utf8'),
    );
    const fresh = new Map(results.map(r => [r.id, r]));
    const merged = base.results.map(r => fresh.get(r.id) ?? r);
    for (const r of results)
      if (!base.results.some(b => b.id === r.id)) merged.push(r);
    report.meta = {
      ...base.meta,
      date: report.meta.date,
      mergedCases: [...(base.meta.mergedCases ?? []), ...fresh.keys()],
    };
    report.results = merged;
    if (!cfg.sizes) report.bundles = base.bundles;
    cfg.label = mergeLabel;
  }
  report.analysis = analyse(report.results, await loadBaseline());
  const jsonPath = path.join(dir, `${cfg.label}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(path.join(dir, `${cfg.label}.md`), markdown(report) + '\n');
  await writeFile(path.join(dir, 'latest.md'), markdown(report) + '\n');
  console.log(
    `\nwrote ${path.relative(process.cwd(), jsonPath)} and benchmarks/results/latest.md`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
