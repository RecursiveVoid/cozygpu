/**
 * Bundle budgets (ARCHITECTURE §10, §18.3).
 *
 *   node scripts/size.mjs                    → tables + JSON, exit 1 when a check fails
 *   node scripts/size.mjs --json             → JSON only
 *   node scripts/size.mjs --verbose          → also list every counted chunk
 *   node scripts/size.mjs --update-baseline  → rewrite scripts/size-baseline.json
 *
 * Builds small fixture programs with esbuild (bundle + code splitting +
 * minify, shaders minified like the Rollup build), gzips every output chunk
 * (level 9) and runs three checks (M2.5 budgets):
 *
 * 1. Fixtures: the chunks each program actually loads.
 *      minimal-webgpu  entry + static imports + WebGPU backend + sprite WGSL   ≤ 44 KB
 *      minimal-webgl2  entry + static imports + WebGL2 backend + sprite GLSL   ≤ 46 KB
 *      worker-webgpu   src/worker/entry.ts + the WebGPU chunks                 ≤ 25 KB
 *      worker-webgl2   src/worker/entry.ts + the WebGL2 chunks                 ≤ 26 KB
 *      graphics-webgpu the minimal program + Graphics and every graphics chunk ≤ 65 KB
 *      all-exports     every chunk (reported, no absolute budget)
 * 2. Feature chunks: each lazily imported feature chunk of the all-exports
 *    build, found by the source module it contains, against its own budget
 *    (measured size at the M2.5 freeze + 0.5 KB headroom). A chunk whose
 *    module lands in no output chunk (renamed, deleted, inlined) fails.
 * 3. No growth: every fixture and chunk against scripts/size-baseline.json;
 *    growing more than the baseline's `slackBytes` (NO_GROWTH_SLACK, 0.5 KB,
 *    when the field is missing) over the recorded value fails. A missing or
 *    unreadable baseline fails (except with --update-baseline, which writes
 *    it), and so does a chunk the baseline records that is no longer built.
 *    Refresh the baseline (--update-baseline) only after the growth was
 *    reviewed and accepted.
 *
 * Nothing is written to disk except the baseline with --update-baseline.
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, '..');
const require = createRequire(import.meta.url);
const { minifyShader } = require('./shader-minify.cjs');

const KB = 1000;
/** Allowed growth over the recorded baseline before the check fails. */
const NO_GROWTH_SLACK = 500;
const BASELINE_FILE = path.join(SCRIPTS, 'size-baseline.json');

const cozygpuAlias = {
  name: 'cozygpu-alias',
  setup(b) {
    b.onResolve({ filter: /^cozygpu$/ }, () => ({
      path: path.join(ROOT, 'src/index.ts'),
    }));
  },
};

/** *.wgsl / *.glsl → minified string module (same as rollup.config.cjs). */
const shaderText = {
  name: 'cozygpu-shaders',
  setup(b) {
    b.onLoad({ filter: /\.(wgsl|glsl)$/ }, async args => {
      const lang = args.path.endsWith('.glsl') ? 'glsl' : 'wgsl';
      const source = await readFile(args.path, 'utf8');
      return { contents: minifyShader(source, lang), loader: 'text' };
    });
  },
};

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cozygpuAlias, shaderText],
  logLevel: 'error',
  write: false,
  metafile: true,
};

const BACKEND_WEBGPU = 'src/backend/webgpu/WebGPUBackend.ts';
const BACKEND_WEBGL2 = 'src/backend/webgl2/WebGL2Backend.ts';
/** Sprite shaders load per language when the sprite core starts. */
const SPRITE_WGSL = 'src/sprites/shadersWGSL.ts';
const SPRITE_GLSL = 'src/sprites/shadersGLSL.ts';
/** Graphics chunks (ARCHITECTURE §26.9). */
const GRAPHICS_EMIT = 'src/graphics/emit.ts';
const GRAPHICS_TESS = 'src/graphics/tess.ts';
const GRAPHICS_CORE = 'src/graphics/core.ts';
const GRAPHICS_WGSL = 'src/graphics/shadersWGSL.ts';

