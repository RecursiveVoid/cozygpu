/**
 * The MSDF branch is the only text-specific GPU code (ARCHITECTURE §23.3) and
 * it lives in the sprite shaders, so WGSL and GLSL must agree on the flag bit
 * and on the coverage formula — including in the pick shaders, where a
 * distance-field page is opaque and would otherwise pick as a full quad.
 */
import spriteWGSL from '../shaders/sprite/sprite.wgsl';
import spriteFragGLSL from '../shaders/sprite/sprite.frag.glsl';
import spritePickGLSL from '../shaders/sprite/sprite.pick.frag.glsl';
import { SpriteInstanceFlag } from '../types/layouts';

const wgsl = spriteWGSL as unknown as string;
const frag = spriteFragGLSL as unknown as string;
const pick = spritePickGLSL as unknown as string;

describe('the sprite shaders MSDF branch', () => {
  it('uses SpriteInstanceFlag.MSDF in WGSL', () => {
    const match = /const MSDF: u32 = (\d+)u;/.exec(wgsl);
    expect(Number(match?.[1])).toBe(SpriteInstanceFlag.MSDF);
  });

  it('uses the same bit in both GLSL shaders', () => {
    const bit = `& ${SpriteInstanceFlag.MSDF}u`;
    expect(frag).toContain(`(v_flags ${bit})`);
    expect(pick).toContain(`(v_flags ${bit})`);
  });

  it('derives coverage from the field itself in every shader', () => {
    for (const source of [wgsl, frag, pick]) {
      expect(source).toMatch(/fwidth\(d\)/);
      expect(source).toMatch(/- 0\.5/);
    }
  });
});
