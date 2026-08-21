/**
 * The only file that imports `@nimiq/mini-app-sdk`. The SDK's read surface is
 * `getBlockNumber`, `isConsensusEstablished`, `getNetwork`, `listAccounts` —
 * no history methods exist, so nothing about the past ever comes from here
 * (docs/rpc-reference.md §8).
 *
 * Sends live here too, since 2026-08-21, when the §10.5 probe finally ran on a
 * post-fork build. Three things it measured that the typings do not say:
 *
 *   - `value` and `fee` are honoured **exactly** — nothing is substituted, so
 *     §10.5 payment exactness holds and G/N/B are safe to send.
 *   - `data` is **plain text**, utf-8 encoded by the wallet. Passing hex lands
 *     the ASCII of the hex digits on chain. `hexToText` is the boundary.
 *   - the return value is a **32-byte transaction hash**, not "the serialized
 *     transaction" the declarations promise.
 */

import type { NimiqProvider } from '@nimiq/mini-app-sdk'
import { tryParseAddress } from '@nns/core'
import { hexToText } from './hex'

export interface WalletSession {
  /**
   * Every address the wallet reports, canonical order as given.
   *
   * **Not one address.** `listAccounts()` was recorded as returning exactly
   * one (probed 2026-08-13) and returned two on 2026-08-21. Taking `[0]` and
   * calling it "the Pay account" is what made the second address invisible —
   * and the send went from the *second* one, so "my names" would have looked
   * up an address that owns nothing while the names sat on the other.
   */
  readonly addresses: readonly string[]
  readonly provider: NimiqProvider
}

/** A wallet method answers `T | ErrorResponse` — a failure is a value, not a throw. */
function walletError(result: unknown): { type: string; message: string } | null {
  if (typeof result !== 'object' || result === null || !('error' in result)) return null
  const { error } = result as { error?: unknown }
  if (typeof error !== 'object' || error === null) return { type: 'unknown', message: '' }
  const { type, message } = error as Record<string, unknown>
  return { type: typeof type === 'string' ? type : 'unknown', message: typeof message === 'string' ? message : '' }
}

export async function connectWallet(timeoutMs = 3000): Promise<WalletSession | null> {
  if (typeof window === 'undefined') return null
  try {
    const { init } = await import('@nimiq/mini-app-sdk')
    const provider = await init({ timeout: timeoutMs })
    const accounts = await provider.listAccounts()
    if (!Array.isArray(accounts)) return null
    const addresses: string[] = []
    for (const entry of accounts) {
      if (typeof entry !== 'string') continue
      const parsed = tryParseAddress(entry)
      if (parsed !== null && !addresses.includes(entry)) addresses.push(entry)
    }
    if (addresses.length === 0) return null
    return { addresses, provider }
  } catch {
    return null
  }
}

export type PaySendOutcome =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly declined: boolean; readonly detail: string }

/**
 * One Pay send. There is **no sender parameter** — the wallet chooses which of
 * its addresses signs, and the app cannot influence it. That is why identity
 * here is the whole set and why every send is still confirmed by effect: if
 * the wallet signs with a set member that does not own the name, the effect
 * never appears and `performSend` reports `unconfirmed` rather than success.
 *
 * `validityStartHeight` is deliberately omitted so the wallet takes it from
 * its own node. Supplying one would carry a height across the two planes
 * (rpc-reference §8); the probe run showed the wallet's node four blocks ahead
 * of ours at the same moment.
 */
export async function paySendTransaction(
  provider: NimiqProvider,
  request: { recipient: string; valueLuna: bigint; dataHex: string },
): Promise<PaySendOutcome> {
  // The one place bigint narrows to the wallet's number (rpc-reference §8).
  if (request.valueLuna > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, declined: false, detail: `value ${request.valueLuna} luna exceeds the SDK's number boundary` }
  }
  const data = hexToText(request.dataHex)
  if (data === null) {
    return { ok: false, declined: false, detail: 'payload is not valid UTF-8 and Pay can only carry text' }
  }
  let result: unknown
  try {
    result = await provider.sendBasicTransactionWithData({
      recipient: request.recipient,
      value: Number(request.valueLuna),
      // Explicit, and honoured: the probe asked for 4321 luna and 4321 luna
      // landed. Matches the Hub path, which also signs a zero fee.
      fee: 0,
      data,
    })
  } catch (error) {
    return { ok: false, declined: false, detail: error instanceof Error ? error.message : String(error) }
  }
  const failure = walletError(result)
  if (failure !== null) {
    // The user closing the confirmation sheet arrives here as a resolved
    // value, like every other wallet failure.
    const declined = /reject|declin|cancel|denied|abort/i.test(`${failure.type} ${failure.message}`)
    return { ok: false, declined, detail: failure.message === '' ? failure.type : failure.message }
  }
  if (typeof result !== 'string' || result === '') {
    return { ok: false, declined: false, detail: 'the wallet returned neither an error nor a transaction' }
  }
  // Declared as "The serialized transaction"; measured as a 32-byte hash.
  // Treated as a hash only where one is useful, and never as confirmation.
  return { ok: true, hash: result }
}

/** The Pay host's UI language — never `navigator.language`. */
export function hostLanguage(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.nimiqPay?.language
}

/**
 * Development affordance for a desktop browser, where no wallet is injected:
 * `?address=NQ…` stands in as the viewer identity. Read-only — it can never
 * sign anything, so it impersonates nothing.
 */
export function devAddressOverride(search: string): string | null {
  const raw = new URLSearchParams(search).get('address')
  if (raw === null) return null
  return tryParseAddress(raw)
}
