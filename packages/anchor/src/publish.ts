/**
 * The publisher (§9): read the matched pair off the NNS API, put the log
 * snapshot on IPFS through two independent implementations, and anchor the
 * checkpoint's commitment on the EVM chain — **on change, with a daily
 * floor**. The cron runs this every few hours; an anchor goes out when the
 * commitment differs from the last one this key anchored, and
 * unconditionally when the newest own anchor is older than
 * {@link DAILY_FLOOR_SEC}, so a quiet registry still gets a daily
 * attestation and §8.5 #8's staleness check keeps meaning "the publisher
 * stopped".
 *
 * Pure with respect to every service: it runs on {@link NnsApi},
 * {@link IpfsAdd}, {@link PublisherRpc} and {@link Signer}, so the whole loop
 * is exercised by tests against fakes, and viem never enters this module.
 *
 * Two lines this module must never cross, both §9's:
 *
 * - **The commitment is anchored verbatim.** It is read off the checkpoint
 *   document and travels untouched into the calldata. Re-deriving it would
 *   make the publisher a second implementation of §8.1, laundering exactly
 *   the divergence anchoring exists to expose. The one hash taken here is
 *   §8.2's *client* check — keccak256 of the fetched log bytes against the
 *   committed `log_hash` — which verifies the transport, not the state.
 * - **No CID is ever computed from bytes.** The two IPFS services mint the
 *   CID; this module compares their two answers and hard-stops on any
 *   disagreement — never picking one — then extracts the event's digest from
 *   the agreed string with `core.digestFromCid`, which is parsing plus the
 *   §8.2 shape check — a CID is a locator, not a verifier.
 *
 * **Catch-up anchors only the latest boundary, and says so.** The log is
 * cumulative — the newest snapshot contains every line a missed boundary
 * would have published, and the newest commitment binds the whole history
 * through `log_hash` — so a backfilled anchor adds no evidence, and its
 * block timestamp would be the catch-up time regardless, so it cannot
 * recreate the attestation record either. Decisively: `/log` has no height
 * parameter, so anchoring a past boundary would mean *constructing* its
 * snapshot by truncating the current one — the class of derivation this
 * publisher refuses. Under the on-change cadence, unanchored checkpoints
 * between two anchors are the normal case, not an outage; what stays owed
 * is that a missed *floor* is never silent, which is the staleness warning
 * in {@link planPublish}.
 */

import { CONSTANTS, digestFromCid, LogError } from '@nns/core'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { ANCHORED_TOPIC0 } from './artifact.js'
import type { EvmAddress, EvmLog, Hex, PublisherRpc, Signer } from './chain.js'
import { GAS_BUFFER_PERCENT, describeMismatch, verifyDeployedCode } from './deploy.js'
import type { IpfsAdd } from './ipfs.js'
import type { NnsApi } from './nns-api.js'

export class PublishError extends Error {
  override readonly name = 'PublishError'
}

/**
 * §9's daily floor, seconds: the publisher anchors on change, and
 * unconditionally when its newest anchor is older than this — so a live
 * publisher over a quiet registry still attests daily, and §8.5 #8's
 * staleness check keeps meaning "the publisher stopped" rather than "the
 * registry was quiet". Half of `ANCHOR_STALENESS_LIMIT_SEC`, on purpose:
 * one missed floor anchor of margin before clients warn.
 */
export const DAILY_FLOOR_SEC = CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC / 2

// ── Calldata ────────────────────────────────────────────────────────────────

/** `keccak256("anchor(bytes32,uint64,bytes32)")[0..4]` — pinned by a test against viem over the ABI. */
export const ANCHOR_SELECTOR: Hex = `0x${bytesToHex(keccak_256(utf8ToBytes('anchor(bytes32,uint64,bytes32)')).slice(0, 4))}`

const word = (bytes: Uint8Array): string => {
  if (bytes.length > 32) throw new PublishError('ABI word overflow')
  return bytesToHex(bytes).padStart(64, '0')
}

/**
 * ABI-encodes the `anchor` call. Three static words after the selector, so
 * the encoding is written out here rather than importing an ABI coder into
 * the pure module. `commitment` passes through as bytes — parsed from hex
 * and re-hexed, never interpreted.
 */
