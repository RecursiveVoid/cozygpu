const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const json = require('@rollup/plugin-json');
const serve = require('rollup-plugin-serve');
const livereload = require('rollup-plugin-livereload');
const path = require('path');

module.exports = {
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/bundle.cjs.js',
      format: 'cjs',
      sourcemap: true,
    },
    {
      file: 'dist/bundle.esm.js',
      format: 'esm',
      sourcemap: true,
    },
  ],
  plugins: [
    resolve(),
    commonjs(),
    typescript(),
    json(),
    serve({
      open: true, 
      contentBase: path.join(__dirname, 'dist'), 
      port: 3000, 
    }),
    livereload({
      watch: 'dist', 
    }),
    text({include: '**/*.wgsl'}),
  ],
};
