/**
 * Build-time WGSL / GLSL minifier (ARCHITECTURE §18.2).
 *
 * Used by rollup.config.cjs (before rollup-plugin-string) and by
 * scripts/size.mjs. Jest keeps loading the raw sources.
 *
 *  - Removes `//` and `/* *\/` comments (WGSL block comments nest; GLSL ones
 *    do not), EXCEPT lines whose trimmed text starts with `//@` (composer
 *    markers such as `//@SLOT`), which are kept verbatim on their own line.
 *  - Drops indentation, trailing spaces and blank lines, collapses runs of
 *    spaces, and removes spaces next to `{ } ( ) [ ] ; , : =` (not on GLSL
 *    preprocessor lines, where `#define X (a)` differs from `#define X(a)`).
 *  - Keeps one output line per remaining source line, so every `//@` marker
 *    and every `#` preprocessor line stays on its own line (`#version` stays
 *    first) and compile diagnostics stay readable. Identifiers are never
 *    renamed.
 */
'use strict';

const PUNCT_SPACES = /\s*([{}()[\];,:=])\s*/g;

/**
 * @param {string} source
 * @param {'wgsl' | 'glsl'} [language]
 * @returns {string}
 */
function minifyShader(source, language = 'wgsl') {
  const nested = language === 'wgsl';
  const src = String(source).replace(/\r\n?/g, '\n');
  const n = src.length;
  let out = '';
  let lineHasContent = false;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && d === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      if (!lineHasContent && src[i + 2] === '@') {
        out += src.slice(i, end).trimEnd();
        lineHasContent = true;
      }
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else if (nested && src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else {
          // Keep newlines so line structure (markers, #lines) survives.
          if (src[i] === '\n') {
            out += '\n';
            lineHasContent = false;
          }
          i++;
        }
      }
      // A block comment separates tokens.
      out += ' ';
      continue;
    }
    if (c === '\n') lineHasContent = false;
    else if (c !== ' ' && c !== '\t') lineHasContent = true;
    out += c;
    i++;
  }

  const lines = out.split('\n');
  const kept = [];
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k].trim();
    if (line === '') continue;
    if (line.startsWith('//@')) {
      kept.push(line);
      continue;
    }
    line = line.replace(/[ \t]+/g, ' ');
    if (!line.startsWith('#')) line = line.replace(PUNCT_SPACES, '$1');
    kept.push(line);
  }
  return kept.join('\n') + '\n';
}

/** Rollup plugin: minifies *.wgsl / *.glsl before rollup-plugin-string. */
function shaderMinifyPlugin() {
  return {
    name: 'cozygpu-shader-minify',
    transform(code, id) {
      const clean = id.split('?')[0];
      if (clean.endsWith('.wgsl'))
        return { code: minifyShader(code, 'wgsl'), map: null };
      if (clean.endsWith('.glsl'))
        return { code: minifyShader(code, 'glsl'), map: null };
      return null;
    },
  };
}

module.exports = { minifyShader, shaderMinifyPlugin };
