/**
 * Chain history for the NC inbox. A browser cannot reach a node directly
 * (basic auth + no CORS; probed 2026-08-16, docs/rpc-reference.md §3), so
 * reads go to the operator-run endpoint — through the SDK's own RPC channel
 * inside Pay (`setRPCUrl` + `provider.request`, which unwraps `result.data`
 * itself), or a plain fetch speaking the same JSON-RPC outside it.
 */

import type { NimiqProvider } from '@nimiq/mini-app-sdk'
import type { ChatTx } from './chat'

export class HistoryError extends Error {
  override readonly name = 'HistoryError'
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
    if (response.status !== 200) throw new HistoryError(`history endpoint answered ${response.status}`)
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) throw new HistoryError('history endpoint answered non-JSON')
    const record = body as Record<string, unknown>
    const rpcError = record['error']
    if (typeof rpcError === 'object' && rpcError !== null) {
      const { data, message } = rpcError as Record<string, unknown>
      throw new HistoryError(typeof data === 'string' ? data : typeof message === 'string' ? message : 'rpc error')
    }
    const result = record['result']
    if (typeof result !== 'object' || result === null) throw new HistoryError('history endpoint answered no result')
    // The RPC wraps every result: {data, metadata}. Unwrap or read undefined.
    return (result as Record<string, unknown>)['data']
  }

export interface HistoryPage {
  readonly txs: readonly ChatTx[]
  /** The deepest block this page saw — the honest "since" boundary. */
  readonly oldestBlock: number | null
}

export async function fetchHistory(transport: HistoryTransport, address: string, max = 500): Promise<HistoryPage> {
  const data = await transport('getTransactionsByAddress', [address, max, null])
  if (!Array.isArray(data)) throw new HistoryError('history result carried no transaction array')

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
    txs.push({ hash, blockNumber, timestamp, from, to, recipientData, executionResult })
  }
  return { txs, oldestBlock }
}
