import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'chat',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