export function encodeAnchorCalldata(commitment: Hex, nimiqHeight: number, logDigest: Uint8Array): Hex {
  if (!/^0x[0-9a-f]{64}$/.test(commitment)) {
    throw new PublishError(`commitment must be 32 bytes of lowercase hex, got ${JSON.stringify(commitment)}`)
  }
  if (!Number.isSafeInteger(nimiqHeight) || nimiqHeight < 0) {
    throw new PublishError(`nimiqHeight must be a non-negative integer, got ${String(nimiqHeight)}`)
  }
  if (logDigest.length !== 32) {
    throw new PublishError(`logDigest must be 32 bytes, got ${logDigest.length}`)
  }
  const heightWord = nimiqHeight.toString(16).padStart(64, '0')
  return `${ANCHOR_SELECTOR}${commitment.slice(2)}${heightWord}${word(logDigest)}`
}

// ── Reading the chain — what makes a re-run idempotent ──────────────────────

/**
 * An `Anchored` event, decoded — the publisher reads its own history with
 * it, and the reader (§8.5) reads everyone's.
 */
export interface PastAnchor {
  readonly root: Hex
  readonly publisher: EvmAddress
  readonly nimiqHeight: number
  /** Anchor-chain block time, unix seconds — the daily floor and §8.5 #8 run on it. */
  readonly timestamp: number
  /** The log snapshot's CID digest (§8.2) — what a reader rebuilds the fetch CID from. */
  readonly logDigest: Hex
  readonly transactionHash: Hex
}

/** The address as a 32-byte topic, for the `publisher` filter slot. */
export function addressTopic(address: EvmAddress): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

export function decodeAnchored(log: EvmLog): PastAnchor {
  const [topic0, root, publisherTopic] = log.topics
  if (topic0?.toLowerCase() !== ANCHORED_TOPIC0 || root === undefined || publisherTopic === undefined) {
    throw new PublishError(`log ${log.transactionHash} is not an Anchored event`)
  }
  const data = log.data.toLowerCase()
  // Three non-indexed words: nimiqHeight, timestamp, logDigest.
  if (!/^0x[0-9a-f]{192}$/.test(data)) {
    throw new PublishError(`Anchored event ${log.transactionHash} has malformed data`)
  }
  const nimiqHeight = Number(BigInt(`0x${data.slice(2, 66)}`))
  const timestamp = Number(BigInt(`0x${data.slice(66, 130)}`))
  if (!Number.isSafeInteger(nimiqHeight) || !Number.isSafeInteger(timestamp)) {
    throw new PublishError(`Anchored event ${log.transactionHash} carries an unusable nimiqHeight or timestamp`)
  }
  return {
    root: root.toLowerCase() as Hex,
    publisher: `0x${publisherTopic.slice(26).toLowerCase()}` as EvmAddress,
    nimiqHeight,
    timestamp,
    logDigest: `0x${data.slice(130, 194)}` as Hex,
    transactionHash: log.transactionHash,
  }
}

// ── Planning ────────────────────────────────────────────────────────────────

export interface PublishDeps {
  readonly api: NnsApi
  readonly rpc: PublisherRpc
  /** Exactly two, independent by deployment (§8.2). Order is presentation only. */
  readonly ipfs: readonly [IpfsAdd, IpfsAdd]
  readonly signer: Signer
  /**
   * Wall clock, unix seconds — what the daily floor is measured against,
   * compared with the newest own anchor's block timestamp. Injected so the
   * tests own time; the CLI passes `Date.now`.
   */
  now(): number
}

export interface PublishOptions {
  readonly expectedChainId: number
  readonly contractAddress: EvmAddress
  /** §11.5's alert threshold — warn below it, sized so topping up is routine. */
  readonly minBalanceWei: bigint
  /** How far back `eth_getLogs` looks for this publisher's own anchors. */
  readonly lookbackBlocks: bigint
}

export interface PublishPlan {
  readonly chainId: number
  readonly contractAddress: EvmAddress
  readonly publisher: EvmAddress
  readonly nimiqHeight: number
  /** Verbatim from the checkpoint document. */
  readonly commitment: Hex
  /** The CID string both services agreed on. */
  readonly cid: string
  /** Its 32-byte multihash digest — the event's `logDigest`. */
  readonly logDigest: Hex
  readonly logBytes: Uint8Array
  readonly calldata: Hex
  readonly nonce: number
  readonly balance: bigint
  /** Node estimate, already multiplied by {@link GAS_BUFFER_PERCENT}. */
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly maxCost: bigint
  /**
   * Why this anchor is being sent (§9's cadence): the log moved, or the
   * daily floor came due over an unchanged log.
   */
  readonly trigger: 'change' | 'floor'
  /** Conditions worth a human's attention that do not stop the anchor. */
  readonly warnings: readonly string[]
}

