/**
 * §8.5 #1, wired — not reimplemented.
 *
 * The rule itself (which publishers count, what quorum means, when two
 * endpoints disagreeing is "couldn't check" rather than "checked and
 * conflicting", how staleness is measured) lives in `@nimiqnames/anchor/reader` and
 * exists exactly once. That module is browser-safe by a pinned import-graph
 * test, and the test now walks this package's graph too, so the edge cannot
 * quietly drag viem or a node builtin into a mini-app bundle.
 *
 * What this file adds is the part §8.5 #3 puts on the *client* rather than on
 * the reader: **tying the anchor to the answer.**
 *
 * An anchor carries the §8.1 **checkpoint commitment**. A proof verifies
 * against **`nameRoot`**, one of the six values that commitment is taken over.
 * Comparing an anchored commitment with anything else — or comparing nothing
 * at all and reporting the anchor beside a proof — proves only that the party
 * serving you is internally consistent, which §2.1 says a single party's
 * proofs always are. So the chain is closed here, in three links:
 *
 * 1. Fetch `/checkpoints/{height}` from the resolver whose proof was used, and
 *    require its `nameRoot` to be the root that proof verified against.
 * 2. **Recompute** the commitment from that document's own six components via
 *    `core.commitmentFrom`, and require it to equal the commitment the
 *    document claims. Without this step the whole exercise is free to fake: a
 *    party pairs a genuinely anchored commitment with any `nameRoot` it likes
 *    and every downstream check still passes.
 * 3. Ask the reader what listed publishers anchored at that height, and
 *    require the value to be the same one.
 *
 * Link 3 failing is not a warning. A resolver whose checkpoint publishers did
 * not anchor is either a fork or a lie, and §8.5 #7 says stop.
 *
 * **Cost when nothing is configured is zero.** No policy, no publishers, or no
 * checkpoint to ask about, and this makes no request at all — which is the
 * shipped default, since `DEFAULT_ANCHOR_PUBLISHERS` is empty.
 */

import { checkAnchors, createAnchorReadRpc, type AnchorCheck, type AnchorReadRpc } from '@nimiqnames/anchor/reader'
import { CONSTANTS, commitmentFrom, type CheckpointComponents } from '@nimiqnames/core'

import { toHex } from './documents.js'
import { DEFAULT_ANCHOR_PUBLISHERS } from './defaults.js'
import { AnchorError, ConfigurationError } from './errors.js'
import type { CheckpointRef } from './quorum.js'
import { getJson, join, type HttpFetch, type ResolverEndpoint } from './transport.js'
import { warn, type ResolveWarning } from './warnings.js'

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * How to read §9 anchors. Absent by default: nothing is deployed, so there is
 * no contract address to ship and no endpoint pair to ship with it.
 */
export interface AnchorPolicy {
  /** The §9 contract, `0x`-prefixed. A deployment decision — no default exists. */
  readonly contract: string
  /**
   * **At least two independent endpoints** (§9). Strings are wrapped with the
   * reader's plain-`fetch` JSON-RPC edge; an {@link AnchorReadRpc} is taken as
   * given, which is how a host injects a wallet provider or a test injects a
   * fake.
   *
   * Two is a refusal, not a recommendation: the injected provider belongs to
   * the host, so a single endpoint can feed a client a false anchor and no
   * cross-check can catch it.
   */
  readonly rpcs: readonly (string | AnchorReadRpc)[]
  /** `ANCHOR_PUBLISHERS`. Defaults to {@link DEFAULT_ANCHOR_PUBLISHERS}, which is empty. */
  readonly publishers?: readonly string[]
  /** Distinct listed publishers that must agree. Defaults to `CONSTANTS.ANCHOR_QUORUM`. */
  readonly quorum?: number
  /** How far back to scan for `Anchored` events. The reader's default is ~5.8 days. */
  readonly lookbackBlocks?: bigint
  /** Wall clock in unix seconds, for §8.5 #8 staleness. Injectable so tests can age an anchor. */
  readonly now?: () => number
}

