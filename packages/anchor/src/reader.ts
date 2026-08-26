/**
 * The anchor reader (§8.5 #1, #7, #8) — the client half of §9, shipped to
 * the mini app and consumed by `packages/resolver`. Implemented once, here.
 *
 * **Browser-safe by construction**: plain `fetch` JSON-RPC, no viem, no
 * node builtins, no key material, read-only. `browser-safety.test.ts`
 * walks this module's transitive runtime import graph and fails the suite
 * if any of that stops being true.
 *
 * What a check does, in §8.5's terms:
 *
 * - `eth_getLogs` by the committed artifact's `Anchored` topic, decoded by
 *   the shared {@link decodeAnchored} — the same codec the publisher reads
 *   its own history with.
 * - **Unknown publishers are ignored — never counted, never a mismatch**
 *   (§8.5 #1). "Publisher" means an address on the caller-supplied
 *   `ANCHOR_PUBLISHERS` list, which **defaults empty**: until a deployment
 *   decision fills it, every check reports `not-checked` rather than this
 *   package inventing an entry.
 * - **Quorum**: `ANCHOR_QUORUM` distinct listed publishers agreeing on
 *   (commitment, logDigest) at the asked height.
 * - **At least two independent RPC endpoints, and they must agree** (§9):
 *   the injected provider is chosen by the host, so a single endpoint can
 *   feed a client a false anchor. An anchor counts only when at least two
 *   endpoints report it.
 * - **Absence is never agreement.** An endpoint that errors, or reports an
 *   outcome-deciding event the others do not, is "couldn't check"
 *   (`unavailable` / `rpc-disagreement`) — the same discipline as the
 *   resolver's `reconcileAcrossHeights`, and distinct from "checked and
 *   disagreed".
 * - **A listed publisher's cross-checked event at the asked height with a
 *   different (commitment, logDigest) than the quorum is `divergence`** —
 *   a hard signal, the one this whole tier exists to surface (§8.5 #7),
 *   never noise. The same conflict vouched for by only one endpoint is
 *   `rpc-disagreement` instead: the chain views differ, and this reader
 *   cannot know which endpoint is lying.
 * - **Staleness** (§8.5 #8): the newest cross-checked listed anchor's age
 *   against `ANCHOR_STALENESS_LIMIT_SEC` (48 h), reported alongside any
 *   answer that is not itself a hard stop. No anchor in the window is
 *   reported stale too — the client cannot tell "nothing to anchor" from
 *   "the publisher stopped", so it says so rather than guessing.
 * - The fetch CID is rebuilt from the winning digest via
 *   `core.cidFromDigest` — the only CID computation a client performs
 *   (§8.2).
 */

import { cidFromDigest, CONSTANTS } from '@nns/core'
import { hexToBytes } from '@noble/hashes/utils.js'
import { ANCHORED_TOPIC0 } from './artifact.js'
import type { EvmAddress, EvmLog, EvmLogFilter, Hex } from './chain.js'
import { decodeAnchored, type PastAnchor } from './publish.js'

export class ReaderError extends Error {
  override readonly name = 'ReaderError'
}

/**
 * ~5.8 days of ~2 s blocks: comfortably wider than the 48 h staleness
 * limit, so "no anchor in the window" and "stale" coincide, and narrow
 * enough for public endpoints' `eth_getLogs` range caps.
 */
export const DEFAULT_READER_LOOKBACK_BLOCKS = 250_000n

// ── The read-only chain surface, and its plain-fetch implementation ─────────

/** What reading anchors costs. Two methods; both read-only. */
export interface AnchorReadRpc {
  /** Names the endpoint in results and errors. */
  readonly label: string
  blockNumber(): Promise<bigint>
  getLogs(filter: EvmLogFilter): Promise<readonly EvmLog[]>
}

/**
 * JSON-RPC over plain `fetch` — deliberately not viem, per §9: the
 * cross-check endpoint must be reachable from a mini app over nothing but
 * `fetch`, and this package's only viem import stays in `viem-rpc.ts`.
 */
