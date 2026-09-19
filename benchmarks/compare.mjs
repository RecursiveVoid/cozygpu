#!/usr/bin/env node
/**
 * Milestone comparison: cozygpu in a baseline result vs a head result, next
 * to the best competitor (Pixi / Three) of the head run.
 *
 *   node benchmarks/compare.mjs --base m2-final --head m25-final
 *
 * Adds `analysis.milestone` to results/<head>.json and inserts a
 * "Milestone comparison" section at the top of results/<head>.md (after the
 * header block). Re-running replaces the section. The S1b rows (bindColumns)
 * are compared with the baseline S1 row of the same backend (setPosition),
 * because S1b did not exist before M2.5.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const baseLabel = opt('base', 'm2-final');
const headLabel = opt('head', 'm25-final');
const baseName = opt('base-name', 'M2 final');
const headName = opt('head-name', 'M2.5 final');

const load = async l =>
  JSON.parse(await readFile(path.join(DIR, `${l}.json`), 'utf8'));
const base = await load(baseLabel);
const head = await load(headLabel);

const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—');
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
const pct = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && b !== 0
    ? `${a > b ? '+' : ''}${Math.round(((a - b) / b) * 100) || 0} %`
    : '—';
const cnt = n =>
  n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);

const ok = r => r && r.status === 'ok';
/** Same as run.mjs: populate (load + create) + first frame (upload). */
const loadUpload = r =>
  (r.init?.populateMs ?? NaN) + (r.init?.firstFrameMs ?? NaN);

/** Metric per scenario group (lower is better for all of them). */
const METRICS = {
  'sprites-moving': { name: 'frame avg ms', get: r => r.frame?.avgMs },
  'sprites-moving-columns': { name: 'frame avg ms', get: r => r.frame?.avgMs },
  swarm: { name: 'frame avg ms', get: r => r.frame?.avgMs },
  'sprites-static': { name: 'frame avg ms', get: r => r.frame?.avgMs },
  'assets-png': { name: 'load+upload ms', get: loadUpload },
  'assets-ktx2': { name: 'load+upload ms', get: loadUpload },
  picking: { name: 'pick latency ms', get: r => r.info?.pick?.latencyAvgMs },
  'picking-uncapped': {
    name: 'pick latency ms',
    get: r => r.info?.pick?.latencyAvgMs,
  },
  'swarm-churn': { name: 'frame avg ms', get: r => r.frame?.avgMs },
  'init-100k': { name: 'init total ms', get: r => r.init?.totalMs },
};
const ORDER = Object.keys(METRICS);

const groupOf = r => r.id.split('/')[0];
const byId = new Map(base.results.map(r => [r.id, r]));
/** Baseline row for a head row (S1b → baseline S1 of the same backend). */
function baseRow(r) {
  if (groupOf(r) === 'sprites-moving-columns') {
    const p = r.params;
    return byId.get(`sprites-moving/${p.count}/cozygpu-${p.renderer}-auto`);
  }
  return byId.get(r.id);
}

