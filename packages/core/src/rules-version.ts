/**
 * Which rules produced a derived state.
 *
 * Bump it in the commit that changes what a replay of an existing log or chain
 * would produce: a verdict, an obligation, a height effect, the canonical
 * order, the effective sender, or a §3 constant the reducer reads. A database
 * built under one value and resumed under another holds a state that matches
 * neither set of rules, so the indexer refuses that resume (`Store.loadCursor`)
 * and names the two ways on: a rebuild, or `NNS_ACCEPT_RULES_VERSION` for a
 * change known not to move the history this database holds.
 *
 * It is not `SPEC_REVISION`. Revisions are weekly and many leave the reducer
 * alone; refusing on each would make the override a habit. It is also not
 * `COMMITMENT_LAYOUT`, which says the narrower thing about §8.1's shape.
 *
 * Bookkeeping only: it is in no commitment, no log line and no published
 * constant, so moving it moves no root.
 *
 * `rules-version.test.ts` pins it beside a digest of the conformance vectors,
 * so a rule change that moved a vector cannot land without this being looked
 * at.
 */
export const RULES_VERSION = 2
