/**
 * WebGPU stencil support (ARCHITECTURE §21.3): the depth/stencil state a mask
 * pipeline asks for, the color write mask of a stencil-only draw, and the
 * pipeline cache key that keeps two stencil variants apart.
 */
import { COLOR_WRITE_ALL, stencilKey, toGPUDepthStencil } from './convert';

describe('webgpu depth/stencil state', () => {
  it('keeps the M1 depth behavior when no stencil state is asked for', () => {
    expect(toGPUDepthStencil(undefined, undefined)).toBeUndefined();
    expect(toGPUDepthStencil('depth24plus', undefined)).toEqual({
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
    });
  });

  it('makes depth inert and fills both faces for a stencil pipeline', () => {
    const state = toGPUDepthStencil('depth24plus-stencil8', {
      compare: 'equal',
      passOp: 'increment-clamp',
      writeMask: 0xff,
    })!;
    expect(state.depthWriteEnabled).toBe(false);
    expect(state.depthCompare).toBe('always');
    expect(state.stencilFront).toEqual({
      compare: 'equal',
      failOp: 'keep',
      depthFailOp: 'keep',
      passOp: 'increment-clamp',
    });
    expect(state.stencilFront).toEqual(state.stencilBack);
    expect(state.stencilReadMask).toBe(0xff);
    expect(state.stencilWriteMask).toBe(0xff);
  });

  it('defaults a stencil face to always/keep and full masks', () => {
    const state = toGPUDepthStencil('depth24plus-stencil8', {})!;
    expect(state.stencilFront).toEqual({
      compare: 'always',
      failOp: 'keep',
      depthFailOp: 'keep',
      passOp: 'keep',
    });
    expect(state.stencilWriteMask).toBe(0xff);
  });

  it('separates pipelines that differ only in stencil state or color writes', () => {
    const increment = stencilKey(
      { compare: 'equal', passOp: 'increment-clamp' },
      true,
    );
    const decrement = stencilKey(
      { compare: 'equal', passOp: 'decrement-clamp' },
      true,
    );
    expect(increment).not.toBe(decrement);
    expect(stencilKey(undefined, undefined)).not.toBe(
      stencilKey(undefined, true),
    );
    expect(COLOR_WRITE_ALL).toBe(0xf);
  });
});
