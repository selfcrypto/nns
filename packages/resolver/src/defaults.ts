/**
 * The lists this package ships with — and both of them are empty.
 *
 * That is a statement about the deployment, not a placeholder: at the time of
 * writing no NNS API is deployed and no §9 anchor contract exists on any
 * chain, so there is no honest entry to put here. An invented one would be
 * worse than none, because every consumer would inherit it and §8.5's whole
 * argument is that the parties a client checks against are **independent** of
 * the party that shipped the client (§2.2).
 *
 * They are exported rather than inlined so a host app spreads them —
 * `[...DEFAULT_RESOLVERS, myOwn]` — and picks up the real entries by upgrading
 * this package on the day they exist, instead of by editing its own code.
 *
 * The visible consequence today: with `DEFAULT_ANCHOR_PUBLISHERS` empty, every
 * anchor check answers `not-checked` / `NO_PUBLISHERS`, and every result says
 * so. §8.5 #1 does not run. That is the truth about the current deployment and
 * it belongs on the result rather than in a comment.
 */

import type { ResolverEndpoint } from './transport.js'

/**
 * Independent NNS APIs to query (§8.5 #2). **Empty.**
 *
 * `RESOLVER_QUORUM` is 2, so a host app must supply at least two — see the
 * still-open question of what a launch with fewer than two independent
 * operators does, which is a deployment decision this package refuses to make
 * for anyone (`quorum` is an option, and setting it below the spec is loud).
 */
export const DEFAULT_RESOLVERS: readonly ResolverEndpoint[] = []

/**
 * `ANCHOR_PUBLISHERS` — the client-side list §9 makes the whole of publisher
 * admission, since `anchor()` is permissionless. **Empty.**
 *
 * An address not on this list is ignored by the reader: never counted toward
 * quorum, and never a mismatch. Contents are a deployment decision.
 */
export const DEFAULT_ANCHOR_PUBLISHERS: readonly string[] = []
