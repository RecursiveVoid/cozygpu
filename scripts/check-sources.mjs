/**
 * Owner: integrator. Guards against raw control characters in sources.
 *
 *   node scripts/check-sources.mjs      → exit 1 and list offenders
 *
 * Why: a NUL byte in a template literal in src/backend/webgl2/WebGL2Backend.ts
 * made `file` classify that source as binary, so plain `grep` and `prettier`
 * skipped the whole file and it went unreviewed by both. Anything outside tab,
 * newline and carriage return is rejected.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'examples', 'scripts', 'benchmarks', 'docs'];
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  '_screenshots',
  'files',
]);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|wgsl|glsl)$/;
// Everything below 0x20 except \t (09), \n (0a), \r (0d).
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT.test(entry.name)) yield full;
  }
}

const bad = [];
for (const dir of DIRS) {
  for await (const file of walk(path.join(ROOT, dir))) {
    const text = await readFile(file, 'utf8');
    const match = CONTROL.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const code = match[0].charCodeAt(0).toString(16).padStart(2, '0');
    bad.push(
      `${path.relative(ROOT, file)}:${line}: control character 0x${code}`,
    );
  }
}

if (bad.length) {
  console.error('raw control characters in sources (use an escape instead):');
  for (const line of bad) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`check-sources: ok (${DIRS.join(', ')})`);
}
