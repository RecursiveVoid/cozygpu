#version 300 es
// cozygpu unified graphics fragment shader, GLSL ES 3.0 twin of unified.wgsl
// (ARCHITECTURE §27.4). One source, three programs: the core inserts
// `#define PICK` (fs_pick) or `#define MASK` (fs_mask) after the version
// line; neither gives fs_main. Derivatives are taken before any branch on
// the kind; texture slots are read with explicit gradients.
precision highp float;
precision highp int;

in vec2 v_p;
flat in vec4 v_ext;
flat in vec2 v_band;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in uint v_flags;
flat in uint v_kind;

uniform sampler2D G2_B0;
uniform sampler2D G2_B2;
uniform sampler2D G2_B4;
uniform sampler2D G2_B6;
uniform sampler2D G2_B8;
uniform sampler2D G2_B10;
uniform sampler2D G2_B12;
uniform sampler2D G2_B14;

#ifdef PICK
layout(location = 0) out uvec4 pick;
#else
layout(location = 0) out vec4 fragColor;
#endif

float arc(vec2 p, float r, float start, float sweep, float hw, uint cap) {
  float half_ = min(abs(sweep) * 0.5, 3.14159265);
  float mid = start + sweep * 0.5;
  float cm = cos(mid);
  float sm = sin(mid);
  vec2 q = vec2(abs(p.x * sm - p.y * cm), p.x * cm + p.y * sm);
  vec2 sc = vec2(sin(half_), cos(half_));
  float radial = abs(length(q) - r) - hw;
  float past = sc.y * q.x - sc.x * q.y;
  if (past <= 0.0) return radial;
  if (cap == 16u) return length(q - sc * r) - hw;
  return max(radial, past - (cap == 32u ? hw : 0.0));
}

float field() {
  if (v_kind != 1u) return 0.0;
  uint kind = v_flags & 15u;
  vec2 p = v_p;
  vec2 h = v_ext.xy;
  if (kind == 0u) {
    float r = clamp(v_ext.z, 0.0, min(h.x, h.y));
    vec2 q = abs(p) - h + r;
    float m = max(q.x, q.y);
    if (r > 0.0 || (v_flags & 16u) != 0u)
      return length(max(q, vec2(0.0))) + min(m, 0.0) - r;
    if ((v_flags & 32u) != 0u) return max(m, q.x + q.y);
    return m;
  }
  if (kind == 1u) {
    if (h.x == h.y) return length(p) - h.x;
    float k1 = length(p / h);
    float k2 = length(p / (h * h));
    return k1 * (k1 - 1.0) / max(k2, 1e-6);
  }
  if (kind == 2u) return v_p.y;
  return length(p) - h.x;
}

vec4 sampleSlot(uint slot, vec2 uv, vec2 gx, vec2 gy) {
  if (slot == 0u) return textureGrad(G2_B0, uv, gx, gy);
  if (slot == 1u) return textureGrad(G2_B2, uv, gx, gy);
  if (slot == 2u) return textureGrad(G2_B4, uv, gx, gy);
  if (slot == 3u) return textureGrad(G2_B6, uv, gx, gy);
  if (slot == 4u) return textureGrad(G2_B8, uv, gx, gy);
  if (slot == 5u) return textureGrad(G2_B10, uv, gx, gy);
  if (slot == 6u) return textureGrad(G2_B12, uv, gx, gy);
  return textureGrad(G2_B14, uv, gx, gy);
}

void main() {
  float g = field();
  float k = max(length(vec2(dFdx(g), dFdy(g))), 1e-6);
  vec2 gx = dFdx(v_p);
  vec2 gy = dFdy(v_p);
  vec4 texel = vec4(1.0);
  if (v_kind > 1u) texel = sampleSlot((v_flags >> 3u) & 7u, v_p, gx, gy);
  float md = max(min(texel.r, texel.g), min(max(texel.r, texel.g), texel.b)) - 0.5;
  float msdf = clamp(md / max(fwidth(md), 1e-4) + 0.5, 0.0, 1.0);

  float fill = 0.0;
  float stroke = 0.0;
  uint kind = v_flags & 15u;
  if (v_kind == 1u) {
    vec2 p = v_p;
    vec2 h = v_ext.xy;
    float unit = (v_flags & 64u) != 0u ? k : 1.0;
    float d = g;
    float bandIn = v_band.x * unit;
    float bandOut = v_band.y * unit;
    if (kind >= 2u) {
      float hw = 0.5 * (bandIn + bandOut);
      if (kind == 2u && hw <= 0.0) hw = h.y * unit;
      uint cap = v_flags & 48u;
      if (kind == 2u) {
        vec2 a = abs(p);
        d = cap == 16u
          ? length(vec2(max(a.x - h.x, 0.0), a.y)) - hw
          : max(a.y - hw, a.x - h.x - (cap == 32u ? hw : 0.0));
      } else {
        d = arc(p, h.x, v_ext.z, v_ext.w, hw, cap);
      }
      bandIn = 1e6 * k;
      bandOut = 0.0;
    }
    float dp = d / k;
    fill = kind >= 2u ? 0.0 : clamp(0.5 - dp, 0.0, 1.0);
    stroke = clamp(dp + bandIn / k + 0.5, 0.0, 1.0) -
      clamp(dp - bandOut / k + 0.5, 0.0, 1.0);
  }
  bool msdfOn = (v_flags & 2u) != 0u;

#if defined(PICK) || defined(MASK)
  float cov = 1.0;
  if (v_kind == 1u) {
    bool stroked = kind >= 2u || v_band.x + v_band.y > 0.0;
    bool filled = kind < 2u && (v_flags & 128u) != 0u;
    cov = max(filled ? fill : 0.0, stroked ? stroke : 0.0);
  } else if (v_kind > 1u) {
    cov = msdfOn ? msdf : texel.a;
  #ifdef PICK
    cov *= v_fill.a;
  #endif
  }
#endif
#ifdef PICK
  uint id = v_flags >> 8u;
  if (id == 0u || cov < 0.5) discard;
  pick = uvec4(id, 0u, 0u, 0u);
#elif defined(MASK)
  if (cov < 0.5) discard;
  fragColor = vec4(1.0);
#else
  if (v_kind == 1u) {
    float f = v_fill.a * fill;
    float s = v_stroke.a * stroke;
    float a = s + f * (1.0 - s);
    if (a <= 0.0) discard;
    fragColor = vec4(v_stroke.rgb * s + v_fill.rgb * (f * (1.0 - s)), a);
    return;
  }
  float a = v_fill.a;
  if (v_kind == 0u) {
    fragColor = vec4(v_fill.rgb * a, a);
  } else if (msdfOn) {
    float c = msdf * a;
    fragColor = vec4(v_fill.rgb * c, c);
  } else if ((v_flags & 1u) != 0u) {
    fragColor = vec4(v_fill.rgb * texel.a * a, texel.a * a);
  } else {
    fragColor = vec4(texel.rgb * v_fill.rgb * a, texel.a * a);
  }
#endif
}
