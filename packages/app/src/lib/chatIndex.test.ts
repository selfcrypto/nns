import { describe, expect, it } from 'vitest'
import { fetchChatIndex } from './chatIndex'
import { HistoryError, isDefiniteRejection } from './history'

const message = (over: Record<string, unknown> = {}) => ({
  hash: 'h1',
  blockNumber: 1_000,
  timestamp: 1_700_000_000_000,
  from: 'NQ42 A',
  to: 'NQ64 B',
  recipientData: '4e433165|',
  executionResult: true,
  ...over,
})

const answering = (status: number, body: unknown): typeof fetch =>
  (async () =>
    ({
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch

describe('the chat index as an inbox source', () => {
  it('returns rows in the shape the app already parses, and the declared window', async () => {
    const page = await fetchChatIndex(
      'https://chat.example',
      'NQ64 B',
      answering(200, { messages: [message()], window: { startHeight: 58_842_720 } }),
    )
    expect(page.txs).toHaveLength(1)
    expect(page.txs[0]?.recipientData).toBe('4e433165|')
    expect(page.oldestBlock).toBe(1_000)
    // The operator's declared floor, not the deepest row returned.
    expect(page.startHeight).toBe(58_842_720)
  })

  it('drops a malformed row rather than failing the page', async () => {
    const page = await fetchChatIndex(
      'https://chat.example',
      'NQ64 B',
      answering(200, { messages: [message(), { hash: 'no-fields' }, 7, null], window: {} }),
    )
    expect(page.txs).toHaveLength(1)
    expect(page.startHeight).toBeNull()
  })

  it('distinguishes a refusal from an ambiguous failure', async () => {
    await expect(fetchChatIndex('https://chat.example', 'A', answering(404, {}))).rejects.toBeInstanceOf(HistoryError)
    await fetchChatIndex('https://chat.example', 'A', answering(404, {})).catch((error: unknown) => {
      expect(isDefiniteRejection(error)).toBe(true)
    })
    await fetchChatIndex('https://chat.example', 'A', answering(503, {})).catch((error: unknown) => {
      expect(isDefiniteRejection(error)).toBe(false)
    })
  })

  it('refuses a body that carries no message array', async () => {
    await expect(fetchChatIndex('https://chat.example', 'A', answering(200, { ok: true }))).rejects.toBeInstanceOf(
      HistoryError,
    )
  })
})
