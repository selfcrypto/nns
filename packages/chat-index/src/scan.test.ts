import { describe, expect, it } from 'vitest'
import { CHAT_PREFIX_HEX, hasChatPrefix, rowsFromBatch } from './scan.js'
import type { RpcTransaction } from './rpc.js'

const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const SENDER = 'NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA'
const RECIPIENT = 'NQ64 TY4R HYX0 2XL4 9J8T UD8K 6YLV M2KP KMBS'

const tx = (over: Partial<RpcTransaction> = {}): RpcTransaction => ({
  hash: 'h1',
  blockNumber: 1_000,
  timestamp: 1_700_000_000_000,
  from: SENDER,
  to: RECIPIENT,
  recipientData: hex('NC1codescrafter|hello'),
  networkId: 24,
  executionResult: true,
  ...over,
})

describe('discovery', () => {
  it('recognises the prefix as hex, case-insensitively', () => {
    expect(CHAT_PREFIX_HEX).toBe('4e4331')
    expect(hasChatPrefix(hex('NC1x|y'))).toBe(true)
    expect(hasChatPrefix(hex('NC1x|y').toUpperCase())).toBe(true)
    expect(hasChatPrefix(hex('NNS1Gexample'))).toBe(false)
    expect(hasChatPrefix(undefined)).toBe(false)
  })

  it('keeps a well-formed message and reads its fields', () => {
    const { rows } = rowsFromBatch(7, [tx()], 24, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      txHash: 'h1',
      blockNumber: 1_000,
      sender: SENDER,
      recipient: RECIPIENT,
      name: 'codescrafter',
      message: 'hello',
    })
    // The raw payload is kept so a reader re-parses rather than trusting us.
    expect(rows[0]?.recipientData).toBe(hex('NC1codescrafter|hello'))
  })

  it('drops what is not an NC message, and never the NNS ones', () => {
    const batch = rowsFromBatch(
      7,
      [
        tx({ hash: 'failed', executionResult: false }),
        tx({ hash: 'wrong-net', networkId: 5 }),
        tx({ hash: 'too-early', blockNumber: 10 }),
        tx({ hash: 'nns', recipientData: hex('NNS1Gexample') }),
        tx({ hash: 'reward', recipientData: undefined }),
        tx({ hash: 'malformed', recipientData: hex('NC1no-separator') }),
        tx({ hash: 'bad-name', recipientData: hex('NC1UPPER|hi') }),
        tx({ hash: 'keeper' }),
      ],
      24,
      100,
    )
    expect(batch.rows.map((row) => row.txHash)).toEqual(['keeper'])
    expect(batch.returned).toBe(8)
  })

  it('reads an empty batch as empty rather than as an error', () => {
    expect(rowsFromBatch(7, [], 24, 1)).toEqual({ batch: 7, returned: 0, rows: [] })
  })
})
