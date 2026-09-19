/**
 * Owner: "worker+build". Bundle budgets (ARCHITECTURE §10, §18.3).
 *
 *   node scripts/size.mjs            → table + JSON, exit 1 when over budget
 *   node scripts/size.mjs --json     → JSON only
 *   node scripts/size.mjs --verbose  → also list every counted chunk
 *
 * Builds small fixture programs with esbuild (bundle + code splitting +
 * minify, shaders minified like the Rollup build), gzips every output chunk
 * (level 9) and sums the chunks each fixture actually loads:
 *
 *   minimal-webgpu  entry + static imports + the WebGPU backend chunk     ≤ 30 KB
 *                   (+ the sprite WGSL chunk)
 *   minimal-webgl2  entry + static imports + the WebGL2 backend chunk     ≤ 30 KB
 *                   (+ the sprite GLSL chunk)
 *   all-exports     every chunk of a program using every export           ≤ 45 KB
 *   worker-webgpu   src/worker/entry.ts + the WebGPU backend chunk        ≤ 25 KB
 *   worker-webgl2   src/worker/entry.ts + the WebGL2 backend chunk        ≤ 25 KB
 *
 * The worker is code-split like the library (§18.1), so it loads one backend,
 * not both; both fixtures count what a worker actually fetches on that
 * backend, the same way the minimal ones do.
 *
 * Nothing is written to disk (esbuild `write: false`).
 */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, '..');
const require = createRequire(import.meta.url);
const { minifyShader } = require('./shader-minify.cjs');

const KB = 1000;

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

export const FIXTURES = [
  {
    id: 'minimal-webgpu',
    file: 'scripts/size-fixtures/minimal-webgpu.ts',
    what: 'createRenderer + Texture + Sprite, WebGPU chunks',
    budget: 30 * KB,
    dynamic: [BACKEND_WEBGPU, SPRITE_WGSL],
  },
  {
    id: 'minimal-webgl2',
    file: 'scripts/size-fixtures/minimal-webgl2.ts',
    what: 'createRenderer + Texture + Sprite, WebGL2 chunks',
    budget: 30 * KB,
    dynamic: [BACKEND_WEBGL2, SPRITE_GLSL],
  },
  {
    id: 'all-exports',
    file: 'scripts/size-fixtures/all-exports.ts',
    what: 'every export, every chunk',
    budget: 45 * KB,
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
    budget: 25 * KB,
    dynamic: [BACKEND_WEBGL2, SPRITE_GLSL],
  },
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
  return {
    id: fixture.id,
    what: fixture.what,
    min,
    gzip,
    budget: fixture.budget,
    ok: gzip <= fixture.budget,
    chunks,
    totalChunks: sizes.size,
    allChunksGzip: allGzip,
  };
}

export async function measureSizes() {
  const results = [];
  for (const fixture of FIXTURES) results.push(await measure(fixture));
  return results;
}

const fmt = n => `${(n / KB).toFixed(1)} KB`;

async function main() {
  const json = process.argv.includes('--json');
  const verbose = process.argv.includes('--verbose');
  const results = await measureSizes();
  if (!json) {
    const rows = [
      ['fixture', 'min', 'min+gzip', 'budget', 'chunks', 'status'],
      ...results.map(r => [
        r.id,
        fmt(r.min),
        fmt(r.gzip),
        fmt(r.budget),
        `${r.chunks.length}/${r.totalChunks}`,
        r.ok ? 'ok' : 'OVER',
      ]),
    ];
    const widths = rows[0].map((_, c) =>
      Math.max(...rows.map(r => r[c].length)),
    );
    for (const row of rows) {
      console.log(row.map((cell, c) => cell.padEnd(widths[c])).join('  '));
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
      results.map(({ chunks, ...rest }) => ({
        ...rest,
        chunks: chunks.map(c => c.file),
      })),
      null,
      json ? 2 : 0,
    ),
  );
  const over = results.filter(r => !r.ok);
  if (over.length) {
    console.error(
      `\nsize budget exceeded: ${over.map(r => `${r.id} ${fmt(r.gzip)} > ${fmt(r.budget)}`).join(', ')}`,
    );
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
