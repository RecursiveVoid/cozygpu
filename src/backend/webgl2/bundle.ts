/**
 * Render bundles for the WebGL2 backend (ARCHITECTURE §27.3), a lazily
 * loaded chunk (`WebGL2Backend.loadRenderBundles`).
 *
 * WebGL has no bundles: a bundle is the recorded list of RHI calls (a u32 op
 * stream plus a table of the objects they name), replayed through the render
 * pass and its state cache. That saves the command decoding and the systems'
 * per-draw logic, not GL calls. As on WebGPU, a bundle runs only in a pass
 * with the attachments it was recorded for, and pass-state calls make it
 * unrecordable (`finish` returns null).
 */
import type {
  Backend,
  IndexFormat,
  RenderBundleEncoder,
  RenderPass,
  RenderPassDesc,
  RhiBindGroup,
  RhiBuffer,
  RhiRenderBundle,
  RhiRenderPipeline,
} from '../types';
import type { GLCommandList, GLRenderPass } from './commands';
import type { GLTexture } from './resources';

const OP_PIPELINE = 1;
const OP_BIND = 2;
const OP_VERTEX = 3;
const OP_INDEX = 4;
const OP_DRAW = 5;
const OP_INDEXED = 6;

/** Dynamic offset arrays by length, reused by every replay. */
const OFFSETS = [0, 1, 2, 3, 4].map(n => new Uint32Array(n));

interface PassFormats {
  _color?: string;
  _samples?: number;
  _depth?: string;
}

class GLBundle implements RhiRenderBundle {
  constructor(
    readonly ops: Uint32Array,
    readonly objects: unknown[],
    readonly color: string | undefined,
    readonly samples: number | undefined,
    readonly depth: string | undefined,
  ) {}

  readonly label = 'cozygpu.retained';

  destroy(): void {}
}

class GLBundleEncoder implements RenderBundleEncoder {
  private ops = new Uint32Array(64);
  private n = 0;
  private readonly objects: unknown[] = [];
  private ok = true;

  constructor(private readonly pass: PassFormats) {}

  private room(k: number): Uint32Array {
    if (this.n + k > this.ops.length) {
      const grown = new Uint32Array(Math.max(this.ops.length * 2, this.n + k));
      grown.set(this.ops);
      this.ops = grown;
    }
    return this.ops;
  }

  private object(o: unknown): number {
    this.objects.push(o);
    return this.objects.length - 1;
  }

  setPipeline(pipeline: RhiRenderPipeline): void {
    const ops = this.room(2);
    ops[this.n++] = OP_PIPELINE;
    ops[this.n++] = this.object(pipeline);
  }

