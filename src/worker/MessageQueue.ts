/** Owner: "worker". Single-listener delivery that buffers messages until the listener is set. */
import type { CoreMessage } from '../types/transport';

/** Cap on messages kept while no listener is attached (oldest dropped). */
const MAX_PENDING = 64;

export class MessageQueue {
  private listener: ((message: CoreMessage) => void) | null = null;
  private pending: CoreMessage[] = [];

  deliver(message: CoreMessage): void {
    const listener = this.listener;
    if (listener !== null) {
      listener(message);
      return;
    }
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push(message);
  }

  setListener(listener: (message: CoreMessage) => void): void {
    this.listener = listener;
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    for (let i = 0; i < pending.length; i++) listener(pending[i]);
  }
}
