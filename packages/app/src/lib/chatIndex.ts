/**
 * The NC chat index as an inbox source.
 *
 * It answers the same shape the node's history call answers, deliberately: the
 * rows carry `recipientData` exactly as it appeared on chain, so the app parses
 * them with `@nns/chat` — the same parser, on the same bytes — instead of
 * trusting the service's own parse. An index that lied about a message's text
 * would have to lie about the payload too, and the payload is what the chain
 * has.
 *
 * The service is not proof-backed and is not presented as if it were. It can
 * omit rows; so can the RPC relay the fallback path reads through. This is the
 * same trust, not more.
 */

import type { ChatTx } from '@nns/chat'
import { HistoryError, type HistoryPage } from './history'

export interface ChatIndexPage extends HistoryPage {
  /**
   * The height below which this index knows nothing — the operator's declared
   * window, not the deepest row it happened to return. Reported so the Inbox
   * can say "messages since ≈ <date>" rather than implying completeness.
   */
  readonly startHeight: number | null
}

const asTx = (entry: unknown): ChatTx | null => {
  if (typeof entry !== 'object' || entry === null) return null
  const row = entry as Record<string, unknown>
  const { hash, blockNumber, timestamp, from, to, recipientData, executionResult } = row
  if (
    typeof hash !== 'string' ||
    typeof blockNumber !== 'number' ||
    typeof timestamp !== 'number' ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof recipientData !== 'string' ||
    typeof executionResult !== 'boolean'
  ) {
    return null
  }
  return { hash, blockNumber, timestamp, from, to, recipientData, executionResult }
}

export async function fetchChatIndex(
  base: string,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatIndexPage> {
  const response = await fetchImpl(`${base}/messages/${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' },
  })
  if (response.status !== 200) {
    throw new HistoryError(`chat index answered ${response.status}`, response.status >= 400 && response.status < 500)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new HistoryError('chat index answered non-JSON', false)
  }
  if (typeof body !== 'object' || body === null) throw new HistoryError('chat index answered non-JSON', false)
  const record = body as Record<string, unknown>
  const messages = record['messages']
  if (!Array.isArray(messages)) throw new HistoryError('chat index carried no message array', false)

  const txs: ChatTx[] = []
  let oldestBlock: number | null = null
  for (const entry of messages) {
    const tx = asTx(entry)
    if (tx === null) continue
    oldestBlock = oldestBlock === null ? tx.blockNumber : Math.min(oldestBlock, tx.blockNumber)
    txs.push(tx)
  }

  const window = record['window']
  const startHeight =
    typeof window === 'object' && window !== null && typeof (window as Record<string, unknown>)['startHeight'] === 'number'
      ? ((window as Record<string, unknown>)['startHeight'] as number)
      : null
  return { txs, oldestBlock, startHeight }
}