  setBindGroup(
    index: number,
    group: RhiBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void {
    const count = dynamicOffsets ? Math.min(dynamicOffsets.length, 4) : 0;
    const ops = this.room(4 + count);
    ops[this.n++] = OP_BIND;
    ops[this.n++] = index;
    ops[this.n++] = this.object(group);
    ops[this.n++] = count;
    for (let i = 0; i < count; i++) ops[this.n++] = dynamicOffsets![i];
  }

  setVertexBuffer(slot: number, buffer: RhiBuffer, offset = 0): void {
    const ops = this.room(4);
    ops[this.n++] = OP_VERTEX;
    ops[this.n++] = slot;
    ops[this.n++] = this.object(buffer);
    ops[this.n++] = offset;
  }

  setIndexBuffer(buffer: RhiBuffer, format: IndexFormat, offset = 0): void {
    const ops = this.room(4);
    ops[this.n++] = OP_INDEX;
    ops[this.n++] = this.object(buffer);
    ops[this.n++] = format === 'uint32' ? 1 : 0;
    ops[this.n++] = offset;
  }

  setViewport(): void {
    this.ok = false;
  }

  setScissor(): void {
    this.ok = false;
  }

  setStencilReference(): void {
    this.ok = false;
  }

  draw(
    vertexCount: number,
    instanceCount = 1,
    firstVertex = 0,
    firstInstance = 0,
  ): void {
    const ops = this.room(5);
    ops[this.n++] = OP_DRAW;
    ops[this.n++] = vertexCount;
    ops[this.n++] = instanceCount;
    ops[this.n++] = firstVertex;
    ops[this.n++] = firstInstance;
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    const ops = this.room(6);
    ops[this.n++] = OP_INDEXED;
    ops[this.n++] = indexCount;
    ops[this.n++] = instanceCount;
    ops[this.n++] = firstIndex;
    ops[this.n++] = baseVertex;
    ops[this.n++] = firstInstance;
  }

  /** No indirect draws on WebGL2. */
  drawIndirect(): void {
    this.ok = false;
  }

  end(): void {
    this.ok = false;
  }

  finish(): RhiRenderBundle | null {
    if (!this.ok) return null;
    const p = this.pass;
    return new GLBundle(
      this.ops.slice(0, this.n),
      this.objects,
      p._color,
      p._samples,
      p._depth,
    );
  }
}

/** Replays `bundle` into `pass`. */
function replay(pass: GLRenderPass, b: GLBundle): void {
  const ops = b.ops;
  const objects = b.objects;
  for (let i = 0; i < ops.length; ) {
    switch (ops[i]) {
      case OP_PIPELINE:
        pass.setPipeline(objects[ops[i + 1]] as RhiRenderPipeline);
        i += 2;
        break;
      case OP_BIND: {
        const count = ops[i + 3];
        let offsets: Uint32Array | undefined;
        if (count > 0) {
          offsets = OFFSETS[count];
          for (let k = 0; k < count; k++) offsets[k] = ops[i + 4 + k];
        }
        pass.setBindGroup(
          ops[i + 1],
          objects[ops[i + 2]] as RhiBindGroup,
          offsets,
        );
        i += 4 + count;
        break;
      }
      case OP_VERTEX:
        pass.setVertexBuffer(
          ops[i + 1],
          objects[ops[i + 2]] as RhiBuffer,
          ops[i + 3],
        );
        i += 4;
        break;
      case OP_INDEX:
        pass.setIndexBuffer(
          objects[ops[i + 1]] as RhiBuffer,
          ops[i + 2] === 1 ? 'uint32' : 'uint16',
          ops[i + 3],
        );
        i += 4;
        break;
      case OP_DRAW:
        pass.draw(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4]);
        i += 5;
        break;
      default:
        pass.drawIndexed(
          ops[i + 1],
          ops[i + 2],
          ops[i + 3],
          ops[i + 4] | 0,
          ops[i + 5],
        );
        i += 6;
    }
  }
}

/** The recording wrappers, reached through the backend (no runtime import). */
interface Wrappers {
  readonly list: object & { readonly renderPass: object };
}

let patched = false;

/** Installs bundles on `backend` (idempotent). */
export function installRenderBundles(backend: Backend): void {
  backend.createRenderBundleEncoder = (pass: RenderPass) =>
    new GLBundleEncoder(pass as unknown as PassFormats);
  if (patched) return;
  patched = true;
  const wrappers = (backend as unknown as Wrappers).list;
  const list = Object.getPrototypeOf(wrappers) as GLCommandList;
  const begin = list.beginRenderPass;
  list.beginRenderPass = function (
    this: GLCommandList,
    desc: RenderPassDesc,
  ): RenderPass {
    const pass = begin.call(this, desc);
    const f = pass as unknown as PassFormats;
    const target = desc.color.target;
    f._color = target === 'canvas' ? 'canvas' : (target as GLTexture).format;
    f._samples = target === 'canvas' ? 1 : (target as GLTexture).sampleCount;
    f._depth = (desc.depth?.target as GLTexture | undefined)?.format;
    return pass;
  };
  (Object.getPrototypeOf(wrappers.renderPass) as RenderPass).executeBundle =
    function (this: GLRenderPass, bundle: RhiRenderBundle): boolean {
      const b = bundle as GLBundle;
      const f = this as unknown as PassFormats;
      if (
        b.color !== f._color ||
        b.samples !== f._samples ||
        b.depth !== f._depth
      ) {
        return false;
      }
      replay(this, b);
      return true;
    };
}
