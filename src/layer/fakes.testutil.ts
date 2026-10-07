/**
 * Test fakes for the SpriteLayer front and core: a FrontFrame over the real
 * command encoder, a packet decoder, and a recording backend / context /
 * pass. No GPU.
 */
import type {
  Backend,
  BindGroupDesc,
  BufferDesc,
  Capabilities,
  CommandList,
  ComputePass,
  RenderPass,
  RenderPipelineDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiTexture,
  ShaderSource,
  TextureDesc,
} from '../backend/types';
import { createCommandDecoder, createCommandEncoder } from '../commands';
import { CommandFlag, Op } from '../commands/opcodes';
import type { CommandEncoder, CommandReader } from '../commands/types';
import { FAKE_CAPS } from '../renderer/testing/fakeBackend';
import type {
  CoreContext,
  CoreFrameState,
  CoreSystem,
  CoreTexture,
  FrontFrame,
  FrontFrameHook,
} from '../types/core';

export interface Recorded {
  opcode: number;
  flags: number;
  words: number[];
  floats: number[];
  bytes: Uint8Array;
}

let nextRenderer = 1;
const RELEASED = new ArrayBuffer(0);

export class TestFrame implements FrontFrame {
  /** Unique per frame object, as per renderer (the layer front hooks once per id). */
  rendererId = nextRenderer++;
  encoder: CommandEncoder = createCommandEncoder();
  frameId = 0;
  time = 0;
  dt = 1 / 60;
  cssWidth = 800;
  cssHeight = 600;
  resolution = 1;
  sharedMemory = false;
  useSharedArrayBuffer = false;
  generation = 0;
  caps: Capabilities = { ...FAKE_CAPS, vertexStorage: true };
  ready = true;
  hooks: FrontFrameHook[] = [];
  shared: (ArrayBuffer | SharedArrayBuffer)[] = [];

  isSystemReady(): boolean {
    return this.ready;
  }

  registerShared(buffer: ArrayBuffer | SharedArrayBuffer): number {
    const i = this.shared.indexOf(buffer);
    if (i >= 0) return i + 1;
    this.shared.push(buffer);
    return this.shared.length;
  }

  /** Buffers given back with `_releaseShared`, in order. */
  released: (ArrayBuffer | SharedArrayBuffer)[] = [];
  /** `error` events (`_emit`). */
  errors: { code: string; message: string }[] = [];

  /** Emits SHARED_RELEASE; the id is never handed out again. */
  _releaseShared(buffer: ArrayBuffer | SharedArrayBuffer): void {
    const i = this.shared.indexOf(buffer);
    if (i < 0) return;
    this.encoder.begin(Op.SHARED_RELEASE, 4);
    this.encoder.u32(i + 1);
    this.encoder.end();
    this.shared[i] = RELEASED;
    this.released.push(buffer);
  }

  _emit(name: string, payload: { code: string; message: string }): void {
    if (name === 'error') this.errors.push(payload);
  }

  readback(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('unused'));
  }

  _addFrameHook(hook: FrontFrameHook): () => void {
    this.hooks.push(hook);
    return () => this.hooks.splice(this.hooks.indexOf(hook), 1);
  }

  /** Runs the encodeFrame hooks (start of a frame, before the pack). */
  begin(): void {
    for (const h of this.hooks) h.encodeFrame(this);
  }

  /** Finishes and decodes the packet, starts the next frame. */
  end(): Recorded[] {
    const packet = this.encoder.finish(this.frameId++);
    const out = decode(packet);
    this.encoder.reset();
    return out;
  }
}

export function decode(
  packet: ReturnType<CommandEncoder['finish']>,
): Recorded[] {
  const decoder = createCommandDecoder();
  decoder.reset(packet);
  const out: Recorded[] = [];
  while (decoder.next()) {
    const r = decoder.reader;
    const words: number[] = [];
    const floats: number[] = [];
    const base = r.payloadOffset >> 2;
    for (let i = 0; i < r.payloadBytes >> 2; i++) {
      words.push(r.u32View[base + i]);
      floats.push(r.f32View[base + i]);
    }
    out.push({
      opcode: r.opcode,
      flags: r.flags,
      words,
      floats,
      bytes: r.u8.slice(r.payloadOffset, r.payloadOffset + r.payloadBytes),
    });
  }
  return out;
}

// ─── Core side ────────────────────────────────────────────────────────────────

const res = (label?: string) => ({ label, destroy() {} });

export class FakeBuffer {
  destroyed = false;
  constructor(readonly desc: BufferDesc) {}
  get label() {
    return this.desc.label;
  }
  get size() {
    return this.desc.size;
  }
  get usage() {
    return this.desc.usage;
  }
  destroy() {
    this.destroyed = true;
  }
}

