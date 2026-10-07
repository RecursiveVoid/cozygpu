/**
 * JS allocation per frame in examples/worker, on the
 * main thread AND inside the worker (ARCHITECTURE §10, §17).
 *
 *   EXAMPLES=1 npx rollup -c rollup.config.cjs     (build the examples first)
 *   node scripts/worker-heap.mjs [--frames 600] [--variants main,ring,transfer] [--swarm]
 *
 * Serves the repo with COOP/COEP (crossOriginIsolated), opens the example in
 * system Chrome (headless, WebGPU), warms up, then records a sampling heap
 * profile that includes objects already collected by minor/major GC. The sum
 * of sampled sizes over the window / frames = allocated bytes per frame
 * (sampling estimate, interval 64 B). Prints JSON and the top allocation
 * sites per thread.
 */
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const FRAMES = Number(arg('frames', '600'));
const VARIANTS = arg('variants', 'main,ring,transfer').split(',');
const SWARM = argv.includes('--swarm');
const PORT = Number(arg('port', '3019'));

const QUERY = {
  main: 'busy=0&hud=0',
  ring: 'worker=1&busy=0&hud=0',
  transfer: 'worker=1&ring=0&busy=0&hud=0',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function summarize(profile) {
  let total = 0;
  const sites = new Map();
  const walk = (node, stack) => {
    const cf = node.callFrame;
    const name = `${cf.functionName || '(anonymous)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
    if (node.selfSize > 0) {
      total += node.selfSize;
      const key = `${name}  <  ${stack}`;
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child, name);
  };
  walk(profile.head, '');
  const top = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { total, top };
}

async function frameId(page) {
  return page.evaluate(
    () => globalThis.__cozyExample?.renderer.stats.frameId ?? -1,
  );
}

async function measure(browser, variant) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push(String(e)));
  const url = `http://127.0.0.1:${PORT}/examples/worker/?${QUERY[variant]}${SWARM ? '&swarm=1' : ''}`;
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto(url, { waitUntil: 'load' });
  const start = Date.now();
  while ((await frameId(page)) < 120) {
    if (Date.now() - start > 20000) {
      throw new Error(`${variant}: no frames (logs: ${logs.join(' | ')})`);
    }
    await sleep(100);
  }
  const info = await page.evaluate(() => {
    const r = globalThis.__cozyExample.renderer;
    return {
      worker: r.info.worker,
      sharedMemory: r.info.sharedMemory,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      backend: r.info.backend,
    };
  });
  const sessions = [{ thread: 'main', client: await page.createCDPSession() }];
  if (info.worker) {
    const workers = page.workers();
    if (workers.length === 0) throw new Error(`${variant}: no worker target`);
    sessions.push({ thread: 'worker', client: workers[0].client });
  }
  for (const s of sessions) {
    await s.client.send('HeapProfiler.enable');
    await s.client.send('HeapProfiler.collectGarbage');
  }
  await sleep(500);
  // Phase 1: retained growth (forced GC before and after, no profiler).
  for (const s of sessions) await s.client.send('HeapProfiler.collectGarbage');
  await sleep(300);
  for (const s of sessions) {
    await s.client.send('HeapProfiler.collectGarbage');
    s.before = (await s.client.send('Runtime.getHeapUsage')).usedSize;
  }
  const r0 = await frameId(page);
  while ((await frameId(page)) - r0 < FRAMES) await sleep(100);
  const retainedFrames = (await frameId(page)) - r0;
  // Two GCs with a pause: GPU object wrappers are released by finalizers.
  for (const s of sessions) await s.client.send('HeapProfiler.collectGarbage');
  await sleep(300);
  for (const s of sessions) {
    await s.client.send('HeapProfiler.collectGarbage');
    s.after = (await s.client.send('Runtime.getHeapUsage')).usedSize;
  }
  // Phase 2: allocation sampling, including objects collected by GC.
  for (const s of sessions) {
    await s.client.send('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const f0 = await frameId(page);
  const skipped0 = await page.evaluate(
    () => globalThis.__cozyExample.renderer.stats.skippedFrames,
  );
  while ((await frameId(page)) - f0 < FRAMES) await sleep(100);
  const results = [];
  for (const s of sessions) {
    const { profile } = await s.client.send('HeapProfiler.stopSampling');
    results.push({
      thread: s.thread,
      retained: s.after - s.before,
      ...summarize(profile),
    });
  }
  const frames = (await frameId(page)) - f0;
  const skipped =
    (await page.evaluate(
      () => globalThis.__cozyExample.renderer.stats.skippedFrames,
    )) - skipped0;
  await page.close();
  return {
    variant,
    ...info,
    frames,
    skipped,
    /** Allocated bytes per frame (sampled, includes garbage). */
    perFrame: Object.fromEntries(
      results.map(r => [r.thread, Math.round(r.total / frames)]),
    ),
    /** Heap growth per frame after a forced GC (retained). */
    retainedPerFrame: Object.fromEntries(
      results.map(r => [
        r.thread,
        Math.round((r.retained / retainedFrames) * 10) / 10,
      ]),
    ),
    top: Object.fromEntries(
      results.map(r => [
        r.thread,
        r.top.map(
          ([site, bytes]) => `${Math.round(bytes / frames)} B/frame  ${site}`,
        ),
      ]),
    ),
    errors: logs.filter(l => /error/i.test(l)),
  };
}

const server = await startServer(PORT);
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--enable-unsafe-webgpu',
      '--use-angle=metal',
      '--enable-features=Vulkan',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1000,700',
    ],
  });
  const out = [];
  for (const v of VARIANTS) {
    try {
      out.push(await measure(browser, v));
    } catch (error) {
      out.push({ variant: v, error: String(error) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser?.close();
  server.close();
}
