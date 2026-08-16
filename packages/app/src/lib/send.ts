/**
 * The one send state machine (docs/app-ux.md §4): every send — the eight
 * NNS actions and an NC message — goes compose → review → wallet → confirm
 * loop, one implementation. Nothing here trusts what the wallet returned:
 * confirmation is the effect appearing (§5.3 — three silent-drop routes,
 * and the SDK returns no hash at all on the Pay path).
 */

import type { HistoryTransport } from './history'
import type { SubmitRequest, Wallet } from './wallet'

export type SendPhase = 'submitting' | 'confirming'

export type SendResult =
  | { readonly status: 'confirmed' }
  | { readonly status: 'declined' }
  | { readonly status: 'blocked'; readonly reason: 'probe-gated' | 'no-rpc' }
  /** Polls answered, the effect never showed: the network did not include it — sayable. */
  | { readonly status: 'unconfirmed'; readonly hash: string | null }
  /**
   * No poll ever answered: the checker was down, not the send. A broken
   * checker never reads as a negative result (docs/decisions.md) — this is
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
    if (submitted.reason === 'probe-gated' || submitted.reason === 'no-rpc') {
      return { status: 'blocked', reason: submitted.reason }
    }
    return { status: 'failed', detail: submitted.detail ?? 'the wallet could not submit' }
  }

  options.onPhase?.('confirming')
  const timeoutMs = confirm.timeoutMs ?? 90_000
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
  // Two different truths at timeout. Polls that answered "not yet" all the
  // way down mean the network did not show the effect — unconfirmed. Polls
  // that never answered mean the *checker* was down, and a broken checker
  // never reads as a negative result.
  return anyPollAnswered
    ? { status: 'unconfirmed', hash: submitted.hash }
    : { status: 'unchecked', hash: submitted.hash }
}
