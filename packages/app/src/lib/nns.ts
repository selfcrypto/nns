/**
 * The configured `@nns/resolver` instance. `resolve()` and `available()` on
 * this instance are the only sources of an address or an availability verdict
 * in the whole app — no other module may produce either.
 *
 * The instance is held: it carries the §8.6 delegation cache.
 */

import { createResolver, type HttpFetch, type NnsResolver } from '@nns/resolver'
import { appConfig, ConfigParseError } from '../config'

/**
 * Dev-only detour to a local §8.6 delegate. A chain `D` host carries no port
 * and the client hardcodes `https://`, so a delegate on a loopback port is
 * unreachable from a dev browser. With `VITE_NNS_DELEGATE_DEV=1` under
 * `vite dev`, **any** delegate request is rerouted same-origin under
 * `/nns-delegate`, which vite.config.ts proxies to the local delegate.
 *
 * **The prefix is this file's, not the protocol's** (r25). §8.6's request is
 * `/<parent>/<label>` and swapping the origin alone would leave `/alice/shop`
 * colliding with the dev server's own paths, so the detour supplies a prefix
 * to route on — and does not have to strip it again, because the delegate
 * reads the last two segments and ignores whatever mount precedes them.
 *
 * **It rewrites whatever host the `D` names, not `localhost` alone**, and that
 * is the point. Matching only `localhost` meant the way to test a delegate was
 * to record `localhost` in a real `D` — which points every other visitor at
 * their own machine and takes the name's subdomains down for everyone. Now the
 * `D` holds the real public host permanently and this flag decides which
 * server answers it locally: unset, the dev browser reaches the public
 * delegate like anyone else; set, it reaches yours.
 *
 * `import.meta.env.DEV` is compile-time false in a build, so no production
 * bundle can carry the exception.
 */
function delegateDevFetch(): HttpFetch | undefined {
  if (!import.meta.env.DEV || import.meta.env['VITE_NNS_DELEGATE_DEV'] !== '1') return undefined
  return (url, init) => fetch(url.replace(/^https:\/\/[^/]+\//, '/nns-delegate/'), init)
}

let cached: NnsResolver | null = null

export function resolver(): NnsResolver {
  if (cached === null) {
    const { resolvers, quorum } = appConfig()
    const devFetch = delegateDevFetch()
    cached = createResolver({ resolvers, quorum, ...(devFetch ? { fetch: devFetch } : {}) })
  }
  return cached
}

/**
 * Base URL for the non-address reads in `api.ts` — the first configured
 * resolver. List and detail data is display material; everything an address
 * comes out of still goes through the quorum above.
 */
export function apiBase(): string {
  const first = appConfig().resolvers[0]
  if (!first) {
    throw new ConfigParseError(
      'No resolver endpoints configured. Set VITE_NNS_RESOLVERS — the shipped default list is empty until a public NNS API exists.',
    )
  }
  return first.url
}
