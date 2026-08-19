/**
 * The endpoint, against a stub store. What is worth testing here is not SQL —
 * `store.test.ts` has that — but the contract the app depends on: the shape of
 * a page, the cursor, and that a window statement is always present.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createChatServer } from './server.js'
import { createLogger } from './logger.js'
import type { ChatRow, Store } from './store.js'

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  txHash: 'h1',
  blockNumber: 1_000,
  timestamp: 1_700_000_000_000,
  sender: 'NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA',
  recipient: 'NQ64 TY4R HYX0 2XL4 9J8T UD8K 6YLV M2KP KMBS',
  name: 'codescrafter',
  message: 'hello',
  recipientData: '4e4331636f6465736372616674657232',
  ...over,
})

const stubStore = (rows: readonly ChatRow[]): Store =>
  ({
    messagesFor: async (_address: string, limit: number, before: number | null) =>
      rows.filter((entry) => before === null || entry.blockNumber < before).slice(0, limit),
  }) as unknown as Store

const silent = createLogger('error', () => undefined)

/** `json()` answers `unknown`; a test that reads a contract may name it. */
type Page = {
  messages: { hash: string; from: string; to: string; recipientData: string; executionResult: boolean }[]
  window: { startHeight: number; nextBatch: number | null }
  next: number | null
  message?: string
}
const page = async (response: Response): Promise<Page> => (await response.json()) as Page

describe('the read endpoint', () => {
  const server = createChatServer({
    store: stubStore([row(), row({ txHash: 'h2', blockNumber: 900 })]),
    logger: silent,
    maxPageSize: 2,
    startHeight: 58_842_720,
    scannedTo: () => 987_654,
  })
  let base = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('answers messages for an address in the shape the client already parses', async () => {
    const response = await fetch(`${base}/messages/${encodeURIComponent('NQ64 TY4R')}`)
    expect(response.status).toBe(200)
    // CORS open to any origin: the app is independently hostable by design.
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = await page(response)
    expect(body.messages[0]).toMatchObject({
      hash: 'h1',
      from: expect.stringContaining('NQ42'),
      to: expect.stringContaining('NQ64'),
      executionResult: true,
    })
    // The raw payload travels, so the client parses with @nns/chat.
    expect(body.messages[0]?.recipientData).toBe('4e4331636f6465736372616674657232')
  })

  it('always states its window, so an empty answer is never read as "no messages"', async () => {
    const body = await page(await fetch(`${base}/messages/NQ00`))
    expect(body.window).toEqual({ startHeight: 58_842_720, nextBatch: 987_654 })
  })

  it('offers a cursor only when the page was full, and honours it', async () => {
    const full = await page(await fetch(`${base}/messages/NQ00`))
    expect(full.next).toBe(900)
    const next = await page(await fetch(`${base}/messages/NQ00?before=900`))
    expect(next.messages).toHaveLength(0)
    expect(next.next).toBeNull()
  })

  it('caps the page size at the configured maximum', async () => {
    const body = await page(await fetch(`${base}/messages/NQ00?limit=5000`))
    expect(body.messages).toHaveLength(2)
  })

  it('refuses junk parameters and unknown routes by name', async () => {
    expect((await fetch(`${base}/messages/NQ00?limit=0`)).status).toBe(400)
    expect((await fetch(`${base}/messages/NQ00?before=tomorrow`)).status).toBe(400)
    const unknown = await fetch(`${base}/resolve/example`)
    expect(unknown.status).toBe(404)
    expect((await page(unknown)).message).toContain('/messages/{address}')
  })

  it('is read-only, and says so', async () => {
    expect((await fetch(`${base}/messages/NQ00`, { method: 'POST' })).status).toBe(405)
  })

  it('reports health with the window rather than a bare ok', async () => {
    const body = await (await fetch(`${base}/healthz`)).json() as unknown
    expect(body).toEqual({ ok: true, startHeight: 58_842_720, nextBatch: 987_654 })
  })
})
