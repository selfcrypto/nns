import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'anchor',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // `artifact.test.ts` compiles NnsAnchor.sol in-process, twice — the only
    // tests in this workspace that are not effectively instant. Measured
    // 157ms and 31ms (2026-08-14); the default 5s would cover that many times
    // over, so the headroom here is for a cold solc load on a slow machine,
    // not for the steady state the earlier note claimed.
    testTimeout: 60_000,
  },
})
