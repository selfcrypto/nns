import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'resolver',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
