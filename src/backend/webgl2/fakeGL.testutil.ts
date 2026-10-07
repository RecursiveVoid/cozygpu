/**
 * TEST-ONLY recording WebGL2 context. Every method call is
 * appended to `calls` as `name(arg, ...)` (objects print as their fake id) so
 * tests can assert call sequences without a GPU.
 */
import * as G from './glconst';

export interface FakeGL {
  gl: WebGL2RenderingContext;
  calls: string[];
  /** Extensions getExtension() reports. */
  extensions: Set<string>;
  lost: { value: boolean };
  /** Values returned by clientWaitSync (shifted; default ALREADY_SIGNALED). */
  syncResults: number[];
  /** getBufferSubData fills its destination from this. */
  readData: { bytes: Uint8Array };
  listeners: Map<string, ((event: Event) => void)[]>;
  canvas: {
    width: number;
    height: number;
    getContext(): unknown;
    addEventListener(t: string, f: (e: Event) => void): void;
    removeEventListener(t: string, f: (e: Event) => void): void;
  };
  clear(): void;
  fire(type: string): void;
}

let nextId = 1;

class FakeObject {
  readonly id = nextId++;
  constructor(readonly kind: string) {}
  toString(): string {
    return `${this.kind}#${this.id}`;
  }
}

function fmt(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof FakeObject) return value.toString();
  if (ArrayBuffer.isView(value))
    return `${value.constructor.name}(${value.byteLength})`;
  if (Array.isArray(value)) return `[${value.join(',')}]`;
  if (typeof value === 'object') return 'obj';
  return String(value);
}

export function createFakeGL(options: { extensions?: string[] } = {}): FakeGL {
  const calls: string[] = [];
  const extensions = new Set(
    options.extensions ?? [
      'KHR_parallel_shader_compile',
      'WEBGL_lose_context',
      'EXT_color_buffer_float',
    ],
  );
  const lost = { value: false };
  const syncResults: number[] = [];
  const readData = { bytes: new Uint8Array(0) };
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const loseExt = {
    loseContext(): void {
      lost.value = true;
    },
    restoreContext(): void {
      lost.value = false;
    },
  };
  const special: Record<string, (...args: unknown[]) => unknown> = {
    getExtension: name => {
      if (!extensions.has(name as string)) return null;
      if (name === 'WEBGL_lose_context') return loseExt;
      if (name === 'WEBGL_draw_instanced_base_vertex_base_instance') {
        return {
          drawArraysInstancedBaseInstance: (...a: unknown[]) =>
            calls.push(
              `drawArraysInstancedBaseInstance(${a.map(fmt).join(', ')})`,
            ),
          drawElementsInstancedBaseVertexBaseInstance: (...a: unknown[]) =>
            calls.push(
              `drawElementsInstancedBaseVertexBaseInstance(${a.map(fmt).join(', ')})`,
            ),
        };
      }
      return {};
    },
    getParameter: pname => {
      switch (pname) {
        case G.MAX_TEXTURE_SIZE:
          return 8192;
        case G.MAX_TEXTURE_IMAGE_UNITS:
          return 16;
        case G.MAX_UNIFORM_BLOCK_SIZE:
          return 65536;
        case G.MAX_SAMPLES:
          return 4;
        default:
          return 0;
      }
    },
    isContextLost: () => lost.value,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getUniformBlockIndex: (_p, name) =>
      (name as string).startsWith('G') ? 0 : G.INVALID_INDEX,
    getUniformLocation: (_p, name) => new FakeObject(`loc:${name as string}`),
    getTransformFeedbackVarying: (_p, i) => ({
      name: `v${i as number}`,
      type: G.FLOAT_VEC4,
      size: 1,
    }),
    fenceSync: () => new FakeObject('sync'),
    clientWaitSync: () =>
      syncResults.length ? syncResults.shift() : G.ALREADY_SIGNALED,
    getBufferSubData: (_t, _o, dst) => {
      (dst as Uint8Array).set(
        readData.bytes.subarray(0, (dst as Uint8Array).byteLength),
      );
    },
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
  };
  const canvas = {
    width: 300,
    height: 150,
    getContext: (): unknown => gl,
    addEventListener(type: string, fn: (e: Event) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (e: Event) => void): void {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter(f => f !== fn),
      );
    },
  };
  const target: Record<string, unknown> = {
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    canvas,
  };
  const gl = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => {
        calls.push(`${prop}(${args.map(fmt).join(', ')})`);
        if (special[prop]) return special[prop](...args);
        if (prop.startsWith('create')) return new FakeObject(prop.slice(6));
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    extensions,
    lost,
    syncResults,
    readData,
    listeners,
    canvas,
    clear: () => {
      calls.length = 0;
    },
    fire: type => {
      const event = {
        type,
        preventDefault: () => calls.push(`preventDefault(${type})`),
      } as unknown as Event;
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}
