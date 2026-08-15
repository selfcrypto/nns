import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'delegate',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
