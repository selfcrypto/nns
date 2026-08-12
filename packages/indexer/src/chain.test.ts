import { describe, expect, it } from 'vitest'

import {
  BLOCKS_PER_BATCH,
  batchAt,
  firstBlockOf,
  heightInBatch,
  lastFinalisedBatch,
  lastFinalisedHeight,
  macroBlockOf,
} from './chain.js'

describe('batch geometry', () => {
  it('puts the first 60 blocks in batch 1', () => {
    expect(batchAt(1)).toBe(1)
    expect(batchAt(59)).toBe(1)
    expect(batchAt(60)).toBe(1)
    expect(batchAt(61)).toBe(2)
  })

  it('treats genesis as batch 0', () => {
    expect(batchAt(0)).toBe(0)
    expect(batchAt(-5)).toBe(0)
  })

  it('closes each batch with its macro block', () => {
    expect(macroBlockOf(1)).toBe(60)
    expect(macroBlockOf(970_000)).toBe(58_200_000)
  })

  it('round-trips first block and macro block', () => {
    for (const batch of [1, 2, 7, 12_345, 969_425]) {
      expect(firstBlockOf(batch)).toBe(macroBlockOf(batch - 1) + 1)
      expect(batchAt(firstBlockOf(batch))).toBe(batch)
      expect(batchAt(macroBlockOf(batch))).toBe(batch)
      expect(macroBlockOf(batch) - firstBlockOf(batch) + 1).toBe(BLOCKS_PER_BATCH)
    }
  })

  it('bounds a batch inclusively', () => {
    expect(heightInBatch(60, 1)).toBe(true)
    expect(heightInBatch(61, 1)).toBe(false)
    expect(heightInBatch(61, 2)).toBe(true)
    expect(heightInBatch(120, 2)).toBe(true)
    expect(heightInBatch(121, 2)).toBe(false)
  })
})

describe('FINALITY_RULE', () => {
  it('never advances past the last macro block', () => {
    // Mid-batch: batch 2 is still open, so batch 1 is the last final one.
    expect(lastFinalisedBatch(61)).toBe(1)
    expect(lastFinalisedHeight(61)).toBe(60)
    expect(lastFinalisedBatch(119)).toBe(1)
    expect(lastFinalisedHeight(119)).toBe(60)
  })

  it('counts a head that IS a macro block as final', () => {
    // Albatross macro blocks carry a 2/3 aggregate commit and are final on
    // production, so there is no reason to lag a batch behind here.
    expect(lastFinalisedBatch(60)).toBe(1)
    expect(lastFinalisedHeight(60)).toBe(60)
    expect(lastFinalisedBatch(120)).toBe(2)
    expect(lastFinalisedHeight(120)).toBe(120)
  })

  it('has nothing final before the first macro block', () => {
    expect(lastFinalisedBatch(0)).toBe(0)
    expect(lastFinalisedBatch(59)).toBe(0)
    expect(lastFinalisedHeight(59)).toBe(0)
  })

  it('agrees with the node batch number to within one batch', () => {
    for (const head of [59, 60, 61, 58_165_492, 58_177_017]) {
      const nodeBatch = batchAt(head)
      expect(Math.abs(nodeBatch - lastFinalisedBatch(head))).toBeLessThanOrEqual(1)
    }
  })
})