export const FIXTURES = [
  {
    id: 'minimal-webgpu',
    file: 'scripts/size-fixtures/minimal-webgpu.ts',
    what: 'createRenderer + Texture + Sprite, WebGPU chunks',
    budget: 44 * KB,
    dynamic: [BACKEND_WEBGPU, SPRITE_WGSL],
  },
  {
    id: 'minimal-webgl2',
    file: 'scripts/size-fixtures/minimal-webgl2.ts',
    what: 'createRenderer + Texture + Sprite, WebGL2 chunks',
    budget: 46 * KB,
    dynamic: [BACKEND_WEBGL2, SPRITE_GLSL],
  },
  {
    id: 'graphics-webgpu',
    file: 'scripts/size-fixtures/graphics-webgpu.ts',
    what: 'minimal WebGPU program + Graphics, every graphics chunk',
    budget: 65 * KB,
    dynamic: [
      BACKEND_WEBGPU,
      SPRITE_WGSL,
      GRAPHICS_EMIT,
      GRAPHICS_TESS,
      GRAPHICS_CORE,
      GRAPHICS_WGSL,
    ],
  },
  {
    id: 'all-exports',
    file: 'scripts/size-fixtures/all-exports.ts',
    what: 'every export, every chunk (no absolute budget)',
    budget: null,
    dynamic: 'all',
  },
  {
    id: 'worker-webgpu',
    file: 'src/worker/entry.ts',
    what: 'worker bundle + the WebGPU backend chunk',
    budget: 25 * KB,
    dynamic: [BACKEND_WEBGPU, SPRITE_WGSL],
  },
  {
    id: 'worker-webgl2',
    file: 'src/worker/entry.ts',
    what: 'worker bundle + the WebGL2 backend chunk',
    budget: 26 * KB,
    dynamic: [BACKEND_WEBGL2, SPRITE_GLSL],
  },
];

/**
 * Lazily imported feature chunks (ARCHITECTURE §18.1), measured in the
 * all-exports build and identified by the source module they contain.
 * Budgets = min+gzip at the M2.5 freeze (2026-09-19) + 0.5 KB, rounded up to
 * 0.1 KB. Every entry must be built: an absent chunk fails its budget.
 */
