import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the bundle must work from any static host and any
  // path — independent hosting is a §2.2 mitigation, not a convenience.
  base: './',
  build: { target: 'es2022' },
})
