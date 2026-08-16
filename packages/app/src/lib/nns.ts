/**
 * The configured `@nns/resolver` instance. `resolve()` and `available()` on
 * this instance are the only sources of an address or an availability verdict
 * in the whole app — no other module may produce either.
 *
 * The instance is held: it carries the §8.6 delegation cache.
 */

import { createResolver, type NnsResolver } from '@nns/resolver'
import { appConfig, ConfigParseError } from '../config'

let cached: NnsResolver | null = null

export function resolver(): NnsResolver {
  if (cached === null) {
    const { resolvers, quorum } = appConfig()
    cached = createResolver({ resolvers, quorum })
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
