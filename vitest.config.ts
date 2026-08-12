import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // A package joins the test run by having a vitest.config.ts. Matching on
    // the config file rather than the directory keeps "no test files found" a
    // real failure instead of the normal state of seven empty packages.
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
    },
  },
})
