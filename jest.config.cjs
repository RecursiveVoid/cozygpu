/** Unit tests run in Node (no GPU): pure logic only — command stream, math, composers, allocators. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/benchmarks'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
    '^.+\\.(wgsl|glsl)$': '<rootDir>/jest.wgsl-transform.cjs',
  },
  moduleNameMapper: {
    '^cozygpu$': '<rootDir>/src/index.ts',
  },
  moduleFileExtensions: ['ts', 'js', 'cjs', 'wgsl', 'glsl'],
};
