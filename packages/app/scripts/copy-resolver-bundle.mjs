/**
 * Copy `@nimiqnames/resolver`'s self-contained browser build into this app's
 * `public/`, so the deployment serves it at `/nns.js`.
 *
 * Why the app and not a static host of its own: `docs/integration.md` points a
 * page with no build step at a URL, and that URL has to exist on day one, for
 * every operator serving this app — not only on the day the packages
 * reach npm and jsDelivr can mirror them. One `web` image, one more file,
 * every deployment gets it.
 *
 * It is **copied, never committed**: the bundle is a build artifact of another
 * package, and a checked-in copy is a copy that goes stale silently. Run
 * `pnpm build` (this is its `prebuild`) or `pnpm --filter @nimiqnames/resolver build`
 * first — the script says so rather than producing a page that 404s.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', '..', 'resolver', 'dist', 'nns.js')
const to = join(here, '..', 'public', 'nns.js')

if (!existsSync(from)) {
  console.error(
    `[app] ${from} is missing — build @nimiqnames/resolver first (pnpm --filter @nimiqnames/resolver build).\n` +
      '      Without it this deployment would serve a 404 at /nns.js, which docs/integration.md links.',
  )
  process.exit(1)
}

mkdirSync(dirname(to), { recursive: true })
copyFileSync(from, to)
console.log('[app] public/nns.js ← @nimiqnames/resolver/dist/nns.js')