export function createAnchorReadRpc(url: string, fetchImpl: typeof fetch = fetch): AnchorReadRpc {
  let nextId = 1
  async function call(method: string, params: readonly unknown[]): Promise<unknown> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    })
    if (!response.ok) throw new ReaderError(`${url}: ${method} answered HTTP ${response.status}`)
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
    if (body.error !== undefined) {
      throw new ReaderError(`${url}: ${method} answered ${body.error.message ?? 'an RPC error'}`)
    }
    return body.result
  }

  return {
    label: url,
    async blockNumber(): Promise<bigint> {
      return BigInt((await call('eth_blockNumber', [])) as string)
    },
    async getLogs(filter: EvmLogFilter): Promise<readonly EvmLog[]> {
      const raw = (await call('eth_getLogs', [
        {
          address: filter.address,
          topics: [...filter.topics],
          fromBlock: `0x${filter.fromBlock.toString(16)}`,
          toBlock: filter.toBlock,
        },
      ])) as readonly {
        address: string
        topics: readonly Hex[]
        data: Hex
        blockNumber: Hex
        transactionHash: Hex
      }[]
      return raw.map((log) => ({
        address: log.address.toLowerCase() as EvmAddress,
        topics: log.topics,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
        transactionHash: log.transactionHash,
      }))
    },
  }
}

// ── The check ───────────────────────────────────────────────────────────────

export interface AnchorCheckOptions {
  readonly contractAddress: EvmAddress
  /** The Nimiq checkpoint height being verified (§8.5 #3's first step). */
  readonly height: number
  /**
   * `ANCHOR_PUBLISHERS` — the caller's list, **empty by default**. Its
   * contents are a deployment decision; this package never supplies one.
   */
  readonly publishers?: readonly string[]
  /** Distinct listed publishers that must agree. Default `CONSTANTS.ANCHOR_QUORUM`. */
  readonly quorum?: number
  readonly lookbackBlocks?: bigint
  /** Wall clock, unix seconds, for staleness. Default `Date.now()/1000`. */
  now?(): number
}

/** §8.5 #8, computed over cross-checked listed anchors in the whole window. */
export interface AnchorStaleness {
  /** Newest cross-checked listed anchor's block time; `null` when none seen. */
  readonly newestTimestamp: number | null
  readonly ageSeconds: number | null
  /** Older than `ANCHOR_STALENESS_LIMIT_SEC`, or nothing in the window at all. */
  readonly stale: boolean
}

export interface AgreedAnchor {
  readonly publisher: EvmAddress
  readonly commitment: Hex
  readonly logDigest: Hex
  readonly transactionHash: Hex
}

/**
 * Every way a check can come out, kept distinct because each is a different
 * instruction to the caller. Only `verified` may be trusted; `divergence`
 * and `rpc-disagreement` are hard stops; `quorum-not-met` is §8.7-style
 * pending depth; `not-checked` and `unavailable` mean the check did not run.
 */
export type AnchorCheck =
  | {
      /** `ANCHOR_PUBLISHERS` is empty — §8.5 #1 has not run at all. */
      readonly status: 'not-checked'
      readonly reason: 'NO_PUBLISHERS'
    }
  | {
      /** Fewer than two endpoints answered — the §9 cross-check could not run. */
      readonly status: 'unavailable'
      readonly errors: readonly { readonly rpc: string; readonly error: string }[]
    }
  | {
      readonly status: 'verified'
      readonly height: number
      readonly commitment: Hex
      readonly logDigest: Hex
      /** Rebuilt from `logDigest` via `core.cidFromDigest` — where the log snapshot lives. */
      readonly cid: string
      /** The distinct listed publishers that agreed. */
      readonly publishers: readonly EvmAddress[]
      readonly staleness: AnchorStaleness
    }
  | {
      /** Cross-checked listed anchors at this height carry conflicting values. */
      readonly status: 'divergence'
      readonly height: number
      readonly conflicting: readonly AgreedAnchor[]
    }
  | {
      /** The endpoints' chain views differ on events that decide the outcome. */
      readonly status: 'rpc-disagreement'
      readonly height: number
      readonly detail: string
      readonly singleSource: readonly (AgreedAnchor & { readonly rpc: string })[]
    }
  | {
      readonly status: 'quorum-not-met'
      readonly height: number
      readonly found: number
      readonly required: number
      readonly anchors: readonly AgreedAnchor[]
      readonly staleness: AnchorStaleness
    }