/** What a run decided. Only `anchor` leads to a broadcast. */
export type PublishOutcome =
  | { readonly kind: 'anchor'; readonly plan: PublishPlan }
  | {
      /** This exact (height, commitment) is already on chain from this key. */
      readonly kind: 'already-anchored'
      readonly nimiqHeight: number
      readonly commitment: Hex
      readonly transactionHash: Hex
    }
  | {
      /**
       * §9's cadence says not yet: the log digest equals the newest own
       * anchor's and that anchor is younger than the daily floor.
       */
      readonly kind: 'unchanged'
      readonly nimiqHeight: number
      readonly commitment: Hex
      /** The digest both runs derived — the proof "unchanged" is about content. */
      readonly logDigest: Hex
      readonly lastAnchoredHeight: number
      readonly ageSeconds: number
      readonly transactionHash: Hex
    }
  | {
      /** `/checkpoints/{height}` said PENDING — a lagging replica. Retry next run. */
      readonly kind: 'waiting'
      readonly nimiqHeight: number
      readonly detail: string
    }

/**
 * Everything up to (but not including) pinning and broadcasting. Safe to run
 * with no key and no intent to send: the only external effect is `only-hash`
 * adds on the two IPFS services, which store nothing.
 */
export async function planPublish(deps: PublishDeps, options: PublishOptions): Promise<PublishOutcome> {
  const { api, rpc, ipfs, signer } = deps
  const warnings: string[] = []

  // The same refusal the deploy script opens with: an RPC URL is one edit
  // from the wrong network, and anchoring there would look like success.
  const chainId = await rpc.chainId()
  if (chainId !== options.expectedChainId) {
    throw new PublishError(
      `endpoint is on chain ${chainId}, expected ${options.expectedChainId} — refusing to anchor. ` +
        'Check NNS_ANCHOR_RPC_URL and NNS_ANCHOR_CHAIN_ID.',
    )
  }

  // Calling anchor() on an address with no code "succeeds" and emits
  // nothing, so the configured address is checked against the committed
  // artifact before anything else is spent.
  const contractAddress = options.contractAddress
  const code = await verifyDeployedCode(rpc, contractAddress)
  if (!code.match) {
    throw new PublishError(`NNS_ANCHOR_CONTRACT_ADDRESS: ${describeMismatch(contractAddress, code)}`)
  }

  // The matched pair, in the order that keeps it matched: /log stamps the
  // height it served, /checkpoints/{height} answers for that exact height.
  const snapshot = await api.fetchLog()
  const nimiqHeight = snapshot.checkpointHeight

  // §8.2's client check — keccak256 of the fetched bytes against the served
  // hash. This is the transport check the spec assigns to every fetcher; it
  // derives nothing.
  const fetchedHash: Hex = `0x${bytesToHex(keccak_256(snapshot.bytes))}`
  if (fetchedHash !== snapshot.logHash) {
    throw new PublishError(
      `/log bytes hash to ${fetchedHash} but the response claimed ${snapshot.logHash} — ` +
        'the snapshot was corrupted in transit or the server is lying. Nothing anchored.',
    )
  }

  const answer = await api.fetchCheckpoint(nimiqHeight)
  if (answer.kind === 'pending') {
    // /log stamped this height, so PENDING means a replica lagging its
    // sibling. Wait: the cron's next run is the retry.
    return {
      kind: 'waiting',
      nimiqHeight,
      detail: `checkpoint ${nimiqHeight} is pending on the API (latest ${answer.latest ?? 'unknown'})`,
    }
  }
  if (answer.kind === 'notRetained') {
    throw new PublishError(
      `checkpoint ${nimiqHeight} is no longer retained (oldest ${answer.oldest ?? 'unknown'}) although ` +
        '/log stamped it moments ago — the API regressed underneath us. Nothing anchored.',
    )
  }
  if (answer.kind === 'missing') {
    throw new PublishError(
      `checkpoint ${nimiqHeight} is missing from the API's retained range — its database has a gap. Nothing anchored.`,
    )
  }
  const checkpoint = answer.checkpoint
  if (checkpoint.logHash !== snapshot.logHash) {
    throw new PublishError(
      `torn pair: /log served log hash ${snapshot.logHash} but checkpoint ${nimiqHeight} commits ` +
        `${checkpoint.logHash}. Nothing anchored.`,
    )
  }

  // Idempotency comes from the chain, not from local state: a restart reads
  // its own anchors back and never double-anchors.
  const publisher = signer.address
  const head = await rpc.blockNumber()
  const fromBlock = head > options.lookbackBlocks ? head - options.lookbackBlocks : 0n
  const logs = await rpc.getLogs({
    address: contractAddress,
    topics: [ANCHORED_TOPIC0 as Hex, null, addressTopic(publisher)],
    fromBlock,
    toBlock: 'latest',
  })
  const mine = logs.map(decodeAnchored).filter((anchor) => anchor.publisher === publisher)

  const atThisHeight = mine.find((anchor) => anchor.nimiqHeight === nimiqHeight)
  if (atThisHeight !== undefined) {
    if (atThisHeight.root !== checkpoint.commitment) {
      throw new PublishError(
        `divergence: this key anchored ${atThisHeight.root} at height ${nimiqHeight} ` +
          `(tx ${atThisHeight.transactionHash}) but the API now serves ${checkpoint.commitment} for the same ` +
        'height. The indexer rewrote history or the API is not the one previously anchored. Do not anchor; investigate.',
      )
    }
    return {
      kind: 'already-anchored',
      nimiqHeight,
      commitment: checkpoint.commitment,
      transactionHash: atThisHeight.transactionHash,
    }
  }

  // §8.2's operational mitigation: the same bytes through two independent
  // implementations, and only a CID both minted is anchored. A mismatch is a
  // hard stop and an alert — never a choice of one, because the publisher
  // has no way to know which service is the broken one. This runs before the
  // cadence decision because the cadence needs the digest, and deriving a
  // CID locally would be a third §8.2 implementation — the dry adds are the
  // only way to know the log is unchanged without becoming one.
  const [first, second] = ipfs
  const [cidA, cidB] = await Promise.all([
    first.add(snapshot.bytes, { pin: false }),
    second.add(snapshot.bytes, { pin: false }),
  ])
  if (cidA !== cidB) {
    throw new PublishError(
      `CID mismatch: ${first.label} minted ${cidA}, ${second.label} minted ${cidB} for the same bytes. ` +
        'One of the two deviates from §8.2\'s parameter table (kubo turns raw leaves on under --cid-version=1 ' +
        'unless --raw-leaves=false is explicit). Hard stop; nothing anchored.',
    )
  }
  let digest: Uint8Array
  try {
    digest = digestFromCid(cidA)
  } catch (error) {
    if (!(error instanceof LogError)) throw error
    throw new PublishError(`both services agreed on a CID that is not §8.2's shape — ${error.message}`)
  }
  const logDigest: Hex = `0x${bytesToHex(digest)}`

  // §9's cadence: anchor on change, and unconditionally at the daily floor.
  // "Change" is judged by the log digest, never by the commitment: §8.1
  // binds the checkpoint height into the commitment, so it differs at every
  // checkpoint over an unchanged registry, and comparing it anchored on
  // every look (live until 2026-09-01 — the quiet path below was
  // unreachable). An unchanged log digest is an unchanged registry: state
  // moves only through logged messages. The newest own anchor decides both
  // halves; its block timestamp is the clock the floor runs against.
  // Catch-up stays latest-only either way — the checkpoints between the
  // last anchor and this one stay unanchored, which the cadence makes the
  // *normal* case rather than an outage, so the warning
  // below is about time, not heights.
  let trigger: PublishPlan['trigger'] = 'change'
  const newest = mine.reduce(
    (best: PastAnchor | null, anchor) =>
      best === null || anchor.nimiqHeight > best.nimiqHeight ? anchor : best,
    null,
  )
  if (newest === null) {
    warnings.push(
      `no prior anchor from ${publisher} within the last ${options.lookbackBlocks} anchor-chain blocks — ` +
        'first run, or an outage longer than the lookback window',
    )
  } else {
    const ageSeconds = deps.now() - newest.timestamp
    if (newest.logDigest === logDigest) {
      if (ageSeconds < DAILY_FLOOR_SEC) {
        return {
          kind: 'unchanged',
          nimiqHeight,
          commitment: checkpoint.commitment,
          logDigest,
          lastAnchoredHeight: newest.nimiqHeight,
          ageSeconds,
          transactionHash: newest.transactionHash,
        }
      }
      trigger = 'floor'
    }
    if (ageSeconds > CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC) {
      warnings.push(
        `newest own anchor is ${Math.floor(ageSeconds / 3600)} h old — beyond ANCHOR_STALENESS_LIMIT ` +
          `(${CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC / 3600} h), so clients have been warning. The schedule ` +
          'missed at least one daily-floor anchor; this run closes the gap, and the timestamp gap on chain ' +
          'is the honest record of it',
      )
    }
  }

  const calldata = encodeAnchorCalldata(checkpoint.commitment, nimiqHeight, digest)
  const [nonce, balance, rawGas, fees] = await Promise.all([
    rpc.getTransactionCount(publisher),
    rpc.getBalance(publisher),
    rpc.estimateGas({ from: publisher, to: contractAddress, data: calldata }),
    rpc.estimateFees(),
  ])
  const gas = (rawGas * GAS_BUFFER_PERCENT) / 100n
  const maxCost = gas * fees.maxFeePerGas
  if (balance < maxCost) {
    // §11.5 rule 1: refuse before signing rather than emit a transaction
    // that will be dropped.
    throw new PublishError(
      `publisher ${publisher} holds ${balance} wei, needs up to ${maxCost} wei for this anchor. Fund it.`,
    )
  }
  if (balance < options.minBalanceWei) {
    // §11.5 rule 2: the threshold alert fires while anchoring still works,
    // so topping up stays routine instead of becoming an incident.
    warnings.push(
      `ALERT: publisher balance ${balance} wei is below NNS_ANCHOR_MIN_BALANCE_WEI (${options.minBalanceWei}) — ` +
        'this anchor still fits, top up now',
    )
  }

  return {
    kind: 'anchor',
    plan: {
      chainId,
      contractAddress,
      publisher,
      nimiqHeight,
      commitment: checkpoint.commitment,
      cid: cidA,
      logDigest,
      logBytes: snapshot.bytes,
      calldata,
      nonce,
      balance,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxCost,
      trigger,
      warnings,
    },
  }
}

