/**
 * Built-in behaviors + defineBehavior.
 *
 * Snippet contract (see BehaviorDefinition in ./types.ts): each `update` is
 * inlined in its own `{ }` block of cs_step, after aging, in array order.
 * In scope: `var p: SwarmHot`, `let c: SwarmCold`, `let i: u32`,
 * `sim: SwarmSim` (dt per substep), `view: View`, `$params.<param>`,
 * `hash32()`, `rand01()`. `p.life = 0.0;` kills. Positions are in swarm
 * space (the swarm node's local space; equal to stage space when the swarm
 * sits untransformed at the stage root).
 */
import { validateBehavior } from './composer';
import { velocityBehavior } from './velocity';
import type { BehaviorDefinition, BuiltinBehaviors, ParamSpec } from './types';

/** Identity helper that validates the definition and gives type inference for custom behaviors. */
export function defineBehavior<P extends ParamSpec>(
  definition: BehaviorDefinition<P>,
): BehaviorDefinition<P> {
  validateBehavior(definition as unknown as BehaviorDefinition);
  return definition;
}

const BOUNDS_UPDATE = {
  bounce: /* wgsl */ `
    let lo = $params.rect.xy + abs(p.scale) * 0.5;
    let hi = $params.rect.xy + $params.rect.zw - abs(p.scale) * 0.5;
    if (p.pos.x < lo.x) { p.pos.x = lo.x; p.vel.x = abs(p.vel.x) * $params.restitution; }
    else if (p.pos.x > hi.x) { p.pos.x = hi.x; p.vel.x = -abs(p.vel.x) * $params.restitution; }
    if (p.pos.y < lo.y) { p.pos.y = lo.y; p.vel.y = abs(p.vel.y) * $params.restitution; }
    else if (p.pos.y > hi.y) { p.pos.y = hi.y; p.vel.y = -abs(p.vel.y) * $params.restitution; }`,
  wrap: /* wgsl */ `
    let size = max($params.rect.zw, vec2f(1e-6));
    let rel = p.pos - $params.rect.xy;
    if (any(rel < vec2f(0.0)) || any(rel >= size)) {
      p.pos = $params.rect.xy + rel - floor(rel / size) * size;
    }`,
  kill: /* wgsl */ `
    let rel = p.pos - $params.rect.xy;
    if (any(rel < vec2f(0.0)) || any(rel > $params.rect.zw)) { p.life = 0.0; }`,
} as const;

/** GLSL ES 3.0 twins of BOUNDS_UPDATE (WebGL2, ARCHITECTURE §14.2). */
const BOUNDS_GLSL = {
  bounce: /* glsl */ `
    vec2 lo = $params.rect.xy + abs(p.scale) * 0.5;
    vec2 hi = $params.rect.xy + $params.rect.zw - abs(p.scale) * 0.5;
    if (p.pos.x < lo.x) { p.pos.x = lo.x; p.vel.x = abs(p.vel.x) * $params.restitution; }
    else if (p.pos.x > hi.x) { p.pos.x = hi.x; p.vel.x = -abs(p.vel.x) * $params.restitution; }
    if (p.pos.y < lo.y) { p.pos.y = lo.y; p.vel.y = abs(p.vel.y) * $params.restitution; }
    else if (p.pos.y > hi.y) { p.pos.y = hi.y; p.vel.y = -abs(p.vel.y) * $params.restitution; }`,
  wrap: /* glsl */ `
    vec2 size = max($params.rect.zw, vec2(1e-6));
    vec2 rel = p.pos - $params.rect.xy;
    if (any(lessThan(rel, vec2(0.0))) || any(greaterThanEqual(rel, size))) {
      p.pos = $params.rect.xy + rel - floor(rel / size) * size;
    }`,
  kill: /* glsl */ `
    vec2 rel = p.pos - $params.rect.xy;
    if (any(lessThan(rel, vec2(0.0))) || any(greaterThan(rel, $params.rect.zw))) { p.life = 0.0; }`,
} as const;

export const behaviors: BuiltinBehaviors = {
  velocity: velocityBehavior,

  acceleration: options =>
    defineBehavior({
      name: options?.name ?? 'acceleration',
      params: { value: 'vec2f' },
      defaults: { value: [options?.x ?? 0, options?.y ?? 0] },
      update: /* wgsl */ `
    p.vel += $params.value * sim.dt;`,
      glsl: {
        update: /* glsl */ `
    p.vel += $params.value * sim.dt;`,
      },
    }),

  drag: options =>
    defineBehavior({
      name: options?.name ?? 'drag',
      params: { k: 'f32' },
      defaults: { k: options?.k ?? 1 },
      update: /* wgsl */ `
    p.vel *= exp(-$params.k * sim.dt);`,
      glsl: {
        update: /* glsl */ `
    p.vel *= exp(-$params.k * sim.dt);`,
      },
    }),

  bounds: options =>
    defineBehavior({
      name: options.name ?? 'bounds',
      params: { rect: 'vec4f', restitution: 'f32' },
      defaults: {
        rect: [options.x, options.y, options.width, options.height],
        restitution: options.restitution ?? 1,
      },
      update: BOUNDS_UPDATE[options.mode ?? 'bounce'],
      glsl: { update: BOUNDS_GLSL[options.mode ?? 'bounce'] },
    }),

  attractor: options =>
    defineBehavior({
      name: options.name ?? 'attractor',
      params: { point: 'vec2f', strength: 'f32', radius: 'f32' },
      defaults: {
        point: [options.x, options.y],
        strength: options.strength ?? 1000,
        radius: options.radius ?? 0,
      },
      // strength in px/s² at the point, linear falloff to 0 at `radius`
      // (radius <= 0: no falloff, unlimited range).
      update: /* wgsl */ `
    let d = $params.point - p.pos;
    let dist = length(d);
    if (dist > 0.5) {
      var f = 1.0;
      if ($params.radius > 0.0) { f = max(0.0, 1.0 - dist / $params.radius); }
      p.vel += d * ($params.strength * f * sim.dt / dist);
    }`,
      glsl: {
        update: /* glsl */ `
    vec2 d = $params.point - p.pos;
    float dist = length(d);
    if (dist > 0.5) {
      float f = 1.0;
      if ($params.radius > 0.0) { f = max(0.0, 1.0 - dist / $params.radius); }
      p.vel += d * ($params.strength * f * sim.dt / dist);
    }`,
      },
    }),
};