/** What must agree: the pair §9 makes one attestation of. */
const valueKey = (anchor: PastAnchor): string => `${anchor.root}:${anchor.logDigest}`
/** Event identity for cross-endpoint matching — the full tuple, so a fabricated variant never merges. */
const anchorKey = (anchor: PastAnchor): string =>
  `${anchor.publisher}:${anchor.nimiqHeight}:${valueKey(anchor)}:${anchor.transactionHash}`

function toAgreed(anchor: PastAnchor): AgreedAnchor {
  return {
    publisher: anchor.publisher,
    commitment: anchor.root,
    logDigest: anchor.logDigest,
    transactionHash: anchor.transactionHash,
  }
}

/**
 * Runs §8.5 #1 for one checkpoint height. Never throws on chain content —
 * every outcome is a typed status — but does throw {@link ReaderError} on
 * caller mistakes (fewer than two endpoints, a malformed height), because
 * those are bugs, not states.
 */
export async function checkAnchors(
  rpcs: readonly AnchorReadRpc[],
  options: AnchorCheckOptions,
): Promise<AnchorCheck> {
  const publishers = (options.publishers ?? []).map((address) => address.toLowerCase())
  if (publishers.length === 0) return { status: 'not-checked', reason: 'NO_PUBLISHERS' }
  if (rpcs.length < 2) {
    // §9: the injected provider is the host's; one endpoint can lie alone.
    throw new ReaderError('checkAnchors needs at least two independent RPC endpoints (§9) — one is not a cross-check')
  }
  if (!Number.isSafeInteger(options.height) || options.height < 0) {
    throw new ReaderError(`not a height: ${String(options.height)}`)
  }
  const quorum = options.quorum ?? CONSTANTS.ANCHOR_QUORUM
  const lookback = options.lookbackBlocks ?? DEFAULT_READER_LOOKBACK_BLOCKS
  const listed = new Set(publishers)

  const swept = await sweep(rpcs, options.contractAddress, listed, lookback)
  if (swept.confirmed === null) return { status: 'unavailable', errors: swept.errors }
  const { confirmed, singleSource } = swept

  const staleness = computeStaleness(confirmed, options.now ?? (() => Math.floor(Date.now() / 1000)))

  // The asked height, confirmed view first.
  const atHeight = confirmed.filter((anchor) => anchor.nimiqHeight === options.height)
  const byValue = new Map<string, PastAnchor[]>()
  for (const anchor of atHeight) {
    const group = byValue.get(valueKey(anchor))
    if (group === undefined) byValue.set(valueKey(anchor), [anchor])
    else group.push(anchor)
  }
  if (byValue.size > 1) {
    // Two cross-checked values at one height: the §8.5 #7 signal itself.
    return { status: 'divergence', height: options.height, conflicting: atHeight.map(toAgreed) }
  }

  const agreed = byValue.size === 1 ? [...byValue.values()][0]! : []
  const agreedPublishers = [...new Set(agreed.map((anchor) => anchor.publisher))] as EvmAddress[]
  const singleAtHeight = singleSource.filter(({ anchor }) => anchor.nimiqHeight === options.height)

  // A seen-once event decides nothing — but if it *would* have (a
  // conflicting value, or the missing quorum vote), the endpoints' views
  // genuinely differ and this reader cannot pick one (§9).
  const agreedValue = agreed[0] === undefined ? null : valueKey(agreed[0])
  const conflictingSingles = singleAtHeight.filter(
    ({ anchor }) => agreedValue !== null && valueKey(anchor) !== agreedValue,
  )
  if (conflictingSingles.length > 0) {
    return {
      status: 'rpc-disagreement',
      height: options.height,
      detail:
        'an endpoint reports a conflicting anchor the others do not have — a divergence one provider ' +
        'vouches for is a provider disagreement, not yet a publisher one',
      singleSource: conflictingSingles.map(({ anchor, rpc }) => ({ ...toAgreed(anchor), rpc })),
    }
  }

  if (agreedPublishers.length >= quorum) {
    const winner = agreed[0]!
    return {
      status: 'verified',
      height: options.height,
      commitment: winner.root,
      logDigest: winner.logDigest,
      cid: cidFromDigest(hexToBytes(winner.logDigest.slice(2))),
      publishers: agreedPublishers,
      staleness,
    }
  }

  // Not enough confirmed votes. If seen-once events would have closed the
  // gap, that is an endpoint disagreement, not a quorum answer.
  const unionPublishers = new Set([
    ...agreedPublishers,
    ...singleAtHeight
      .filter(({ anchor }) => agreedValue === null || valueKey(anchor) === agreedValue)
      .map(({ anchor }) => anchor.publisher),
  ])
  if (unionPublishers.size >= quorum) {
    return {
      status: 'rpc-disagreement',
      height: options.height,
      detail:
        'quorum would be met only with anchors a single endpoint reports — the endpoints disagree ' +
        'about events that decide the outcome',
      singleSource: singleAtHeight.map(({ anchor, rpc }) => ({ ...toAgreed(anchor), rpc })),
    }
  }

  return {
    status: 'quorum-not-met',
    height: options.height,
    found: agreedPublishers.length,
    required: quorum,
    anchors: agreed.map(toAgreed),
    staleness,
  }
}