export const CHUNKS = [
  { id: 'backend-webgpu', module: BACKEND_WEBGPU, budget: 8800 },
  { id: 'backend-webgl2', module: BACKEND_WEBGL2, budget: 10800 },
  { id: 'sprite-wgsl', module: SPRITE_WGSL, budget: 1300 },
  { id: 'sprite-glsl', module: SPRITE_GLSL, budget: 1200 },
  { id: 'structure-patch', module: 'src/sprites/frontPatch.ts', budget: 2500 },
  {
    id: 'picking-core',
    module: 'src/renderer/pickingCoreImpl.ts',
    budget: 2100,
  },
  { id: 'assets', module: 'src/assets/Assets.ts', budget: 11400 },
  { id: 'swarm-core', module: 'src/swarm/core.ts', budget: 11400 },
  { id: 'swarm-glsl', module: 'src/swarm/glsl.ts', budget: 3800 },
  {
    id: 'worker-transport',
    module: 'src/worker/WorkerTransport.ts',
    budget: 3000,
  },
  // M2.5 chunks, budgeted at their measured size at the end of M2.5 + 0.5 KB.
  // interopImpl also carries the core half (coreInterop.ts, §19.4); the
  // readback-ring chunks also carry readTexture (both backends) and WebGL2's
  // readBuffer, which moved off the minimal program.
  { id: 'interop', module: 'src/renderer/interopImpl.ts', budget: 1500 },
  { id: 'pick-client', module: 'src/renderer/picking.ts', budget: 1400 },
  {
    id: 'readback-webgpu',
    module: 'src/backend/webgpu/readbackRing.ts',
    budget: 2100,
  },
  {
    id: 'readback-webgl2',
    module: 'src/backend/webgl2/readbackRing.ts',
    budget: 2700,
  },
  {
    id: 'wgsl-diagnostics',
    module: 'src/backend/webgpu/compileMessages.ts',
    budget: 1000,
  },
  // M3 chunks, re-measured now that the features are built: measured
  // min+gzip + ~0.5 KB, rounded to 0.1 KB, the same rule as the older
  // entries. Six of the seven came down from their freeze targets; `mask-core`
  // is the exception (5.0 KB target, 5.6 KB measured — it carries the front
  // packer, the scissor stack, the stencil pipelines and the bounds
  // fallbacks, with the soft-mask half already split into `alpha`). M4 added
  // Graphics mask geometry (MaskFlag.EXTERNAL, MASK_GEOMETRY_END and the
  // Graphics-mask front path): 6.4 KB measured, re-budgeted by the same rule.
  { id: 'mask-core', module: 'src/masks/core.ts', budget: 6900 },
  { id: 'filter-core', module: 'src/filters/core.ts', budget: 6900 },
  { id: 'filters-builtin', module: 'src/filters/builtin.ts', budget: 2100 },
  { id: 'sprite-effects', module: 'src/sprites/effects.ts', budget: 2100 },
  { id: 'text-core', module: 'src/text/layout.ts', budget: 2600 },
  { id: 'text-msdf', module: 'src/text/msdf.ts', budget: 1800 },
  { id: 'text-canvas', module: 'src/text/canvas.ts', budget: 2500 },
  { id: 'particles', module: 'src/particles/emitter.ts', budget: 4300 },
  // M4 Graphics chunks (ARCHITECTURE §26.9): the front emitter, the
  // recording compiler it shares with tessellation, tessellation, the core
  // system and its shaders. Measured min+gzip + ~0.5 KB, rounded to 0.1 KB.
  { id: 'graphics', module: GRAPHICS_EMIT, budget: 4000 },
  { id: 'graphics-compile', module: 'src/graphics/compile.ts', budget: 2900 },
  { id: 'graphics-tess', module: GRAPHICS_TESS, budget: 7300 },
  { id: 'graphics-core', module: GRAPHICS_CORE, budget: 3800 },
  { id: 'graphics-wgsl', module: GRAPHICS_WGSL, budget: 2500 },
  { id: 'graphics-glsl', module: 'src/graphics/shadersGLSL.ts', budget: 2300 },
];

const gz = bytes => gzipSync(bytes, { level: 9 }).length;

