/**
 * Owner: "sprites". Incremental structure pass of the ScenePacker
 * (ARCHITECTURE §16.2), split out of front.ts and loaded with a dynamic
 * import the first time the scene structure changes after the first frame
 * (see `loadPatcher` in front.ts). Until it lands, structure changes take the
 * full rebuild, which is always correct; this module only makes them cheaper.
 * A static scene never loads it.
 */
import {
  STRUCT_LOG_SIZE,
  StructEdit,
  nodeStore,
  structLog,
} from '../scene/store';
import type { ContainerNode, SceneNode } from '../scene/types';
import { SPRITE_INSTANCE_BYTES } from '../types/layouts';
import {
  BATCH_CUSTOM,
  BATCH_SPRITES,
  INST_OFF,
  computeRuns,
  fixRunAt,
  type SpriteScenePacker,
} from './front';

/** Region kinds of an incremental structure patch. */
const REGION_CHILDREN = 0;
const REGION_NODE = 1;
const MAX_REGIONS = STRUCT_LOG_SIZE;
const LOG_MASK = STRUCT_LOG_SIZE - 1;

// Patch regions: module scratch (patch() is synchronous and not re-entrant).
const regionStart = new Int32Array(MAX_REGIONS);
const regionEnd = new Int32Array(MAX_REGIONS);
const regionParent = new Int32Array(MAX_REGIONS);
const regionMode = new Uint8Array(MAX_REGIONS);
const regionChild = new Int32Array(MAX_REGIONS);
const regionTarget: (SceneNode | null)[] = [];
const regionOrder = new Int32Array(MAX_REGIONS);

/**
 * Incremental structure pass (ARCHITECTURE §16.2): turns the structure log
 * entries since the last pack into laminar flat regions and re-visits only
 * those. Returns false when a full rebuild is required.
 */
export function patch(
  pk: SpriteScenePacker,
  stage: ContainerNode,
  useSAB: boolean,
): boolean {
  if (pk.hasForeign) return false;
  const log = structLog;
  const head = log.head;
  const seenVersion = pk.structureVersion;
  const oldest = head > STRUCT_LOG_SIZE ? head - STRUCT_LOG_SIZE : 0;
  let k = head - 1;
  while (k >= oldest && log.version[k & LOG_MASK] > seenVersion) k--;
  // Entries older than the ring may be unseen.
  if (k < oldest && oldest > 0) return false;
  pk.ensureSlotArrays(nodeStore.capacity);

  // ── entries → regions
  const list = pk.list;
  const rStart = regionStart;
  const rEnd = regionEnd;
  const rParent = regionParent;
  const rMode = regionMode;
  const rChild = regionChild;
  const rTarget = regionTarget;
  let regions = 0;
  for (let e = k + 1; e < head; e++) {
    const at = e & LOG_MASK;
    const kind = log.kind[at];
    if (kind === StructEdit.UNKNOWN) return false;
    const target = log.target[at] as SceneNode;
    if (kind === StructEdit.NODE && target === stage) return false;
    let container: ContainerNode;
    let childIndex: number;
    let pIdx: number;
    if (kind === StructEdit.NODE) {
      const idx = pk.flatIndexOf(target);
      if (idx >= 0) {
        rStart[regions] = idx;
        rEnd[regions] = list.end[idx];
        rParent[regions] = list.parent[idx];
        rMode[regions] = REGION_NODE;
        rChild[regions] = 0;
        rTarget[regions] = target;
        regions++;
        continue;
      }
      const parent = target.parent;
      if (!parent) continue;
      pIdx = pk.flatIndexOf(parent);
      if (pIdx < 0) continue; // not drawn by this packer
      container = parent;
      childIndex = parent.children.indexOf(target);
      if (childIndex < 0) continue;
    } else {
      container = target as ContainerNode;
      pIdx = pk.flatIndexOf(container);
      if (pIdx < 0) continue;
      childIndex = log.index[at];
    }
    // Children [0, childIndex) are unchanged since the last pack: the
    // region starts after the last of them that is in the list.
    const children = container.children;
    let start = pIdx + 1;
    for (
      let c = (childIndex < children.length ? childIndex : children.length) - 1;
      c >= 0;
      c--
    ) {
      const ci = pk.flatIndexOf(children[c]);
      if (ci >= 0 && list.parent[ci] === pIdx) {
        start = list.end[ci];
        break;
      }
    }
    rStart[regions] = start;
    rEnd[regions] = list.end[pIdx];
    rParent[regions] = pIdx;
    rMode[regions] = REGION_CHILDREN;
    rChild[regions] = childIndex;
    rTarget[regions] = container;
    regions++;
  }

  // ── Regions are laminar (subtrees, or trailing children of one
  // container). Order: start asc; at equal starts empty regions first
  // (inner containers first), then non-empty ones by end desc. Applied
  // back to front, so everything at one index lands in draw order.
  const order = regionOrder;
  for (let r = 0; r < regions; r++) {
    let i = r;
    while (i > 0 && regionBefore(pk, r, order[i - 1])) {
      order[i] = order[i - 1];
      i--;
    }
    order[i] = r;
  }
  let n = 0;
  let coveredEnd = -1;
  let lastStart = -1;
  let lastEnd = -1;
  let lastR = -1;
  let lastEmpty = -1;
  for (let i = 0; i < regions; i++) {
    const r = order[i];
    const s = rStart[r];
    const e = rEnd[r];
    if (s === e) {
      // Empty: children appended after the last drawn child of rParent.
      if (s < coveredEnd) continue;
      if (
        s === lastEnd &&
        (lastStart <= rParent[r] ||
          (rMode[lastR] === REGION_CHILDREN && rParent[lastR] === rParent[r]))
      ) {
        continue; // the previous region re-visits these children
      }
      if (
        lastEmpty >= 0 &&
        rStart[lastEmpty] === s &&
        rParent[lastEmpty] === rParent[r]
      ) {
        continue; // same container: the first one starts at the lower child
      }
      order[n++] = r;
      lastEmpty = r;
      continue;
    }
    if (s < coveredEnd) continue; // nested
    order[n++] = r;
    coveredEnd = e;
    lastStart = s;
    lastEnd = e;
    lastR = r;
  }

  pk.patchCount++;
  pk.structureVersion = nodeStore.structureVersion;
  pk.stamp++;
  pk.hadForce = true;
  pk.sawForeign = false;
  // Apply from the back so earlier regions keep their indices.
  for (let i = n - 1; i >= 0; i--) {
    const r = order[i];
    applyRegion(
      pk,
      rStart[r],
      rEnd[r],
      rParent[r],
      rMode[r],
      rTarget[r] as SceneNode,
      rChild[r],
      useSAB,
    );
  }
  for (let r = 0; r < regions; r++) rTarget[r] = null;
  if (pk.sawForeign) pk.hasForeign = true;
  return true;
}

