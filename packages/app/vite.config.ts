import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the bundle must work from any static host and any
  // path — independent hosting is a §2.2 mitigation, not a convenience.
  base: './',
  build: { target: 'es2022' },
  // Dev only: same-origin path to a local @nns/api, which (unlike the relay)
  // sends no CORS headers. Point VITE_NNS_RESOLVERS at /nns-api.
  server: {
    proxy: {
      '/nns-api': {
        target: 'http://127.0.0.1:8635',
        rewrite: (path) => path.replace(/^\/nns-api/, ''),
      },
      // Dev-only §8.6 detour (see src/lib/nns.ts): a D record naming
      // `localhost` resolves against the local delegate on its real port.
      '/delegated': { target: 'http://127.0.0.1:8636' },
    },
  },
})
