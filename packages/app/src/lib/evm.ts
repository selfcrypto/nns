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

export type EvmSendOutcome =
  | { readonly ok: true; readonly hash: string; readonly from: string }
  | { readonly ok: false; readonly reason: 'no-provider' | 'declined' | 'wrong-chain' | 'failed'; readonly detail?: string }

const looksDeclined = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code
  if (code === 4001) return true // EIP-1193 userRejectedRequest
  return /reject|declin|cancel|denied/i.test(error instanceof Error ? error.message : String(error))
}

/**
 * One USDT transfer on Polygon. Connect (the wallet's own sheet), make sure
 * the wallet is on Polygon (`wallet_switchEthereumChain` — added by the
 * wallet if it knows the chain, refused if it does not), then hand over the
 * transfer for the wallet to price, sign and broadcast. Every step is the
 * wallet's UI; every refusal is a value here, not a throw.
 */
export async function sendUsdtOnPolygon(request: {
  readonly to: string
  readonly units: bigint
}): Promise<EvmSendOutcome> {
  const provider = discoverEvmProvider()
  if (provider === null) return { ok: false, reason: 'no-provider' }
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
      } catch {
        return { ok: false, reason: 'wrong-chain' }
      }
    }

    const hash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          to: USDT_POLYGON.address,
          value: '0x0',
          data: erc20TransferData(request.to, request.units),
        },
      ],
    })) as unknown
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return { ok: false, reason: 'failed', detail: 'the wallet returned no transaction hash' }
    }
    return { ok: true, hash: hash.toLowerCase(), from }
  } catch (error) {
    if (looksDeclined(error)) return { ok: false, reason: 'declined' }
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
