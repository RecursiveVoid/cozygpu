/**
 * M2.5 review: the bundle-budget script (`scripts/size.mjs`, ARCHITECTURE
 * §10, §18.3) and its no-growth baseline (`scripts/size-baseline.json`).
 * Lives under src/ because jest only runs tests below src/ and benchmarks/.
 *
 * Nothing is built here: the budget tables are read by importing the script
 * in a child Node process (its main() only runs when invoked directly), and
 * the no-growth rule is exercised on the script's own `growthRows` source.
 */
export {};

const { execFileSync } = require('child_process') as {
  execFileSync(cmd: string, args: string[], opts: object): string;
};
const fs = require('fs') as {
  readFileSync(p: string, enc: 'utf8'): string;
  existsSync(p: string): boolean;
};
const path = require('path') as {
  join(...p: string[]): string;
  resolve(...p: string[]): string;
};

const ROOT = path.resolve(__dirname, '..');
const nodeBin = (globalThis as unknown as { process: { execPath: string } })
  .process.execPath;

interface Fixture {
  id: string;
  file: string;
  budget: number | null;
  dynamic: string[] | 'all';
}
interface Chunk {
  id: string;
  module: string;
  budget: number;
}
interface Baseline {
  slackBytes: number;
  fixtures: Record<string, number>;
  chunks: Record<string, number>;
}
interface GrowthRow {
  kind: string;
  id: string;
  gzip: number;
  baseline: number | null;
  slack: number;
  absent: boolean;
  ok: boolean;
}
type GrowthRows = (
  results: {
    id: string;
    gzip: number;
    featureChunks: { id: string; gzip: number; absent: boolean }[];
  }[],
  baseline: Partial<Baseline> | null,
) => GrowthRow[];

const tables = JSON.parse(
  execFileSync(
    nodeBin,
    [
      '--input-type=module',
      '-e',
      "const m = await import('./scripts/size.mjs');" +
        'process.stdout.write(JSON.stringify({ fixtures: m.FIXTURES, chunks: m.CHUNKS }));',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  ),
) as { fixtures: Fixture[]; chunks: Chunk[] };

const baseline = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts/size-baseline.json'), 'utf8'),
) as Baseline;

const script = fs.readFileSync(path.join(ROOT, 'scripts/size.mjs'), 'utf8');

/** `growthRows` from the script itself, with its NO_GROWTH_SLACK. */
function loadGrowthRows(): { growthRows: GrowthRows; slack: number } {
  const slack = Number(/const NO_GROWTH_SLACK = (\d+);/.exec(script)![1]);
  const start = script.indexOf('function growthRows(');
  const end = script.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(0);
  const source = script.slice(start, end + 2);
  const growthRows = new Function(
    'NO_GROWTH_SLACK',
    `${source}\nreturn growthRows;`,
  )(slack) as GrowthRows;
  return { growthRows, slack };
}

