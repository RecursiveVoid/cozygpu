/**
 * Static containers and retained segments, front CPU per frame
 * (ARCHITECTURE §27.6), measured on examples/retained in system Chrome.
 *
 *   node benchmarks/graphics/static.mjs                 # 317² ≈ 100k tiles
 *   node benchmarks/graphics/static.mjs --tiles 1000    # 1M tiles
 *   node benchmarks/graphics/static.mjs --no-build      # reuse build/examples
 *
 * Cases per backend (WebGPU, WebGL2), all on one static tile map of sprites
 * plus Graphics roads and houses:
 *   idle      nothing changes                         (target 0 ms, 0 bytes)
 *   moved     the container pans and zooms            (target < 0.02 ms)
 *   faded     the container's alpha changes            (target < 0.02 ms)
 *   rebake    one tile moves every frame: full re-bake (target < 10 ms at 100k)
 *   unbaked   `static = false`, camera panning         (reference)
 * plus `shapes`: 10k static Graphics nodes through retained segments (G1).
 *
 * The number is render()'s own time (`renderer.stats.cpuMs`), averaged from
 * frame 120 on. Prints a markdown table.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../scripts/serve.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const tiles = Number(opt('tiles', 317));
const seconds = Number(opt('seconds', 4));
const port = Number(opt('port', 3091));

if (!args.includes('--no-build')) {
  const r = spawnSync('npx', ['rollup', '-c', 'rollup.config.cjs'], {
    cwd: ROOT,
    env: { ...process.env, EXAMPLES: '1' },
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const CASES = [
  ['idle', `scene=map&tiles=${tiles}&camera=still&units=0`],
  ['moved', `scene=map&tiles=${tiles}&camera=pan&units=0`],
  ['faded', `scene=map&tiles=${tiles}&camera=fade&units=0`],
  ['rebake', `scene=map&tiles=${tiles}&camera=still&units=0&edit=1`],
  ['unbaked', `scene=map&tiles=${tiles}&camera=pan&units=0&static=0`],
  ['shapes (G1)', 'scene=shapes&count=10000'],
];

const server = await startServer(port);
const browser = await puppeteer.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--use-angle=metal'],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 600_000,
});
const rows = [];
try {
  for (const backend of ['webgpu', 'webgl2']) {
    for (const [name, query] of CASES) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(
        `http://127.0.0.1:${port}/examples/retained/?${query}&backend=${backend}`,
        { timeout: 600_000 },
      );
      await page.waitForFunction(() => globalThis.__retained?.frames > 120, {
        timeout: 600_000,
      });
      await new Promise(r => setTimeout(r, seconds * 1000));
      const s = await page.evaluate(() => ({ ...globalThis.__retained }));
      rows.push({ backend, name, ...s, errors: [...errors, ...s.errors] });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(
  `\n${tiles}×${tiles} = ${(tiles * tiles).toLocaleString('en')} tiles\n`,
);
console.log('| backend | case | render() ms | draws | packet B | errors |');
console.log('| ------- | ---- | ----------: | ----: | -------: | ------ |');
for (const r of rows) {
  console.log(
    `| ${r.backend} | ${r.name} | ${r.cpuAvg.toFixed(3)} | ${r.drawCalls} | ${r.packetBytes} | ${r.errors.length ? r.errors.join('; ') : '-'} |`,
  );
}