/** Sort key of patch regions (see patch()). */
function regionBefore(pk: SpriteScenePacker, a: number, b: number): boolean {
  const sa = regionStart[a];
  const sb = regionStart[b];
  if (sa !== sb) return sa < sb;
  const ea = regionEnd[a] === sa;
  const eb = regionEnd[b] === sb;
  if (ea !== eb) return ea;
  if (ea) {
    const pa = regionParent[a];
    const pb = regionParent[b];
    if (pa !== pb) return pa > pb;
    return regionChild[a] < regionChild[b];
  }
  const enda = regionEnd[a];
  const endb = regionEnd[b];
  if (enda !== endb) return enda > endb;
  // Same span: the kept (first) one must cover the other. Trailing
  // children cover a node subtree; a lower child index covers a higher one.
  const ma = regionMode[a];
  const mb = regionMode[b];
  if (ma !== mb) return ma === REGION_CHILDREN;
  return regionChild[a] < regionChild[b];
}

function applyRegion(
  pk: SpriteScenePacker,
  start: number,
  end: number,
  parentFlat: number,
  mode: number,
  target: SceneNode,
  childFrom: number,
  useSAB: boolean,
): void {
  const list = pk.list;
  const oldTotal = list.count;
  const oldInstTotal = pk.instanceCount;
  const is = start < oldTotal ? list.inst[start] : oldInstTotal;
  const ieOld = end < oldTotal ? list.inst[end] : oldInstTotal;

  // 1. Re-visit the region into staging (absolute indices).
  const st = pk.staging;
  pk.beginOut(st, pk.stagingBatches, start, is, true);
  if (mode === REGION_NODE) {
    // A node that moved elsewhere is re-visited by its new parent's region.
    const parent = target.parent;
    if (parent && pk.flatIndexOf(parent) === parentFlat) {
      pk.visit(target, parentFlat);
    }
  } else {
    pk.visitChildren((target as ContainerNode).children, childFrom, parentFlat);
  }
  const newLen = st.count;
  const newInst = pk.outInst - is;
  const delta = newLen - (end - start);
  const idelta = newInst - (ieOld - is);
  computeRuns(st, 0, newLen, start);

  // 2. Old entries that were not re-visited leave the list.
  const seen = pk.seen;
  const inFlat = pk.inFlat;
  const stamp = pk.stamp;
  for (let i = start; i < end; i++) {
    const slot = list.slot[i];
    if (seen[slot] !== stamp) inFlat[slot] = 0;
  }

  // 3. Splice the flat arrays.
  const total = oldTotal + delta;
  if (total > list.slot.length) list.grow(total);
  const nodes = list.nodes;
  if (delta !== 0) {
    const to = start + newLen;
    list.slot.copyWithin(to, end, oldTotal);
    list.parent.copyWithin(to, end, oldTotal);
    list.kind.copyWithin(to, end, oldTotal);
    list.foreign.copyWithin(to, end, oldTotal);
    list.runEnd.copyWithin(to, end, oldTotal);
    list.end.copyWithin(to, end, oldTotal);
    list.inst.copyWithin(to, end, oldTotal);
    if (delta > 0) nodes.length = total;
    nodes.copyWithin(to, end, oldTotal);
    if (delta < 0) nodes.length = total;
  }
  const slotFlat = pk.slotFlat;
  for (let i = 0; i < newLen; i++) {
    const at = start + i;
    list.slot[at] = st.slot[i];
    list.parent[at] = st.parent[i];
    list.kind[at] = st.kind[i];
    list.foreign[at] = st.foreign[i];
    list.runEnd[at] = st.runEnd[i];
    list.end[at] = st.end[i];
    list.inst[at] = st.inst[i];
    nodes[at] = st.nodes[i];
  }
  st.nodes.length = 0;
  list.count = total;
  const tailFrom = start + newLen;
  if (delta !== 0 || idelta !== 0) {
    const parent = list.parent;
    const runEnd = list.runEnd;
    const subEnd = list.end;
    const inst = list.inst;
    const slots = list.slot;
    for (let j = tailFrom; j < total; j++) {
      if (parent[j] >= end) parent[j] += delta;
      runEnd[j] += delta;
      subEnd[j] += delta;
      inst[j] += idelta;
      slotFlat[slots[j]] = j;
    }
    for (let p = parentFlat; p >= 0; p = parent[p]) subEnd[p] += delta;
  }
  // Runs across both junctions.
  fixRunAt(list, tailFrom);
  fixRunAt(list, start);

  // 4. Splice instances.
  if (idelta !== 0 || newInst > 0) {
    const newTotal = oldInstTotal + idelta;
    pk.ensureInstanceArrays(Math.max(newTotal, oldInstTotal));
    if (pk.instances.ensure(newTotal, useSAB)) pk.fullUpload = true;
    const owner = pk.instOwner;
    if (idelta !== 0) {
      const I = SPRITE_INSTANCE_BYTES;
      const to = is + newInst;
      pk.instances.u8.copyWithin(to * I, ieOld * I, oldInstTotal * I);
      pk.instOff.copyWithin(
        to * INST_OFF,
        ieOld * INST_OFF,
        oldInstTotal * INST_OFF,
      );
      owner.copyWithin(to, ieOld, oldInstTotal);
      if (idelta < 0) owner.fill(-1, newTotal, oldInstTotal);
      if (to < newTotal && (pk.shiftedFrom < 0 || to < pk.shiftedFrom)) {
        pk.shiftedFrom = to;
      }
    }
    const staged = pk.stagedOwner;
    for (let t = 0; t < newInst; t++) owner[is + t] = staged[t];
    pk.instanceCount = newTotal;
  }

  // 5. Splice batches: [before region] + [region] + [after region].
  const old = pk.batches;
  const out = pk.spareBatches;
  const reg = pk.stagingBatches;
  out.count = 0;
  out.texture.length = 0;
  let b = 0;
  for (; b < old.count; b++) {
    if (old.kind[b] === BATCH_CUSTOM) {
      if (old.flat[b] >= start) break;
      out.append(BATCH_CUSTOM, 0, 0, 0, null, old.flat[b]);
    } else {
      const first = old.first[b];
      if (first >= is) break;
      const last = first + old.size[b];
      out.append(
        BATCH_SPRITES,
        first,
        (last < is ? last : is) - first,
        old.blend[b],
        old.texture[b],
        old.flat[b],
      );
      if (last > is) break; // crosses the region: its tail is handled below
    }
  }
  for (let r = 0; r < reg.count; r++) {
    out.append(
      reg.kind[r],
      reg.first[r],
      reg.size[r],
      reg.blend[r],
      reg.texture[r],
      reg.flat[r],
    );
  }
  for (; b < old.count; b++) {
    if (old.kind[b] === BATCH_CUSTOM) {
      const f = old.flat[b];
      if (f < end) continue;
      out.append(BATCH_CUSTOM, 0, 0, 0, null, f + delta);
    } else {
      const first = old.first[b];
      const last = first + old.size[b];
      if (last <= ieOld) continue;
      const from = first > ieOld ? first : ieOld;
      const f = old.flat[b];
      out.append(
        BATCH_SPRITES,
        from + idelta,
        last - from,
        old.blend[b],
        old.texture[b],
        f >= end ? f + delta : tailFrom,
      );
    }
  }
  reg.texture.length = 0;
  old.texture.length = 0;
  pk.batches = out;
  pk.spareBatches = old;
}