const groups = new Map();
for (const r of head.results) {
  const key = `${groupOf(r)}/${r.params.count}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
// S4 (init) rows are derived from S3 at 100k.
for (const r of head.results) {
  if (groupOf(r) !== 'sprites-static') continue;
  const k = `init-100k/${r.params.count}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
// S1b competitors: the S1 competitors at the same count.
for (const [key, rows] of groups) {
  if (!key.startsWith('sprites-moving-columns/')) continue;
  const count = key.split('/')[1];
  const s1 = groups.get(`sprites-moving/${count}`) ?? [];
  rows.push(...s1.filter(r => r.params.lib !== 'cozygpu'));
}

const rowsOut = [];
const winners = [];
const sortedKeys = [...groups.keys()].sort((a, b) => {
  const [ga, ca] = a.split('/');
  const [gb, cb] = b.split('/');
  return ORDER.indexOf(ga) - ORDER.indexOf(gb) || Number(ca) - Number(cb);
});
for (const key of sortedKeys) {
  const [g] = key.split('/');
  const m = METRICS[g];
  if (!m) continue;
  const rows = groups.get(key).filter(ok);
  const valid = rows.filter(r => Number.isFinite(m.get(r)));
  if (!valid.length) continue;
  const by = (a, b) => m.get(a) - m.get(b);
  const coz = valid.filter(r => r.params.lib === 'cozygpu').sort(by);
  const comp = valid.filter(r => r.params.lib !== 'cozygpu').sort(by);
  const baseGet = r => {
    const b = baseRow(r);
    if (!ok(b)) return NaN;
    return m.get(b);
  };
  // Drift control: the median head/base ratio of the competitor cases that
  // ran in both results (Pixi / Three did not change between milestones).
  const ratios = comp
    .map(r => {
      const b = byId.get(r.id);
      return ok(b) ? m.get(r) / m.get(b) : NaN;
    })
    .filter(v => Number.isFinite(v) && v > 0)
    .sort((x, y) => x - y);
  const drift = ratios.length
    ? ratios.length % 2
      ? ratios[ratios.length >> 1]
      : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
    : NaN;
  const rank = r =>
    ['webgpu', 'webgl2', 'worker'].indexOf(r.params.renderer) * 10 +
    (r.params.variant === 'auto' ? 0 : 1);
  for (const r of [...coz].sort((a, b) => rank(a) - rank(b))) {
    const bv = baseGet(r);
    const hv = m.get(r);
    rowsOut.push({
      key,
      metric: m.name,
      engine: `${r.params.renderer}${r.params.variant !== 'auto' ? ` (${r.params.variant})` : ''}`,
      id: r.id,
      base: bv,
      head: hv,
      delta: pct(hv, bv),
      drift: Number.isFinite(drift) ? pct(drift, 1) : '—',
      adjusted: Number.isFinite(drift) ? pct(hv / drift, bv) : '—',
      competitor: comp[0]?.id ?? null,
      competitorValue: comp[0] ? m.get(comp[0]) : NaN,
    });
  }
  const best = [...coz, ...comp].sort(by)[0];
  winners.push({
    key,
    metric: m.name,
    winner: best.id,
    winnerValue: m.get(best),
    cozBest: coz[0]?.id ?? null,
    cozBestValue: coz[0] ? m.get(coz[0]) : NaN,
    competitor: comp[0]?.id ?? null,
    competitorValue: comp[0] ? m.get(comp[0]) : NaN,
  });
}

const eng = id => {
  if (!id) return '—';
  const [, , e] = id.split('/');
  const [lib, renderer, ...v] = e.split('-');
  const variant = v.join('-');
  return `${lib} · ${renderer}${variant && variant !== 'auto' ? ` (${variant})` : ''}`;
};
const title = g =>
  ({
    'sprites-moving': 'S1 moving sprites',
    'sprites-moving-columns': 'S1b moving sprites, bindColumns',
    swarm: 'S2 swarm',
    'sprites-static': 'S3 static sprites',
    'assets-png': 'A1 PNG load+upload',
    'assets-ktx2': 'A1 KTX2 load+upload',
    picking: 'A2 picking (vsync)',
    'picking-uncapped': 'A2u picking (uncapped)',
    'swarm-churn': 'A3 swarm churn',
    'init-100k': 'S4 init (from S3)',
  })[g] ?? g;

const md = [];
md.push(`## Milestone comparison: ${baseName} vs ${headName}`, '');
md.push(
  `cozygpu per backend: \`${baseLabel}\` (${base.meta.date.slice(0, 10)}, Chrome ${base.meta.chrome.replace(/^Google Chrome /, '')}) vs \`${headLabel}\` (${head.meta.date.slice(0, 10)}, Chrome ${head.meta.chrome.replace(/^Google Chrome /, '')}), with the best Pixi / Three case of the ${headName} run. Every value is the median over ${head.meta.repeat ?? 1} interleaved runs; lower is better. S1b has no ${baseName} run, so its ${baseName} column is the ${baseName} S1 row of the same backend (per-sprite \`setPosition\`).`,
  '',
  `"competitor drift" is the median ${baseName} → ${headName} change of the Pixi / Three cases of the same scenario that ran in both results; their code did not change, so it measures the machine and browser. "Δ adj" divides the cozygpu change by that drift, the fairer cross-run number when the two runs saw different conditions.`,
  '',
);
md.push(
  `| scenario | count | metric | cozygpu | ${baseName} | ${headName} | Δ | competitor drift | Δ adj | best competitor | value |`,
);
md.push('|---|---:|---|---|---:|---:|---:|---:|---:|---|---:|');
for (const r of rowsOut) {
  const [g, c] = r.key.split('/');
  md.push(
    `| ${title(g)} | ${cnt(Number(c))} | ${r.metric} | ${r.engine} | ${f2(r.base)} | ${f2(r.head)} | ${r.delta} | ${r.drift} | ${r.adjusted} | ${eng(r.competitor)} | ${f2(r.competitorValue)} |`,
  );
}
md.push('', `### Winner per scenario (${headName})`, '');
md.push(
  '| scenario | count | metric | winner | value | cozygpu best | value | best competitor | value |',
);
md.push('|---|---:|---|---|---:|---|---:|---|---:|');
for (const w of winners) {
  const [g, c] = w.key.split('/');
  md.push(
    `| ${title(g)} | ${cnt(Number(c))} | ${w.metric} | **${eng(w.winner)}** | ${f2(w.winnerValue)} | ${eng(w.cozBest)} | ${f2(w.cozBestValue)} | ${eng(w.competitor)} | ${f2(w.competitorValue)} |`,
  );
}
md.push('');
const section = md.join('\n');

head.analysis = head.analysis ?? {};
head.analysis.milestone = {
  base: baseLabel,
  head: headLabel,
  rows: rowsOut,
  winners,
};
await writeFile(
  path.join(DIR, `${headLabel}.json`),
  JSON.stringify(head, null, 2),
);

const mdPath = path.join(DIR, `${headLabel}.md`);
let text = await readFile(mdPath, 'utf8');
const start = text.indexOf('## Milestone comparison');
if (start >= 0) {
  const next = text.indexOf('\n## ', start + 5);
  text = text.slice(0, start) + (next >= 0 ? text.slice(next + 1) : '');
}
const firstSection = text.indexOf('\n## ');
text =
  firstSection >= 0
    ? `${text.slice(0, firstSection + 1)}${section}\n${text.slice(firstSection + 1)}`
    : `${text}\n${section}\n`;
await writeFile(mdPath, text);
console.log(`${rowsOut.length} rows, ${winners.length} scenarios → ${mdPath}`);
for (const w of winners)
  console.log(
    `${w.key.padEnd(34)} ${eng(w.winner).padEnd(34)} ${f2(w.winnerValue)}`,
  );
