/**
 * cozygpu build.
 *   npm run build           → dist/: library (ESM + CJS + .d.ts) and worker bundle
 *   npm run build:examples  → build/examples/<name>/main.js (no server)
 *   npm run dev             → watch everything + dev server (serve/livereload ONLY in watch mode)
 *   npm run build:site      → site-dist/: the static showcase page (GitHub Pages)
 */
const fs = require('fs');
const path = require('path');
const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const json = require('@rollup/plugin-json');
const { string } = require('rollup-plugin-string');
const { shaderMinifyPlugin } = require('./scripts/shader-minify.cjs');

const WATCH = !!process.env.ROLLUP_WATCH;
const SITE = !!process.env.SITE;
const WITH_EXAMPLES = WATCH || !!process.env.EXAMPLES;
const DEV_PORT = Number(process.env.PORT || 3002);

/** `import * as GPU from 'cozygpu'` inside examples/benchmarks → src/index.ts */
const aliasCozygpu = () => ({
  name: 'alias-cozygpu',
  resolveId(id) {
    if (id === 'cozygpu') return path.resolve(__dirname, 'src/index.ts');
    return null;
  },
});

/**
 * Rollup never cleans `output.dir`, so hashed chunk names from earlier builds
 * pile up in dist/chunks (and get published). Wipe that one directory before
 * the ESM build; dist/types and the single-file outputs are overwritten.
 */
const cleanChunks = dir => ({
  name: 'clean-chunks',
  buildStart() {
    fs.rmSync(path.resolve(__dirname, dir), { recursive: true, force: true });
  },
});

const basePlugins = tsOptions => [
  aliasCozygpu(),
  resolve({ browser: true }),
  commonjs(),
  json(),
  // §18.2: strip shader comments/whitespace, keep `//@` marker lines.
  shaderMinifyPlugin(),
  string({ include: ['**/*.wgsl', '**/*.glsl'] }),
  typescript(tsOptions),
];

const libTs = { tsconfig: './tsconfig.build.json' };
const noDeclTs = {
  tsconfig: './tsconfig.build.json',
  compilerOptions: {
    declaration: false,
    declarationDir: undefined,
    outDir: undefined,
  },
};

const configs = [
  {
    input: 'src/index.ts',
    // Lets chunks import shared code from cozygpu.js instead of a facade + chunk.
    preserveEntrySignatures: 'allow-extension',
    output: [
      {
        // §18.1: code splitting. Backends, the worker transport, the swarm core
        // (once loaded lazily) and the assets implementation become chunks.
        dir: 'dist',
        entryFileNames: 'cozygpu.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'esm',
        sourcemap: true,
      },
    ],
    plugins: [
      cleanChunks('dist/chunks'),
      ...basePlugins({
        ...libTs,
        outDir: 'dist',
        declarationDir: 'dist/types',
      }),
    ],
  },
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/cozygpu.cjs',
      format: 'cjs',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: basePlugins(noDeclTs),
  },
  {
    // §18.1: the worker is a module worker, so it is code-split too — an
    // inlined bundle would ship BOTH backends to every worker (~18 KB gz) to
    // use one. `worker: { url }` still points at this single entry file.
    input: 'src/worker/entry.ts',
    preserveEntrySignatures: false,
    output: {
      dir: 'dist',
      entryFileNames: 'cozygpu.worker.js',
      chunkFileNames: 'chunks/worker-[name]-[hash].js',
      format: 'esm',
      sourcemap: true,
    },
    plugins: basePlugins(noDeclTs),
  },
];

if (WITH_EXAMPLES) {
  const examplesDir = path.join(__dirname, 'examples');
  const names = fs
    .readdirSync(examplesDir)
    .filter(n => fs.existsSync(path.join(examplesDir, n, 'main.ts')));
  const exampleTs = {
    tsconfig: './tsconfig.json',
    noEmitOnError: false,
    include: ['src/**/*.ts', 'examples/**/*.ts'],
    exclude: ['**/*.test.ts'],
    compilerOptions: {
      noEmit: false,
      declaration: false,
      types: ['@webgpu/types'],
    },
  };
  for (const name of names) {
    configs.push({
      input: `examples/${name}/main.ts`,
      output: {
        file: `build/examples/${name}/main.js`,
        format: 'esm',
        sourcemap: true,
        inlineDynamicImports: true,
      },
      plugins: basePlugins(exampleTs),
    });
  }
  // Worker bundle next to the examples (examples pass worker: { url: '/build/examples/cozygpu.worker.js' }).
  configs.push({
    input: 'src/worker/entry.ts',
    output: {
      file: 'build/examples/cozygpu.worker.js',
      format: 'esm',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: basePlugins(exampleTs),
  });
}

if (WATCH) {
  const serve = require('rollup-plugin-serve');
  const livereload = require('rollup-plugin-livereload');
  const last = configs[configs.length - 1];
  last.plugins.push(
    serve({
      open: false,
      contentBase: __dirname,
      port: DEV_PORT,
      // Enables SharedArrayBuffer (crossOriginIsolated) for worker-mode examples.
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    }),
    livereload({ watch: 'build', delay: 150 }),
  );
  // eslint-disable-next-line no-console
  console.log(
    `\n  cozygpu examples → http://localhost:${DEV_PORT}/examples/\n`,
  );
}

/**
 * Showcase page (site/ → site-dist/). Every URL is relative, so the folder
 * works under any sub-path (https://<user>.github.io/<repo>/). The library is
 * code-split: each demo and each backend is a chunk loaded on demand.
 */
function siteConfigs() {
  const OUT = 'site-dist';
  const siteTs = {
    tsconfig: './tsconfig.json',
    noEmitOnError: false,
    include: ['src/**/*.ts', 'site/src/**/*.ts'],
    exclude: ['**/*.test.ts'],
    compilerOptions: {
      noEmit: false,
      declaration: false,
      sourceMap: false,
      types: ['@webgpu/types'],
    },
  };
  const minify = () => ({
    name: 'esbuild-minify',
    async renderChunk(code) {
      const { transform } = require('esbuild');
      const out = await transform(code, {
        minify: true,
        format: 'esm',
        target: 'es2022',
      });
      return { code: out.code, map: null };
    },
  });
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(path.resolve(__dirname, to)), {
      recursive: true,
    });
    fs.cpSync(path.resolve(__dirname, from), path.resolve(__dirname, to), {
      recursive: true,
    });
  };
  const staticFiles = () => ({
    name: 'site-static',
    buildStart() {
      fs.rmSync(path.resolve(__dirname, OUT), { recursive: true, force: true });
    },
    writeBundle() {
      copy('site/index.html', `${OUT}/index.html`);
      copy('site/style.css', `${OUT}/style.css`);
      copy('site/public', OUT);
      copy('examples/text/font', `${OUT}/assets/font`);
      fs.writeFileSync(path.resolve(__dirname, OUT, '.nojekyll'), '');
    },
  });
  return [
    {
      input: 'site/src/main.ts',
      preserveEntrySignatures: false,
      output: {
        dir: `${OUT}/assets`,
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'esm',
      },
      plugins: [staticFiles(), ...basePlugins(siteTs), minify()],
    },
    {
      // The worker option loads this file next to main.js.
      input: 'src/worker/entry.ts',
      output: {
        file: `${OUT}/assets/cozygpu.worker.js`,
        format: 'esm',
        inlineDynamicImports: true,
      },
      plugins: [...basePlugins(siteTs), minify()],
    },
  ];
}

module.exports = SITE ? siteConfigs() : configs;
