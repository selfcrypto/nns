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
import { tryParseAddress } from '@nimiqnames/core'
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

export type PaySignOutcome =
  | { readonly ok: true; readonly publicKey: string; readonly signature: string }
  | { readonly ok: false; readonly declined: boolean; readonly detail: string }

/**
 * A 32- or 64-byte value as the SDK might spell it — hex with or without
 * `0x`, or base64 — normalised to bare lowercase hex. `sign()`'s encoding is
 * undocumented (tasks/26 D0), so both are accepted and the verifier decides.
 */
export function keyHex(value: unknown, bytes: number): string | null {
  if (typeof value !== 'string') return null
  const bare = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
  if (bare.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(bare)) return bare.toLowerCase()
  try {
    const decoded = atob(bare.replace(/-/g, '+').replace(/_/g, '/'))
    if (decoded.length !== bytes) return null
    return Array.from(decoded, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * Sign a text with the wallet's key: `sign()` is on the SDK's wallet surface
 * (rpc-reference §8, typed 2026-08-16, unprobed until tasks/26 D0). No
 * transaction, no broadcast; the wallet chooses which address signs, as it
 * does for a send, and the server derives the address from the public key.
 */
export async function paySign(provider: NimiqProvider, text: string): Promise<PaySignOutcome> {
  let result: unknown
  try {
    result = await provider.sign(text)
  } catch (error) {
    return { ok: false, declined: false, detail: error instanceof Error ? error.message : String(error) }
  }
  const failure = walletError(result)
  if (failure !== null) {
    const declined = /reject|declin|cancel|denied|abort/i.test(`${failure.type} ${failure.message}`)
    return { ok: false, declined, detail: failure.message === '' ? failure.type : failure.message }
  }
  const { publicKey, signature } = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  const pk = keyHex(publicKey, 32)
  const sig = keyHex(signature, 64)
  if (pk === null || sig === null) {
    return { ok: false, declined: false, detail: `the wallet returned an unexpected shape: ${JSON.stringify(result).slice(0, 200)}` }
  }
  return { ok: true, publicKey: pk, signature: sig }
}

/** The Pay host's UI language — never `navigator.language`. */
export function hostLanguage(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.nimiqPay?.language
}

// ── The host's EVM side (§6 `E` pre-fill) ───────────────────────────────────
//
// The mini-app SDK's typed surface is NIM-only (its ten `WALLET_METHODS`),
// but Pay demonstrably has an EVM side: opening an EVM dApp in its in-app
// browser offers a connect sheet naming the user's EVM address (observed
// on-device, 2026-08-23). That is the standard EIP-1193 gate — `eth_accounts`
// answers `[]` until the site is *connected*, and `eth_requestAccounts` is
// what raises the wallet's connect UI. So there are two calls here: a silent
// probe for the already-connected case, and a gesture-driven request that
// walks the same flow every EVM dApp uses.
//
// A positive answer is a pre-fill, never an authority: the user still
// reviews the address, and the record is whatever they confirm.

interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
}

function asEip1193(candidate: unknown): Eip1193Provider | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  return typeof (candidate as { request?: unknown }).request === 'function' ? (candidate as Eip1193Provider) : null
}

/**
 * `window.ethereum`, or the first EIP-6963 announcer — the modern discovery
 * path, where wallets answer a `requestProvider` event instead of (or beside)
 * claiming the global. Announcements are dispatched synchronously from the
 * request per the EIP, so no waiting is involved; absence is `null`.
 */
export function discoverEvmProvider(win: Window | undefined = globalThis.window): Eip1193Provider | null {
  if (win === undefined) return null
  const injected = asEip1193((win as { ethereum?: unknown }).ethereum)
  if (injected !== null) return injected
  let announced: Eip1193Provider | null = null
  const listen = (event: Event) => {
    const detail = (event as CustomEvent<{ provider?: unknown }>).detail
    if (announced === null) announced = asEip1193(detail?.provider)
  }
  win.addEventListener('eip6963:announceProvider', listen)
  win.dispatchEvent(new Event('eip6963:requestProvider'))
  win.removeEventListener('eip6963:announceProvider', listen)
  return announced
}

const firstEvmAddress = (answer: unknown): string | null => {
  if (!Array.isArray(answer)) return null
  const first = answer.find((entry) => typeof entry === 'string' && /^0x[0-9a-fA-F]{40}$/.test(entry))
  return typeof first === 'string' ? first.toLowerCase() : null
}

/** Silent: the already-connected case only. `eth_accounts` never prompts. */
export async function probeHostEvmAddress(): Promise<string | null> {
  const provider = discoverEvmProvider()
  if (provider === null) return null
  try {
    return firstEvmAddress(await provider.request({ method: 'eth_accounts' }))
  } catch {
    return null
  }
}

/**
 * Prompting: raises the wallet's own connect sheet, so call it from a user
 * gesture and nowhere else. A decline, a missing provider and an empty
 * answer are all `null` — the sheet falls back to paste.
 */
export async function requestHostEvmAddress(): Promise<string | null> {
  const provider = discoverEvmProvider()
  if (provider === null) return null
  try {
    return firstEvmAddress(await provider.request({ method: 'eth_requestAccounts' }))
  } catch {
    return null
  }
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
