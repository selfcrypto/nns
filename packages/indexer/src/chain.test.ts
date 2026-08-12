import { describe, expect, it } from 'vitest'

import { BLOCKS_PER_BATCH, CalibrationError, calibrate, geometryFor, lastFinalisedBatch } from './chain.js'
import type { RpcBlock } from './rpc.js'
import { collectingLogger } from './test-fixtures.js'

/**
 * Measured on mainnet 2026-08-12. Every claim here came off the node:
 *
 *   getBlockNumber            → 58,707,995
 *   getBatchNumber            → 920,867
 *   getBlockByNumber(58707553) → { batch: 920860, type: "micro" }
 *   getBlockByNumber(58707600) → { batch: 920860, type: "macro" }
 *   getBlockByNumber(58707541) → { batch: 920860, type: "micro" }
 *   getBlockByNumber(58707540) → { batch: 920859, type: "macro" }
 *
 * So batch 920,860 is blocks 58,707,541–58,707,600, and the PoS genesis is
 * 58,707,600 − 920,860 × 60 = 3,456,000.
 */
const MAINNET = {
  genesis: 3_456_000,
  head: 58_707_553,
  batch: 920_860,
  firstBlock: 58_707_541,
  macroBlock: 58_707_600,
}

describe('the measured mainnet pair', () => {
  const geometry = geometryFor(MAINNET.genesis)

  it('pins head 58,707,553 to batch 920,860', () => {
    expect(geometry.batchAt(MAINNET.head)).toBe(MAINNET.batch)
  })

  it('does NOT derive the batch as floor(height / 60)', () => {
    // The bug this test exists to prevent. Batch numbering starts at the PoS
    // genesis, not at block 0, so height/60 is 57,599 batches too high — and
    // it does not throw, it just scans a part of the chain that never existed.
    const naive = Math.floor(MAINNET.head / BLOCKS_PER_BATCH)
    expect(naive).toBe(978_459)
    expect(naive - MAINNET.batch).toBe(57_599)
    expect(geometry.batchAt(MAINNET.head)).not.toBe(naive)
  })

  it('reproduces the measured block range of batch 920,860', () => {
    expect(geometry.firstBlockOf(MAINNET.batch)).toBe(MAINNET.firstBlock)
    expect(geometry.macroBlockOf(MAINNET.batch)).toBe(MAINNET.macroBlock)
    // The blocks either side belong to the neighbouring batches, as measured.
    expect(geometry.batchAt(MAINNET.firstBlock - 1)).toBe(MAINNET.batch - 1)
    expect(geometry.batchAt(MAINNET.macroBlock + 1)).toBe(MAINNET.batch + 1)
  })

  it('holds for the second measured head, 58,707,995 → batch 920,867', () => {
    expect(geometry.batchAt(58_707_995)).toBe(920_867)
  })

  it('rejects the lower bound that head - batch * 60 would have given', () => {
    // 3,455,953 also satisfies the (head, batch) pair — the batch number is a
    // ceiling, so one sample pins genesis only to a 60-wide window. It is 47
    // short, which would put every batch's range off by 47 blocks.
    const bound = MAINNET.head - MAINNET.batch * BLOCKS_PER_BATCH
    expect(bound).toBe(3_455_953)
    expect(Math.ceil((MAINNET.head - bound) / BLOCKS_PER_BATCH)).toBe(MAINNET.batch)
    expect(geometryFor(bound).macroBlockOf(MAINNET.batch)).not.toBe(MAINNET.macroBlock)
    expect(MAINNET.genesis - bound).toBe(47)
  })
})

describe('geometryFor', () => {
  const geometry = geometryFor(MAINNET.genesis)

  it('round-trips first block and macro block', () => {
    for (const batch of [1, 2, 7, 12_345, MAINNET.batch]) {
      expect(geometry.firstBlockOf(batch)).toBe(geometry.macroBlockOf(batch - 1) + 1)
      expect(geometry.macroBlockOf(batch) - geometry.firstBlockOf(batch) + 1).toBe(BLOCKS_PER_BATCH)
      expect(geometry.batchAt(geometry.macroBlockOf(batch))).toBe(batch)
      expect(geometry.batchAt(geometry.firstBlockOf(batch))).toBe(batch)
    }
  })

  it('bounds a batch inclusively at both ends', () => {
    expect(geometry.heightInBatch(MAINNET.firstBlock, MAINNET.batch)).toBe(true)
    expect(geometry.heightInBatch(MAINNET.macroBlock, MAINNET.batch)).toBe(true)
    expect(geometry.heightInBatch(MAINNET.firstBlock - 1, MAINNET.batch)).toBe(false)
    expect(geometry.heightInBatch(MAINNET.macroBlock + 1, MAINNET.batch)).toBe(false)
  })

  it('puts genesis itself in no batch', () => {
    expect(geometry.batchAt(MAINNET.genesis)).toBe(0)
    expect(geometry.batchAt(MAINNET.genesis + 1)).toBe(1)
    expect(geometry.macroBlockOf(1)).toBe(3_456_060)
  })
})

