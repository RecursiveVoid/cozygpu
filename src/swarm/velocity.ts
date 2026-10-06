/**
 * The `velocity` built-in, on its own so that the particle emitter compiler
 * can reach it without importing the whole `behaviors` table.
 *
 * `behaviors` is a static export of the library entry, while the emitter
 * compiler is a lazily loaded chunk. A module both of them import lands in a
 * chunk the entry loads eagerly, which would put the behavior table, the
 * shader composer and the swarm WGSL on the minimal path (ARCHITECTURE
 * §18.1). This file imports nothing, so sharing it costs a few hundred bytes.
 */
import type { BehaviorDefinition } from './types';

/** Integrates position and rotation; see `behaviors.velocity`. */
export function velocityBehavior(options?: {
  name?: string;
}): BehaviorDefinition {
  return {
    name: options?.name ?? 'velocity',
    params: {},
    defaults: {},
    update: /* wgsl */ `
    p.pos += p.vel * sim.dt;
    p.rot += p.angVel * sim.dt;`,
    glsl: {
      update: /* glsl */ `
    p.pos += p.vel * sim.dt;
    p.rot += p.angVel * sim.dt;`,
    },
  };
}
