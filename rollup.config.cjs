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
      open: true, // Automatically opens the browser
      contentBase: path.join(__dirname, 'dist'), // Serve the files from 'dist'
      port: 3000, // Specify the port for the server
    }),
    livereload({
      watch: 'dist', // Watch the 'dist' folder for changes
    }),
  ],
};
