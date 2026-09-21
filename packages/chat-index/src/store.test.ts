/**
 * Store integration — **needs a real Postgres**, and is skipped without one.
 *
 *   NNS_TEST_DATABASE_URL=postgres://…/throwaway pnpm vitest run --project chat-index
 *
 * It drops and recreates its own **named schema**, like the indexer's and the
 * API's gated suites, so the three can share one throwaway database and run in
 * parallel without deleting each other's tables mid-run. The search_path goes
 * on the connection string rather than a `SET`, so it is in force on every
 * pooled connection instead of only the one that ran the statement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store, createPool, migrate } from './store.js'
import { createLogger } from './logger.js'
import type { ChatRow } from './store.js'

const DB = process.env['NNS_TEST_DATABASE_URL']
const SCHEMA = 'chat_index_test'
const POOL_URL =
  DB === undefined ? '' : `${DB}${DB.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`

const A = 'NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA'
const B = 'NQ64 TY4R HYX0 2XL4 9J8T UD8K 6YLV M2KP KMBS'
const C = 'NQ39 M3TJ 2NC1 G4PJ 07JF BFKG Q3X6 AK7K J7YT'

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  txHash: 'h1',
  blockNumber: 1_000,
  timestamp: 1_700_000_000_000,
  sender: A,
  recipient: B,
  message: 'hello',
  recipientData: '4e4331',
  ...over,
})

const cursor = (nextBatch: number) => ({ nextBatch, startHeight: 58_842_720, networkId: 24 })

describe.skipIf(DB === undefined)('Store', () => {
  const pool = createPool(POOL_URL)
  const logger = createLogger('error', () => undefined)
  const store = new Store(pool, logger)

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`)
    await migrate(pool, logger)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('starts with no cursor at all, which is how a fresh index is recognised', async () => {
    expect(await store.loadCursor()).toBeNull()
  })

  it('commits rows and the cursor together', async () => {
    await store.commitBatch([row(), row({ txHash: 'h2', blockNumber: 1_001, sender: B, recipient: A })], cursor(11))
    expect(await store.loadCursor()).toEqual({ nextBatch: 11, startHeight: 58_842_720, networkId: 24 })
    expect(await store.messagesFor(A, 10, null)).toHaveLength(2)
  })

  it('re-applies a batch as a no-op — a re-scan must not duplicate a message', async () => {
    await store.commitBatch([row(), row({ txHash: 'h2', blockNumber: 1_001, sender: B, recipient: A })], cursor(11))
    expect(await store.messagesFor(A, 10, null)).toHaveLength(2)
  })

  it('answers both directions for an address, and nothing for a stranger', async () => {
    const mine = await store.messagesFor(B, 10, null)
    expect(mine.map((entry) => entry.txHash).sort()).toEqual(['h1', 'h2'])
    expect(await store.messagesFor(C, 10, null)).toEqual([])
  })

  it('orders newest first and pages by block with an exclusive cursor', async () => {
    const page = await store.messagesFor(A, 1, null)
    expect(page[0]?.blockNumber).toBe(1_001)
    const next = await store.messagesFor(A, 10, page[0]?.blockNumber ?? null)
    expect(next.map((entry) => entry.txHash)).toEqual(['h1'])
  })

  it('round-trips the payload and the parsed fields unchanged', async () => {
    const [message] = await store.messagesFor(B, 1, null)
    expect(message).toMatchObject({ message: 'hello', recipientData: '4e4331' })
    // Heights and millisecond timestamps come back as numbers, not strings.
    expect(typeof message?.blockNumber).toBe('number')
    expect(typeof message?.timestamp).toBe('number')
  })
})
