/**
 * SpriteLayer benchmark page (ARCHITECTURE §28.7), driven by
 * benchmarks/layer/run.mjs. One scene, two libraries:
 *
 *   ?lib=cozygpu|pixi|three  &backend=webgpu|webgl2  &n=1000000
 *   &case=static    N 8 px sprites written once; nothing changes per frame
 *   &case=tex8      static, the sprites cycle through 8 textures
 *                   (cozygpu: one layer, frame = i % 8; Pixi: one
 *                   ParticleContainer per texture; Three: one InstancedMesh
 *                   per texture)
 *   &case=xy        an ECS bounce step moves every sprite each frame; the
 *                   positions live in one interleaved Float32Array
 *                   (cozygpu: the direct `xy` column, zero-copy upload)
 *   &case=packed    the same step on separate x / y arrays (cozygpu: packed
 *                   `x` / `y` columns, converted in render())
 *   &case=external  cozygpu only, WebGPU: positions written by a compute pass
 *                   into a registered buffer, drawn with zero uploads
 *
 * Pixi: ParticleContainer + Particle (its fastest path); moving cases copy
 * the ECS arrays into particle.x / particle.y, which is what an ECS has to
 * do there. Three: InstancedMesh (a 4×4 matrix per instance); moving cases
 * write the translation slots and flag `instanceMatrix.needsUpdate`. The step itself is identical and NOT timed: `frontMs` is the
 * library's share (column handoff / particle writes + render()).
 * `window.__bench` exposes the rolling numbers, plus the GPU buffer bytes
 * the library holds (createBuffer / bufferData hooks) and the JS heap of
 * the populated scene (`--js-flags=--expose-gc`), both per instance.
 */
import * as GPU from 'cozygpu';

const q = new URLSearchParams(location.search);
const LIB = q.get('lib') ?? 'cozygpu';
const BACKEND = q.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu';
const CASE = q.get('case') ?? 'static';
const N = Number(q.get('n') ?? 1_000_000) | 0;
const W = 1280;
const H = 720;
const SIZE = 8;
const TEXTURES = CASE === 'tex8' ? 8 : 1;

const memory = { gpuBytes: 0, heapBase: 0, heapScene: 0 };