async function measure(fixture) {
  const outdir = path.join(ROOT, '.size-out', fixture.id);
  const result = await build({
    ...common,
    entryPoints: [path.join(ROOT, fixture.file)],
    outdir,
    splitting: !fixture.single,
    chunkNames: 'chunks/[name]-[hash]',
  });
  /** @type {Map<string, {min: number, gzip: number}>} */
  const sizes = new Map();
  for (const f of result.outputFiles) {
    if (!f.path.endsWith('.js')) continue;
    const rel = path.relative(ROOT, f.path);
    sizes.set(rel, { min: f.contents.length, gzip: gz(f.contents) });
  }
  const outputs = result.metafile.outputs;
  // Dynamic-import targets are entry points in the metafile too: match the
  // fixture's own file.
  const entry = Object.keys(outputs).find(
    k =>
      k.endsWith('.js') &&
      outputs[k].entryPoint !== undefined &&
      path.resolve(ROOT, outputs[k].entryPoint) ===
        path.join(ROOT, fixture.file),
  );
  if (!entry) throw new Error(`${fixture.id}: no entry output`);

  const counted = new Set();
  const all = fixture.dynamic === 'all' || fixture.single;
  const wantsDynamic = key => {
    if (all) return true;
    const inputs = Object.keys(outputs[key]?.inputs ?? {});
    return fixture.dynamic.some(d => inputs.includes(d));
  };
  const visit = key => {
    if (counted.has(key) || !outputs[key]) return;
    counted.add(key);
    for (const imp of outputs[key].imports) {
      if (imp.external) continue;
      if (imp.kind === 'dynamic-import' && !wantsDynamic(imp.path)) continue;
      visit(imp.path);
    }
  };
  visit(entry);
  if (all) for (const key of sizes.keys()) counted.add(key);

  let min = 0;
  let gzip = 0;
  const chunks = [];
  for (const key of counted) {
    const s = sizes.get(key);
    if (!s) continue;
    min += s.min;
    gzip += s.gzip;
    chunks.push({ file: path.basename(key), ...s });
  }
  let allGzip = 0;
  for (const s of sizes.values()) allGzip += s.gzip;
  // Feature chunks (CHUNKS) are measured in the all-exports build only.
  const featureChunks = [];
  if (fixture.dynamic === 'all') {
    for (const c of CHUNKS) {
      const key = Object.keys(outputs).find(
        k => k.endsWith('.js') && c.module in (outputs[k].inputs ?? {}),
      );
      const size = key ? sizes.get(key) : undefined;
      featureChunks.push({
        id: c.id,
        module: c.module,
        file: key ? path.basename(key) : null,
        min: size?.min ?? 0,
        gzip: size?.gzip ?? 0,
        budget: c.budget,
        absent: !size,
        ok: !!size && size.gzip <= c.budget,
      });
    }
  }
  return {
    id: fixture.id,
    what: fixture.what,
    min,
    gzip,
    budget: fixture.budget,
    ok: fixture.budget === null || gzip <= fixture.budget,
    chunks,
    totalChunks: sizes.size,
    allChunksGzip: allGzip,
    featureChunks,
  };
}

export async function measureSizes() {
  const results = [];
  for (const fixture of FIXTURES) results.push(await measure(fixture));
  return results;
}

/** The parsed baseline, or `{ error }` when it is missing or unreadable. */
async function readBaseline() {
  let data;
  try {
    data = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof data.fixtures !== 'object' ||
    typeof data.chunks !== 'object'
  ) {
    return { error: 'no fixtures / chunks tables' };
  }
  return data;
}

/**
 * The no-growth check: one row per fixture and feature chunk. Allowed growth
 * is the baseline's `slackBytes` (NO_GROWTH_SLACK when absent). Without a
 * usable baseline (null) every row fails; a chunk the baseline records but
 * the build no longer produces fails too. Ids the baseline does not know yet
 * are new and pass (baseline null).
 */
function growthRows(results, baseline) {
  const rows = [];
  const usable = baseline !== null && baseline !== undefined;
  const slack =
    usable && typeof baseline.slackBytes === 'number'
      ? baseline.slackBytes
      : NO_GROWTH_SLACK;
  const check = (kind, id, gzip, recorded, absent) => {
    const known = typeof recorded === 'number';
    rows.push({
      kind,
      id,
      gzip,
      baseline: known ? recorded : null,
      slack,
      absent,
      ok: usable && !absent && (!known || gzip <= recorded + slack),
    });
  };
  for (const r of results) {
    check('fixture', r.id, r.gzip, baseline?.fixtures?.[r.id], false);
    for (const c of r.featureChunks) {
      const recorded = baseline?.chunks?.[c.id];
      // An absent chunk nobody recorded is already failed by its budget.
      if (!c.absent || typeof recorded === 'number') {
        check('chunk', c.id, c.gzip, recorded, c.absent);
      }
    }
  }
  return rows;
}

