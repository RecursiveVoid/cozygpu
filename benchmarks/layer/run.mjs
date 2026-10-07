/**
 * SpriteLayer benchmark (ARCHITECTURE §28.7): cozygpu SpriteLayer vs Pixi
 * ParticleContainer and Three InstancedMesh, 1M sprites, static / static
 * over 8 textures / moving (interleaved xy, SoA x+y) / GPU-driven, WebGPU
 * and WebGL2. Headless system Chrome with vsync off, so fps is throughput.
 * One fresh browser per case; `--repeat n` runs the matrix n times
 * (interleaved rounds) and reports per-metric medians.
 *
 *   node benchmarks/layer/run.mjs                 # full matrix
 *   node benchmarks/layer/run.mjs --n 1000000 --warmup 2000 --measure 4000
 *   node benchmarks/layer/run.mjs --filter cozygpu --cases static,xy
 *   node benchmarks/layer/run.mjs --repeat 3 --out results/layer.json
 *
 * Writes benchmarks/layer/dist/results.json (or `--out`) and prints a
 * markdown table.
 */
import { build } from 'esbuild';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');
const OUT = path.join(DIR, 'dist');
const require = createRequire(import.meta.url);
const { minifyShader } = require(path.join(ROOT, 'scripts/shader-minify.cjs'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const N = Number(arg('n', 1_000_000));
const WARMUP = Number(arg('warmup', 2000));
const MEASURE = Number(arg('measure', 4000));
const FILTER = new RegExp(arg('filter', '.'));
const CASES = arg('cases', 'static,tex8,xy,packed,external').split(',');
const REPEAT = Math.max(1, Number(arg('repeat', 1)) | 0);
const OUT_FILE = path.resolve(
  arg('out', null) ? process.cwd() : OUT,
  arg('out', 'results.json'),
);

const MATRIX = [];
for (const lib of ['cozygpu', 'pixi', 'three']) {
  for (const backend of ['webgpu', 'webgl2']) {
    for (const c of CASES) {
      if (c === 'external' && (lib !== 'cozygpu' || backend === 'webgl2'))
        continue;
      if (c === 'packed' && lib === 'three') continue;
      const id = `${lib}/${backend}/${c}`;
      if (FILTER.test(id)) MATRIX.push({ id, lib, backend, case: c });
    }
  }
}

async function bundle() {
  await mkdir(OUT, { recursive: true });
  await build({
    entryPoints: [path.join(DIR, 'page.ts')],
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: OUT,
    chunkNames: 'chunks/[name]-[hash]',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
    plugins: [
      {
        name: 'cozygpu',
        setup(b) {
          b.onResolve({ filter: /^cozygpu$/ }, () => ({
            path: path.join(ROOT, 'src/index.ts'),
          }));
          b.onLoad({ filter: /\.(wgsl|glsl)$/ }, async a => ({
            contents: minifyShader(
              await readFile(a.path, 'utf8'),
              a.path.endsWith('.glsl') ? 'glsl' : 'wgsl',
            ),
            loader: 'text',
          }));
        },
      },
    ],
  });
  await writeFile(
    path.join(OUT, 'index.html'),
    '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000}</style>' +
      '<canvas id="view" width="1280" height="720"></canvas>' +
      '<script type="module" src="page.js"></script>',
  );
}

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = url.pathname.endsWith('/') ? 'index.html' : url.pathname;
    const file = path.join(OUT, path.normalize(rel));
    if (!file.startsWith(OUT)) return res.writeHead(403).end();
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader(
      'Content-Type',
      file.endsWith('.js') ? 'text/javascript' : 'text/html',
    );
    createReadStream(file)
      .on('error', () => res.writeHead(404).end())
      .pipe(res);
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

async function runCase(port, c) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--enable-unsafe-webgpu',
      '--use-angle=metal',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--window-size=1280,720',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const url = `http://127.0.0.1:${port}/?lib=${c.lib}&backend=${c.backend}&case=${c.case}&n=${N}`;
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(
      () => globalThis.__bench?.ready || globalThis.__bench?.error,
      { timeout: 120_000 },
    );
    await new Promise(r => setTimeout(r, WARMUP));
    await page.evaluate(() => globalThis.__bench.reset());
    await new Promise(r => setTimeout(r, MEASURE));
    const r = await page.evaluate(() => ({
      error: globalThis.__bench.error,
      ...globalThis.__bench.result(),
    }));
    r.gpuMs = await page.evaluate(() => globalThis.__bench.gpuMs(30));
    return { ...c, ...r, errors: errors.slice(0, 3) };
  } catch (e) {
    return { ...c, error: String(e?.message ?? e), errors };
  } finally {
    await browser.close().catch(() => {});
  }
}

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const METRICS = [
  'fps',
  'frontMs',
  'gpuMs',
  'gpuBytesPerInstance',
  'heapBytesPerInstance',
];

await bundle();
const server = await serve();
const port = server.address().port;
const loadStart = os.loadavg();
const runs = new Map(MATRIX.map(c => [c.id, []]));
try {
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const c of MATRIX) {
      const r = await runCase(port, c);
      r.loadavg = os.loadavg()[0];
      runs.get(c.id).push(r);
      console.error(
        `[r${rep + 1}/${REPEAT}] ${c.id}: ${r.error ? `error ${r.error}` : `${r.fps.toFixed(1)} fps, front ${r.frontMs.toFixed(3)} ms, gpu-synced ${r.gpuMs.toFixed(2)} ms/frame, gpu ${r.gpuBytesPerInstance.toFixed(1)} B/inst, heap ${r.heapBytesPerInstance.toFixed(1)} B/inst (load ${r.loadavg.toFixed(1)})`}`,
      );
    }
  }
} finally {
  server.close();
}
const loadEnd = os.loadavg();
const results = MATRIX.map(c => {
  const all = runs.get(c.id);
  const ok = all.filter(r => !r.error);
  if (ok.length === 0) return { ...c, error: all[0]?.error, runs: all };
  const out = { ...c, backendName: ok[0].backend, ok: ok.length, runs: all };
  for (const k of METRICS) out[k] = median(ok.map(r => r[k]));
  out.fpsRange = [
    Math.min(...ok.map(r => r.fps)),
    Math.max(...ok.map(r => r.fps)),
  ];
  return out;
});
await mkdir(path.dirname(OUT_FILE), { recursive: true });
await writeFile(
  OUT_FILE,
  JSON.stringify(
    {
      n: N,
      date: new Date().toISOString(),
      repeat: REPEAT,
      warmupMs: WARMUP,
      measureMs: MEASURE,
      loadavg: { start: loadStart, end: loadEnd },
      results,
    },
    null,
    2,
  ),
);
console.log(
  `\n| case | backend | fps (uncapped rAF) | fps range | front ms | ms/frame, GPU-synced | GPU B/inst | heap B/inst |\n| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |`,
);
for (const r of results) {
  console.log(
    r.error
      ? `| ${r.lib} ${r.case} | ${r.backend} | error | ${r.error.slice(0, 60)} | | | | |`
      : `| ${r.lib} ${r.case} | ${r.backend} | ${r.fps.toFixed(1)} | ${r.fpsRange.map(v => v.toFixed(0)).join('–')} | ${r.frontMs.toFixed(3)} | ${r.gpuMs.toFixed(2)} | ${r.gpuBytesPerInstance.toFixed(1)} | ${r.heapBytesPerInstance.toFixed(1)} |`,
  );
}