/** Tracks the bytes of every GPU buffer the page creates. */
function hookGpuMemory(): void {
  if (typeof GPUDevice !== 'undefined') {
    const create = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (desc) {
      const buffer = create.call(this, desc);
      const size = desc.size;
      memory.gpuBytes += size;
      const destroy = buffer.destroy;
      let live = true;
      buffer.destroy = function () {
        if (live) memory.gpuBytes -= size;
        live = false;
        destroy.call(this);
      };
      return buffer;
    };
  }
  const gl = WebGL2RenderingContext.prototype;
  const sizes = new Map<WebGLBuffer, number>();
  const bindingOf: Record<number, number> = {
    [gl.ARRAY_BUFFER]: gl.ARRAY_BUFFER_BINDING,
    [gl.ELEMENT_ARRAY_BUFFER]: gl.ELEMENT_ARRAY_BUFFER_BINDING,
    [gl.UNIFORM_BUFFER]: gl.UNIFORM_BUFFER_BINDING,
    [gl.COPY_READ_BUFFER]: gl.COPY_READ_BUFFER_BINDING,
    [gl.COPY_WRITE_BUFFER]: gl.COPY_WRITE_BUFFER_BINDING,
    [gl.PIXEL_PACK_BUFFER]: gl.PIXEL_PACK_BUFFER_BINDING,
    [gl.PIXEL_UNPACK_BUFFER]: gl.PIXEL_UNPACK_BUFFER_BINDING,
    [gl.TRANSFORM_FEEDBACK_BUFFER]: gl.TRANSFORM_FEEDBACK_BUFFER_BINDING,
  };
  const bufferData = gl.bufferData as (...a: unknown[]) => void;
  (gl as unknown as { bufferData: unknown }).bufferData = function (
    this: WebGL2RenderingContext,
    ...a: unknown[]
  ) {
    const target = a[0] as number;
    const src = a[1];
    let size = 0;
    if (typeof src === 'number') size = src;
    else if (ArrayBuffer.isView(src)) {
      const bpe =
        (src as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ??
        1;
      const offset = (a[3] as number | undefined) ?? 0;
      const length = a[4] as number | undefined;
      size = length ? length * bpe : src.byteLength - offset * bpe;
    } else if (src instanceof ArrayBuffer) size = src.byteLength;
    const buffer = this.getParameter(bindingOf[target]) as WebGLBuffer | null;
    if (buffer) {
      memory.gpuBytes += size - (sizes.get(buffer) ?? 0);
      sizes.set(buffer, size);
    }
    bufferData.apply(this, a);
  };
  const deleteBuffer = gl.deleteBuffer;
  gl.deleteBuffer = function (buffer) {
    if (buffer && sizes.has(buffer)) {
      memory.gpuBytes -= sizes.get(buffer)!;
      sizes.delete(buffer);
    }
    deleteBuffer.call(this, buffer);
  };
}

/** Used JS heap after a forced GC (needs --js-flags=--expose-gc). */
function heap(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return (
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      ?.usedJSHeapSize ?? 0
  );
}

const bench = {
  ready: false,
  error: '',
  backend: '',
  frames: 0,
  frontMs: 0,
  fps: 0,
  start: 0,
  reset(): void {
    this.frames = 0;
    this.frontMs = 0;
    this.start = performance.now();
  },
  /** Waits until the GPU finished everything submitted (set per library). */
  sync: null as (() => Promise<void>) | null,
  frame: null as ((dt: number) => number) | null,
  paused: false,
  /**
   * GPU-inclusive cost: K frames back to back, then a wait for the GPU.
   * Uncapped rAF fps can overstate a library that never waits for the GPU;
   * this cannot.
   */
  async gpuMs(k: number): Promise<number> {
    this.paused = true;
    await this.sync!();
    const t0 = performance.now();
    for (let i = 0; i < k; i++) {
      this.frame!(1 / 60);
      // cozygpu skips a render() while the previous frame's completion
      // message is pending; a message-channel yield lets it land. Both
      // libraries get the same yield.
      await yieldTask();
    }
    await this.sync!();
    this.paused = false;
    return (performance.now() - t0) / k;
  },
  result() {
    const n = Math.max(1, this.frames);
    return {
      backend: this.backend,
      frames: this.frames,
      fps: (this.frames * 1000) / (performance.now() - this.start),
      frontMs: this.frontMs / n,
      gpuBytesPerInstance: memory.gpuBytes / N,
      heapBytesPerInstance: (memory.heapScene - memory.heapBase) / N,
    };
  },
};
(globalThis as { __bench?: typeof bench }).__bench = bench;

/** Seeded PRNG: both libraries get the same scene. */
let seed = 12345;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 8×8 soft disc, premultiplied; texture k gets its own tint. */
function disc(k = 0): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 4);
  const tint = k === 0 ? 0xffffff : (0x3fa9f5 * (k + 1)) & 0xffffff;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
      const a = Math.max(0, Math.min(1, SIZE / 2 - d));
      const o = 4 * (y * SIZE + x);
      px[o] = (tint & 0xff) * a;
      px[o + 1] = ((tint >> 8) & 0xff) * a;
      px[o + 2] = ((tint >> 16) & 0xff) * a;
      px[o + 3] = 255 * a;
    }
  }
  return px;
}

// The "ECS": positions and velocities, SoA and interleaved.
const xy = new Float32Array(2 * N);
const xs = new Float32Array(N);
const ys = new Float32Array(N);
const vx = new Float32Array(N);
const vy = new Float32Array(N);
for (let i = 0; i < N; i++) {
  xs[i] = xy[2 * i] = random() * W;
  ys[i] = xy[2 * i + 1] = random() * H;
  vx[i] = (random() - 0.5) * 120;
  vy[i] = (random() - 0.5) * 120;
}

function stepInterleaved(dt: number): void {
  for (let i = 0, p = 0; i < N; i++, p += 2) {
    const x = xy[p] + vx[i] * dt;
    const y = xy[p + 1] + vy[i] * dt;
    if (x < 0 || x > W) vx[i] = -vx[i];
    if (y < 0 || y > H) vy[i] = -vy[i];
    xy[p] = x;
    xy[p + 1] = y;
  }
}

