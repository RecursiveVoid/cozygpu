import { BufferUsage, ShaderStage, TextureUsage } from '../types';
import {
  GPU_BUFFER_USAGE,
  GPU_SHADER_STAGE,
  GPU_TEXTURE_USAGE,
  align4,
  bytesPerTexel,
  fullMipLevelCount,
  toGPUBlendState,
  toGPUBufferUsage,
  toGPUShaderStage,
  toGPUTextureUsage,
} from './convert';
import { formatCompilationMessages } from './diagnostics';

describe('webgpu convert', () => {
  it('maps buffer usage flags', () => {
    expect(toGPUBufferUsage(BufferUsage.VERTEX | BufferUsage.COPY_DST)).toBe(
      GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
    );
    expect(
      toGPUBufferUsage(
        BufferUsage.STORAGE |
          BufferUsage.COPY_SRC |
          BufferUsage.INDIRECT |
          BufferUsage.UNIFORM |
          BufferUsage.INDEX |
          BufferUsage.MAP_READ,
      ),
    ).toBe(
      GPU_BUFFER_USAGE.STORAGE |
        GPU_BUFFER_USAGE.COPY_SRC |
        GPU_BUFFER_USAGE.INDIRECT |
        GPU_BUFFER_USAGE.UNIFORM |
        GPU_BUFFER_USAGE.INDEX |
        GPU_BUFFER_USAGE.MAP_READ,
    );
  });

  it('adds RENDER_ATTACHMENT for color copy destinations and mipmapped textures', () => {
    const sampled = toGPUTextureUsage(
      TextureUsage.SAMPLED | TextureUsage.COPY_DST,
      'rgba8unorm',
      1,
    );
    expect(sampled & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT).toBeTruthy();
    expect(sampled & GPU_TEXTURE_USAGE.TEXTURE_BINDING).toBeTruthy();
    const plain = toGPUTextureUsage(TextureUsage.SAMPLED, 'rgba8unorm', 1);
    expect(plain).toBe(GPU_TEXTURE_USAGE.TEXTURE_BINDING);
    const mips = toGPUTextureUsage(TextureUsage.SAMPLED, 'rgba8unorm', 4);
    expect(mips & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT).toBeTruthy();
    const depth = toGPUTextureUsage(
      TextureUsage.RENDER_TARGET | TextureUsage.COPY_DST,
      'depth24plus',
      1,
    );
    expect(depth).toBe(
      GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_DST,
    );
  });

  it('maps shader stages', () => {
    expect(toGPUShaderStage(ShaderStage.VERTEX | ShaderStage.COMPUTE)).toBe(
      GPU_SHADER_STAGE.VERTEX | GPU_SHADER_STAGE.COMPUTE,
    );
  });

  it('uses premultiplied blend presets', () => {
    expect(toGPUBlendState(undefined)).toEqual(toGPUBlendState('normal'));
    expect(toGPUBlendState('normal')!.color).toEqual({
      operation: 'add',
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
    });
    expect(toGPUBlendState('add')!.color.dstFactor).toBe('one');
    expect(toGPUBlendState('multiply')!.color.srcFactor).toBe('dst');
    expect(toGPUBlendState('screen')!.color.dstFactor).toBe('one-minus-src');
    expect(toGPUBlendState('none')).toBeUndefined();
  });

  it('computes sizes', () => {
    expect(align4(0)).toBe(0);
    expect(align4(5)).toBe(8);
    // Regression: `& ~3` wrapped sizes past 2^31 (100M-object Swarm hot
    // buffer = 4e9 B became a 4 B buffer).
    expect(align4(4_000_000_000)).toBe(4_000_000_000);
    expect(align4(4_000_000_001)).toBe(4_000_000_004);
    expect(align4(2 ** 31 + 1)).toBe(2 ** 31 + 4);
    expect(bytesPerTexel('rgba8unorm')).toBe(4);
    expect(bytesPerTexel('r8unorm')).toBe(1);
    expect(fullMipLevelCount(1, 1)).toBe(1);
    expect(fullMipLevelCount(256, 64)).toBe(9);
    expect(fullMipLevelCount(300, 2)).toBe(9);
  });
});

describe('WGSL diagnostics', () => {
  const source = [
    'struct V { a: f32 }',
    '@fragment fn fs_main() -> @location(0) vec4f {',
    '  return colr;',
    '}',
  ].join('\n');

  it('formats errors with a source excerpt and caret', () => {
    const text = formatCompilationMessages('sprite.wgsl', source, [
      {
        type: 'error',
        message: "unresolved identifier 'colr'",
        lineNum: 3,
        linePos: 10,
        length: 4,
      },
      { type: 'warning', message: 'unused', lineNum: 1, linePos: 1, length: 1 },
    ]);
    expect(text).toBe(
      [
        "sprite.wgsl:3:10 error: unresolved identifier 'colr'",
        '    3 |   return colr;',
        '      |          ^^^^',
      ].join('\n'),
    );
  });

  it('includes warnings when asked and tolerates missing locations', () => {
    const text = formatCompilationMessages(
      undefined,
      undefined,
      [{ type: 'warning', message: 'something', lineNum: 0, linePos: 0 }],
      'warning',
    );
    expect(text).toBe('shader warning: something');
  });
});