/** A validated policy. Built once at construction, so a typo fails before any lookup does. */
export interface AnchorSettings {
  readonly contract: `0x${string}`
  readonly rpcs: readonly AnchorReadRpc[]
  readonly publishers: readonly string[]
  readonly quorum: number | null
  readonly lookbackBlocks: bigint | null
  readonly now: (() => number) | null
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Validate a policy at construction time.
 *
 * Every refusal here is something that otherwise degrades **silently**: a
 * mistyped publisher is simply never matched, so it lowers the effective
 * quorum without lowering the number the result reports; one endpoint is not a
 * cross-check; a wrong-shaped contract address makes every check answer
 * "nothing anchored here", which reads exactly like a publisher that stopped.
 */
export function anchorSettings(policy: AnchorPolicy): AnchorSettings {
  if (!EVM_ADDRESS.test(policy.contract)) {
    throw new ConfigurationError(`anchors.contract is not a 20-byte EVM address: ${policy.contract}`)
  }
  if (policy.rpcs.length < 2) {
    throw new ConfigurationError(
      `anchors.rpcs holds ${policy.rpcs.length} endpoint(s); §9 requires at least two independent ones — ` +
        'the injected provider is the host app\'s, so one endpoint alone can serve a false anchor',
    )
  }
  const publishers = policy.publishers ?? DEFAULT_ANCHOR_PUBLISHERS
  for (const publisher of publishers) {
    if (!EVM_ADDRESS.test(publisher)) {
      throw new ConfigurationError(
        `anchors.publishers holds "${publisher}", which is not a 20-byte EVM address — ` +
          'an unmatchable entry lowers the quorum that is actually enforced without lowering the one reported',
      )
    }
  }
  if (policy.quorum !== undefined && (!Number.isSafeInteger(policy.quorum) || policy.quorum < 1)) {
    throw new ConfigurationError(`anchors.quorum must be a positive integer, got ${String(policy.quorum)}`)
  }
  if (policy.quorum !== undefined && policy.quorum > publishers.length) {
    throw new ConfigurationError(
      `anchors.quorum is ${policy.quorum} but only ${publishers.length} publisher(s) are listed — ` +
        'a quorum that cannot be met is a quorum that is not enforced',
    )
  }
  return {
    contract: policy.contract.toLowerCase() as `0x${string}`,
    rpcs: policy.rpcs.map((rpc) => (typeof rpc === 'string' ? createAnchorReadRpc(rpc) : rpc)),
    publishers,
    quorum: policy.quorum ?? null,
    lookbackBlocks: policy.lookbackBlocks ?? null,
    now: policy.now ?? null,
  }
}

// ── The report ──────────────────────────────────────────────────────────────

/** Why the reader never ran. Distinct from anything the reader itself concluded. */
export type AnchorNotRunReason =
  /** No `anchors` policy was configured. */
  | 'NOT_CONFIGURED'
  /** No resolver served a proof, so there is no checkpoint height to ask about (§8.7). */
  | 'NO_CHECKPOINT'
  /** The serving resolver could not supply the §8.1 components the anchor must be tied to. */
  | 'BINDING_UNAVAILABLE'

/**
 * What §8.5 #1 concluded, on every result.
 *
 * `status` is the reader's vocabulary, unmodified — the six outcomes a host
 * app renders. `check` is the reader's full typed answer when it ran, and
 * `null` when it did not; `reason` says which of the two, and why.
 */
export interface AnchorReport {
  readonly status: AnchorCheck['status']
  readonly detail: string
  /** The reader's answer, or `null` when the reader never ran. */
  readonly check: AnchorCheck | null
  /** Present only when the reader never ran. */
  readonly reason: AnchorNotRunReason | null
}

const notRun = (reason: AnchorNotRunReason, detail: string): AnchorReport => ({
  status: 'not-checked',
  detail,
  check: null,
  reason,
})

export const ANCHORS_NOT_CONFIGURED: AnchorReport = notRun(
  'NOT_CONFIGURED',
  'no anchor policy configured: the agreed checkpoint was not compared against any chain (§8.5 #1, §9)',
)

// ── Reading the §8.1 components a served checkpoint claims ──────────────────

/**
 * The six values of a `/checkpoints/{height}` document, or `null` if the body
 * is not that shape.
 *
 * Read defensively, not through `documents.ts`'s throwing readers: a malformed
 * or missing checkpoint document must degrade to "the anchor check did not
 * run", never halt a resolution that has already agreed on its answer and
 * verified its proof. A document that parses and **contradicts** itself is the
 * other case entirely, and it is handled by the caller.
 */
export function readCheckpointComponents(
  body: unknown,
): { readonly components: CheckpointComponents; readonly commitment: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const checkpoint = (body as Record<string, unknown>)['checkpoint']
  if (typeof checkpoint !== 'object' || checkpoint === null) return null
  const source = checkpoint as Record<string, unknown>

  const digest = (key: string): Uint8Array | null => {
    const value = source[key]
    if (typeof value !== 'string') return null
    const hex = (value.startsWith('0x') ? value.slice(2) : value).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(hex)) return null
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  const height = source['height']
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) return null
  const nameRoot = digest('nameRoot')
  const pricesRoot = digest('pricesRoot')
  const pendingRoot = digest('pendingRoot')
  // `null` is a real value here: a layout-1 row predates the unreserved set,
  // and its commitment cannot be recomputed by an r16+ client at all.
  const unreservedRoot = digest('unreservedRoot')
  const logHash = digest('logHash')
  const commitment = digest('commitment')
  if (
    nameRoot === null ||
    pricesRoot === null ||
    pendingRoot === null ||
    unreservedRoot === null ||
    logHash === null ||
    commitment === null
  ) {
    return null
  }
  return {
    components: { height, nameRoot, pricesRoot, pendingRoot, unreservedRoot, logHash },
    commitment: toHex(commitment),
  }
}