function stepSoA(dt: number): void {
  for (let i = 0; i < N; i++) {
    const x = xs[i] + vx[i] * dt;
    const y = ys[i] + vy[i] * dt;
    if (x < 0 || x > W) vx[i] = -vx[i];
    if (y < 0 || y > H) vy[i] = -vy[i];
    xs[i] = x;
    ys[i] = y;
  }
}

const channel = new MessageChannel();
/** Resolves on the next task (faster than setTimeout's clamp). */
function yieldTask(): Promise<void> {
  return new Promise(resolve => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}

/** GPU sync for a WebGL2 context (1-pixel readback) or a GPUDevice. */
function syncFor(device: unknown): () => Promise<void> {
  if (
    typeof WebGL2RenderingContext !== 'undefined' &&
    device instanceof WebGL2RenderingContext
  ) {
    const px = new Uint8Array(4);
    return async () => {
      device.readPixels(0, 0, 1, 1, device.RGBA, device.UNSIGNED_BYTE, px);
    };
  }
  return () => (device as GPUDevice).queue.onSubmittedWorkDone();
}

async function cozygpu(canvas: HTMLCanvasElement) {
  const renderer = await GPU.createRenderer({
    canvas,
    width: W,
    height: H,
    resolution: 1,
    backend: BACKEND,
    background: 0x101018,
    limits: 'max',
  });
  bench.backend = renderer.info.backend;
  const interop = await renderer.interop();
  bench.sync = syncFor(interop.device);
  memory.heapBase = heap();
  const textures: GPU.TextureHandle[] = [];
  for (let k = 0; k < TEXTURES; k++) {
    textures.push(GPU.Texture.fromPixels(SIZE, SIZE, disc(k)));
  }
  const layer = new GPU.SpriteLayer({
    capacity: N,
    textures,
    streams: { xform: TEXTURES > 1, color: false },
  });
  renderer.stage.addChild(layer);
  await layer.ready;
  let step: (dt: number) => void = () => {};
  let handoff: () => void = () => {};
  if (CASE === 'static') {
    layer.data.position.set(xy);
    layer.markDirty(0, N);
    layer.count = N;
  } else if (CASE === 'tex8') {
    for (let i = 0; i < N; i++) {
      layer.setInstance(i, xy[2 * i], xy[2 * i + 1], 0, 1, i & 7);
    }
    layer.count = N;
  } else if (CASE === 'xy') {
    const binding = layer.bindColumns({ xy });
    step = stepInterleaved;
    handoff = () => binding.commit(N);
  } else if (CASE === 'packed') {
    const binding = layer.bindColumns({ x: xs, y: ys });
    step = stepSoA;
    handoff = () => binding.commit(N);
  } else if (CASE === 'external') {
    step = await external(renderer, layer);
  }
  return (dt: number) => {
    step(dt);
    const t0 = performance.now();
    handoff();
    renderer.render();
    return performance.now() - t0;
  };
}

/** GPU-written positions + draw count (zero uploads, no readback). */
async function external(
  renderer: GPU.Renderer,
  layer: GPU.SpriteLayerNode,
): Promise<(dt: number) => void> {
  const interop = await renderer.interop();
  const device = interop.device as GPUDevice;
  const pos = device.createBuffer({
    size: 8 * N,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(pos, 0, xy);
  const vel = device.createBuffer({
    size: 8 * N,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const v = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    v[2 * i] = vx[i];
    v[2 * i + 1] = vy[i];
  }
  device.queue.writeBuffer(vel, 0, v);
  const args = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(args, 0, new Uint32Array([4, N, 0, 0]));
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const module = device.createShaderModule({
    code: /* wgsl */ `
      struct P { dt: f32, w: f32, h: f32, n: u32 }
      @group(0) @binding(0) var<uniform> p: P;
      @group(0) @binding(1) var<storage, read_write> pos: array<vec2f>;
      @group(0) @binding(2) var<storage, read_write> vel: array<vec2f>;
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) g: vec3u) {
        let i = g.y * 65535u * 256u + g.x;
        if (i >= p.n) { return; }
        var x = pos[i] + vel[i] * p.dt;
        var v = vel[i];
        if (x.x < 0.0 || x.x > p.w) { v.x = -v.x; }
        if (x.y < 0.0 || x.y > p.h) { v.y = -v.y; }
        pos[i] = x;
        vel[i] = v;
      }`,
  });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: pos } },
      { binding: 2, resource: { buffer: vel } },
    ],
  });
  layer.setSource({
    position: interop.registerInstanceBuffer(pos, {
      layout: 'layer-position',
      capacity: N,
    }),
    indirect: interop.registerInstanceBuffer(args, {
      layout: 'draw-indirect',
      capacity: 1,
    }),
  });
  const data = new Float32Array(4);
  const u32 = new Uint32Array(data.buffer);
  const groups = Math.ceil(N / 256);
  return dt => {
    data[0] = dt;
    data[1] = W;
    data[2] = H;
    u32[3] = N;
    device.queue.writeBuffer(params, 0, data);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
}

