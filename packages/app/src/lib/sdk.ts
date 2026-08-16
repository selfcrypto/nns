/**
 * The only file that imports `@nimiq/mini-app-sdk`. The SDK's read surface is
 * `getBlockNumber`, `isConsensusEstablished`, `getNetwork`, `listAccounts` —
 * no history methods exist, so nothing about the past ever comes from here
 * (docs/rpc-reference.md §8).
 */

import type { NimiqProvider } from '@nimiq/mini-app-sdk'
import { tryParseAddress } from '@nns/core'

export interface WalletSession {
  /** The user's Pay account — `listAccounts()` returns exactly one. */
  readonly address: string
  readonly provider: NimiqProvider
}

export async function connectWallet(timeoutMs = 3000): Promise<WalletSession | null> {
  if (typeof window === 'undefined') return null
  try {
    const { init } = await import('@nimiq/mini-app-sdk')
    const provider = await init({ timeout: timeoutMs })
    const accounts = await provider.listAccounts()
    if (!Array.isArray(accounts)) return null
    const first = accounts[0]
    if (typeof first !== 'string' || tryParseAddress(first) === null) return null
    return { address: first, provider }
  } catch {
    return null
  }
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
