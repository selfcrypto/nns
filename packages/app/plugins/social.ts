/**
 * The social card's absolute URLs.
 *
 * Every other URL this bundle ships is relative — `base: './'`, so one build
 * runs on any host at any path, which is a §2.2 mitigation and not a
 * convenience. `og:image` and `og:url` cannot join them: a link preview
 * crawler is not a browser, and Telegram, WhatsApp and Slack drop a relative
 * `og:image` rather than resolve it against the page they just fetched. The
 * Open Graph protocol has always said absolute; the lenient one is Facebook,
 * and it is the only one.
 *
 * So `index.html` carries the canonical origin literally — the file reads as
 * what a crawler will see — and this rewrites it for a build that will be
 * served somewhere else:
 *
 *     NNS_SITE_URL=https://names.example pnpm --filter @nns/app build
 */

import type { Plugin } from 'vite'

/** What `index.html` says. Changing it here changes nothing; change it there. */
const CANONICAL = 'https://nimiqnames.com'

export function socialPlugin(): Plugin {
  const site = (process.env['NNS_SITE_URL'] ?? CANONICAL).replace(/\/+$/, '')
  return {
    name: 'nns-social-urls',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => (site === CANONICAL ? html : html.replaceAll(CANONICAL, site)),
    },
  }
}