/** A node whose blocks answer with their own batch and type. */
function chainAt(genesis: number, head: number) {
  const probes: number[] = []
  const rpc = {
    getBlockNumber: async () => head,
    getBlockByNumber: async (height: number): Promise<RpcBlock> => {
      probes.push(height)
      return {
        number: height,
        hash: `b${height}`,
        batch: Math.ceil((height - genesis) / BLOCKS_PER_BATCH),
        type: height > genesis && (height - genesis) % BLOCKS_PER_BATCH === 0 ? 'macro' : 'micro',
      }
    },
  }
  return { rpc, probes }
}

describe('calibrate', () => {
  it('measures the true mainnet genesis, not the lower bound', async () => {
    const { rpc } = chainAt(MAINNET.genesis, 58_707_995)
    const geometry = await calibrate(rpc)
    expect(geometry.genesisBlock).toBe(3_456_000)
    expect(geometry.batchAt(MAINNET.head)).toBe(MAINNET.batch)
    expect(geometry.macroBlockOf(MAINNET.batch)).toBe(MAINNET.macroBlock)
  })

  it('finds the boundary wherever the head sits inside its batch', async () => {
    // The offset from the batch's first block is what the naive derivation
    // cannot see, so every one of them has to come out at the same genesis.
    for (let offset = 0; offset < BLOCKS_PER_BATCH; offset += 1) {
      const { rpc } = chainAt(MAINNET.genesis, MAINNET.firstBlock + offset)
      expect((await calibrate(rpc)).genesisBlock).toBe(MAINNET.genesis)
    }
  })

  it('costs a handful of calls, not sixty', async () => {
    const { rpc, probes } = chainAt(MAINNET.genesis, 58_707_995)
    await calibrate(rpc)
    expect(probes.length).toBeLessThanOrEqual(10)
  })

  it('reads the head, then that block — a consistent pair with no race', async () => {
    // Reading getBlockNumber and getBatchNumber separately can straddle a
    // boundary. Reading the block AT the head cannot.
    const order: string[] = []
    const geometry = await calibrate({
      getBlockNumber: async () => {
        order.push('head')
        return 58_707_995
      },
      getBlockByNumber: async (height: number) => {
        order.push(`block:${height}`)
        return {
          number: height,
          hash: 'b',
          batch: Math.ceil((height - MAINNET.genesis) / BLOCKS_PER_BATCH),
          type: (height - MAINNET.genesis) % BLOCKS_PER_BATCH === 0 ? 'macro' : 'micro',
        }
      },
    })
    expect(order[0]).toBe('head')
    expect(order[1]).toBe('block:58707995')
    expect(geometry.genesisBlock).toBe(MAINNET.genesis)
  })

  it('refuses to guess when the node omits the batch field', async () => {
    await expect(
      calibrate({
        getBlockNumber: async () => 58_707_995,
        getBlockByNumber: async (height: number) => ({ number: height, hash: 'b' }),
      }),
    ).rejects.toThrow(CalibrationError)
  })

  it('throws when the derived boundary is not a macro block', async () => {
    // If this fires, the anchor is wrong and everything downstream would be
    // wrong with it — silently, which is the one outcome worth crashing over.
    await expect(
      calibrate({
        getBlockNumber: async () => 58_707_995,
        getBlockByNumber: async (height: number) => ({
          number: height,
          hash: 'b',
          batch: Math.ceil((height - MAINNET.genesis) / BLOCKS_PER_BATCH),
          type: 'micro',
        }),
      }),
    ).rejects.toThrow(/not trustworthy/)
  })

  it('logs the anchor next to the bound it replaces', async () => {
    const { logger, lines } = collectingLogger()
    const { rpc } = chainAt(MAINNET.genesis, 58_707_995)
    await calibrate(rpc, logger)
    expect(lines.find((line) => line['msg'] === 'chain.calibrated')).toMatchObject({
      head: 58_707_995,
      currentBatch: 920_867,
      genesisBlock: 3_456_000,
      lowerBoundWas: 3_455_975,
    })
  })
})

describe('FINALITY_RULE', () => {
  it('is the batch below the current one, from getBatchNumber', () => {
    expect(lastFinalisedBatch(MAINNET.batch)).toBe(920_859)
    expect(lastFinalisedBatch(2)).toBe(1)
  })

  it('has nothing final before the first batch closes', () => {
    expect(lastFinalisedBatch(1)).toBe(0)
    expect(lastFinalisedBatch(0)).toBe(0)
  })
})
