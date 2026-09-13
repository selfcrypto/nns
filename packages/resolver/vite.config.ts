import { defineConfig } from 'vite'

/**
 * The no-build-step artifact: `dist/nns.js`, one self-contained ES module.
 *
 * `npm install` is not available to the case this package exists for. A shop
 * with a checkout page, a payments form on a CMS, a static site — none of them
 * have a bundler, and telling them to get one is telling them to integrate
 * later. Without this file the documented answer for a plain HTML page was the
 * HTTP API plus a hand-written keccak verifier, which is a page of code to
 * reproduce something already written and tested here.
 *
 * So: everything is inlined — `@nns/core`, `@nns/anchor/reader`, `@noble/*` —
 * and the output imports nothing. `<script type="module">` and a URL is the
 * whole integration. It is the same source as the npm package, built twice,
 * not a second implementation.
 *
 * Two things this deliberately does **not** do:
 *
 * - **It does not empty `dist/`.** `tsc` runs first and puts the typed ESM
 *   build there; this only adds a file beside it. `emptyOutDir: false` is
 *   load-bearing, not caution.
 * - **It does not bundle the CSS.** §4.3's stylesheet stays its own file
 *   (`dist/rendering.css`), because a page that wants the resolver and its own
 *   type face should not be made to take ours to get one.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    // ES2022: the floor `@nns/core` already needs for bigint literals, and
    // every browser that can run a module can run it.
    target: 'es2022',
    minify: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'nns.js',
    },
    rollupOptions: {
      // Nothing is external. That is the entire point of this build.
      external: [],
    },
  },
})
