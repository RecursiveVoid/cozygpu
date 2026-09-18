// ─── Uniforms ────────────────────────────────────────────────────────────────

struct Camera {
    view:       mat4x4<f32>,
    projection: mat4x4<f32>,
};

@binding(0) @group(0) var<uniform>  camera:        Camera;
@binding(1) @group(0) var           spriteTexture: texture_2d<f32>;
@binding(2) @group(0) var           spriteSampler: sampler;

// ─── Vertex I/O ──────────────────────────────────────────────────────────────

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
    @location(1)       tint:     vec4<f32>,
};

// ─── Vertex shader ───────────────────────────────────────────────────────────

@vertex
fn vs_main(
    // Per-vertex — from QuadMesh (locations 0-1)
    @location(0) position: vec3<f32>,
    @location(1) uv:       vec2<f32>,

    // Per-instance — model matrix split into 4 columns (locations 2-5)
    @location(2) col0: vec4<f32>,
    @location(3) col1: vec4<f32>,
    @location(4) col2: vec4<f32>,
    @location(5) col3: vec4<f32>,

    // Per-instance — atlas rect (xy = uv offset, zw = uv scale) and tint
    @location(6) uvRect: vec4<f32>,
    @location(7) tint:   vec4<f32>,
) -> VertexOutput {
    let model = mat4x4<f32>(col0, col1, col2, col3);

    var out: VertexOutput;
    out.position = camera.projection * camera.view * model * vec4<f32>(position, 1.0);
    // Map [0,1] quad uv into atlas sub-rect
    out.uv   = uvRect.xy + uv * uvRect.zw;
    out.tint = tint;
    return out;
}

// ─── Fragment shader ─────────────────────────────────────────────────────────

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(spriteTexture, spriteSampler, in.uv);
    return color * in.tint;
}
