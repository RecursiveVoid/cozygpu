/**
 * Benchmark bundling with esbuild (no rollup, no dev server).
 *
 *   node benchmarks/build.mjs          → benchmarks/dist/*.js
 *   node benchmarks/build.mjs --sizes  → also prints bundle sizes (JSON)
 *
 * Exports `buildBench()` and `measureBundleSizes()` for run.mjs.
 */
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { generateAssets } from './assets.mjs';

export const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(BENCH_DIR, '..');
export const OUT_DIR = path.join(BENCH_DIR, 'dist');

/** `import * as GPU from 'cozygpu'` → src/index.ts (same alias as rollup/tsconfig). */
const cozygpuAlias = {
  name: 'cozygpu-alias',
  setup(b) {
    b.onResolve({ filter: /^cozygpu$/ }, () => ({
      path: path.join(ROOT, 'src/index.ts'),
    }));
  },
};

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  loader: { '.wgsl': 'text', '.glsl': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cozygpuAlias],
  logLevel: 'warning',
};

export async function buildBench() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: {
      cozygpu: path.join(BENCH_DIR, 'src/cozygpu.ts'),
      pixi: path.join(BENCH_DIR, 'src/pixi.ts'),
      'three-webgl': path.join(BENCH_DIR, 'src/three-webgl.ts'),
      'three-webgpu': path.join(BENCH_DIR, 'src/three-webgpu.ts'),
    },
    outdir: OUT_DIR,
    splitting: true,
    sourcemap: true,
    chunkNames: 'chunks/[name]-[hash]',
  });
  // Worker bundle for cozygpu worker mode (served next to cozygpu.js).
  await build({
    ...common,
    entryPoints: [path.join(ROOT, 'src/worker/entry.ts')],
    outfile: path.join(OUT_DIR, 'cozygpu.worker.js'),
    sourcemap: true,
  });
  // T1 font: the example MSDF font, plus the same atlas as a BMFont .fnt.
  await writeFonts(path.join(OUT_DIR, 'fonts'));
  // A1 asset set (PNG, KTX2, KTX1), served from dist/a1/.
  return generateAssets(OUT_DIR);
}

/**
 * T1: copies examples/text/font (msdf-atlas-gen JSON + page) and writes
 * cozy.fnt, the same glyphs in the BMFont text format Pixi's BitmapFont
 * loader reads (`distanceField fieldType=msdf`), so Pixi BitmapText and
 * cozygpu Text draw from one atlas.
 */
async function writeFonts(dir) {
  const src = path.join(ROOT, 'examples/text/font');
  await mkdir(dir, { recursive: true });
  await copyFile(path.join(src, 'cozy.json'), path.join(dir, 'cozy.json'));
  await copyFile(path.join(src, 'cozy.png'), path.join(dir, 'cozy.png'));
  const j = JSON.parse(await readFile(path.join(src, 'cozy.json'), 'utf8'));
  const size = j.atlas.size;
  const m = j.metrics;
  const r = Math.round;
  const lines = [
    `info face="cozy" size=${size} bold=0 italic=0 padding=0,0,0,0 spacing=0,0`,
    `common lineHeight=${r(m.lineHeight * size)} base=${r(m.ascender * size)} scaleW=${j.atlas.width} scaleH=${j.atlas.height} pages=1 packed=0`,
    `page id=0 file="${j.pages[0]}"`,
    `chars count=${j.glyphs.length}`,
  ];
  for (const g of j.glyphs) {
    const a = g.atlasBounds;
    const p = g.planeBounds;
    const top = j.atlas.yOrigin === 'top';
    lines.push(
      a && p
        ? `char id=${g.unicode} x=${a.left} y=${top ? a.top : j.atlas.height - a.top} width=${a.right - a.left} height=${Math.abs(a.bottom - a.top)} xoffset=${r(p.left * size)} yoffset=${r((m.ascender - p.top) * size)} xadvance=${r(g.advance * size)} page=0 chnl=15`
        : `char id=${g.unicode} x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=${r(g.advance * size)} page=0 chnl=15`,
    );
  }
  lines.push(
    `distanceField fieldType=msdf distanceRange=${j.atlas.distanceRange}`,
  );
  await writeFile(path.join(dir, 'cozy.fnt'), `${lines.join('\n')}\n`);
}

const SIZE_ENTRIES = [
  {
    id: 'cozygpu',
    file: 'size/cozygpu.ts',
    note: 'createRenderer + Texture + Sprite',
  },
  {
    id: 'cozygpu (all exports)',
    file: '../src/index.ts',
    note: 'whole public API, ≈ dist/cozygpu.js (budget ≤ 30 KB)',
  },
  {
    id: 'cozygpu worker',
    file: '../src/worker/entry.ts',
    note: 'worker bundle (budget ≤ 25 KB)',
  },
  {
    id: 'pixi.js',
    file: 'size/pixi.ts',
    note: 'Application + Sprite + Texture (renderer chunks loaded on demand)',
  },
  {
    id: 'three (WebGLRenderer)',
    file: 'size/three-webgl.ts',
    note: 'WebGLRenderer + Mesh + MeshBasicMaterial',
  },
  {
    id: 'three/webgpu (WebGPURenderer)',
    file: 'size/three-webgpu.ts',
    note: 'WebGPURenderer + Mesh + MeshBasicNodeMaterial',
  },
];

const gz = buf => gzipSync(buf, { level: 9 }).length;

/**
 * Min + gzip size of each library's minimal program. `entry` is what loads
 * up front; `total` adds every code-split chunk (e.g. Pixi's lazily imported
 * WebGL/WebGPU renderers), which is what a real app eventually downloads
 * for one backend or more.
 */
export async function measureBundleSizes() {
  const out = [];
  for (const e of SIZE_ENTRIES) {
    // write: false → nothing is written; outdir only names the outputs.
    const outdir = path.join(
      BENCH_DIR,
      '.size-out',
      e.id.replace(/[^a-z0-9]+/gi, '_'),
    );
    const res = await build({
      ...common,
      entryPoints: [path.join(BENCH_DIR, e.file)],
      outdir,
      splitting: true,
      write: false,
      metafile: true,
    });
    let entryMin = 0;
    let entryGzip = 0;
    let totalMin = 0;
    let totalGzip = 0;
    let chunks = 0;
    for (const f of res.outputFiles) {
      if (!f.path.endsWith('.js')) continue;
      const rel = path.relative(process.cwd(), f.path);
      const meta = res.metafile.outputs[rel];
      chunks++;
      totalMin += f.contents.length;
      totalGzip += gz(f.contents);
      if (meta?.entryPoint) {
        entryMin += f.contents.length;
        entryGzip += gz(f.contents);
      }
    }
    out.push({
      library: e.id,
      program: e.note,
      chunks,
      entryMin,
      entryGzip,
      totalMin,
      totalGzip,
    });
  }
  return out;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildBench();
  console.log(`built → ${path.relative(process.cwd(), OUT_DIR)}`);
  if (process.argv.includes('--sizes')) {
    console.log(JSON.stringify(await measureBundleSizes(), null, 2));
  }
}
