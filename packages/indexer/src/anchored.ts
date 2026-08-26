/**
 * Bootstrapping from the §9 anchor instead of from a peer's word
 * (`NNS_SNAPSHOT_SOURCE=anchor`).
 *
 * The peer path asks one operator for its log and for the checkpoint it says
 * commits to it. Both halves come from the same party, so what it proves is
 * "this is what *that operator* committed to" — everything after that rests on
 * replaying the log and getting the same commitment back, which is real, but
 * the commitment being compared against was chosen by the party under
 * examination.
 *
 * The anchor path moves that value onto the chain. `@nns/anchor`'s reader runs
 * §8.5 #1 — `ANCHOR_QUORUM` distinct **listed** publishers agreeing, seen by
 * at least two independent RPC endpoints, with anything less reported as a
 * typed refusal rather than an answer — and hands back `(height, commitment,
 * cid)`. The bytes then come from any IPFS gateway, and the gateway is not
 * trusted for anything.
 *
 * ## The CID is a locator, not a verifier
 *
 * `logDigest` in an `Anchored` event is the **CID's sha2-256 multihash**, not
 * the §8.2 keccak log hash (`core.cidFromDigest`'s note, and "The CID is a
 * locator, not a verifier" in `docs/decisions.md`). Rebuilding it from the
 * fetched bytes would mean implementing UnixFS chunking and dag-pb here, which
 * is a second IPFS implementation to keep correct and worth nothing.
 *
 * So there is **exactly one check on the bytes, and it is the whole check**:
 * `bootstrap.ts` replays them and derives the §8.1 commitment at the anchored
 * height, which must equal the anchored commitment. The §8.2 log hash is one
 * of that commitment's six components, so a single wrong byte anywhere in the
 * file moves it. A gateway can waste a replay; it cannot get a wrong log past
 * this.
 *
 * ## What it still does not prove
 *
 * The same thing the peer path does not prove, and for the same reason:
 * **omission**. A message that was on chain and is missing from the log the
 * publishers anchored commits perfectly, and the publishers would be attesting
 * to it. `hybrid` is what closes that, here as there.
 */

import { CONSTANTS } from '@nns/core'
import { checkAnchors, latestAnchoredHeight, type AnchorReadRpc } from '@nns/anchor/reader'

import type { Logger } from './logger.js'
import { fetchLogBytes, type Fetcher, type LogSource } from './peer.js'

export class AnchorSourceError extends Error {
  override readonly name = 'AnchorSourceError'
}

export interface AnchoredSourceOptions {
  /** At least two independent endpoints — §9, and the reader refuses one. */
  readonly rpcs: readonly AnchorReadRpc[]
  readonly contractAddress: string
  /** `ANCHOR_PUBLISHERS`. Empty means the check does not run at all (§8.5 #1). */
  readonly publishers: readonly string[]
  /** Distinct listed publishers that must agree. Defaults to `ANCHOR_QUORUM`. */
  readonly quorum?: number
  /**
   * Where to fetch the snapshot. `{cid}` is substituted if present; otherwise
   * `/ipfs/<cid>` is appended, which is the path form every public gateway
   * serves.
   */
  readonly gateway: string
  readonly fetcher: Fetcher
  readonly logger: Logger
}

/** `https://gw/{cid}` or `https://gw` → the URL the snapshot is fetched from. */
export function gatewayUrl(gateway: string, cid: string): string {
  if (gateway.includes('{cid}')) return gateway.replaceAll('{cid}', cid)
  return `${gateway.replace(/\/+$/, '')}/ipfs/${cid}`
}

/**
 * Read the newest anchored checkpoint, fetch the log snapshot it points at, and
 * return it with the commitment it must reproduce.
 *
 * @throws {AnchorSourceError} on any reader status but `verified`. Each one is
 *   a different instruction and none of them is "try an older height": falling
 *   back until something passes is how a caller talks itself into the anchor a
 *   liar could supply.
 */
