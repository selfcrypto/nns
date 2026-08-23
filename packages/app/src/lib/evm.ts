/**
 * The EVM send plane — USDT over Polygon, through whatever EIP-1193 wallet
 * the environment offers (Pay's in-app browser, MetaMask on a desktop).
 *
 * This is deliberately the *dApp* path, not a chain client: the app holds no
 * EVM key, runs no Polygon RPC, and estimates no gas. It resolves a name to
 * the owner's declared EVM address (§6 `E`, through the verified resolver —
 * never any other source), builds the one calldata an ERC-20 transfer is,
 * and hands the transaction to the wallet, whose own sheet is the
 * confirmation UI — exactly what the wallet does for every other dApp.
 *
 * **The returned hash is not confirmation**, same §5.3 discipline as NIM
 * sends — but unlike them, no endpoint of ours can watch for the effect, so
 * the honest report is "the wallet accepted it" plus the hash to track on
 * Polygonscan, and never the word "sent" as a fact about the chain.
 */

import { discoverEvmProvider } from './sdk'

/** The provider shape `discoverEvmProvider` answers with — re-declared here for the injectable parameter. */
interface Eip1193Like {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
}

/** Polygon PoS, the chain the record's convention names first (§6 `E`). */
export const POLYGON_CHAIN_HEX = '0x89'

/**
 * USDT on Polygon PoS — `(PoS) Tether USD`, upgraded in place to USDT0;
 * this address is the USDT on that chain. Six decimals, as USDT everywhere.
 * Verified against Polygonscan 2026-08-23.
 */
export const USDT_POLYGON = Object.freeze({
  address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  decimals: 6,
  symbol: 'USDT',
})

export class EvmAmountError extends Error {
  override readonly name = 'EvmAmountError'
}

/**
 * A USDT decimal to integer units — six decimals, the whole precision there
 * is. The same shape as `parseNimAmount`, for the same reason: one parser
 * per notation, or two come to disagree.
 */
export const parseUsdtAmount = (text: string): bigint => {
  const match = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(text.trim())
  if (match === null || match[1] === undefined) {
    throw new EvmAmountError('Amount must be a USDT amount, like 25 or 9.50')
  }
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))
}

/** Integer units back to a display string, trailing zeros trimmed. */
export const formatUsdt = (units: bigint): string => {
  const whole = units / 1_000_000n
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac === '' ? whole.toString() : `${whole}.${frac}`
}

/**
 * `transfer(address,uint256)` calldata: the selector `0xa9059cbb` and two
 * 32-byte-padded arguments. The one piece of ABI this app will ever encode,
 * so it is written out rather than imported.
 */
export function erc20TransferData(to: string, units: bigint): string {
  const address = to.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const amount = units.toString(16).padStart(64, '0')
  return `0xa9059cbb${address}${amount}`
}

