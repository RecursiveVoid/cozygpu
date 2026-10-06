/**
 * WebGL2 stencil support (ARCHITECTURE §21.3): pipeline stencil state, the
 * reference value, the stencil clear of a pass, and the rule that a pipeline
 * without stencil state inherits the test (so ordinary sprite draws are
 * clipped by a mask) but never writes to the buffer.
 */
import { BufferUsage, ShaderStage } from '../types';
import type {
  Backend,
  RenderPassDesc,
  RhiBindGroupLayout,
  RhiTexture,
} from '../types';
import maskFrag from '../../shaders/mask/mask.frag.glsl';
import maskVert from '../../shaders/mask/mask.vert.glsl';
import { createFakeGL, type FakeGL } from './fakeGL.testutil';
import * as G from './glconst';
import { GL_STENCIL_INSIDE, toGLStencil } from './state';
import { WebGL2Backend } from './WebGL2Backend';

async function makeBackend(): Promise<{
  fake: FakeGL;
  backend: WebGL2Backend;
}> {
  const fake = createFakeGL();
  const backend = await WebGL2Backend.create(
    fake.canvas as unknown as OffscreenCanvas,
    { preference: 'webgl2' },
  );
  fake.clear();
  return { fake, backend };
}

function layouts(b: Backend): RhiBindGroupLayout[] {
  return [
    b.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.VERTEX,
          type: { kind: 'uniform' },
        },
      ],
    }),
    b.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: ShaderStage.FRAGMENT,
          type: { kind: 'texture' },
        },
        {
          binding: 1,
          visibility: ShaderStage.FRAGMENT,
          type: { kind: 'sampler' },
        },
      ],
    }),
  ];
}

const VERTEX_BUFFERS = [
  {
    stride: 40,
    stepMode: 'instance' as const,
    attributes: [{ location: 1, format: 'float32x4' as const, offset: 0 }],
  },
];

describe('webgl2 stencil translation', () => {
  it('maps compare functions and stencil operations to GL enums', () => {
    expect(
      toGLStencil({
        compare: 'equal',
        passOp: 'increment-clamp',
        writeMask: 0xff,
      }),
    ).toEqual({
      func: G.EQUAL,
      readMask: 0xff,
      writeMask: 0xff,
      fail: G.KEEP,
      zfail: G.KEEP,
      pass: G.INCR,
    });
    expect(toGLStencil({ passOp: 'decrement-clamp' }).pass).toBe(G.DECR);
    expect(toGLStencil({ compare: 'always' }).func).toBe(G.ALWAYS);
    expect(toGLStencil({ compare: 'not-equal' }).func).toBe(G.NOTEQUAL);
    expect(toGLStencil({ failOp: 'replace' }).fail).toBe(G.REPLACE);
    // Draws inside a mask test the buffer and leave it alone.
    expect(GL_STENCIL_INSIDE.func).toBe(G.EQUAL);
    expect(GL_STENCIL_INSIDE.writeMask).toBe(0);
  });

  it('reports the capability', async () => {
    const { backend } = await makeBackend();
    expect(backend.caps.stencil).toBe(true);
  });
});

describe('webgl2 stencil passes and draws', () => {
  it('clears the stencil buffer when the pass asks for it', async () => {
    const { fake, backend } = await makeBackend();
    const depth = backend.createTexture({
      width: 4,
      height: 4,
      format: 'depth24plus-stencil8',
      usage: 4,
    }) as RhiTexture;
    const desc: RenderPassDesc = {
      color: { target: 'canvas', load: 'load' },
      depth: { target: depth, load: 'load', stencilLoad: 'clear' },
    };
    const list = backend.beginCommands();
    list.beginRenderPass(desc).end();
    expect(fake.calls).toContain('stencilMask(255)');
    expect(fake.calls).toContain('clearStencil(0)');
    expect(fake.calls).toContain(`clear(${G.STENCIL_BUFFER_BIT})`);
  });

  it('applies the pipeline stencil state, then lets the next draw inherit the test', async () => {
    const { fake, backend } = await makeBackend();
    const shader = backend.createShaderModule({
      glsl: { vertex: maskVert as string, fragment: maskFrag as string },
    });
    const [view, texture] = layouts(backend);
    const masked = await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [view, texture],
      vertexBuffers: VERTEX_BUFFERS,
      topology: 'triangle-strip',
      blend: 'none',
      depthFormat: 'depth24plus-stencil8',
      colorWriteDisabled: true,
      stencil: { compare: 'equal', passOp: 'increment-clamp' },
    });
    const plain = await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [view, texture],
      vertexBuffers: VERTEX_BUFFERS,
      topology: 'triangle-strip',
      blend: 'normal',
    });
    const instances = backend.createBuffer({
      size: 400,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const list = backend.beginCommands();
    fake.clear();
    const pass = list.beginRenderPass({
      color: { target: 'canvas', load: 'clear' },
    });
    // Clearing the canvas clears its stencil buffer, so a mask always starts
    // counting from 0.
    expect(fake.calls).toContain('clearStencil(0)');
    // The mask writes the buffer without touching color.
    pass.setPipeline(masked);
    pass.setVertexBuffer(0, instances);
    pass.draw(4, 1);
    expect(fake.calls).toContain(`enable(${G.STENCIL_TEST})`);
    expect(fake.calls).toContain(`stencilFunc(${G.EQUAL}, 0, 255)`);
    expect(fake.calls).toContain(`stencilOp(${G.KEEP}, ${G.KEEP}, ${G.INCR})`);
    expect(fake.calls).toContain('stencilMask(255)');
    expect(fake.calls).toContain('colorMask(false, false, false, false)');

    // What draws inside the mask keeps the test at the new reference and
    // gets its color writes back.
    fake.clear();
    pass.setStencilReference(1);
    pass.setPipeline(plain);
    pass.setVertexBuffer(0, instances);
    pass.draw(4, 1);
    expect(fake.calls).toContain(`stencilFunc(${G.EQUAL}, 1, 255)`);
    expect(fake.calls).toContain('stencilMask(0)');
    expect(fake.calls).toContain('colorMask(true, true, true, true)');
    pass.end();
  });

  it('leaves the stencil alone in a pass without masks', async () => {
    const { fake, backend } = await makeBackend();
    const shader = backend.createShaderModule({
      glsl: { vertex: maskVert as string, fragment: maskFrag as string },
    });
    const [view, texture] = layouts(backend);
    const plain = await backend.createRenderPipeline({
      shader,
      bindGroupLayouts: [view, texture],
      vertexBuffers: VERTEX_BUFFERS,
      topology: 'triangle-strip',
      blend: 'normal',
    });
    const instances = backend.createBuffer({
      size: 400,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const list = backend.beginCommands();
    const pass = list.beginRenderPass({
      color: { target: 'canvas', load: 'clear' },
    });
    fake.clear();
    pass.setPipeline(plain);
    pass.setVertexBuffer(0, instances);
    pass.draw(4, 1);
    pass.end();
    // The test is switched off rather than left at whatever a mask in an
    // earlier pass set.
    expect(fake.calls).toContain(`disable(${G.STENCIL_TEST})`);
    expect(fake.calls.some(c => c.startsWith('stencilFunc'))).toBe(false);
    expect(fake.calls.some(c => c.startsWith('colorMask'))).toBe(false);
  });
});
