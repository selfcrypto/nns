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
import { group, looksGrouped } from './format'

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
 * per notation, or two come to disagree. `,` is a decimal separator too —
 * half the keyboards this app meets write 0,50 — and only that: one
 * separator per amount, no thousands grouping.
 */
export const parseUsdtAmount = (text: string): bigint => {
  const trimmed = text.trim()
  // Same refusal as `parseNimAmount`, same reason: `,` is a decimal separator
  // here, so a grouped amount has two honest readings (`format.ts`'s
  // `looksGrouped`). One screen, one rule — the Pay form takes both assets.
  if (looksGrouped(trimmed)) {
    throw new EvmAmountError('Amount is typed without thousands separators — 12345, not 12,345')
  }
  const match = /^([0-9]+)(?:[.,]([0-9]{1,6}))?$/.exec(trimmed)
  if (match === null || match[1] === undefined) {
    throw new EvmAmountError('Amount must be a USDT amount, like 25 or 9.50')
  }
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))
}

/** Six decimals, trailing zeros trimmed; `whole` is read or typed. */
const usdt = (units: bigint, whole: (value: bigint) => string): string => {
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac === '' ? whole(units / 1_000_000n) : `${whole(units / 1_000_000n)}.${frac}`
}

/** Integer units → USDT, grouped. **For reading.** */
export const formatUsdt = (units: bigint): string => usdt(units, group)

/** The same number, ungrouped. **For a field** — see `lunaToNimInput`. */
export const formatUsdtInput = (units: bigint): string => usdt(units, String)

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
 * Public Polygon endpoints, for the **display-only** balance reads and the
 * refusal measurements, nothing else. The send path deliberately runs no
 * Polygon RPC — the wallet prices, signs, broadcasts and confirms — but a
 * balance needs an `eth_call` answered from Polygon specifically, and the
 * wallet's provider may be on another chain or not proxy reads at all. A
 * miss here hides a line; it can never misroute a payment.
 *
 * A **list**, tried in order, because a single endpoint is a single point
 * of silent failure: `polygon-rpc.com` started answering 401 to plain
 * JSON-RPC (measured 2026-08-27 — key-gated now), and every fallback read
 * quietly became a miss. Both entries verified CORS-open to any origin the
 * same day.
 */
export const POLYGON_PUBLIC_RPCS: readonly string[] = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
]

const parseBalanceAnswer = (answer: unknown): bigint | null =>
  typeof answer === 'string' && /^0x[0-9a-fA-F]+$/.test(answer) ? BigInt(answer) : null

/**
 * One Polygon read: the wallet's own provider when it reports Polygon, else
 * the public endpoints in order. `null` on every miss — an endpoint that
 * cannot answer must not read as a zero balance.
 */
async function readPolygonQuantity(
  method: string,
  params: readonly unknown[],
  providerOverride: Eip1193Like | null | undefined,
  fetchImpl: typeof fetch,
): Promise<bigint | null> {
  const provider = providerOverride ?? discoverEvmProvider()
  if (provider != null) {
    try {
      const chain = (await provider.request({ method: 'eth_chainId' })) as unknown
      if (chain === POLYGON_CHAIN_HEX) {
        const quantity = parseBalanceAnswer(await provider.request({ method, params }))
        if (quantity !== null) return quantity
      }
    } catch {
      /* fall through to the public endpoint */
    }
  }

  for (const endpoint of POLYGON_PUBLIC_RPCS) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const body = (await response.json()) as { result?: unknown }
      const quantity = parseBalanceAnswer(body.result)
      if (quantity !== null) return quantity
    } catch {
      /* the next endpoint, then the honest null */
    }
  }
  return null
}

/** The account's USDT balance — display and refusal evidence, never a false zero. */
export async function fetchUsdtBalanceFor(
  account: string,
  providerOverride?: Eip1193Like | null,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint | null> {
  const call = { to: USDT_POLYGON.address, data: erc20BalanceOfData(account) }
  return readPolygonQuantity('eth_call', [call, 'latest'], providerOverride, fetchImpl)
}

/**
 * The account's native POL — read only to *explain* a refused send, never to
 * refuse one ourselves: whether a transfer needs POL at all is the wallet's
 * business (Pay's OpenGSN relay serves only its native send flow — measured
 * 2026-08-27: a funded-USDT, zero-POL dApp send refused on gas — but that is
 * Pay today, not every wallet), so the app asks only after the wallet said no.
 */
export async function fetchPolBalanceFor(
  account: string,
  providerOverride?: Eip1193Like | null,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint | null> {
  return readPolygonQuantity('eth_getBalance', [account, 'latest'], providerOverride, fetchImpl)
}

export type EvmSendOutcome =
  | { readonly ok: true; readonly hash: string; readonly from: string }
  | {
      readonly ok: false
      readonly reason: 'no-provider' | 'declined' | 'wrong-chain' | 'failed'
      /**
       * The account the send acted for, when the wallet had named one before
       * refusing — a failed send is still a connect, and the screen reads
       * this account's balance rather than prompting again for it.
       */
      readonly from: string | null
      readonly detail?: string
      /**
       * Only on `failed`, and only when a balance was measured: what the
       * wallet's "insufficient funds" actually meant. The string alone names
       * no culprit — Polygon says it for a gas shortfall, wallets say it for
       * a token shortfall — and guessing put "no POL" on a screen whose real
       * problem was zero USDT (tester, 2026-08-25).
       */
      readonly cause?: { readonly kind: 'no-usdt'; readonly held: bigint } | { readonly kind: 'no-pol' }
    }

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
  fetchImpl: typeof fetch = fetch,
): Promise<EvmSendOutcome> {
  const provider = providerOverride ?? discoverEvmProvider()
  if (provider == null) return { ok: false, reason: 'no-provider', from: null }
  let from: string | null = null
  try {
    const accounts = (await provider.request({
      method: 'eth_requestAccounts',
    })) as unknown
    from = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null
    if (from === null) return { ok: false, reason: 'declined', from }

    const chain = (await provider.request({ method: 'eth_chainId' })) as unknown
    if (chain !== POLYGON_CHAIN_HEX) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_CHAIN_HEX }] })
      } catch (error) {
        if (looksDeclined(error)) return { ok: false, reason: 'declined', from }
        return { ok: false, reason: 'wrong-chain', from }
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
      return { ok: false, reason: 'failed', from, detail: 'the wallet returned no transaction hash' }
    }
    return { ok: true, hash: hash.toLowerCase(), from }
  } catch (error) {
    if (looksDeclined(error)) return { ok: false, reason: 'declined', from }
    const detail = evmErrorMessage(error)
    // "insufficient funds" names no culprit by itself. Measure before
    // blaming: a USDT balance below the send is the answer; failing that, a
    // POL balance of exactly zero is; anything else stays the wallet's own
    // words. Both reads are misses-stay-silent, so an unreachable endpoint
    // degrades to the generic report, never to a wrong diagnosis.
    if (from !== null && /insufficient funds/i.test(detail)) {
      const held = await fetchUsdtBalanceFor(from, provider, fetchImpl)
      if (held !== null && held < request.units) {
        return { ok: false, reason: 'failed', from, detail, cause: { kind: 'no-usdt', held } }
      }
      const pol = await fetchPolBalanceFor(from, provider, fetchImpl)
      if (pol === 0n) return { ok: false, reason: 'failed', from, detail, cause: { kind: 'no-pol' } }
    }
    return { ok: false, reason: 'failed', from, detail }
  }
}
