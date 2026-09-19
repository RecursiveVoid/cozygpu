/**
 * Owner: "assets". Concurrency limiter for fetch + decode jobs
 * (ARCHITECTURE §15.4): at most `limit` running, the rest wait FIFO; low
 * priority jobs (`preload`) run after every normal job.
 */
import { CozyGPUError } from '../types/errors';

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  low: boolean;
}

export class JobQueue {
  running = 0;
  private readonly normal: Waiter[] = [];
  private readonly low: Waiter[] = [];

  constructor(public limit: number) {
    if (!(limit >= 1)) this.limit = 1;
  }

  get queued(): number {
    return this.normal.length + this.low.length;
  }

  /**
   * Resolves when a slot is free. The caller must call `release()` exactly
   * once afterwards. Rejects ABORTED (without taking a slot) when `signal`
   * aborts while waiting.
   */
  acquire(signal?: AbortSignal, low = false): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (
      this.running < this.limit &&
      (low ? this.queued === 0 : this.normal.length === 0)
    ) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const list = low ? this.low : this.normal;
      const waiter: Waiter = { resolve, reject, low };
      list.push(waiter);
      if (signal) {
        const onAbort = (): void => {
          const i = list.indexOf(waiter);
          if (i >= 0) {
            list.splice(i, 1);
            reject(abortError());
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.resolve = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
      }
    });
  }

  release(): void {
    this.running--;
    const next =
      this.normal.length > 0 ? this.normal.shift() : this.low.shift();
    if (next !== undefined) {
      this.running++;
      next.resolve();
    }
  }

  /** Rejects every waiter (manager destroyed). */
  rejectAll(error: unknown): void {
    const all = this.normal.concat(this.low);
    this.normal.length = 0;
    this.low.length = 0;
    for (let i = 0; i < all.length; i++) all[i].reject(error);
  }
}

export function abortError(): CozyGPUError {
  return new CozyGPUError('ABORTED', 'asset load aborted');
}
