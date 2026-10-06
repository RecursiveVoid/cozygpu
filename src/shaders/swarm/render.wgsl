// cozygpu swarm render template.
// The composer prepends prelude.wgsl and replaces whole marker lines:
//   FLAGS      const bools RF_FADE_OUT, RF_SHRINK, RF_ALIGN, RF_CIRCLE, RF_CURVES
//   SLOT_DECL  the `visible` binding when culling / allocation 'gpu'
//   SLOT       `let slot = ...;`
//   COLOR      body of swarm_color (textured quad or SDF circle)
// No vertex buffers: 4-vertex triangle strip per instance, geometry from
// vertex_index, per-object data read from storage (hot, cold, frames).
// Output is premultiplied alpha. fs_pick (M2 picking, ARCHITECTURE §14.5)
// writes vec4u(pickId, slot + 1, user, 0) into the rgba32uint pick target.

//@FLAGS

// PICK_ALPHA_THRESHOLD (src/types/layouts.ts)
const SWARM_PICK_ALPHA: f32 = 0.5;

// Over-life curves (SWARM_SET_CURVES): four stops of packed color, size
// multiplier and alpha multiplier, evaluated here when RF_CURVES is set.
struct SwarmCurves {
  stops: vec4f,
  color: vec4u,
  size: vec4f,
  alpha: vec4f,
}

struct SwarmPick {
  id: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var swarmTexture: texture_2d<f32>;
@group(1) @binding(1) var swarmSampler: sampler;
@group(2) @binding(0) var<storage, read> hot: array<SwarmHot>;
@group(2) @binding(1) var<storage, read> cold: array<SwarmCold>;
@group(2) @binding(2) var<storage, read> frames: array<vec4f>;
@group(2) @binding(3) var<uniform> draw: SwarmDraw;
@group(2) @binding(5) var<uniform> swarmPick: SwarmPick;
@group(2) @binding(6) var<uniform> curves: SwarmCurves;
//@SLOT_DECL

// Piecewise-linear weights of the four over-life stops at normalized age t
// (src/types/layouts.ts SWARM_CURVE_BYTES). Branch-free: at most two weights
// are non-zero, so a value is `dot(w, stops)`.
fn swarm_curve_w(t: f32) -> vec4f {
  let s = curves.stops;
  let u0 = clamp((t - s.x) / max(s.y - s.x, 1e-6), 0.0, 1.0);
  let u1 = clamp((t - s.y) / max(s.z - s.y, 1e-6), 0.0, 1.0);
  let u2 = clamp((t - s.z) / max(s.w - s.z, 1e-6), 0.0, 1.0);
  return vec4f(1.0 - u0, u0 - u0 * u1, u1 - u1 * u2, u2);
}

struct SwarmVertex {
  @builtin(position) position: vec4f,
  // textured: atlas uv; circle: quad-local coords in [-1, 1]
  @location(0) uv: vec2f,
  // premultiplied
  @location(1) color: vec4f,
  // object slot (picking)
  @location(2) @interpolate(flat) slot: u32,
  // cold.user, the instance user id (picking, ARCHITECTURE §19.3)
  @location(3) @interpolate(flat) user: u32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> SwarmVertex {
  var out: SwarmVertex;
//@SLOT
  out.slot = slot;
  let h = hot[slot];
  if (h.life <= 0.0) {
    // degenerate, clipped
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let c = cold[slot];
  out.user = c.user;
  let q = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let t = 1.0 - clamp(h.age / h.life, 0.0, 1.0);

  // Over-life curves: identity multipliers unless RF_CURVES.
  var curveTint = vec4f(1.0);
  var curveSize = 1.0;
  if (RF_CURVES) {
    let cw = swarm_curve_w(1.0 - t);
    curveSize = dot(cw, curves.size);
    curveTint =
      unpack4x8unorm(curves.color.x) * cw.x +
      unpack4x8unorm(curves.color.y) * cw.y +
      unpack4x8unorm(curves.color.z) * cw.z +
      unpack4x8unorm(curves.color.w) * cw.w;
    curveTint.a *= dot(cw, curves.alpha);
  }

  var size = h.scale * curveSize;
  if (RF_SHRINK) {
    size *= t;
  }
  var ang = h.rot;
  if (RF_ALIGN) {
    ang = atan2(h.vel.y, h.vel.x);
  }
  let cs = cos(ang);
  let sn = sin(ang);
  let corner = (q - 0.5) * size;
  let local = vec2f(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs) + h.pos;
  let stage = draw.col0 * local.x + draw.col1 * local.y + draw.translate;
  let css = view.col0 * stage.x + view.col1 * stage.y + view.translate;
  out.position = vec4f(
    css.x / view.resolution.x * 2.0 - 1.0,
    1.0 - css.y / view.resolution.y * 2.0,
    0.0,
    1.0,
  );

  let color = unpack4x8unorm(c.color) * curveTint;
  var a = color.a * draw.alpha;
  if (RF_FADE_OUT) {
    a *= t;
  }
  out.color = vec4f(color.rgb * a, a);

  if (RF_CIRCLE) {
    out.uv = q * 2.0 - 1.0;
  } else {
    let fr = frames[min(c.frame, arrayLength(&frames) - 1u)];
    out.uv = mix(fr.xy, fr.zw, q);
  }
  return out;
}

// Premultiplied fragment color (may discard).
fn swarm_color(in: SwarmVertex) -> vec4f {
//@COLOR
}

@fragment
fn fs_main(in: SwarmVertex) -> @location(0) vec4f {
  return swarm_color(in);
}

@fragment
fn fs_pick(in: SwarmVertex) -> @location(0) vec4u {
  let color = swarm_color(in);
  if (color.a < SWARM_PICK_ALPHA) {
    discard;
  }
  return vec4u(swarmPick.id, in.slot + 1u, in.user, 0u);
}
