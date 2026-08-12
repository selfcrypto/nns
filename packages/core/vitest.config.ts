import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts', 'vectors/**/*.test.ts'],
    environment: 'node',
  },
})
