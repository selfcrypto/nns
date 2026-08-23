/**
 * Chain history for the NC inbox. A browser cannot reach a node directly
 * (basic auth + no CORS; probed 2026-08-16, docs/rpc-reference.md §3), so
 * reads go to the operator-run endpoint — through the SDK's own RPC channel
 * inside Pay (`setRPCUrl` + `provider.request`, which unwraps `result.data`
 * itself), or a plain fetch speaking the same JSON-RPC outside it.
 */

import type { NimiqProvider } from '@nimiq/mini-app-sdk'
import { rpcEndpoint } from '../config'
import type { ChatTx } from '@nns/chat'

export class HistoryError extends Error {
  override readonly name = 'HistoryError'
  /**
   * True when the upstream **definitely** did not act on the request: an
   * HTTP 4xx, or a JSON-RPC error body (the node answered, refusing). A
   * 5xx, a non-JSON body or a network throw is ambiguous — the request may
   * have been processed. Broadcast handling turns on this bit: an ambiguous
   * broadcast must fall through to the confirm loop, never read as failed,
   * because a retry re-signs at a fresh validity height — a different
   * transaction and a second fee.
   */
  readonly definite: boolean

  constructor(message: string, definite: boolean) {
    super(message)
    this.definite = definite
  }
}

/** True only when an error proves the upstream did not act on the request. */
export function isDefiniteRejection(error: unknown): boolean {
  return error instanceof HistoryError && error.definite
}

/** Answers a read-only RPC method with the already-unwrapped `result.data`. */
export type HistoryTransport = (method: string, params: readonly unknown[]) => Promise<unknown>

/** In-Pay transport: the SDK forwards non-wallet methods to its configured RPC URL. */
export const providerTransport =
  (provider: NimiqProvider, endpoint: string): HistoryTransport => {
    provider.setRPCUrl(endpoint)
    return (method, params) => provider.request({ method, params: [...params] })
  }

/** Dev/browser transport: the same JSON-RPC over plain fetch, unwrapping {data, metadata}. */
export const fetchTransport =
  (endpoint: string, fetchImpl: typeof fetch = fetch): HistoryTransport =>
  async (method, params) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (response.status !== 200) {
      const definite = response.status >= 400 && response.status < 500
      throw new HistoryError(`endpoint answered ${response.status}`, definite)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new HistoryError('endpoint answered non-JSON', false)
    }
    if (typeof body !== 'object' || body === null) throw new HistoryError('endpoint answered non-JSON', false)
    const record = body as Record<string, unknown>
    const rpcError = record['error']
    if (typeof rpcError === 'object' && rpcError !== null) {
      const { data, message } = rpcError as Record<string, unknown>
      const text = typeof data === 'string' ? data : typeof message === 'string' ? message : 'rpc error'
      // The node answered and refused: definite.
      throw new HistoryError(text, true)
    }
    const result = record['result']
    if (typeof result !== 'object' || result === null) throw new HistoryError('endpoint answered no result', false)
    // The RPC wraps every result: {data, metadata}. Unwrap or read undefined.
    return (result as Record<string, unknown>)['data']
  }

/**
 * The configured transport, or null when `VITE_NNS_RPC` is unset. Plain
 * fetch — right for Hub and desktop dev; the Pay path swaps in
 * `providerTransport` when its sends unlock.
 */
export function defaultTransport(): HistoryTransport | null {
  const endpoint = rpcEndpoint()
  return endpoint === null ? null : fetchTransport(endpoint)
}

export interface HistoryPage {
  readonly txs: readonly ChatTx[]
  /** The deepest block this page saw — the honest "since" boundary. */
  readonly oldestBlock: number | null
}

export async function fetchHistory(transport: HistoryTransport, address: string, max = 500): Promise<HistoryPage> {
  const data = await transport('getTransactionsByAddress', [address, max, null])
  if (!Array.isArray(data)) throw new HistoryError('history result carried no transaction array', false)

  const txs: ChatTx[] = []
  let oldestBlock: number | null = null
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const tx = entry as Record<string, unknown>
    const { hash, blockNumber, timestamp, from, to, recipientData, executionResult } = tx
    if (
      typeof hash !== 'string' ||
      typeof blockNumber !== 'number' ||
      typeof timestamp !== 'number' ||
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      typeof recipientData !== 'string' ||
      typeof executionResult !== 'boolean'
    ) {
      continue
    }
    oldestBlock = oldestBlock === null ? blockNumber : Math.min(oldestBlock, blockNumber)
    // `fromType` and `proof` ride along when present (§3 carries both on
    // every read endpoint) so the inbox can attribute an HTLC-sent message
    // to its authorizing key — the raw `from` of a Nimiq Pay send is a
    // contract address that holds no names and will be pruned.
    const fromType = typeof tx['fromType'] === 'number' ? tx['fromType'] : undefined
    const proof = typeof tx['proof'] === 'string' ? tx['proof'] : undefined
    txs.push({ hash, blockNumber, timestamp, from, fromType, proof, to, recipientData, executionResult })
  }
  return { txs, oldestBlock }
}

/**
 * The account's type, or null when the node did not clearly say.
 *
 * One caller and one purpose: Nimiq Pay's `listAccounts()` returns the durable
 * address **and the Remote wallet's HTLC contract**, and nothing in the SDK
 * distinguishes them. `getAccountByAddress` carries a `type` field —
 * `"basic"` for a keypair account (docs/rpc-reference.md §4) — which is the
 * only signal there is.
 *
 * Null on any doubt: a missing endpoint, a refusal, a shape that is not what
 * was measured. Every caller must read null as "keep it", because dropping an
 * address the user actually owns hides their names, and showing a contract for
 * a few days does not.
 */
export async function fetchAccountType(transport: HistoryTransport, address: string): Promise<string | null> {
  let answer: unknown
  try {
    answer = await transport('getAccountByAddress', [address])
  } catch {
    return null
  }
  if (typeof answer !== 'object' || answer === null) return null
  const { type } = answer as { type?: unknown }
  return typeof type === 'string' ? type : null
}

/**
 * The account's balance in luna, from the same allowlisted call the type
 * lookup uses. Display-only — `null` (endpoint missing, refusal, odd shape)
 * hides the line rather than showing a zero that would read as "broke".
 */
export async function fetchNimBalance(transport: HistoryTransport, address: string): Promise<bigint | null> {
  let answer: unknown
  try {
    answer = await transport('getAccountByAddress', [address])
  } catch {
    return null
  }
  if (typeof answer !== 'object' || answer === null) return null
  const { balance } = answer as { balance?: unknown }
  return typeof balance === 'number' && Number.isSafeInteger(balance) && balance >= 0 ? BigInt(balance) : null
}
