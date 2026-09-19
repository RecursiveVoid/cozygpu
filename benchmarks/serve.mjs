/**
 * Minimal static server for benchmarks/ (default port 4100).
 * Sends COOP/COEP so the page is crossOriginIsolated (SharedArrayBuffer for
 * cozygpu worker mode, precise timers).
 *
 *   node benchmarks/serve.mjs            → build once, serve until Ctrl-C
 *   node benchmarks/serve.mjs --no-build
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_DIR, buildBench } from './build.mjs';

export const PORT = Number(process.env.BENCH_PORT || 4100);
const NO_COI = process.env.BENCH_NO_COI === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.ktx2': 'image/ktx2',
  '.ktx': 'image/ktx',
};

export function startServer(port = PORT) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(BENCH_DIR, path.normalize(rel));
      if (!file.startsWith(BENCH_DIR)) {
        res.writeHead(403).end();
        return;
      }
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': s.size,
        'Cache-Control': 'no-store',
        // BENCH_NO_COI=1 drops COOP/COEP (diagnostics: no SharedArrayBuffer path).
        ...(NO_COI
          ? {}
          : {
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
              'Cross-Origin-Resource-Policy': 'same-origin',
            }),
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv.includes('--no-build')) await buildBench();
  const server = await startServer();
  console.log(`benchmarks on http://127.0.0.1:${PORT}/ (Ctrl-C to stop)`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