// ── Execution ───────────────────────────────────────────────────────────────

export interface PublishResult {
  readonly transactionHash: Hex
  readonly blockNumber: bigint
  readonly gasUsed: bigint
}

/**
 * Pin, then broadcast — in that order, so the anchored digest never points
 * at content nobody kept. The pinned adds must reproduce the plan's CID
 * exactly; a service that answers differently under `pin` than under
 * `only-hash` is nondeterministic and nothing sane can be anchored through
 * it.
 */
export async function executePublish(deps: PublishDeps, plan: PublishPlan): Promise<PublishResult> {
  const [first, second] = deps.ipfs
  const [cidA, cidB] = await Promise.all([
    first.add(plan.logBytes, { pin: true }),
    second.add(plan.logBytes, { pin: true }),
  ])
  for (const [label, cid] of [
    [first.label, cidA],
    [second.label, cidB],
  ] as const) {
    if (cid !== plan.cid) {
      throw new PublishError(
        `${label} pinned the snapshot as ${cid} but answered ${plan.cid} when planning — ` +
          'nondeterministic service. Hard stop; nothing anchored.',
      )
    }
  }

  const signed = await deps.signer.signTransaction({
    chainId: plan.chainId,
    nonce: plan.nonce,
    gas: plan.gas,
    maxFeePerGas: plan.maxFeePerGas,
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    data: plan.calldata,
    to: plan.contractAddress,
  })
  const hash = await deps.rpc.sendRawTransaction(signed)
  const receipt = await deps.rpc.waitForReceipt(hash)
  if (receipt.status !== 'success') {
    throw new PublishError(`anchor transaction ${receipt.transactionHash} reverted`)
  }
  // The code check up front is what makes this receipt conclusive: a
  // successful call into verified NnsAnchor bytecode emitted the event.
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  }
}

// ── Presentation ────────────────────────────────────────────────────────────

export function describePublishPlan(plan: PublishPlan): readonly string[] {
  const lines = [
    'anchor NNS checkpoint',
    `  chain id        ${plan.chainId} (confirmed against the endpoint)`,
    `  contract        ${plan.contractAddress} (code verified against the artifact)`,
    `  publisher       ${plan.publisher}`,
    `  nimiq height    ${plan.nimiqHeight}`,
    `  trigger         ${plan.trigger === 'change' ? 'log changed' : 'daily floor (log unchanged, newest anchor ≥ 24 h old)'}`,
    `  commitment      ${plan.commitment} (verbatim from the checkpoint)`,
    `  log snapshot    ${plan.logBytes.length} bytes`,
    `  cid             ${plan.cid} (two implementations agree)`,
    `  logDigest       ${plan.logDigest}`,
    `  nonce           ${plan.nonce}`,
    `  gas (buffered)  ${plan.gas}`,
    `  max cost        ${plan.maxCost} wei`,
    `  balance         ${plan.balance} wei`,
  ]
  for (const warning of plan.warnings) lines.push(`  ⚠ ${warning}`)
  return lines
}