/**
 * One `Anchored` sweep per endpoint, cross-checked.
 *
 * Every endpoint is queried in parallel and a failure is recorded rather than
 * thrown: **absence of an answer is "couldn't check", not data.** Fewer than
 * two answers means the §9 cross-check could not run at all, which comes back
 * as `confirmed: null` — the caller turns that into `unavailable`.
 *
 * An anchor is `confirmed` only when **at least two endpoints report it**
 * (the full tuple, so a fabricated variant never merges with a real one).
 * A seen-once anchor is neither counted nor discarded: it goes to
 * `singleSource`, because whether it matters depends on what the caller was
 * asking, and an event that would change the answer means the endpoints
 * genuinely disagree.
 *
 * Shared by {@link checkAnchors} and {@link latestAnchoredHeight} so the two
 * cannot drift about what "the chain says" means.
 */
async function sweep(
  rpcs: readonly AnchorReadRpc[],
  contractAddress: EvmAddress,
  listed: ReadonlySet<string>,
  lookback: bigint,
): Promise<{
  readonly confirmed: PastAnchor[] | null
  readonly singleSource: { anchor: PastAnchor; rpc: string }[]
  readonly errors: readonly { readonly rpc: string; readonly error: string }[]
}> {
  interface EndpointView {
    readonly rpc: string
    readonly anchors: readonly PastAnchor[] | null
    readonly error: string | null
  }
  const views: readonly EndpointView[] = await Promise.all(
    rpcs.map(async (rpc): Promise<EndpointView> => {
      try {
        const head = await rpc.blockNumber()
        const fromBlock = head > lookback ? head - lookback : 0n
        const logs = await rpc.getLogs({
          address: contractAddress,
          topics: [ANCHORED_TOPIC0 as Hex],
          fromBlock,
          toBlock: 'latest',
        })
        const anchors = logs.map(decodeAnchored).filter((anchor) => listed.has(anchor.publisher))
        return { rpc: rpc.label, anchors, error: null }
      } catch (error) {
        return { rpc: rpc.label, anchors: null, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  const errors = views
    .filter((view) => view.error !== null)
    .map((view) => ({ rpc: view.rpc, error: view.error ?? 'unknown' }))
  const answered = views.filter((view) => view.anchors !== null)
  if (answered.length < 2) return { confirmed: null, singleSource: [], errors }

  const seenBy = new Map<string, { anchor: PastAnchor; rpcs: string[] }>()
  for (const view of answered) {
    for (const anchor of view.anchors ?? []) {
      const key = anchorKey(anchor)
      const entry = seenBy.get(key)
      if (entry === undefined) seenBy.set(key, { anchor, rpcs: [view.rpc] })
      else if (!entry.rpcs.includes(view.rpc)) entry.rpcs.push(view.rpc)
    }
  }
  const confirmed: PastAnchor[] = []
  const singleSource: { anchor: PastAnchor; rpc: string }[] = []
  for (const { anchor, rpcs: sources } of seenBy.values()) {
    if (sources.length >= 2) confirmed.push(anchor)
    else singleSource.push({ anchor, rpc: sources[0]! })
  }
  return { confirmed, singleSource, errors }
}

/** Which height {@link latestAnchoredHeight} found, or why it found none. */
export type AnchorHeightLookup =
  | { readonly status: 'found'; readonly height: number }
  | { readonly status: 'not-checked'; readonly reason: 'NO_PUBLISHERS' }
  | { readonly status: 'unavailable'; readonly errors: readonly { readonly rpc: string; readonly error: string }[] }
  /** The window holds no cross-checked anchor from a listed publisher. */
  | { readonly status: 'none'; readonly lookbackBlocks: bigint }

export interface AnchorHeightOptions {
  readonly contractAddress: EvmAddress
  readonly publishers?: readonly string[]
  readonly lookbackBlocks?: bigint
}

/**
 * The newest Nimiq checkpoint height any listed publisher has anchored, as
 * agreed by at least two endpoints.
 *
 * Discovery, **not** verification: it reports which height to ask about, and
 * {@link checkAnchors} is what decides whether the answer at that height is
 * trustworthy. Quorum is deliberately not applied here — a height that turns
 * out to have only one publisher behind it must come back as an explicit
 * `quorum-not-met` from the real check, not silently as "no anchor found".
 *
 * A seen-once anchor cannot raise the answer: an endpoint that alone claims a
 * newer height would otherwise steer every caller to a height the others have
 * never heard of, which is the single-endpoint trust §9 exists to remove.
 */
export async function latestAnchoredHeight(
  rpcs: readonly AnchorReadRpc[],
  options: AnchorHeightOptions,
): Promise<AnchorHeightLookup> {
  const publishers = (options.publishers ?? []).map((address) => address.toLowerCase())
  if (publishers.length === 0) return { status: 'not-checked', reason: 'NO_PUBLISHERS' }
  if (rpcs.length < 2) {
    throw new ReaderError(
      'latestAnchoredHeight needs at least two independent RPC endpoints (§9) — one is not a cross-check',
    )
  }
  const lookback = options.lookbackBlocks ?? DEFAULT_READER_LOOKBACK_BLOCKS
  const swept = await sweep(rpcs, options.contractAddress, new Set(publishers), lookback)
  if (swept.confirmed === null) return { status: 'unavailable', errors: swept.errors }

  let height: number | null = null
  for (const anchor of swept.confirmed) {
    if (height === null || anchor.nimiqHeight > height) height = anchor.nimiqHeight
  }
  return height === null ? { status: 'none', lookbackBlocks: lookback } : { status: 'found', height }
}

function computeStaleness(confirmed: readonly PastAnchor[], now: () => number): AnchorStaleness {
  let newest: number | null = null
  for (const anchor of confirmed) {
    if (newest === null || anchor.timestamp > newest) newest = anchor.timestamp
  }
  if (newest === null) {
    // Nothing in the window: the client cannot tell "nothing to anchor"
    // from "the publisher stopped", so it reports stale rather than guess
    // (§8.5 #8).
    return { newestTimestamp: null, ageSeconds: null, stale: true }
  }
  const ageSeconds = now() - newest
  return { newestTimestamp: newest, ageSeconds, stale: ageSeconds > CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC }
}
