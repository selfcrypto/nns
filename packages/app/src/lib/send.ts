/**
 * The one send state machine (docs/app-ux.md §4): every send — the eight
 * NNS actions and an NC message — goes compose → review → wallet → confirm
 * loop, one implementation. Nothing here trusts what the wallet returned:
 * confirmation is the effect appearing (§5.3 — three silent-drop routes,
 * and the SDK returns no hash at all on the Pay path).
 */

import { isDefiniteRejection, type HistoryTransport } from './history'
import type { SubmitRequest, Wallet } from './wallet'

export type SendPhase = 'submitting' | 'confirming'

export type SendResult =
  | { readonly status: 'confirmed' }
  | { readonly status: 'declined' }
  | { readonly status: 'blocked'; readonly reason: 'no-rpc' }
  /**
   * The transaction is in a block and executed; the effect is not visible at
   * the API yet. **Not a failure, and the common outcome for a registry
   * effect** — the indexer scans by batch, so visibility sawtooths by a full
   * batch (measured 2026-08-21: the API's height advances in exact 60-block
   * steps, so up to ~60 s) on top of its poll interval.
   */
  | { readonly status: 'settling'; readonly hash: string | null }
  /** In a block, and did not execute. Included, so a retry is a second fee. */
  | { readonly status: 'rejected'; readonly hash: string | null }
  /**
   * Polls answered, the effect never showed, and the transaction is not on
   * chain either. The strongest negative this app is entitled to — and still
   * not "the network refused it", because a transaction can be in flight.
   */
  | { readonly status: 'unconfirmed'; readonly hash: string | null }
  /**
   * No poll ever answered: the checker was down, not the send. A broken
   * checker never reads as a negative result — this is
   * "couldn't check", never "not included".
   */
  | { readonly status: 'unchecked'; readonly hash: string | null }
  | { readonly status: 'failed'; readonly detail: string }

export interface ConfirmSpec {
  /**
   * True when the effect is visible (the API shows it; a chat tx is found
   * executed). Receives the wallet's claimed hash — null on the Pay path —
   * for polls that can only key on it; the NNS actions ignore it and poll
   * the state effect instead.
   */
  readonly poll: (hash: string | null) => Promise<boolean>
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function performSend(options: {
  wallet: Wallet
  transport: HistoryTransport | null
  request: SubmitRequest
  confirm: ConfirmSpec
  onPhase?: (phase: SendPhase) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<SendResult> {
  const { wallet, transport, request, confirm } = options
  const sleep = options.sleep ?? defaultSleep

  options.onPhase?.('submitting')
  const submitted = await wallet.submit(request, transport)
  if (!submitted.ok) {
    if (submitted.reason === 'declined') return { status: 'declined' }
    if (submitted.reason === 'no-rpc') {
      return { status: 'blocked', reason: submitted.reason }
    }
    return { status: 'failed', detail: submitted.detail ?? 'the wallet could not submit' }
  }

  options.onPhase?.('confirming')
  // 90 s could not cover a registry effect and was losing the race routinely.
  // The indexer scans by batch, so the API trails the chain by up to a full
  // batch — measured 2026-08-21, its height advancing in exact 60-block
  // steps — and that is on top of the scan's own poll interval. A
  // registration landing just after a batch boundary needs most of three
  // minutes before it can possibly be visible. Overshooting costs a longer
  // spinner; undershooting told a user their paid registration had failed.
  const timeoutMs = confirm.timeoutMs ?? 210_000
  const intervalMs = confirm.intervalMs ?? 3_000
  const rounds = Math.max(1, Math.floor(timeoutMs / intervalMs))
  let anyPollAnswered = false
  for (let round = 0; round < rounds; round += 1) {
    try {
      const seen = await confirm.poll(submitted.hash)
      anyPollAnswered = true
      if (seen) return { status: 'confirmed' }
    } catch {
      // A flaky poll is not a failed send; the next round asks again.
    }
    await sleep(intervalMs)
  }
  // A broken checker never reads as a negative result — and neither does a
  // *lagging* one, which is the same rule and the one this loop used to
  // break. Polls answering "not yet" is a statement about what our indexer
  // can see, never about what the network did, so before concluding
  // anything negative, ask the chain directly. It answered a registration
  // as "the network did not include this transaction" while the name was
  // already registered and visible in "My names" (Kike, 2026-08-21).
  if (!anyPollAnswered) return { status: 'unchecked', hash: submitted.hash }
  switch (await inspectOnChain(transport, submitted.hash)) {
    case 'executed':
      return { status: 'settling', hash: submitted.hash }
    case 'failed':
      return { status: 'rejected', hash: submitted.hash }
    case 'absent':
      return { status: 'unconfirmed', hash: submitted.hash }
    case 'unknown':
      return { status: 'unchecked', hash: submitted.hash }
  }
}

/**
 * What the chain says about a hash, asked only once the effect poll has run
 * out. `getTransactionByHash` is one of the relay's five allowed methods, and
 * it sees a transaction as soon as it is in a block — long before the
 * batch-scanning indexer puts the effect behind the API.
 */
async function inspectOnChain(
  transport: HistoryTransport | null,
  hash: string | null,
): Promise<'executed' | 'failed' | 'absent' | 'unknown'> {
  if (transport === null || hash === null) return 'unknown'
  let tx: unknown
  try {
    tx = await transport('getTransactionByHash', [hash])
  } catch (error) {
    // A node that does not know the hash says so by *refusing*, not by
    // answering null: `getTransactionByHash` on an unknown hash comes back
    // as a JSON-RPC error body, `Transaction not found: <hash>` (measured
    // against the live node, 2026-09-14). So the refusal is the answer —
    // treating it as "could not ask" made the `absent` branch below
    // unreachable, and every genuinely-dropped transaction reported itself
    // as "the service didn't answer, it may well have gone through". A
    // friend's 200 NIM registration from an empty wallet read that way.
    //
    // `definite` is the bit that separates the two: the node answered and
    // refused (absent), versus a 5xx, a dead proxy or a network throw,
    // which is still evidence of nothing.
    if (isDefiniteRejection(error)) return 'absent'
    return 'unknown'
  }
  if (typeof tx !== 'object' || tx === null) return 'absent'
  const executed = (tx as Record<string, unknown>)['executionResult']
  if (executed === true) return 'executed'
  if (executed === false) return 'failed'
  return 'unknown'
}