export async function anchoredSource(options: AnchoredSourceOptions): Promise<LogSource> {
  const { logger } = options
  const contractAddress = options.contractAddress as `0x${string}`
  const quorum = options.quorum ?? CONSTANTS.ANCHOR_QUORUM
  if (quorum < CONSTANTS.ANCHOR_QUORUM) {
    // Not refused: a deployment whose second publisher is not live yet is a
    // real state, and the resolver already ships the same disclosure for
    // RESOLVER_QUORUM. Said out loud so it is a decision, not a default.
    logger.warn('anchor.quorum-below-spec', {
      quorum,
      spec: CONSTANTS.ANCHOR_QUORUM,
      note: 'fewer publishers must agree than §3 requires — the bootstrap rests on a narrower attestation',
    })
  }

  const lookup = await latestAnchoredHeight(options.rpcs, {
    contractAddress,
    publishers: options.publishers,
  })
  switch (lookup.status) {
    case 'found':
      break
    case 'not-checked':
      throw new AnchorSourceError(
        'no anchor publishers are configured, so §8.5 #1 did not run at all. ' +
          'Set NNS_SNAPSHOT_ANCHOR_PUBLISHERS — an empty list is not a permissive default, it is no check.',
      )
    case 'unavailable':
      throw new AnchorSourceError(
        `fewer than two anchor RPC endpoints answered, so the §9 cross-check could not run: ${lookup.errors
          .map((entry) => `${entry.rpc}: ${entry.error}`)
          .join('; ')}`,
      )
    case 'none':
      throw new AnchorSourceError(
        `no listed publisher has anchored anything in the last ${lookup.lookbackBlocks} blocks. ` +
          'Nothing to bootstrap from — use NNS_START_MODE=scratch, or a peer API.',
      )
  }

  const check = await checkAnchors(options.rpcs, {
    contractAddress,
    height: lookup.height,
    publishers: options.publishers,
    quorum,
  })
  if (check.status !== 'verified') {
    throw new AnchorSourceError(describeRefusal(check, lookup.height))
  }
  if (check.staleness.stale) {
    // Not fatal: a stale anchor is still an attestation, and the chain scan
    // covers everything above it. Worth saying, because a publisher that
    // stopped is why the range being bootstrapped is larger than it should be.
    logger.warn('anchor.stale', {
      height: check.height,
      ageSeconds: check.staleness.ageSeconds,
      limit: CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC,
    })
  }

  const url = gatewayUrl(options.gateway, check.cid)
  logger.info('anchor.verified', {
    height: check.height,
    commitment: check.commitment,
    cid: check.cid,
    publishers: check.publishers,
    url,
  })

  const lines = await fetchLogBytes(url, options.fetcher)
  return Object.freeze({
    lines,
    height: check.height,
    commitment: check.commitment.slice(2).toLowerCase(),
    // The event carries the commitment and the CID digest, and no other root.
    components: null,
    origin: url,
    evidence: 'anchor' as const,
  })
}

/**
 * Each reader status turned into the sentence that says what to do about it.
 *
 * They are kept apart because they are different problems: `divergence` means
 * the publishers disagree and no bootstrap should happen from anywhere until
 * that is understood; `quorum-not-met` usually means a deployment has not
 * filled its publisher list yet.
 */
function describeRefusal(check: { status: string } & Record<string, unknown>, height: number): string {
  switch (check.status) {
    case 'divergence':
      return (
        `the anchor publishers disagree about height ${height}. Two cross-checked attestations carry ` +
        'different values, which is the §8.5 #7 signal this tier exists to surface — do not bootstrap ' +
        'from anywhere until it is understood.'
      )
    case 'rpc-disagreement':
      return (
        `the anchor RPC endpoints report different chains at height ${height}: ${String(check['detail'])}. ` +
        'One of them is wrong and this cannot tell which — add a third endpoint rather than picking.'
      )
    case 'quorum-not-met':
      return (
        `only ${String(check['found'])} of the required ${String(check['required'])} listed publishers have ` +
        `anchored height ${height}. Either the publisher list is short of what the deployment actually runs, ` +
        'or the second publisher is not live yet — NNS_SNAPSHOT_ANCHOR_QUORUM can say so deliberately.'
      )
    default:
      return `the anchor check at height ${height} came back ${check.status}, which is not a verified anchor`
  }
}
