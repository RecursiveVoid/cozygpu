/**
 * CPU mirror of the behavior params uniform + Behavior
 * handles. `set()` writes typed-array slots and marks the mirror dirty; the
 * Swarm emits one SWARM_SET_PARAMS per frame when dirty.
 */
import { CozyGPUError } from '../types/errors';
import { PARAM_TYPE_INFO } from './composer';
import type {
  Behavior,
  BehaviorDefinition,
  ComposedSwarmShaders,
  ParamLayoutEntry,
  ParamSpec,
  ParamType,
  ParamValue,
} from './types';

export class ParamsMirror {
  readonly bytes: number;
  readonly u8: Uint8Array;
  readonly u32: Uint32Array;
  readonly i32: Int32Array;
  readonly f32: Float32Array;
  dirty = true;

  constructor(bytes: number) {
    this.bytes = bytes;
    const buffer = new ArrayBuffer(bytes);
    this.u8 = new Uint8Array(buffer);
    this.u32 = new Uint32Array(buffer);
    this.i32 = new Int32Array(buffer);
    this.f32 = new Float32Array(buffer);
  }

  write(
    type: ParamType,
    offset: number,
    value: number | readonly number[],
  ): void {
    const at = offset >> 2;
    if (typeof value === 'number') {
      if (type === 'u32') this.u32[at] = value >>> 0;
      else if (type === 'i32') this.i32[at] = value | 0;
      else this.f32[at] = value;
    } else {
      const n = PARAM_TYPE_INFO[type].arity;
      for (let k = 0; k < n; k++) this.f32[at + k] = value[k] ?? 0;
    }
    this.dirty = true;
  }

  read(type: ParamType, offset: number): number | number[] {
    const at = offset >> 2;
    if (type === 'u32') return this.u32[at];
    if (type === 'i32') return this.i32[at];
    if (type === 'f32') return this.f32[at];
    const n = PARAM_TYPE_INFO[type].arity;
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(this.f32[at + k]);
    return out;
  }
}

class BehaviorHandle<P extends ParamSpec = ParamSpec> implements Behavior<P> {
  readonly name: string;
  definition: BehaviorDefinition<P>;
  /** param name → layout entry (swapped by Swarm.setBehaviors). */
  entries: Map<string, ParamLayoutEntry>;
  mirror: ParamsMirror;

  constructor(
    definition: BehaviorDefinition<P>,
    entries: Map<string, ParamLayoutEntry>,
    mirror: ParamsMirror,
  ) {
    this.name = definition.name;
    this.definition = definition;
    this.entries = entries;
    this.mirror = mirror;
  }

  set<K extends keyof P & string>(param: K, value: ParamValue<P[K]>): void {
    const entry = this.entries.get(param);
    if (!entry) this.unknown(param);
    this.mirror.write(
      entry.type,
      entry.offset,
      value as number | readonly number[],
    );
  }

  get<K extends keyof P & string>(param: K): ParamValue<P[K]> {
    const entry = this.entries.get(param);
    if (!entry) this.unknown(param);
    return this.mirror.read(entry.type, entry.offset) as unknown as ParamValue<
      P[K]
    >;
  }

  private unknown(param: string): never {
    throw new CozyGPUError(
      'INVALID_ARGUMENT',
      `swarm behavior "${this.name}" has no param "${param}"`,
    );
  }
}

export interface BehaviorSet {
  readonly mirror: ParamsMirror;
  readonly handles: BehaviorHandle[];
  readonly byName: Map<string, BehaviorHandle>;
}

/**
 * Builds the mirror + handles for a composed shader set. Values are taken
 * from `previous` when (behavior, param, type) match, else from defaults.
 */
export function createBehaviorSet(
  definitions: readonly BehaviorDefinition[],
  composed: ComposedSwarmShaders,
  previous?: BehaviorSet,
): BehaviorSet {
  const mirror = new ParamsMirror(composed.paramsBytes);
  const handles: BehaviorHandle[] = [];
  const byName = new Map<string, BehaviorHandle>();
  const entriesByBehavior = new Map<string, Map<string, ParamLayoutEntry>>();
  for (let e = 0; e < composed.params.length; e++) {
    const entry = composed.params[e];
    let map = entriesByBehavior.get(entry.behavior);
    if (!map) entriesByBehavior.set(entry.behavior, (map = new Map()));
    map.set(entry.param, entry);
  }
  for (let d = 0; d < definitions.length; d++) {
    const def = definitions[d];
    const entries = entriesByBehavior.get(def.name) ?? new Map();
    // Reuse the handle object so references held by users stay valid.
    const old = previous?.byName.get(def.name);
    const oldEntries = old?.entries;
    const oldMirror = old?.mirror;
    entries.forEach(entry => {
      const prev = oldEntries?.get(entry.param);
      const value =
        oldMirror && prev && prev.type === entry.type
          ? oldMirror.read(prev.type, prev.offset)
          : (def.defaults as Record<string, number | readonly number[]>)[
              entry.param
            ];
      mirror.write(entry.type, entry.offset, value);
    });
    let handle: BehaviorHandle;
    if (old) {
      handle = old;
      handle.definition = def;
      handle.entries = entries;
      handle.mirror = mirror;
    } else {
      handle = new BehaviorHandle(def, entries, mirror);
    }
    handles.push(handle);
    byName.set(def.name, handle);
  }
  mirror.dirty = true;
  return { mirror, handles, byName };
}
