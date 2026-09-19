/** Jest: import WGSL files as strings (mirrors rollup-plugin-string). */
module.exports = {
  process(sourceText) {
    return { code: `module.exports = ${JSON.stringify(sourceText)};` };
  },
};
