/**
 * Retained segment ids (ARCHITECTURE §27.2), private to the retain core's
 * table. One id space for the scene packers' segments and the static bakes'
 * segments, so both can live in one core; ids are unique across renderers
 * too, which keeps the per-renderer bookkeeping out of here.
 */
let next = 1;
const free: number[] = [];

export function allocSegmentId(): number {
  return free.length > 0 ? free.pop()! : next++;
}

export function freeSegmentId(id: number): void {
  free.push(id);
}