export class LayerBackend {
  caps: Capabilities = { ...FAKE_CAPS, vertexStorage: true };
  readonly calls: string[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly writes: { label: string; offset: number; bytes: Uint8Array }[] = [];
  readonly modules: ShaderSource[] = [];
  readonly pipelines: RenderPipelineDesc[] = [];
  readonly groups: BindGroupDesc[] = [];

  createBuffer(desc: BufferDesc): RhiBuffer {
    const b = new FakeBuffer(desc);
    this.buffers.push(b);
    return b;
  }
  writeBuffer(
    buffer: RhiBuffer,
    offset: number,
    data: ArrayBufferView,
    dataOffset = 0,
    byteLength = data.byteLength - dataOffset,
  ): void {
    this.writes.push({
      label: buffer.label ?? '',
      offset,
      bytes: new Uint8Array(
        data.buffer.slice(
          data.byteOffset + dataOffset,
          data.byteOffset + dataOffset + byteLength,
        ),
      ),
    });
  }
  createTexture(desc: TextureDesc): RhiTexture {
    this.calls.push(`createTexture ${desc.width}x${desc.height}`);
    return { ...res(desc.label), ...desc, mipLevelCount: 1, sampleCount: 1 };
  }
  writeTexture(
    t: RhiTexture,
    data: ArrayBufferView,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    this.calls.push(`writeTexture ${x},${y} ${w}x${h} ${data.byteLength}`);
  }
  createSampler() {
    return res('sampler');
  }
  createShaderModule(source: ShaderSource) {
    this.modules.push(source);
    return res(source.label);
  }
  createBindGroupLayout(desc: { label?: string }) {
    return res(desc.label);
  }
  createBindGroup(desc: BindGroupDesc): RhiBindGroup {
    this.groups.push(desc);
    return res(desc.label ?? `group${this.groups.length}`);
  }
  createRenderPipeline(desc: RenderPipelineDesc) {
    this.pipelines.push(desc);
    return Promise.resolve(res(desc.label));
  }
  createComputePipeline(desc: { label?: string }) {
    return Promise.resolve(res(desc.label));
  }
}

export class RecordPass {
  readonly calls: string[] = [];
  setPipeline(p: { label?: string }) {
    this.calls.push(`pipeline ${p.label}`);
  }
  setBindGroup(i: number, g: RhiBindGroup, offsets?: Uint32Array) {
    this.calls.push(`bind ${i} ${g.label}${offsets ? ` @${offsets[0]}` : ''}`);
  }
  setVertexBuffer(slot: number, b: RhiBuffer) {
    this.calls.push(`vertex ${slot} ${b.label}`);
  }
  draw(v: number, n = 1) {
    this.calls.push(`draw ${v}x${n}`);
  }
  drawIndirect(b: RhiBuffer, offset: number) {
    this.calls.push(`drawIndirect ${b.label} ${offset}`);
  }
  dispatch(x: number, y = 1) {
    this.calls.push(`dispatch ${x}x${y}`);
  }
  end() {
    this.calls.push('end');
  }
}

export function fakeTexture(label: string): CoreTexture {
  return {
    texture: { ...res(label) } as RhiTexture,
    sampler: res(`${label}.sampler`),
    bindGroup: res(`${label}.group`),
    width: 1,
    height: 1,
  };
}

export interface LayerContext extends CoreContext {
  textures: Map<number, CoreTexture>;
  external: Map<number, RhiBuffer>;
  sharedMap: Map<number, ArrayBuffer | SharedArrayBuffer>;
  posted: unknown[];
}

export function createContext(backend: LayerBackend): LayerContext {
  const white = fakeTexture('white');
  const textures = new Map<number, CoreTexture>();
  const external = new Map<number, RhiBuffer>();
  const sharedMap = new Map<number, ArrayBuffer | SharedArrayBuffer>();
  const posted: unknown[] = [];
  return {
    backend: backend as unknown as Backend,
    viewLayout: res('viewLayout'),
    viewBindGroup: res('view'),
    textureLayout: res('textureLayout'),
    whiteTexture: white,
    getTexture: id => textures.get(id) ?? white,
    getShared: id => sharedMap.get(id),
    getExternalBuffer: id => external.get(id),
    sampleCount: 1,
    post: m => void posted.push(m),
    textures,
    external,
    sharedMap,
    posted,
  };
}

export const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

export function frameState(frameId = 1): CoreFrameState {
  return {
    frameId,
    time: 0,
    dt: 1 / 60,
    pixelWidth: 800,
    pixelHeight: 600,
    cssWidth: 800,
    cssHeight: 600,
    resolution: 1,
  };
}

/**
 * Feeds one packet through `core` as RenderCore does: non-DRAW commands
 * first, then compute, then the DRAW commands (and the pick pass when
 * `pick`). Returns the pass and compute-pass calls.
 */
export function runPacket(
  core: CoreSystem,
  encoder: CommandEncoder,
  frameId = 1,
  pick = false,
): { pass: RecordPass; compute: RecordPass } {
  const frame = frameState(frameId);
  const decoder = createCommandDecoder();
  decoder.reset(encoder.finish(frameId));
  const reader: CommandReader = decoder.reader;
  const draws: number[] = [];
  while (decoder.next()) {
    if ((reader.flags & CommandFlag.DRAW) !== 0) {
      draws.push(reader.commandOffset);
    } else core.execute(reader, frame);
  }
  const compute = new RecordPass();
  const list = {
    beginComputePass: () => compute as unknown as ComputePass,
  } as unknown as CommandList;
  core.compute?.(list, frame);
  const pass = new RecordPass();
  for (let i = 0; i < draws.length; i++) {
    decoder.seek(draws[i]);
    core.draw(reader, pass as unknown as RenderPass, frame);
  }
  if (pick) {
    for (let i = 0; i < draws.length; i++) {
      decoder.seek(draws[i]);
      core.drawPick?.(
        reader,
        pass as unknown as RenderPass,
        frame,
        res('pickView'),
      );
    }
  }
  core.endFrame?.(frame);
  encoder.reset();
  return { pass, compute };
}
