#version 300 es
// cozygpu graphics SDF shape fragment shader, GLSL ES 3.0 twin of shape.wgsl
// (ARCHITECTURE §26.5). One source, three programs: the core inserts
// `#define PICK` (fs_pick: rgba32uint pick id) or `#define MASK` (fs_mask:
// stencil mask geometry) after the version line; neither gives fs_main.
precision highp float;
precision highp int;

in vec2 v_p;
flat in vec4 v_ext;
flat in vec2 v_band;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in uint v_flags;

#ifdef PICK
layout(location = 0) out uvec4 pick;
#else
layout(location = 0) out vec4 fragColor;
#endif

// Distance to a centred arc stroke of half width hw (caps by flag).
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

void main() {
  uint kind = v_flags & 15u;
  vec2 p = v_p;
  vec2 h = v_ext.xy;
  float g;
  if (kind == 0u) {
    float r = clamp(v_ext.z, 0.0, min(h.x, h.y));
    vec2 q = abs(p) - h + r;
    float m = max(q.x, q.y);
    g = m;
    if (r > 0.0 || (v_flags & 16u) != 0u) {
      g = length(max(q, vec2(0.0))) + min(m, 0.0) - r;
    } else if ((v_flags & 32u) != 0u) {
      g = max(m, q.x + q.y);
    }
  } else if (kind == 1u) {
    if (h.x == h.y) {
      g = length(p) - h.x;
    } else {
      float k1 = length(p / h);
      float k2 = length(p / (h * h));
      g = k1 * (k1 - 1.0) / max(k2, 1e-6);
    }
  } else if (kind == 2u) {
    g = p.y;
  } else {
    g = length(p) - h.x;
  }
  float k = max(length(vec2(dFdx(g), dFdy(g))), 1e-6);
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
  float fill = kind >= 2u ? 0.0 : clamp(0.5 - dp, 0.0, 1.0);
  float stroke = clamp(dp + bandIn / k + 0.5, 0.0, 1.0) -
    clamp(dp - bandOut / k + 0.5, 0.0, 1.0);
#if defined(PICK) || defined(MASK)
  bool stroked = kind >= 2u || v_band.x + v_band.y > 0.0;
  bool filled = kind < 2u && (v_flags & 128u) != 0u;
  float hit = max(filled ? fill : 0.0, stroked ? stroke : 0.0);
#endif
#ifdef PICK
  uint id = v_flags >> 8u;
  if (id == 0u || hit < 0.5) discard;
  pick = uvec4(id, 0u, 0u, 0u);
#elif defined(MASK)
  if (hit < 0.5) discard;
  fragColor = vec4(1.0);
#else
  float f = v_fill.a * fill;
  float s = v_stroke.a * stroke;
  float a = s + f * (1.0 - s);
  if (a <= 0.0) discard;
  fragColor = vec4(v_stroke.rgb * s + v_fill.rgb * (f * (1.0 - s)), a);
#endif
}
