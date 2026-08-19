import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the bundle must work from any static host and any
  // path — independent hosting is a §2.2 mitigation, not a convenience.
  base: './',
  build: { target: 'es2022' },
  // Dev only: same-origin path to a local @nns/api. Kept as a convenience —
  // the API has been open to any origin since 2026-08-17, so pointing
  // VITE_NNS_RESOLVERS straight at http://127.0.0.1:8635 works too.
  server: {
    proxy: {
      '/nns-api': {
        target: 'http://127.0.0.1:8635',
        rewrite: (path) => path.replace(/^\/nns-api/, ''),
      },
      // Dev-only §8.6 detour (see src/lib/nns.ts): whatever host a D names
      // resolves against the local delegate on its real port. No `rewrite` —
      // the delegate takes the last two segments of the path and ignores the
      // mount, so this prefix reaches it harmlessly.
      '/nns-delegate': { target: 'http://127.0.0.1:8636' },
    },
  },
})
