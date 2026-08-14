/**
 * §8.5 #2: query at least `RESOLVER_QUORUM` independent resolvers and compare
 * both the root and the resolved answer.
 *
 * The order of operations is the load-bearing part, and it is the same order
 * `packages/api` uses on its checkpoint snapshot: **verify first, then
 * compare.** Each resolver's document is checked on its own — leaf rebuilt,
 * path recombined — before any of them are set against each other. Agreement
 * between two unverified answers is worth nothing; agreement between two
 * independently verified ones is the entire security argument.
 *
 * Three outcomes, and the difference between them is deliberate:
 *
 * - **Unreachable** removes a party from the count. Too few left, and quorum
 *   is unmet — `QUORUM_UNMET`.
 * - **A bad document or a bad proof halts everything**, even if the other
 *   resolvers agree with each other. Dropping the liar and proceeding on the
 *   honest majority sounds robust and is the exact opposite: it lets whoever
 *   controls one resolver degrade the quorum silently, which is the hole
 *   §8.5 #2 exists to close.
 * - **Different answers halt too**, per §8.5's "stop and warn — never
 *   silently prefer one".
 */

import { CONSTANTS } from '@nns/core'

import { QuorumError, type ResolverReply } from './errors.js'
import { getJson, type Fetched, type FetchedOk, type HttpFetch, type ResolverEndpoint, join } from './transport.js'
import { warn, type ResolveWarning } from './warnings.js'

/** The checkpoint a resolver answered against, when it served a proof at all. */
export interface CheckpointRef {
  readonly rootHex: string
  readonly height: number
}

/**
 * What one resolver said, reduced to the two things §8.5 #2 compares.
 *
 * `key` is the answer: two resolvers agree exactly when their keys are equal.
 * `summary` is the same thing in prose, carried so a disagreement can be
 * reported as "resolver A said X, resolver B said Y" rather than as a bare
 * failure.
 */
export interface Observation {
  readonly key: string
  readonly summary: string
  readonly checkpoint: CheckpointRef | null
}

export interface Witness<O extends Observation> {
  readonly endpoint: ResolverEndpoint
  readonly observation: O
}

export interface Agreement<O extends Observation> {
  /** The resolvers that answered, all of them agreeing. Never fewer than `required`. */
  readonly witnesses: readonly Witness<O>[]
  readonly queried: number
  /** The deepest checkpoint any witness proved against, `null` when none served a proof. */
  readonly checkpoint: CheckpointRef | null
  readonly warnings: readonly ResolveWarning[]
}

export interface QuorumPolicy {
  readonly endpoints: readonly ResolverEndpoint[]
  readonly required: number
  readonly fetch: HttpFetch
  readonly timeoutMs: number
}

/**
 * What `interpret` may conclude about one reply.
 *
 * `unavailable` is not a third answer, it is the absence of one: a resolver
 * that is still syncing answers 503 `NOT_SYNCED` on every route, which is
 * downtime wearing an HTTP status. Folding it in with the unreachable ones
 * keeps it out of the agreement comparison, where it would read as a
 * disagreement and halt a resolution that nothing is actually wrong with.
 */
export type Interpretation<O extends Observation> =
  | { readonly kind: 'answer'; readonly observation: O }
  | { readonly kind: 'unavailable'; readonly reason: string }

export const answered = <O extends Observation>(observation: O): Interpretation<O> => ({ kind: 'answer', observation })
export const unavailable = <O extends Observation>(reason: string): Interpretation<O> => ({ kind: 'unavailable', reason })

/**
 * Fetch `path` from every endpoint, interpret each reply, and require them to
 * agree.
 *
 * `interpret` is where verification happens, and it is expected to **throw**
 * on anything it cannot verify — see the module note on why that halts the
 * call rather than dropping the party. It runs in endpoint order after all
 * the fetches have settled, so which failure surfaces first is deterministic
 * and does not depend on network timing.
 */
