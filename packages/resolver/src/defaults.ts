/**
 * The lists this package ships with: two resolvers, no anchor publishers.
 *
 * They are exported rather than inlined so a host app spreads them —
 * `[...DEFAULT_RESOLVERS, myOwn]` — and picks up new entries by upgrading this
 * package instead of by editing its own code.
 *
 * `DEFAULT_ANCHOR_PUBLISHERS` is still empty, and that is a statement about
 * the deployment rather than a placeholder: no §9 contract is deployed on any
 * chain, so there is no honest address to put there. The visible consequence
 * is that every anchor check answers `not-checked` / `NO_PUBLISHERS` and every
 * result says so. §8.5 #1 does not run. That is the truth about the current
 * deployment and it belongs on the result rather than in a comment.
 */

import type { ResolverEndpoint } from './transport.js'

/**
 * Independent NNS APIs to query (§8.5 #2). **Two, since 2026-09-13.**
 *
 * `RESOLVER_QUORUM` is 2, and the shipped list meets it without a host app
 * supplying anything — which is the point of shipping a list at all. Before
 * this there were no public endpoints, so the list was empty and every
 * consumer had to invent one or drop the quorum to 1; both of those are worse
 * than a default, because a list nobody publishes is a list nobody can audit.
 *
 * **What two entries here do and do not prove.** They are two separately
 * replayed databases — their own Postgres, their own indexer, their own host
 * and their own provider — so when they agree, the reducer was deterministic
 * across two machines and neither one silently drifted or shipped a bad
 * deploy. That is the failure this whole design exists to catch, and one
 * endpoint cannot catch it. What it does **not** yet prove is §2.2's stronger
 * claim: both are run by the operator that publishes this package, so a
 * client checking only these two is trusting one party twice. The entry that
 * closes that gap is a third, independently operated endpoint — running one
 * is `docs/integration.md` §7 and `packages/app/docs/operators.md`, and
 * getting listed here is an issue with a name and a URL.
 *
 * The names, not the URLs, are what a host app shows when resolvers disagree.
 */
export const DEFAULT_RESOLVERS: readonly ResolverEndpoint[] = [
  { name: 'nimiqnames.com', url: 'https://api.nimiqnames.com' },
  { name: 'nns.sonartech.pro', url: 'https://nns.sonartech.pro' },
]

/**
 * `ANCHOR_PUBLISHERS` — the client-side list §9 makes the whole of publisher
 * admission, since `anchor()` is permissionless. **Empty.**
 *
 * An address not on this list is ignored by the reader: never counted toward
 * quorum, and never a mismatch. Contents are a deployment decision.
 */
export const DEFAULT_ANCHOR_PUBLISHERS: readonly string[] = []
