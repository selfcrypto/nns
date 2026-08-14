import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'anchor',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Compiling Solidity in-process is slower than every other test in this
    // workspace by two orders of magnitude, and it happens twice. The
    // default 5s timeout is not enough on a cold machine.
    testTimeout: 60_000,
  },
})