async function pixi(canvas: HTMLCanvasElement) {
  const { Application, Particle, ParticleContainer, Texture } =
    await import('pixi.js');
  const app = new Application();
  await app.init({
    canvas,
    width: W,
    height: H,
    resolution: 1,
    antialias: false,
    backgroundColor: 0x101018,
    preference: BACKEND === 'webgl2' ? 'webgl' : 'webgpu',
    autoStart: false,
    sharedTicker: false,
  });
  app.ticker.stop();
  bench.backend = app.renderer.name;
  const r = app.renderer as unknown as {
    gl?: WebGL2RenderingContext;
    gpu?: { device: GPUDevice };
  };
  bench.sync = syncFor(r.gl ?? r.gpu!.device);
  memory.heapBase = heap();
  const moving = CASE !== 'static' && CASE !== 'tex8';
  const containers: InstanceType<typeof ParticleContainer>[] = [];
  const textures: InstanceType<typeof Texture>[] = [];
  for (let k = 0; k < TEXTURES; k++) {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const image = new ImageData(SIZE, SIZE);
    image.data.set(disc(k));
    c.getContext('2d')!.putImageData(image, 0, 0);
    const texture = Texture.from(c);
    textures.push(texture);
    const pc = new ParticleContainer({
      texture,
      dynamicProperties: {
        position: moving,
        vertex: false,
        rotation: false,
        uvs: false,
        color: false,
      },
    });
    containers.push(pc);
    app.stage.addChild(pc);
  }
  // One particle list per texture (Pixi needs one texture source per
  // ParticleContainer); `all` keeps ECS order for the moving cases.
  const all: InstanceType<typeof Particle>[] = [];
  for (let i = 0; i < N; i++) {
    const k = i % TEXTURES;
    const p = new Particle({
      texture: textures[k],
      x: xs[i],
      y: ys[i],
      anchorX: 0.5,
      anchorY: 0.5,
    });
    containers[k].particleChildren.push(p);
    all.push(p);
  }
  for (const pc of containers) pc.update();
  let step: (dt: number) => void = () => {};
  let handoff: () => void = () => {};
  if (CASE === 'xy') {
    step = stepInterleaved;
    handoff = () => {
      for (let i = 0; i < N; i++) {
        const p = all[i];
        p.x = xy[2 * i];
        p.y = xy[2 * i + 1];
      }
    };
  } else if (CASE === 'packed') {
    step = stepSoA;
    handoff = () => {
      for (let i = 0; i < N; i++) {
        const p = all[i];
        p.x = xs[i];
        p.y = ys[i];
      }
    };
  } else if (CASE !== 'static' && CASE !== 'tex8') {
    throw new Error(`pixi: no '${CASE}' case`);
  }
  return (dt: number) => {
    step(dt);
    const t0 = performance.now();
    handoff();
    app.renderer.render(app.stage);
    return performance.now() - t0;
  };
}

/**
 * Three: InstancedMesh per texture, orthographic pixel camera. WebGPU uses
 * `three/webgpu` (a fallback to its WebGL2 backend fails the case).
 */
