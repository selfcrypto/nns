import { describe, expect, it } from 'vitest'
import { CHAT_PREFIX_HEX, Scanner, StartAheadOfHead, hasChatPrefix, rowsFromBatch } from './scan.js'
import { RpcError, type RpcClient, type RpcTransaction } from './rpc.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} } as never

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
  recipientData: hex('NC1hello'),
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
      message: 'hello',
    })
    // The raw payload is kept so a reader re-parses rather than trusting us.
    expect(rows[0]?.recipientData).toBe(hex('NC1hello'))
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
        tx({ hash: 'malformed', recipientData: hex('NC1') }),
        tx({ hash: 'keeper' }),
      ],
      24,
      100,
    )
    expect(batch.rows.map((row) => row.txHash)).toEqual(['keeper'])
    expect(batch.returned).toBe(7)
  })

  it('reads an empty batch as empty rather than as an error', () => {
    expect(rowsFromBatch(7, [], 24, 1)).toEqual({ batch: 7, returned: 0, rows: [] })
  })

  it('stores the effective sender of an HTLC-sent message, not the contract (r25)', () => {
    // Real mainnet proof, block 59,516,314 — the shape core/attribution.test.ts
    // pins. The second signature is the contract sender: the durable wallet.
    const proof =
      '010091b21f4b100273bd7034f6369c29d1f7ba72dba7de6720ad3cd8b8191621891300668acc228bf8ad0a832757b1e92b549e07f775937c2b4d2818d555943bef1c8421728d8f7bd4695d85fb3b626b541dcb0e3fbd791357d8720596c3b89547f506009e1ffbdc365402365800270b0b68904e51514e8bb05e48cd5e7310ba1412f6a2008525da9a0f4d04539a1a606df4b39307eeec06df1cf2e2c3d65030bcf4f675967425e34eb68cee64d3b7e9c6ea935ddc1ffa110565ead6a92aaf912d7fb1fb03'
    const htlc = 'NQ89 R3HN 70XQ 2E5A L4YS CV2Q UL5J 84TX 8L8H'
    const { rows } = rowsFromBatch(7, [tx({ from: htlc, fromType: 2, proof })], 24, 1)
    expect(rows[0]?.sender).toBe('NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9')
    // An unrecognised proof shape degrades to the account, exactly as core does.
    const fallback = rowsFromBatch(7, [tx({ from: htlc, fromType: 2, proof: '00ff' })], 24, 1)
    expect(fallback.rows[0]?.sender).toBe(htlc)
  })
})

describe('Scanner.tick before the start height', () => {
  const rpcAt = (head: number) =>
    ({
      isConsensusEstablished: async () => true,
      getBatchNumber: async () => 980_000,
      getBlockNumber: async () => head,
      batchOfBlock: async (height: number) => {
        if (height > head) throw new RpcError(`Block not found: ${height}`, true)
        return 979_000
      },
      transactionsByBatch: async () => [],
    }) as unknown as RpcClient

  it('waits when the start height is above the head, instead of reading it as a pruned horizon', async () => {
    const scanner = new Scanner({ rpc: rpcAt(100), logger: silent, networkId: 24, startHeight: 200, onBatch: async () => {} })
    await expect(scanner.tick()).rejects.toBeInstanceOf(StartAheadOfHead)
    expect(scanner.nextBatch).toBeUndefined()
  })

  it('still refuses a start height the node answers not-found for below the head', async () => {
    const rpc = rpcAt(300)
    rpc.batchOfBlock = async () => {
      throw new RpcError('Block not found: 200', true)
    }
    const scanner = new Scanner({ rpc, logger: silent, networkId: 24, startHeight: 200, onBatch: async () => {} })
    await expect(scanner.tick()).rejects.toBeInstanceOf(RpcError)
  })
})