export async function agree<O extends Observation>(
  policy: QuorumPolicy,
  path: string,
  interpret: (fetched: FetchedOk, endpoint: ResolverEndpoint) => Interpretation<O>,
): Promise<Agreement<O>> {
  const fetched = await Promise.all(
    policy.endpoints.map((endpoint) => getJson(policy.fetch, join(endpoint.url, path), policy.timeoutMs)),
  )

  const witnesses: Witness<O>[] = []
  const silent: ResolverReply[] = []

  for (const [index, endpoint] of policy.endpoints.entries()) {
    const reply = fetched[index] as Fetched
    if (!reply.ok) {
      silent.push({ resolver: endpoint.name, answer: `unreachable: ${reply.reason}` })
      continue
    }
    const interpretation = interpret(reply, endpoint)
    if (interpretation.kind === 'unavailable') {
      silent.push({ resolver: endpoint.name, answer: interpretation.reason })
      continue
    }
    witnesses.push({ endpoint, observation: interpretation.observation })
  }

  const replies = (): ResolverReply[] => [
    ...witnesses.map((w) => ({ resolver: w.endpoint.name, answer: w.observation.summary })),
    ...silent,
  ]

  if (witnesses.length < policy.required) {
    throw new QuorumError(
      'QUORUM_UNMET',
      `${witnesses.length} of ${policy.endpoints.length} resolvers answered, ${policy.required} required`,
      replies(),
    )
  }

  const first = witnesses[0] as Witness<O>
  if (witnesses.some((w) => w.observation.key !== first.observation.key)) {
    throw new QuorumError(
      'QUORUM_DISAGREEMENT',
      'resolvers gave different answers — refusing to prefer one (§8.5)',
      replies(),
    )
  }

  return {
    witnesses,
    queried: policy.endpoints.length,
    checkpoint: reconcileRoots(witnesses),
    warnings: rootWarnings(witnesses),
  }
}

/** Every distinct checkpoint height a witness proved against, deepest first. */
function checkpoints<O extends Observation>(witnesses: readonly Witness<O>[]): Witness<O>[] {
  return witnesses.filter((w) => w.observation.checkpoint !== null).sort((a, b) => {
    const left = a.observation.checkpoint as CheckpointRef
    const right = b.observation.checkpoint as CheckpointRef
    return right.height - left.height
  })
}

/**
 * The root half of §8.5 #2, and the honest limit on it.
 *
 * Two roots are only comparable **at the same height** — checkpoints are cut
 * every `CHECKPOINT_INTERVAL` blocks and independent resolvers will sit a
 * boundary apart routinely, which is lag, not conflict. Same height and
 * different roots is a conflict, and a hard one: one of these parties is
 * serving a state the other cannot have derived.
 *
 * What this cannot do is compare across heights. Closing that needs a
 * resolver endpoint that serves a checkpoint *by height* so the ahead party
 * can be asked what it had at the behind party's boundary; the API serves
 * only `/checkpoints/latest` today. Until then the mismatch is reported as
 * {@link 'ROOT_HEIGHTS_DIFFER'} rather than passed off as a check that ran.
 */
function reconcileRoots<O extends Observation>(witnesses: readonly Witness<O>[]): CheckpointRef | null {
  const proving = checkpoints(witnesses)
  const deepest = proving[0]
  if (deepest === undefined) return null

  const byHeight = new Map<number, Witness<O>>()
  for (const witness of proving) {
    const checkpoint = witness.observation.checkpoint as CheckpointRef
    const seen = byHeight.get(checkpoint.height)
    if (seen === undefined) {
      byHeight.set(checkpoint.height, witness)
      continue
    }
    const other = seen.observation.checkpoint as CheckpointRef
    if (other.rootHex !== checkpoint.rootHex) {
      throw new QuorumError(
        'QUORUM_ROOT_MISMATCH',
        `two resolvers published different roots for checkpoint ${checkpoint.height}`,
        [
          { resolver: seen.endpoint.name, answer: `root ${other.rootHex} at ${other.height}` },
          { resolver: witness.endpoint.name, answer: `root ${checkpoint.rootHex} at ${checkpoint.height}` },
        ],
      )
    }
  }

  return deepest.observation.checkpoint
}

function rootWarnings<O extends Observation>(witnesses: readonly Witness<O>[]): ResolveWarning[] {
  const proving = checkpoints(witnesses)
  if (proving.length < 2) return []

  const heights = new Set(proving.map((w) => (w.observation.checkpoint as CheckpointRef).height))
  if (heights.size === 1) return []

  return [
    warn(
      'ROOT_HEIGHTS_DIFFER',
      `resolvers proved against different checkpoints (${[...heights].sort((a, b) => b - a).join(', ')}), ` +
        'so their roots were not compared to each other',
    ),
  ]
}

/**
 * The warning that rides on every result when the host app configured a
 * quorum below the spec's. CLAUDE.md's rule for this package: disabling the
 * quorum must be loud, and loud means on the result, not in a log line.
 */
export function belowSpecWarning(required: number): ResolveWarning | null {
  if (required >= CONSTANTS.RESOLVER_QUORUM) return null
  return warn(
    'QUORUM_BELOW_SPEC',
    `quorum is ${required}, below RESOLVER_QUORUM (${CONSTANTS.RESOLVER_QUORUM}) — ` +
      "a single party's proofs are internally consistent whether or not it is honest (§2.1)",
  )
}
