/**
 * Tester (logic, round 1): identifier hygiene of composed swarm shaders.
 * Validation promises "helper identifiers are prefixed" so user helpers
 * cannot clash with the prelude, the module globals or each other. These
 * cases pass validation today but produce WGSL that redeclares a name, which
 * only fails later as an async SHADER_COMPILE on the GPU.
 */
import { CozyGPUError } from '../types/errors';
import { composeSwarmShaders, validateBehavior } from './composer';
import type { BehaviorDefinition } from './types';

const def = (
  name: string,
  helpers?: string,
  params: Record<string, string> = {},
  defaults: Record<string, number> = {},
  update = 'p.pos.x += 0.0;',
): BehaviorDefinition =>
  ({
    name,
    helpers,
    params,
    defaults,
    update,
  }) as unknown as BehaviorDefinition;

/** Top-level (column 0) declarations (fn/struct/const/var/alias/override). */
function declarations(wgsl: string): string[] {
  const noComments = wgsl.replace(/\/\/[^\n]*/g, '');
  const re =
    /^(?:@[^\n]*?\s)?(?:fn|struct|alias|const|override|var(?:<[^>]*>)?)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  return [...noComments.matchAll(re)].map(m => m[1]);
}

describe('composed modules declare every top-level name once', () => {
  it('built-in style behaviors with prefixed helpers', () => {
    const out = composeSwarmShaders(
      [
        def(
          'swirl',
          'fn swirl_angle(v: vec2f) -> f32 { return atan2(v.y, v.x); }',
        ),
        def('noise', 'fn noise_at(i: u32) -> f32 { return rand01(i, 7u); }'),
      ],
      0,
    );
    for (const src of [out.compute, out.render]) {
      const names = declarations(src);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes).toEqual([]);
    }
  });

  // Regression: the helper check used `startsWith(behaviorName)`, so a
  // behavior could redeclare prelude/global identifiers or another
  // behavior's helper. Helpers now need the `${name}_` prefix, must not
  // redeclare a prelude/template name and must be unique across behaviors.
  it.each([
    ['hash / hash32', [def('hash', 'fn hash32(x: u32) -> u32 { return x; }')]],
    [
      'rand / rand01',
      [def('rand', 'fn rand01(i: u32, s: u32) -> f32 { return 0.0; }')],
    ],
    [
      'swarm / swarm_index',
      [def('swarm', 'fn swarm_index(g: vec3u) -> u32 { return 0u; }')],
    ],
    ['view / view', [def('view', 'fn view() -> f32 { return 0.0; }')]],
    ['hot / hot', [def('hot', 'const hot: f32 = 1.0;')]],
    [
      'a + ab both declare ab_x',
      [
        def('a', 'fn ab_x() -> f32 { return 0.0; }'),
        def('ab', 'fn ab_x() -> f32 { return 1.0; }'),
      ],
    ],
    [
      'a + a_b both declare a_b_x',
      [
        def('a', 'fn a_b_x() -> f32 { return 0.0; }'),
        def('a_b', 'fn a_b_x() -> f32 { return 1.0; }'),
      ],
    ],
    [
      'one behavior declares a helper twice',
      [
        def(
          'w',
          'fn w_x() -> f32 { return 0.0; }\nfn w_x() -> f32 { return 1.0; }',
        ),
      ],
    ],
  ])('%s is rejected at compose time', (_label, behaviors) => {
    let error: unknown = null;
    let compute = '';
    try {
      compute = composeSwarmShaders(
        behaviors as BehaviorDefinition[],
        0,
      ).compute;
    } catch (e) {
      error = e;
    }
    if (error === null) {
      // prove the composed module really redeclares a name
      const names = declarations(compute);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes).toEqual([]);
    }
    expect(error).toBeInstanceOf(CozyGPUError);
  });

  // Regression: WGSL keywords/reserved words were accepted as param names and
  // `$params.<field>` used `in`, which matched inherited names.
  it.each([
    ['param named loop', def('w', undefined, { loop: 'f32' }, { loop: 1 })],
    ['param named var', def('w', undefined, { var: 'f32' }, { var: 1 })],
    ['param named self', def('w', undefined, { self: 'f32' }, { self: 1 })],
    // Regression: GLSL ES 3.00 reserved words passed (WGSL-only check) and
    // then failed to compile as struct members on WebGL2 only.
    [
      'GLSL param sample',
      def('w', undefined, { sample: 'f32' }, { sample: 1 }),
    ],
    ['GLSL param in', def('w', undefined, { in: 'f32' }, { in: 1 })],
    [
      'GLSL param uniform',
      def('w', undefined, { uniform: 'f32' }, { uniform: 1 }),
    ],
    ['GLSL param vec2', def('w', undefined, { vec2: 'f32' }, { vec2: 1 })],
    ['GLSL param gl_x', def('w', undefined, { gl_x: 'f32' }, { gl_x: 1 })],
    ['GLSL param a__b', def('w', undefined, { a__b: 'f32' }, { a__b: 1 })],
    [
      '$params.toString',
      def(
        'w',
        undefined,
        { k: 'f32' },
        { k: 1 },
        'p.pos.x += $params.toString;',
      ),
    ],
  ])('%s throws INVALID_ARGUMENT', (_label, behavior) => {
    expect(() => validateBehavior(behavior as BehaviorDefinition)).toThrow(
      CozyGPUError,
    );
  });
});