// ── The check ───────────────────────────────────────────────────────────────

export interface AnchorContext {
  readonly settings: AnchorSettings | null
  readonly fetch: HttpFetch
  readonly timeoutMs: number
}

/**
 * Run §8.5 #1 for the checkpoint a resolution proved against, and tie the
 * result to that checkpoint.
 *
 * @throws {AnchorError} the served checkpoint contradicts the proof or itself
 *   (`CHECKPOINT_BINDING_INVALID`), listed publishers anchored a different
 *   commitment than the one served (`ANCHOR_MISMATCH`), or listed publishers
 *   contradict each other at this height (`ANCHOR_DIVERGENCE`, §8.5 #7).
 */
export async function checkAnchor(
  context: AnchorContext,
  checkpoint: CheckpointRef | null,
  servedBy: ResolverEndpoint | null,
): Promise<AnchorReport> {
  const { settings } = context
  if (settings === null) return ANCHORS_NOT_CONFIGURED
  if (settings.publishers.length === 0) {
    // Ask the reader rather than answering for it: `not-checked` /
    // `NO_PUBLISHERS` is its own conclusion about its own empty list, and the
    // day the list is filled this branch stops existing on its own.
    return report(
      await checkAnchors(settings.rpcs, {
        contractAddress: settings.contract,
        height: checkpoint?.height ?? 0,
        publishers: [],
      }),
    )
  }
  if (checkpoint === null || servedBy === null) {
    return notRun(
      'NO_CHECKPOINT',
      'no resolver served a proof, so there is no checkpoint height to compare against an anchor (§8.7)',
    )
  }

  // Link 1 and 2: what the serving resolver says the checkpoint *is*.
  const fetched = await getJson(
    context.fetch,
    join(servedBy.url, `checkpoints/${checkpoint.height}`),
    context.timeoutMs,
  )
  if (!fetched.ok || fetched.status !== 200) {
    return notRun(
      'BINDING_UNAVAILABLE',
      `${servedBy.name} did not serve checkpoint ${checkpoint.height} (${fetched.ok ? `HTTP ${fetched.status}` : fetched.reason}), ` +
        'so the anchored commitment could not be tied to the proof',
    )
  }
  const document = readCheckpointComponents(fetched.body)
  if (document === null) {
    return notRun(
      'BINDING_UNAVAILABLE',
      `${servedBy.name} served an unreadable checkpoint ${checkpoint.height}, ` +
        'so the anchored commitment could not be tied to the proof',
    )
  }

  const { components, commitment } = document
  if (components.height !== checkpoint.height || toHex(components.nameRoot) !== checkpoint.rootHex) {
    throw new AnchorError(
      'CHECKPOINT_BINDING_INVALID',
      `${servedBy.name} proved against root ${checkpoint.rootHex} at ${checkpoint.height}, but its own ` +
        `checkpoint ${components.height} carries nameRoot ${toHex(components.nameRoot)} — one party, two states`,
    )
  }
  const recomputed = toHex(commitmentFrom(components))
  if (recomputed !== commitment) {
    throw new AnchorError(
      'CHECKPOINT_BINDING_INVALID',
      `${servedBy.name}'s checkpoint ${components.height} claims commitment ${commitment}, but §8.1 over its own ` +
        `six components gives ${recomputed} — the document does not commit to what it says it commits to`,
    )
  }

  // Link 3: what listed publishers put on chain for that height.
  const check = await checkAnchors(settings.rpcs, {
    contractAddress: settings.contract,
    height: checkpoint.height,
    publishers: settings.publishers,
    ...(settings.quorum === null ? {} : { quorum: settings.quorum }),
    ...(settings.lookbackBlocks === null ? {} : { lookbackBlocks: settings.lookbackBlocks }),
    ...(settings.now === null ? {} : { now: settings.now }),
  })

  if (check.status === 'divergence') {
    throw new AnchorError(
      'ANCHOR_DIVERGENCE',
      `listed publishers anchored conflicting commitments for checkpoint ${check.height} — ` +
        'the parties this client trusts to agree do not (§8.5 #7)',
      check,
    )
  }
  // A mismatch is a contradiction whether or not enough publishers vouched for
  // it. Quorum governs how much agreement it takes to *trust* an anchor; it
  // does not turn a listed publisher's conflicting attestation into silence,
  // and reporting "quorum not met" over one would read as "nothing anchored
  // yet, wait" — the wrong instruction entirely. The cost is accepted
  // knowingly: a single listed publisher anchoring garbage halts resolutions,
  // which is the same power the reader already gives it through `divergence`,
  // and the list is the client's own.
  const anchored =
    check.status === 'verified'
      ? check.commitment
      : check.status === 'quorum-not-met'
        ? (check.anchors[0]?.commitment ?? null)
        : null
  if (anchored !== null && anchored.slice(2).toLowerCase() !== commitment) {
    const vouching = check.status === 'verified' ? `${check.publishers.length} listed publisher(s)` : '1 listed publisher, below quorum,'
    throw new AnchorError(
      'ANCHOR_MISMATCH',
      `${servedBy.name} served checkpoint ${checkpoint.height} with commitment 0x${commitment}, but ` +
        `${vouching} anchored ${anchored} — this resolver's state is not the state that was anchored (§8.5 #3, #7)`,
      check,
    )
  }
  return report(check)
}