describe('size budgets (decided 2026-09-18, re-measured at the end of M3 and M5)', () => {
  it('fixture budgets: 44.5 KB WebGPU, 46.8 KB WebGL2, workers 25/26.5 KB, graphics 72.5 KB, all-exports reported only', () => {
    const byId = Object.fromEntries(tables.fixtures.map(f => [f.id, f]));
    // End of M3: the four features cost the minimal program about 2.6 KB —
    // roughly half real code on the minimal path (the cheap-effect routing in
    // the sprite core, the faster column copy, the render-group seam), half
    // the chunk-splitting overhead of four more lazy roots. Measured
    // breakdown in ARCHITECTURE §10; the no-growth check is what actually
    // holds the line from here.
    // M5: the retained-rendering seams on the minimal path (packer emitter
    // and static leaf, RenderCore drawSpan, Container.static, two lazy
    // placeholders, render-bundle loaders, time-gated pacing) cost ~0.7 KB.
    expect(byId['minimal-webgpu'].budget).toBe(44_500);
    expect(byId['minimal-webgl2'].budget).toBe(46_800);
    expect(byId['worker-webgpu'].budget).toBe(25_000);
    expect(byId['worker-webgl2'].budget).toBe(26_500);
    // M4: the minimal WebGPU program plus Graphics and every graphics chunk;
    // M5 added the unified batch.
    expect(byId['graphics-webgpu'].budget).toBe(72_500);
    expect(byId['all-exports'].budget).toBeNull();
    // The all-exports build is where the feature chunks are measured.
    expect(byId['all-exports'].dynamic).toBe('all');
  });

  it('every fixture entry and every feature-chunk module exists (an absent chunk would pass unchecked)', () => {
    for (const f of tables.fixtures) {
      expect([f.id, fs.existsSync(path.join(ROOT, f.file))]).toEqual([
        f.id,
        true,
      ]);
    }
    for (const c of tables.chunks) {
      expect([c.id, fs.existsSync(path.join(ROOT, c.module))]).toEqual([
        c.id,
        true,
      ]);
    }
    const ids = tables.chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the baseline records exactly the current fixtures and chunks, each within its budget', () => {
    expect(Object.keys(baseline.fixtures).sort()).toEqual(
      tables.fixtures.map(f => f.id).sort(),
    );
    expect(Object.keys(baseline.chunks).sort()).toEqual(
      tables.chunks.map(c => c.id).sort(),
    );
    for (const f of tables.fixtures) {
      if (f.budget !== null) {
        expect([f.id, baseline.fixtures[f.id] <= f.budget]).toEqual([
          f.id,
          true,
        ]);
      }
    }
    for (const c of tables.chunks) {
      expect([c.id, baseline.chunks[c.id] <= c.budget]).toEqual([c.id, true]);
    }
  });

  it('the baseline slack matches the script (0.5 KB)', () => {
    const { slack } = loadGrowthRows();
    expect(slack).toBe(500);
    expect(baseline.slackBytes).toBe(slack);
  });
});

describe('size.mjs no-growth rule (growthRows)', () => {
  const { growthRows, slack } = loadGrowthRows();
  const result = (
    id: string,
    gzip: number,
    chunks: { id: string; gzip: number; absent?: boolean }[] = [],
  ) => ({
    id,
    gzip,
    featureChunks: chunks.map(c => ({ absent: false, ...c })),
  });

  it('passes up to baseline + slack and fails one byte beyond, for fixtures and chunks', () => {
    const rows = growthRows(
      [
        result('a', 1000 + slack),
        result('b', 1000 + slack + 1, [
          { id: 'c1', gzip: 200 + slack },
          { id: 'c2', gzip: 200 + slack + 1 },
        ]),
      ],
      { fixtures: { a: 1000, b: 1000 }, chunks: { c1: 200, c2: 200 } },
    );
    expect(rows.map(r => [r.kind, r.id, r.ok])).toEqual([
      ['fixture', 'a', true],
      ['fixture', 'b', false],
      ['chunk', 'c1', true],
      ['chunk', 'c2', false],
    ]);
  });

  it('shrinking always passes; ids missing from the baseline are new (pass, baseline null)', () => {
    const rows = growthRows(
      [result('a', 10, [{ id: 'fresh', gzip: 99_999 }])],
      { fixtures: { a: 5000 }, chunks: {} },
    );
    expect(rows.map(r => [r.kind, r.id, r.gzip, r.baseline, r.ok])).toEqual([
      ['fixture', 'a', 10, 5000, true],
      ['chunk', 'fresh', 99_999, null, true],
    ]);
  });

  it('without a baseline file every row fails (the check cannot switch itself off)', () => {
    const rows = growthRows([result('a', 1)], null);
    expect(rows.map(r => [r.id, r.baseline, r.ok])).toEqual([
      ['a', null, false],
    ]);
  });

  it('a chunk the baseline records but the build no longer produces fails', () => {
    const rows = growthRows(
      [
        result('a', 1, [
          { id: 'gone', gzip: 0, absent: true },
          { id: 'never', gzip: 0, absent: true },
        ]),
      ],
      { fixtures: { a: 1 }, chunks: { gone: 900 } },
    );
    // 'never' has no baseline entry: its own chunk budget fails it instead.
    expect(rows.map(r => [r.id, r.absent, r.ok])).toEqual([
      ['a', false, true],
      ['gone', true, false],
    ]);
  });

  it("uses the baseline's slackBytes when recorded", () => {
    const rows = growthRows([result('a', 1100), result('b', 1101)], {
      slackBytes: 100,
      fixtures: { a: 1000, b: 1000 },
      chunks: {},
    });
    expect(rows.map(r => [r.id, r.slack, r.ok])).toEqual([
      ['a', 100, true],
      ['b', 100, false],
    ]);
  });
});
