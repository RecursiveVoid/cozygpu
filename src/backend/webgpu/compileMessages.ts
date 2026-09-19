/**
 * Owner: "backend". Readable WGSL compilation diagnostics. Pure string
 * formatting (unit-tested in Node); WebGPUBackend imports it lazily, only
 * when a shader reports messages, so it stays off the minimal program.
 */

/** Structural subset of GPUCompilationMessage (keeps this Node-testable). */
export interface CompilationMessageLike {
  readonly message: string;
  readonly type: 'error' | 'warning' | 'info' | string;
  readonly lineNum: number;
  readonly linePos: number;
  readonly length?: number;
}

/**
 * Formats compilation messages with the offending source line and a caret:
 *
 *   sprite.wgsl:12:7 error: unresolved identifier 'colr'
 *      12 |   out.color = colr * tex;
 *         |               ^^^^
 */
export function formatCompilationMessages(
  label: string | undefined,
  source: string | undefined,
  messages: readonly CompilationMessageLike[],
  minType: 'error' | 'warning' = 'error',
): string {
  const name = label ?? 'shader';
  const lines = source ? source.split('\n') : [];
  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (minType === 'error' && m.type !== 'error') continue;
    if (m.type === 'info') continue;
    const loc = m.lineNum > 0 ? `:${m.lineNum}:${m.linePos}` : '';
    out.push(`${name}${loc} ${m.type}: ${m.message}`);
    if (m.lineNum > 0 && m.lineNum <= lines.length) {
      const gutter = String(m.lineNum).padStart(5);
      const text = lines[m.lineNum - 1].replace(/\t/g, ' ');
      out.push(`${gutter} | ${text}`);
      const caretLen = Math.max(1, Math.min(m.length ?? 1, 120));
      out.push(
        `${' '.repeat(gutter.length)} | ${' '.repeat(Math.max(0, m.linePos - 1))}${'^'.repeat(caretLen)}`,
      );
    }
  }
  return out.join('\n');
}
