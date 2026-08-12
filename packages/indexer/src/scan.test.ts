import { describe, expect, it } from 'vitest'

import { PROTOCOL_PREFIX_HEX, Scanner, hasProtocolPrefix } from './scan.js'
import { MAINNET, collectingLogger, fakeNode, payload, tx } from './test-fixtures.js'

const NNS = (message: string) => payload(`NNS1${message}`)

function scanner(node: ReturnType<typeof fakeNode>, overrides: { launchHeight?: number; networkId?: number } = {}) {
  const { logger, lines } = collectingLogger()
  const candidates: unknown[] = []
  const instance = new Scanner({
    rpc: node.rpc,
    logger,
    networkId: overrides.networkId ?? MAINNET,
    launchHeight: overrides.launchHeight ?? 1,
    pollIntervalMs: 1,
    onCandidate: (candidate) => {
      candidates.push(candidate)
    },
  })
  return { scanner: instance, lines, candidates }
}

describe('prefix discovery', () => {
  it('derives the prefix from PROTOCOL_ID', () => {
    expect(PROTOCOL_PREFIX_HEX).toBe('4e4e5331')
    // Straight from the probe: this hex decodes to NNS1Gtestname.
    expect(hasProtocolPrefix('4e4e533147746573746e616d65')).toBe(true)
  })

  it('rejects near misses and empty data', () => {
    expect(hasProtocolPrefix(undefined)).toBe(false)
    expect(hasProtocolPrefix('')).toBe(false)
    expect(hasProtocolPrefix('4e4e5332')).toBe(false)
    expect(hasProtocolPrefix('004e4e5331')).toBe(false)
  })

  it('accepts uppercase hex — the probe saw lowercase, the spec does not promise it', () => {
    expect(hasProtocolPrefix('4E4E5331470000')).toBe(true)
  })
})

describe('§7.5 discovery filters', () => {
  it('keeps only NNS1-prefixed transactions', async () => {
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({ blockNumber: 61, recipientData: payload('hello') }),
          tx({ blockNumber: 61, recipientData: NNS('Gexample') }),
          tx({ blockNumber: 61 }),
        ],
      },
    })
    const { scanner: s, candidates } = scanner(node)
    const found = await s.scanBatch(2)
    expect(found).toHaveLength(1)
    expect(found[0]?.recipientData).toBe(NNS('Gexample'))
    expect(candidates).toHaveLength(1)
  })

  it('discards failed transactions — Albatross keeps them in blocks', async () => {
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({ blockNumber: 61, recipientData: NNS('Gtaken'), executionResult: false }),
          tx({ blockNumber: 61, recipientData: NNS('Gkept') }),
        ],
      },
    })
    const { scanner: s } = scanner(node)
    const found = await s.scanBatch(2)
    expect(found.map((c) => c.recipientData)).toEqual([NNS('Gkept')])
  })

  it('discards a foreign networkId', async () => {
    const node = fakeNode({
      head: 120,
      blocks: { 61: [tx({ blockNumber: 61, recipientData: NNS('Gtestnet'), networkId: 5 })] },
    })
    const { scanner: s } = scanner(node)
    expect(await s.scanBatch(2)).toHaveLength(0)
  })

  it('discards anything below LAUNCH_HEIGHT even inside the launch batch', async () => {
    const node = fakeNode({
      head: 180,
      blocks: {
        61: [tx({ blockNumber: 61, recipientData: NNS('Gearly') })],
        90: [tx({ blockNumber: 90, recipientData: NNS('Glate') })],
      },
    })
    const { scanner: s } = scanner(node, { launchHeight: 90 })
    const found = await s.scanBatch(2)
    expect(found.map((c) => c.recipientData)).toEqual([NNS('Glate')])
  })

  it('counts every drop in the batch summary', async () => {
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({ blockNumber: 61, recipientData: NNS('Gfailed'), executionResult: false }),
          tx({ blockNumber: 61, recipientData: NNS('Gforeign'), networkId: 5 }),
          tx({ blockNumber: 61, recipientData: payload('unrelated') }),
          tx({ blockNumber: 61, recipientData: NNS('Gkept') }),
        ],
      },
    })
    const { scanner: s, lines } = scanner(node)
    await s.scanBatch(2)
    const summary = lines.find((line) => line['msg'] === 'scan.batch')
    expect(summary).toMatchObject({
      batch: 2,
      firstBlock: 61,
      macroBlock: 120,
      returned: 4,
      candidates: 1,
      droppedFailedExecution: 1,
      droppedWrongNetwork: 1,
      droppedNotNns1: 1,
    })
  })
})

