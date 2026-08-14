import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'settlement',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
