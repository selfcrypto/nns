import { describe, expect, it } from 'vitest'

import { HorizonError } from './horizon.js'
import { RpcTransportError } from './rpc.js'
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

describe('canonical order (§5.2, r27)', () => {
  it('ranks NNS messages by hash within their block; nothing else holds a rank', async () => {
    // The batch call also returns a reward inherent and unrelated transfers.
    // The rank's universe is NNS1-prefixed transactions only, so neither can
    // shift an index — the reward heuristic the body-position rule needed has
    // nothing left to guess about.
    const reward = tx({ blockNumber: 61, from: 'NQ07 REWARD', recipientData: '' })
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({ blockNumber: 61, recipientData: payload('noise') }),
          // Response order and hash order disagree on purpose.
          tx({ blockNumber: 61, hash: 'ff'.repeat(32), recipientData: NNS('Gsecond') }),
          tx({ blockNumber: 61, hash: '11'.repeat(32), recipientData: NNS('Gfirst') }),
        ],
        62: [tx({ blockNumber: 62, recipientData: NNS('Gnextblock') })],
      },
      inherents: [reward],
    })
    const { scanner: s } = scanner(node)
    const found = await s.scanBatch(2)
    expect(found.map((c) => [c.blockNumber, c.txIndex, c.recipientData])).toEqual([
      [61, 0, NNS('Gfirst')],
      [61, 1, NNS('Gsecond')],
      [62, 0, NNS('Gnextblock')],
    ])
  })

  it('reads no block bodies at all — the rank comes from the batch response alone', async () => {
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [tx({ blockNumber: 61, recipientData: payload('noise') })],
        75: [tx({ blockNumber: 75, recipientData: NNS('Gonly') }), tx({ blockNumber: 75, recipientData: NNS('Gtwo') })],
      },
    })
    const { scanner: s } = scanner(node)
    await s.scanBatch(2)
    expect(node.calls.blocks).toEqual([])
    // Calibration probes are header reads, counted apart from body reads.
    expect(node.calls.probes.length).toBeGreaterThan(0)
  })

  it('gives a §7.5-discarded message a rank it keeps occupying', async () => {
    // The universe is pre-discard: the failed message holds rank 0, and
    // discarding it later must not renumber the survivor to 0.
    const node = fakeNode({
      head: 120,
      blocks: {
        61: [
          tx({ blockNumber: 61, hash: '11'.repeat(32), recipientData: NNS('Gtaken'), executionResult: false }),
          tx({ blockNumber: 61, hash: 'ff'.repeat(32), recipientData: NNS('Gkept') }),
        ],
      },
    })
    const { scanner: s } = scanner(node)
    const found = await s.scanBatch(2)
    expect(found.map((c) => [c.txIndex, c.recipientData])).toEqual([[1, NNS('Gkept')]])
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
    await expect(s.scanBatch(2)).rejects.toThrow(/outside \[61, 120\]/)
  })

  it('accepts a genesis-relative height in its true batch', async () => {
    // The regression this guards: with the anchor 47 blocks low, real
    // transactions near a batch's start fall outside the computed range and
    // the scan throws on ordinary traffic at startup.
    const straddler = tx({ blockNumber: 3_456_108, recipientData: NNS('Gx') })
    const node = fakeNode({ head: 3_456_600, genesis: 3_456_000, blocks: { 3_456_108: [straddler] } })
    const { logger } = collectingLogger()
    const s = new Scanner({
      rpc: { ...node.rpc, getTransactionsByBatchNumber: async () => [straddler] },
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
    })
    // Batch 2 on this chain is 3,456,061–3,456,120, so this is in range —
    // and only an exact genesis makes that answer right.
    await expect(s.scanBatch(2)).resolves.toHaveLength(1)
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

  it('lags one batch rather than converting the head to a batch number', async () => {
    // Head 120 IS batch 2's macro block, so batch 2 is already final — but
    // knowing that means deriving a batch from a height, which is the thing
    // that was wrong. getBatchNumber says 2, so we scan through 1. One batch
    // (~1 min) of lag is the price, and it is worth paying.
    const node = fakeNode({ head: 120, blocks: {} })
    const { scanner: s } = scanner(node)
    await s.tick()
    expect(node.calls.batches).toEqual([1])
  })

  it('never derives the finality target from the head', async () => {
    // A genesis-relative chain: the node is at height 3,456,300, which is
    // batch 5 — height/60 would say 57,605 and scan tens of thousands of
    // batches that do not exist.
    const node = fakeNode({ head: 3_456_300, genesis: 3_456_000, blocks: {} })
    const { scanner: s } = scanner(node, { launchHeight: 3_456_001 })
    await s.tick()
    expect(node.calls.batches).toEqual([1, 2, 3, 4])
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

  it('resolves the start batch against a genesis-relative chain', async () => {
    // 3,456,190 is 190 blocks past genesis, so batch 4 — not batch 57,603,
    // which is what dividing the raw height by 60 would have said.
    const node = fakeNode({ head: 3_456_600, genesis: 3_456_000, blocks: {} })
    const { scanner: s } = scanner(node, { launchHeight: 3_456_190 })
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

describe('history horizon', () => {
  it('refuses to start below it, naming both heights', async () => {
    // The failure this exists to prevent: the batch call answers `[]` below the
    // horizon exactly as it does for an empty batch, so without the guard this
    // scan reports success over an unreachable window.
    const node = fakeNode({ head: 3_456_600, genesis: 3_456_000, horizon: 3_456_400, blocks: {} })
    const { scanner: s } = scanner(node, { launchHeight: 3_456_190 })
    await expect(s.tick()).rejects.toThrow(HorizonError)
    await expect(s.tick()).rejects.toThrow(/LAUNCH_HEIGHT 3,456,190.*3,456,400/s)
    expect(node.calls.batches).toEqual([])
  })

  it('leaves the poll loop instead of retrying, so the process can exit', async () => {
    const node = fakeNode({ head: 3_456_600, genesis: 3_456_000, horizon: 3_456_400, blocks: {} })
    const { logger, lines } = collectingLogger()
    const s = new Scanner({
      rpc: node.rpc,
      logger,
      networkId: 24,
      launchHeight: 3_456_190,
      pollIntervalMs: 1,
      sleep: async () => {
        throw new Error('the loop idled instead of giving up')
      },
    })
    await expect(s.run(new AbortController().signal)).rejects.toThrow(HorizonError)
    // Not logged as a transient scan.error either — that reads as "behind".
    expect(lines.some((line) => line['msg'] === 'scan.error')).toBe(false)
  })

  it('checks the resumed cursor, not LAUNCH_HEIGHT, once there is one', async () => {
    // A node resynced under a running indexer is the same silent-empty
    // failure; a launch height pruned away long after it was indexed is not.
    const node = fakeNode({ head: 3_456_600, genesis: 3_456_000, horizon: 3_456_400, blocks: {} })
    const { logger } = collectingLogger()
    const s = new Scanner({
      rpc: node.rpc,
      logger,
      networkId: 24,
      launchHeight: 3_456_190,
      pollIntervalMs: 1,
      startBatch: 8, // 3,456,421–3,456,480, above the horizon
    })
    await expect(s.tick()).resolves.toBeGreaterThan(0)
  })

  it('does not refuse a launch height the chain has not reached', async () => {
    const node = fakeNode({ head: 3_456_600, genesis: 3_456_000, horizon: 3_456_400, blocks: {} })
    const { scanner: s } = scanner(node, { launchHeight: 3_460_000 })
    expect(await s.tick()).toBe(0)
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
          // The client wraps every transport failure in its own class
          // (rpc.ts); only those, and the node's own JSON-RPC errors, are
          // transient enough to retry.
          throw new RpcTransportError('getBlockNumber: request failed', { cause: new Error('ECONNREFUSED') })
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
    expect(s.nextBatch).toBe(2)
  })

  it('dies on a failed commit instead of retrying into an advanced log hash', async () => {
    // The commit seam throws a `StoreError` on divergence and anything at all
    // on a database failure. None of it is transient: `CheckpointBuilder` has
    // already advanced the in-memory fold past the failed batch, so a retry
    // appends the same rows again and reports a monotonicity error that masks
    // the real one. The loop must leave, so the process can exit and reseed.
    const node = fakeNode({ head: 120, blocks: {} })
    const { logger, lines } = collectingLogger()
    const s = new Scanner({
      rpc: node.rpc,
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
      onBatchComplete: async () => {
        throw new Error('checkpoint divergence at height 720')
      },
      sleep: async () => {
        throw new Error('the loop retried a failed commit')
      },
    })
    await expect(s.run(new AbortController().signal)).rejects.toThrow(/checkpoint divergence/)
    // Not demoted to a transient-looking scan.error either.
    expect(lines.some((line) => line['msg'] === 'scan.error')).toBe(false)
  })

  it('dies on a transport failure the client itself marks unretryable', async () => {
    const node = fakeNode({ head: 120, blocks: {} })
    const broken = {
      ...node.rpc,
      getBlockNumber: async (): Promise<number> => {
        throw new RpcTransportError('getBlockNumber: result is not an object (envelope missing?)', {
          retryable: false,
        })
      },
    }
    const { logger } = collectingLogger()
    const s = new Scanner({
      rpc: broken,
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
      sleep: async () => {
        throw new Error('the loop retried an unretryable failure')
      },
    })
    await expect(s.run(new AbortController().signal)).rejects.toThrow(/envelope missing/)
  })

  it('stops at stopAfterBatch instead of tailing — a bounded re-scan must end', async () => {
    // `hybrid`'s background re-derivation (`shadow.ts`) re-scans a finished
    // range. Without a ceiling it would idle at the head forever, doubling
    // every RPC call the indexer makes to verify nothing new.
    const node = fakeNode({ head: 600, blocks: {} })
    const { logger } = collectingLogger()
    const s = new Scanner({
      rpc: node.rpc,
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
      stopAfterBatch: 3,
      sleep: async () => {
        throw new Error('a bounded scan idled instead of returning')
      },
    })
    await s.run(new AbortController().signal)
    expect(node.calls.batches).toEqual([1, 2, 3])
    expect(s.nextBatch).toBe(4)
  })

  it('never reads past finality, even when stopAfterBatch is above it', async () => {
    const node = fakeNode({ head: 180, blocks: {} })
    const { logger } = collectingLogger()
    const s = new Scanner({
      rpc: node.rpc,
      logger,
      networkId: 24,
      launchHeight: 1,
      pollIntervalMs: 1,
      stopAfterBatch: 99,
      sleep: async () => {
        throw new Error('stopped waiting for finality')
      },
    })
    // One tick: the ceiling is the lower of the two, so a stop above the
    // finalised batch shortens nothing and the scan is still finality-bound.
    await s.tick()
    expect(Math.max(...node.calls.batches)).toBeLessThan(3)
  })
})

