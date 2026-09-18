// ─── Object data layout (80 bytes = 20 × f32) ────────────────────────────────
//
//  offset  0 │ position        vec2<f32>   8 B
//  offset  8 │ velocity        vec2<f32>   8 B
//  offset 16 │ scale           vec2<f32>   8 B
//  offset 24 │ rotation        f32         4 B
//  offset 28 │ angularVelocity f32         4 B
//  offset 32 │ tint            vec4<f32>  16 B
//  offset 48 │ uvRect          vec4<f32>  16 B  (sprites / atlas)
//  offset 64 │ shapeType       u32         4 B
//  offset 68 │ flags           u32         4 B
//  offset 72 │ _pad            vec2<f32>   8 B
//            └───────────────────────────────── 80 B

struct ObjectData {
    position:        vec2<f32>,
    velocity:        vec2<f32>,
    scale:           vec2<f32>,
    rotation:        f32,
    angularVelocity: f32,
    tint:            vec4<f32>,
    uvRect:          vec4<f32>,
    shapeType:       u32,
    flags:           u32,
    _pad:            vec2<f32>,
};

struct Camera {
    view:       mat4x4<f32>,
    projection: mat4x4<f32>,
};

@group(0) @binding(0) var<storage, read> objects: array<ObjectData>;
@group(0) @binding(1) var<uniform>       camera:  Camera;

// ─── Vertex ───────────────────────────────────────────────────────────────────

struct VertexOutput {
    @builtin(position)              clipPos:   vec4<f32>,
    @location(0)                    uv:        vec2<f32>,
    @location(1)                    tint:      vec4<f32>,
    @location(2) @interpolate(flat) shapeType: u32,
};

@vertex
fn vs_main(
    @builtin(vertex_index)   vi: u32,
    @builtin(instance_index) ii: u32,
) -> VertexOutput {
    let obj = objects[ii];

    // Unit quad — two CW triangles, no vertex buffer needed
    var quad = array<vec2<f32>, 6>(
        vec2(-0.5,  0.5),
        vec2( 0.5,  0.5),
        vec2(-0.5, -0.5),
        vec2( 0.5,  0.5),
        vec2( 0.5, -0.5),
        vec2(-0.5, -0.5),
    );
    var uvs = array<vec2<f32>, 6>(
        vec2(0.0, 0.0),
        vec2(1.0, 0.0),
        vec2(0.0, 1.0),
        vec2(1.0, 0.0),
        vec2(1.0, 1.0),
        vec2(0.0, 1.0),
    );

    let lp = quad[vi];

    // 2D rotation
    let cr = cos(obj.rotation);
    let sr = sin(obj.rotation);
    let rotated = vec2(lp.x * cr - lp.y * sr, lp.x * sr + lp.y * cr);

    // Scale → translate into world space
    let worldPos = rotated * obj.scale + obj.position;

    var out: VertexOutput;
    out.clipPos   = camera.projection * camera.view * vec4(worldPos, 0.0, 1.0);
    out.uv        = uvs[vi];
    out.tint      = obj.tint;
    out.shapeType = obj.shapeType;
    return out;
}

// ─── Fragment ─────────────────────────────────────────────────────────────────

// Signed distance: negative = inside, positive = outside

fn sdCircle(p: vec2<f32>, r: f32) -> f32 {
    return length(p) - r;
}

fn sdBox(p: vec2<f32>, b: vec2<f32>) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sdEquilateralTriangle(p: vec2<f32>, r: f32) -> f32 {
    let k = sqrt(3.0);
    var q = vec2(abs(p.x) - r, -p.y + r / 2.0);
    if (q.x + k * q.y > 0.0) {
        q = vec2(q.x - k * q.y, -k * q.x - q.y) * 0.5;
    }
    q.x -= clamp(q.x, -r, 0.0);
    return -length(q) * sign(q.y);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // p centered at origin in [-0.5, 0.5]
    let p = in.uv - vec2(0.5, 0.5);
    var alpha = 1.0;

    switch (in.shapeType) {
        case 1u: {
            // Circle — smooth anti-aliased edge
            let d = sdCircle(p, 0.48);
            alpha = 1.0 - smoothstep(-0.015, 0.015, d);
        }
        case 2u: {
            // Equilateral triangle
            let d = sdEquilateralTriangle(p, 0.45);
            alpha = 1.0 - smoothstep(-0.015, 0.015, d);
        }
        case 3u: {
            // Rounded rectangle
            let d = sdBox(p, vec2(0.42, 0.42)) - 0.06;
            alpha = 1.0 - smoothstep(-0.015, 0.015, d);
        }
        default: {
            // Rectangle — full quad, perfectly sharp
            alpha = 1.0;
        }
    }

    if (alpha < 0.005) { discard; }
    return in.tint * vec4(1.0, 1.0, 1.0, alpha);
}