describe('canonical order (§5.2)', () => {
  it('takes txIndex from the block body, not from the batch result', async () => {
    // The batch call also returns a reward inherent, which is not in any body.
    // Counting it would shift every index after it.
    const reward = tx({ blockNumber: 61, from: 'NQ07 REWARD', recipientData: '' })
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({ blockNumber: 61, recipientData: payload('noise') }),
          tx({ blockNumber: 61, recipientData: NNS('Gsecond') }),
        ],
        62: [tx({ blockNumber: 62, recipientData: NNS('Gfirst') })],
      },
      inherents: [reward],
    })
    const { scanner: s } = scanner(node)
    const found = await s.scanBatch(2)
    expect(found.map((c) => [c.blockNumber, c.txIndex, c.recipientData])).toEqual([
      [61, 1, NNS('Gsecond')],
      [62, 0, NNS('Gfirst')],
    ])
  })

  it('fetches a block body only for blocks that carry an NNS message', async () => {
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [tx({ blockNumber: 61, recipientData: payload('noise') })],
        75: [tx({ blockNumber: 75, recipientData: NNS('Gonly') })],
      },
    })
    const { scanner: s } = scanner(node)
    await s.scanBatch(2)
    expect(node.calls.blocks).toEqual([75])
  })

  it('emits ascending (blockNumber, txIndex)', async () => {
    const node = fakeNode({
      head: 180,
      blocks: {
        70: [tx({ blockNumber: 70, recipientData: NNS('Ga') }), tx({ blockNumber: 70, recipientData: NNS('Gb') })],
        65: [tx({ blockNumber: 65, recipientData: NNS('Gc') })],
      },
    })
    const { scanner: s, candidates } = scanner(node)
    await s.scanBatch(2)
    const order = (candidates as { blockNumber: number; txIndex: number }[]).map((c) => [c.blockNumber, c.txIndex])
    expect(order).toEqual([
      [65, 0],
      [70, 0],
      [70, 1],
    ])
  })
})

describe('batch parameter assertion', () => {
  it('throws if a returned transaction falls outside the batch', async () => {
    // What we would see if getTransactionsByBatchNumber actually took a block
    // number: the docs describe its parameter as one (rpc-reference §6).
    const node = fakeNode({ head: 600, blocks: {} })
    const rogue = {
      ...node.rpc,
      getTransactionsByBatchNumber: async () => [tx({ blockNumber: 4_000, recipientData: NNS('Gx') })],
    }
    const { logger } = collectingLogger()
    const s = new Scanner({
      rpc: rogue,
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
    })
    await expect(s.scanBatch(2)).rejects.toThrow(/outside that batch/)
  })
})