async function writeBaseline(results) {
  const fixtures = {};
  const chunks = {};
  for (const r of results) {
    fixtures[r.id] = r.gzip;
    for (const c of r.featureChunks) if (!c.absent) chunks[c.id] = c.gzip;
  }
  const data = {
    note: 'min+gzip bytes; refresh with --update-baseline only after review (ARCHITECTURE §10)',
    updated: new Date().toISOString().slice(0, 10),
    slackBytes: NO_GROWTH_SLACK,
    fixtures,
    chunks,
  };
  await writeFile(BASELINE_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

const fmt = n => `${(n / KB).toFixed(1)} KB`;

function printTable(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
  for (const row of rows) {
    console.log(row.map((cell, c) => cell.padEnd(widths[c])).join('  '));
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const verbose = process.argv.includes('--verbose');
  const update = process.argv.includes('--update-baseline');
  const results = await measureSizes();
  if (update) {
    await writeBaseline(results);
    console.log(`wrote ${path.relative(ROOT, BASELINE_FILE)}`);
  }
  const read = await readBaseline();
  const baseline = read.error === undefined ? read : null;
  const growth = growthRows(results, baseline);
  const chunkResults = results.flatMap(r => r.featureChunks);
  if (!json) {
    printTable([
      ['fixture', 'min', 'min+gzip', 'budget', 'chunks', 'status'],
      ...results.map(r => [
        r.id,
        fmt(r.min),
        fmt(r.gzip),
        r.budget === null ? '-' : fmt(r.budget),
        `${r.chunks.length}/${r.totalChunks}`,
        r.ok ? 'ok' : 'OVER',
      ]),
    ]);
    console.log('');
    printTable([
      ['feature chunk', 'min', 'min+gzip', 'budget', 'status'],
      ...chunkResults.map(c => [
        c.id,
        c.absent ? '-' : fmt(c.min),
        c.absent ? '-' : fmt(c.gzip),
        fmt(c.budget),
        c.absent ? 'ABSENT' : c.ok ? 'ok' : 'OVER',
      ]),
    ]);
    console.log('');
    if (baseline === null) {
      console.log(
        `no-growth: FAILED, ${path.relative(ROOT, BASELINE_FILE)} is missing ` +
          `or unreadable (${read.error})`,
      );
    } else {
      printTable([
        ['no-growth', 'min+gzip', 'baseline', 'delta', 'status'],
        ...growth.map(g => [
          `${g.kind} ${g.id}`,
          fmt(g.gzip),
          g.baseline === null ? '-' : fmt(g.baseline),
          g.baseline === null
            ? 'new'
            : `${g.gzip >= g.baseline ? '+' : ''}${fmt(g.gzip - g.baseline)}`,
          g.absent ? 'ABSENT' : g.ok ? 'ok' : 'GREW',
        ]),
      ]);
    }
    if (verbose) {
      for (const r of results) {
        console.log(`\n${r.id}:`);
        for (const c of r.chunks) {
          console.log(
            `  ${c.file.padEnd(40)} ${fmt(c.min).padStart(9)} ${fmt(c.gzip).padStart(9)}`,
          );
        }
      }
    }
    console.log('');
  }
  console.log(
    JSON.stringify(
      {
        fixtures: results.map(({ chunks, featureChunks, ...rest }) => ({
          ...rest,
          chunks: chunks.map(c => c.file),
        })),
        chunks: chunkResults,
        growth,
      },
      null,
      json ? 2 : 0,
    ),
  );
  const failures = [
    ...results
      .filter(r => !r.ok)
      .map(r => `${r.id} ${fmt(r.gzip)} > ${fmt(r.budget)}`),
    ...chunkResults
      .filter(c => !c.ok)
      .map(c =>
        c.absent
          ? `chunk ${c.id} absent (${c.module} is in no output chunk)`
          : `chunk ${c.id} ${fmt(c.gzip)} > ${fmt(c.budget)}`,
      ),
    ...(baseline === null
      ? [`no-growth baseline missing or unreadable (${read.error})`]
      : growth
          .filter(g => !g.ok && !g.absent)
          .map(
            g =>
              `${g.kind} ${g.id} grew ${fmt(g.gzip - g.baseline)} (> ${fmt(g.slack)} over baseline)`,
          )),
  ];
  if (failures.length) {
    console.error(`\nsize check failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 2;
  });
}
