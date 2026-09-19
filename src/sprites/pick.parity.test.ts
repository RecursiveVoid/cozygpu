/**
 * Tester (logic, M2). The pick pass (ARCHITECTURE §16.3) replays the frame's
 * SPRITE_DRAW commands whole, so every sprite of a batch is rasterised into
 * the 1×1 rg32uint target — pickable or not. A sprite that is not pickable
 * carries pick id 0 in SI_FLAGS bits 8-31 and MUST discard, otherwise it
 * overwrites the pick target with (0, 0) and hides the pickable sprite drawn
 * underneath it. The WGSL and GLSL fragment shaders must agree on that.
 */
import pickGLSL from '../shaders/sprite/sprite.pick.frag.glsl';
import spriteWGSL from '../shaders/sprite/sprite.wgsl';
import swarmPickWGSL from '../shaders/swarm/render.wgsl';
import { behaviors } from '../swarm/behaviors';
import { composeSwarmShaders } from '../swarm/composer';
import { installGlslComposer } from '../swarm/glsl';
import { PICK_ALPHA_THRESHOLD, SI_PICK_SHIFT } from '../types/layouts';

const fsPick = /fn fs_pick\([^]*$/.exec(spriteWGSL)![0];

describe('sprite pick shaders agree across backends', () => {
  it('both shift the pick id out of SI_FLAGS by SI_PICK_SHIFT', () => {
    expect(SI_PICK_SHIFT).toBe(8);
    expect(fsPick).toMatch(/flags >> PICK_SHIFT/);
    expect(spriteWGSL).toMatch(
      new RegExp(`const PICK_SHIFT: u32 = ${SI_PICK_SHIFT}u;`),
    );
    expect(pickGLSL).toMatch(new RegExp(`v_flags >> ${SI_PICK_SHIFT}u`));
  });

  it('both discard below the same alpha threshold', () => {
    expect(PICK_ALPHA_THRESHOLD).toBe(0.5);
    expect(fsPick).toMatch(/< PICK_ALPHA_THRESHOLD/);
    expect(spriteWGSL).toMatch(
      new RegExp(`const PICK_ALPHA_THRESHOLD: f32 = ${PICK_ALPHA_THRESHOLD};`),
    );
    expect(pickGLSL).toMatch(/< 0\.5\) discard/);
  });

  it('WGSL fs_pick discards a zero pick id', () => {
    expect(fsPick).toMatch(/id == 0u/);
    expect(fsPick).toMatch(/discard/);
  });

  // Regression: without the `id == 0u` discard, on WebGL2 a non-pickable
  // sprite drawn over a pickable one wrote (0, 0) and renderer.pick()
  // answered "nothing hit", while WebGPU answered the sprite below.
  it('GLSL sprite pick shader also discards a zero pick id', () => {
    expect(pickGLSL).toMatch(/v_flags >> 8u/);
    expect(pickGLSL).toMatch(/id == 0u \|\|[^;]*\) discard;/);
    expect(pickGLSL).toMatch(/pick = uvec4\(id, 0u, 0u, 0u\);/);
  });
});

describe('swarm pick shader', () => {
  it('writes (pickId, slot + 1) so sprites and swarms stay distinguishable', () => {
    expect(swarmPickWGSL).toMatch(
      /return vec2u\(swarmPick\.id, in\.slot \+ 1u\);/,
    );
    installGlslComposer();
    const glsl = composeSwarmShaders([behaviors.velocity()], 0, 'glsl300es');
    const pick = glsl.render.slice(
      glsl.render.indexOf('//@STAGE pickFragment'),
    );
    expect(pick).toMatch(
      /outPick = uvec4\(swarmPick\.id, v_slot \+ 1u, 0u, 0u\);/,
    );
    // A swarm only gets a pick pipeline when its pick id is non-zero, so the
    // shader needs no id == 0 guard (unlike the sprite one).
    expect(pick).toMatch(/discard/);
  });
});