function report(check: AnchorCheck): AnchorReport {
  return { status: check.status, detail: detailOf(check), check, reason: null }
}

function detailOf(check: AnchorCheck): string {
  switch (check.status) {
    case 'not-checked':
      return 'no anchor publishers are configured, so §8.5 #1 did not run: the agreed checkpoint was never compared against a chain'
    case 'unavailable':
      return `fewer than two anchor endpoints answered, so the §9 cross-check could not run (${check.errors
        .map((e) => `${e.rpc}: ${e.error}`)
        .join('; ')})`
    case 'verified':
      return `${check.publishers.length} listed publisher(s) anchored this checkpoint; the log snapshot is at ${check.cid}`
    case 'rpc-disagreement':
      return `the anchor endpoints disagree about what is on chain, so nothing was confirmed — ${check.detail}`
    case 'quorum-not-met':
      return `${check.found} of ${check.required} listed publishers have anchored checkpoint ${check.height} so far`
    // `divergence` never reaches here: it throws.
    default:
      return 'anchors diverge'
  }
}

/**
 * The warnings a report earns. `verified` and fresh earns none — the point of
 * the check is that a client which passes it says nothing at all.
 */
export function anchorWarnings(anchor: AnchorReport): readonly ResolveWarning[] {
  const warnings: ResolveWarning[] = []
  if (anchor.check === null || anchor.status === 'not-checked') {
    warnings.push(warn('ANCHOR_NOT_CHECKED', anchor.detail))
  } else if (anchor.status === 'unavailable' || anchor.status === 'rpc-disagreement') {
    warnings.push(warn('ANCHOR_UNAVAILABLE', anchor.detail))
  } else if (anchor.status === 'quorum-not-met') {
    warnings.push(warn('ANCHOR_QUORUM_NOT_MET', anchor.detail))
  }

  // §8.5 #8 rides alongside any answer that is not itself a hard stop, and an
  // empty window counts as stale: a client cannot tell "nothing to anchor"
  // from "the publisher stopped".
  const check = anchor.check
  if (check !== null && (check.status === 'verified' || check.status === 'quorum-not-met') && check.staleness.stale) {
    const age = check.staleness.ageSeconds
    const limitHours = Math.floor(CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC / 3_600)
    warnings.push(
      warn(
        'ANCHOR_STALE',
        age === null
          ? 'no anchor at all in the scanned window — either nothing has been anchored recently or the publishers stopped (§8.5 #8)'
          : `the newest anchor is ${Math.floor(age / 3_600)} h old, past the ${limitHours} h limit (§8.5 #8)`,
      ),
    )
  }
  return warnings
}