/** `balanceOf(address)` calldata — selector `0x70a08231` and one padded argument. */
export function erc20BalanceOfData(account: string): string {
  return `0x70a08231${account.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
}

/**
 * The already-authorized account, silently — `eth_accounts` never prompts,
 * and answers `[]` until the user has connected this site once (per
 * session on some wallets, which is why a fresh page often knows nothing).
 * The prompting counterpart is `requestHostEvmAddress` in `sdk.ts`.
 */
export async function silentEvmAccount(providerOverride?: Eip1193Like | null): Promise<string | null> {
  const provider = providerOverride ?? discoverEvmProvider()
  if (provider == null) return null
  try {
    const accounts = (await provider.request({ method: 'eth_accounts' })) as unknown
    const account = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null
    return account !== null && /^0x[0-9a-fA-F]{40}$/.test(account) ? account.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * A public Polygon endpoint, for the **display-only** balance read and
 * nothing else. The send path deliberately runs no Polygon RPC — the wallet
 * prices, signs, broadcasts and confirms — but a balance needs an `eth_call`
 * answered from Polygon specifically, and the wallet's provider may be on
 * another chain or not proxy reads at all. A miss here hides a line; it can
 * never misroute a payment.
 */
export const POLYGON_PUBLIC_RPC = 'https://polygon-rpc.com'

const parseBalanceAnswer = (answer: unknown): bigint | null =>
  typeof answer === 'string' && /^0x[0-9a-fA-F]+$/.test(answer) ? BigInt(answer) : null

/**
 * The account's USDT balance: the wallet's own `eth_call` when it is on
 * Polygon, else the public endpoint. Display-only, `null` on every miss —
 * an endpoint that cannot answer must not read as a zero balance.
 */
export async function fetchUsdtBalanceFor(
  account: string,
  providerOverride?: Eip1193Like | null,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint | null> {
  const call = { to: USDT_POLYGON.address, data: erc20BalanceOfData(account) }

  const provider = providerOverride ?? discoverEvmProvider()
  if (provider != null) {
    try {
      const chain = (await provider.request({ method: 'eth_chainId' })) as unknown
      if (chain === POLYGON_CHAIN_HEX) {
        const units = parseBalanceAnswer(await provider.request({ method: 'eth_call', params: [call, 'latest'] }))
        if (units !== null) return units
      }
    } catch {
      /* fall through to the public endpoint */
    }
  }

  try {
    const response = await fetchImpl(POLYGON_PUBLIC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] }),
    })
    const body = (await response.json()) as { result?: unknown }
    return parseBalanceAnswer(body.result)
  } catch {
    return null
  }
}

export type EvmSendOutcome =
  | { readonly ok: true; readonly hash: string; readonly from: string }
  | { readonly ok: false; readonly reason: 'no-provider' | 'declined' | 'wrong-chain' | 'failed'; readonly detail?: string }

/**
 * A provider rejection is usually a plain `{code, message}` object, not an
 * `Error` — `String()` on one is the literal `[object Object]` that reached
 * a screen on 2026-08-23. Dig the human text out, wherever this wallet put
 * it, and cap the JSON fallback so a screen never renders a novel.
 */
export function evmErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'object' && error !== null) {
    const { message, data } = error as { message?: unknown; data?: unknown }
    if (typeof message === 'string' && message !== '') return message
    const nested = (data as { message?: unknown } | null)?.message
    if (typeof nested === 'string' && nested !== '') return nested
    try {
      return JSON.stringify(error).slice(0, 200)
    } catch {
      return 'the wallet refused without a message'
    }
  }
  return String(error)
}

const looksDeclined = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code
  if (code === 4001) return true // EIP-1193 userRejectedRequest
  return /reject|declin|cancel|denied/i.test(evmErrorMessage(error))
}

/**
 * When `eth_estimateGas` itself fails — a node refusing, or a transfer that
 * would revert — the wallet still gets the transaction, under a limit that
 * covers USDT0's proxy paths with room to spare. Unused gas is refunded; a
 * knowingly-reverting send costs cents of POL, and the wallet's own sheet
 * is the right place to refuse it. Pay estimates nothing on its own —
 * "Transaction must include \"gas\" or \"gasLimit\"" (on-device,
 * 2026-08-23) — so a `gas` field is always sent.
 */
export const FALLBACK_TRANSFER_GAS = 160_000n

/** The estimate, padded half again — proxy token paths vary — or the fallback. */
export function gasLimitFor(estimate: unknown): string {
  if (typeof estimate === 'string' && /^0x[0-9a-fA-F]+$/.test(estimate)) {
    return `0x${((BigInt(estimate) * 3n) / 2n).toString(16)}`
  }
  return `0x${FALLBACK_TRANSFER_GAS.toString(16)}`
}

/**
 * One USDT transfer on Polygon. Connect (the wallet's own sheet), make sure
 * the wallet is on Polygon (`wallet_switchEthereumChain` — added by the
 * wallet if it knows the chain, refused if it does not), then hand over the
 * transfer for the wallet to price, sign and broadcast. Every step is the
 * wallet's UI; every refusal is a value here, not a throw.
 */
export async function sendUsdtOnPolygon(
  request: {
    readonly to: string
    readonly units: bigint
  },
  providerOverride?: Eip1193Like | null,
): Promise<EvmSendOutcome> {
  const provider = providerOverride ?? discoverEvmProvider()
  if (provider == null) return { ok: false, reason: 'no-provider' }
  try {
    const accounts = (await provider.request({
      method: 'eth_requestAccounts',
    })) as unknown
    const from = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null
    if (from === null) return { ok: false, reason: 'declined' }

    const chain = (await provider.request({ method: 'eth_chainId' })) as unknown
    if (chain !== POLYGON_CHAIN_HEX) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_CHAIN_HEX }] })
      } catch (error) {
        if (looksDeclined(error)) return { ok: false, reason: 'declined' }
        return { ok: false, reason: 'wrong-chain' }
      }
    }

    const transfer = {
      from,
      to: USDT_POLYGON.address,
      value: '0x0',
      data: erc20TransferData(request.to, request.units),
    }

    // Pay estimates nothing on its own, so estimate here and always send a
    // `gas` field; an estimation failure falls back rather than refusing —
    // the wallet's fee sheet is the honest place for the final no.
    let estimate: unknown = null
    try {
      estimate = await provider.request({ method: 'eth_estimateGas', params: [transfer] })
    } catch {
      /* the fallback limit covers it */
    }

    const hash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ ...transfer, gas: gasLimitFor(estimate) }],
    })) as unknown
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return { ok: false, reason: 'failed', detail: 'the wallet returned no transaction hash' }
    }
    return { ok: true, hash: hash.toLowerCase(), from }
  } catch (error) {
    if (looksDeclined(error)) return { ok: false, reason: 'declined' }
    return { ok: false, reason: 'failed', detail: evmErrorMessage(error) }
  }
}