describe('FINALITY_RULE in the loop', () => {
  it('scans up to the last finalised macro block and no further', async () => {
    const node = fakeNode({ head: 185, blocks: {} })
    const { scanner: s } = scanner(node)
    const scanned = await s.tick()
    // head 185 → batches 1..3 are final (macro block 180); batch 4 is open.
    expect(node.calls.batches).toEqual([1, 2, 3])
    expect(scanned).toBe(3)
    expect(s.nextBatch).toBe(4)
  })

  it('treats a head that is exactly a macro block as final', async () => {
    const node = fakeNode({ head: 120, blocks: {} })
    const { scanner: s } = scanner(node)
    await s.tick()
    expect(node.calls.batches).toEqual([1, 2])
  })

  it('does nothing while the current batch is still open', async () => {
    const node = fakeNode({ head: 125, blocks: {} })
    const { scanner: s } = scanner(node)
    await s.tick()
    node.calls.batches.length = 0
    expect(await s.tick()).toBe(0)
    expect(node.calls.batches).toEqual([])
  })

  it('resumes at the next batch as the head advances', async () => {
    const node = fakeNode({ head: 125, blocks: {} })
    const { scanner: s } = scanner(node)
    await s.tick()
    expect(s.nextBatch).toBe(3)
    node.setHead(245)
    await s.tick()
    expect(node.calls.batches).toEqual([1, 2, 3, 4])
  })

  it('starts at the batch containing LAUNCH_HEIGHT', async () => {
    const node = fakeNode({ head: 600, blocks: {} })
    const { scanner: s } = scanner(node, { launchHeight: 190 })
    await s.tick()
    expect(node.calls.batches[0]).toBe(4)
  })

  it('never indexes without consensus', async () => {
    const node = fakeNode({ head: 600, blocks: {}, consensus: false })
    const { scanner: s, lines } = scanner(node)
    expect(await s.tick()).toBe(0)
    expect(node.calls.batches).toEqual([])
    expect(lines.some((line) => line['msg'] === 'scan.waiting')).toBe(true)
  })
})

describe('candidate shape', () => {
  it('carries luna amounts as bigint and normalises the payload to lowercase', async () => {
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({
            blockNumber: 61,
            recipientData: NNS('Gexample').toUpperCase(),
            value: 400_000_000,
            fee: 138,
          }),
        ],
      },
    })
    const { scanner: s } = scanner(node)
    const [candidate] = await s.scanBatch(2)
    expect(candidate?.value).toBe(400_000_000n)
    expect(candidate?.fee).toBe(138n)
    expect(candidate?.recipientData).toBe(NNS('Gexample'))
  })

  it('logs every candidate it finds', async () => {
    const node = fakeNode({
      head: 120,
      blocks: { 61: [tx({ blockNumber: 61, recipientData: NNS('Gexample') })] },
    })
    const { scanner: s, lines } = scanner(node)
    await s.scanBatch(2)
    const line = lines.find((entry) => entry['msg'] === 'nns.candidate')
    expect(line).toMatchObject({ blockNumber: 61, txIndex: 0, dataBytes: 12 })
  })
})

describe('run', () => {
  it('stops when the signal aborts', async () => {
    const node = fakeNode({ head: 120, blocks: {} })
    const { scanner: s, lines } = scanner(node)
    const controller = new AbortController()
    const running = s.run(controller.signal)
    controller.abort()
    await running
    expect(lines.some((line) => line['msg'] === 'scan.stopped')).toBe(true)
  })

  it('survives an RPC failure and keeps its place', async () => {
    const node = fakeNode({ head: 120, blocks: {} })
    let failed = false
    const flaky = {
      ...node.rpc,
      getBlockNumber: async () => {
        if (!failed) {
          failed = true
          throw new Error('ECONNREFUSED')
        }
        return 120
      },
    }
    const { logger, lines } = collectingLogger()
    const controller = new AbortController()
    // Drive the loop off the idle wait rather than a wall clock: the second
    // idle means it failed, recovered, drained, and had nothing left to do.
    let idles = 0
    const s = new Scanner({
      rpc: flaky,
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
      sleep: async () => {
        idles += 1
        if (idles >= 2) controller.abort()
      },
    })
    await s.run(controller.signal)
    expect(lines.some((line) => line['msg'] === 'scan.error')).toBe(true)
    expect(s.nextBatch).toBe(3)
  })
})
