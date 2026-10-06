// cozygpu cheap in-batch sprite effect (WGSL). docs/ARCHITECTURE.md §22.7.
// Appended to sprite.wgsl by the sprite core the first time a batch binds an
// effect, so a program that never uses one carries none of this text.
// Layout: layouts.ts SPRITE_EFFECT_BYTES / SE_*.

struct SpriteEffect {
  matrix: mat4x4f,
  offset: vec4f,
  outlineColor: u32,
  outlineWidth: f32,
  glow: f32,
  flags: u32,
}

@group(2) @binding(0) var<uniform> effect: SpriteEffect;

const EFFECT_NO_MATRIX: u32 = 1u;

@fragment
fn fs_effect(in: VertexOut) -> @location(0) vec4f {
  let texel = textureSample(spriteTexture, spriteSampler, in.uv);
  let alphaOnly = (in.flags & ALPHA_ONLY) != 0u;
  // Back to straight alpha: the color matrix is defined on unpremultiplied
  // color, so tint and saturation behave the same at any alpha.
  let tex = select(texel.rgb / max(texel.a, 1e-5), vec3f(1.0), alphaOnly);
  let straight = vec4f(
    select(tex, vec3f(1.0), texel.a <= 0.0) * in.color.rgb,
    texel.a * in.color.a,
  );
  var c = straight;
  if ((effect.flags & EFFECT_NO_MATRIX) == 0u) {
    c = clamp(effect.matrix * straight + effect.offset, vec4f(0.0), vec4f(1.0));
  }
  return vec4f(c.rgb * c.a, c.a);
}