async function three(canvas: HTMLCanvasElement) {
  const webgpu = BACKEND === 'webgpu';
  const T = webgpu ? await import('three/webgpu') : await import('three');
  let render: () => void;
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(0, W, 0, H, -10, 10);
  if (webgpu) {
    const W3 = T as typeof import('three/webgpu');
    const renderer = new W3.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.setClearColor(0x101018, 1);
    renderer.sortObjects = false;
    await renderer.init();
    const backend = renderer.backend as {
      isWebGPUBackend?: boolean;
      device?: GPUDevice;
    };
    if (!backend.isWebGPUBackend) throw new Error('three fell back to WebGL2');
    bench.backend = 'webgpu';
    bench.sync = syncFor(backend.device);
    render = () => renderer.render(scene, camera);
  } else {
    const renderer = new (T as typeof import('three')).WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.setClearColor(0x101018, 1);
    renderer.sortObjects = false;
    bench.backend = 'webgl2';
    bench.sync = syncFor(renderer.getContext());
    render = () => renderer.render(scene, camera);
  }
  memory.heapBase = heap();
  const moving = CASE === 'xy' || CASE === 'packed';
  const geometry = new T.PlaneGeometry(SIZE, SIZE);
  const meshes: {
    mesh: InstanceType<typeof T.InstancedMesh>;
    m: Float32Array;
  }[] = [];
  const per = Math.ceil(N / TEXTURES);
  for (let k = 0; k < TEXTURES; k++) {
    const tex = new T.DataTexture(disc(k), SIZE, SIZE, T.RGBAFormat);
    tex.premultiplyAlpha = false;
    tex.magFilter = T.LinearFilter;
    tex.minFilter = T.LinearFilter;
    tex.needsUpdate = true;
    const params = {
      map: tex,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
      side: T.DoubleSide,
    };
    const material = webgpu
      ? new (T as typeof import('three/webgpu')).MeshBasicNodeMaterial(params)
      : new T.MeshBasicMaterial(params);
    const count = Math.min(per, N - k * per);
    const mesh = new T.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(
      moving ? T.DynamicDrawUsage : T.StaticDrawUsage,
    );
    const m = mesh.instanceMatrix.array as Float32Array;
    meshes.push({ mesh, m });
    scene.add(mesh);
  }
  // Instance i lives in mesh i % TEXTURES, slot i / TEXTURES.
  for (let i = 0; i < N; i++) {
    const o = 16 * Math.floor(i / TEXTURES);
    const m = meshes[i % TEXTURES].m;
    m[o] = m[o + 5] = m[o + 10] = m[o + 15] = 1;
    m[o + 12] = xy[2 * i];
    m[o + 13] = xy[2 * i + 1];
  }
  for (const { mesh } of meshes) mesh.instanceMatrix.needsUpdate = true;
  let step: (dt: number) => void = () => {};
  let handoff: () => void = () => {};
  if (moving) {
    const m = meshes[0].m;
    const attr = meshes[0].mesh.instanceMatrix;
    step = stepInterleaved;
    handoff = () => {
      for (let i = 0, o = 12; i < N; i++, o += 16) {
        m[o] = xy[2 * i];
        m[o + 1] = xy[2 * i + 1];
      }
      attr.needsUpdate = true;
    };
  } else if (CASE !== 'static' && CASE !== 'tex8') {
    throw new Error(`three: no '${CASE}' case`);
  }
  return (dt: number) => {
    step(dt);
    const t0 = performance.now();
    handoff();
    render();
    return performance.now() - t0;
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  hookGpuMemory();
  const frame =
    LIB === 'pixi'
      ? await pixi(canvas)
      : LIB === 'three'
        ? await three(canvas)
        : await cozygpu(canvas);
  frame(1 / 60);
  memory.heapScene = heap();
  bench.frame = frame;
  bench.ready = true;
  bench.reset();
  let last = performance.now();
  const loop = (now: number) => {
    if (bench.paused) {
      requestAnimationFrame(loop);
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    bench.frontMs += frame(dt);
    bench.frames++;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch(err => {
  bench.error = String((err as Error)?.message ?? err);
  console.error(err);
});
