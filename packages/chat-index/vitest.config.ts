import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'chat-index',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
