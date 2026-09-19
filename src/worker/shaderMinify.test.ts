/**
 * Owner: "worker+build". Build-time shader minifier (ARCHITECTURE §18.2),
 * implemented in scripts/shader-minify.cjs. Lives here because Jest only
 * scans src/ and benchmarks/.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
// Node built-ins without @types/node (tsconfig types: webgpu + jest only).
declare const require: (id: string) => unknown;
const fs = require('fs') as {
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(
    dir: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
};
const path = require('path') as {
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
};
declare const __dirname: string;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { minifyShader } = require('../../scripts/shader-minify.cjs') as {
  minifyShader(source: string, language?: 'wgsl' | 'glsl'): string;
};

const SHADER_ROOT = path.resolve(__dirname, '..');

function shaderFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shaderFiles(full, out);
    else if (/\.(wgsl|glsl)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const markerLines = (src: string): string[] =>
  src
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('//@'));

describe('minifyShader', () => {
  it('strips comments and whitespace but keeps //@ marker lines', () => {
    const src = [
      '// header comment',
      '/* block',
      '   //@NOT_A_MARKER (inside a block comment) */',
      'struct A {  // trailing',
      '    a : f32,',
      '}',
      '',
      '   //@SLOT   ',
      'fn f( x : f32 ) -> f32 { return x * 2.0; } // done',
      '  x = 1; //@INLINE is a comment, not a marker',
    ].join('\n');
    const out = minifyShader(src);
    expect(out).toBe(
      [
        'struct A{',
        'a:f32,',
        '}',
        '//@SLOT',
        'fn f(x:f32)-> f32{return x * 2.0;}',
        'x=1;',
        '',
      ].join('\n'),
    );
  });

  it('handles nested WGSL block comments and flat GLSL ones', () => {
    expect(minifyShader('a /* x /* y */ z */ b;', 'wgsl')).toBe('a b;\n');
    expect(minifyShader('a /* x /* y */ b;', 'glsl')).toBe('a b;\n');
  });

  it('keeps GLSL preprocessor lines on their own line and does not squeeze them', () => {
    const src = [
      '#version 300 es',
      '// comment',
      'precision highp float;',
      '#define   SCALE (2.0)',
      '#define F(a) (a)',
      'void main() {  gl_Position = vec4( SCALE ); }',
    ].join('\n');
    const out = minifyShader(src, 'glsl').split('\n');
    expect(out[0]).toBe('#version 300 es');
    expect(out).toContain('#define SCALE (2.0)');
    expect(out).toContain('#define F(a) (a)');
    expect(out).toContain('void main(){gl_Position=vec4(SCALE);}');
  });

  it('keeps every marker of every shader in the repo and shrinks it', () => {
    const files = shaderFiles(SHADER_ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const lang = file.endsWith('.glsl') ? 'glsl' : 'wgsl';
      const raw = fs.readFileSync(file, 'utf8');
      const min = minifyShader(raw, lang);
      expect({ file, markers: markerLines(min) }).toEqual({
        file,
        markers: markerLines(raw),
      });
      expect(min.length).toBeLessThanOrEqual(raw.length);
      if (lang === 'glsl' && raw.trimStart().startsWith('#version')) {
        expect(min.startsWith('#version')).toBe(true);
      }
      // Idempotent.
      expect(minifyShader(min, lang)).toBe(min);
    }
  });

  it('the swarm composer behaves the same on minified templates', () => {
    const swarmShaders = path.join(SHADER_ROOT, 'shaders/swarm');
    const min = (name: string): string =>
      minifyShader(fs.readFileSync(path.join(swarmShaders, name), 'utf8'));
    type Out = { compute: string; render: string } | Error;
    const compose = (minified: boolean): Out => {
      let out: Out = new Error('not run');
      jest.isolateModules(() => {
        if (minified) {
          for (const name of ['compute', 'cull', 'prelude', 'render']) {
            jest.doMock(`../shaders/swarm/${name}.wgsl`, () =>
              min(`${name}.wgsl`),
            );
          }
        }
        const composer =
          require('../swarm/composer') as typeof import('../swarm/composer');
        const { behaviors } = require('../swarm') as typeof import('../swarm');
        try {
          out = composer.composeSwarmShaders(
            [
              behaviors.velocity(),
              behaviors.bounds({
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                mode: 'wrap',
              }),
            ],
            0,
          );
        } catch (error) {
          out = error as Error;
        }
      });
      return out;
    };
    const raw = compose(false);
    const minified = compose(true);
    if (raw instanceof Error) {
      // Templates mid-edit by their owner: the minifier must not change the outcome.
      expect(minified).toBeInstanceOf(Error);
      expect((minified as Error).message).toBe(raw.message);
      return;
    }
    expect(minified).not.toBeInstanceOf(Error);
    const { compute, render } = minified as { compute: string; render: string };
    expect(compute).not.toMatch(/^\s*\/\/@/m);
    expect(render).not.toMatch(/^\s*\/\/@/m);
    expect(compute).toContain('fn cs_step');
    expect(render).toContain('fn vs_main');
  });
});
