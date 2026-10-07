/**
 * Validation diagnostics: a deduplicating console logger.
 * WGSL compilation-message formatting is in ./compileMessages (a lazy
 * chunk: it only runs when a shader reports messages).
 */

/** Logs each distinct message once, capped, so a per-frame error cannot flood the console. */
export class DedupLogger {
  private readonly seen = new Set<string>();

  constructor(
    private readonly prefix: string,
    private readonly cap = 32,
  ) {}

  error(message: string): void {
    if (this.seen.has(message) || this.seen.size >= this.cap) return;
    this.seen.add(message);
    // eslint-disable-next-line no-console
    console.error(`${this.prefix} ${message}`);
    if (this.seen.size === this.cap) {
      // eslint-disable-next-line no-console
      console.error(`${this.prefix} further GPU errors are suppressed`);
    }
  }

  warn(message: string): void {
    if (this.seen.has(message) || this.seen.size >= this.cap) return;
    this.seen.add(message);
    // eslint-disable-next-line no-console
    console.warn(`${this.prefix} ${message}`);
  }
}
