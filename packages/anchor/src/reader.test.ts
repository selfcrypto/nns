import { cidFromDigest, CONSTANTS } from '@nimiqnames/core'
import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { ANCHORED_TOPIC0 } from './artifact.js'
import type { EvmAddress, EvmLog, Hex } from './chain.js'
import { addressTopic } from './publish.js'
import {
  checkAnchors,
  createAnchorReadRpc,
  DEFAULT_READER_LOOKBACK_BLOCKS,
  latestAnchoredHeight,
  ReaderError,
  type AnchorReadRpc,
} from './reader.js'

const CONTRACT = '0x0102030405060708090a0b0c0d0e0f1011121314' as EvmAddress
const HEIGHT = 58_204_800
const NOW = 1_765_000_000

const ALICE = '0x00000000000000000000000000000000000a11ce' as EvmAddress
const BOB = '0x0000000000000000000000000000000000000b0b' as EvmAddress
const MALLORY = '0x00000000000000000000000000000000000000ee' as EvmAddress

const COMMITMENT: Hex = `0x${'ab'.repeat(32)}`
const OTHER_COMMITMENT: Hex = `0x${'cd'.repeat(32)}`
const DIGEST: Hex = '0xbfccda787baba32b59c78450ac3d20b633360b43992c77289f9ed46d843561e6'

interface EventOptions {
  root?: Hex
  height?: number
  timestamp?: number
  digest?: Hex
  tx?: Hex
}

function anchored(publisher: EvmAddress, options: EventOptions = {}): EvmLog {
  const height = options.height ?? HEIGHT
  const timestamp = options.timestamp ?? NOW - 3_600
  return {
    address: CONTRACT,
    topics: [ANCHORED_TOPIC0 as Hex, options.root ?? COMMITMENT, addressTopic(publisher)],
    data: `0x${height.toString(16).padStart(64, '0')}${timestamp.toString(16).padStart(64, '0')}${(options.digest ?? DIGEST).slice(2)}`,
    blockNumber: 500n,
    transactionHash: options.tx ?? (`0x${publisher.slice(-4)}feed` as Hex),
  }
}

function rpc(label: string, logs: readonly EvmLog[] | Error): AnchorReadRpc & { filters: unknown[] } {
  const filters: unknown[] = []
  return {
    label,
    filters,
    blockNumber: async () => 1_000_000n,
    getLogs: async (filter) => {
      filters.push(filter)
      if (logs instanceof Error) throw logs
      return logs
    },
  }
}

const OPTIONS = {
  contractAddress: CONTRACT,
  height: HEIGHT,
  publishers: [ALICE, BOB],
  now: () => NOW,
}

describe('checkAnchors', () => {
  it('reports not-checked on the empty default list — never inventing an entry', async () => {
    const a = rpc('a', [anchored(ALICE)])
    const result = await checkAnchors([a, rpc('b', [anchored(ALICE)])], {
      contractAddress: CONTRACT,
      height: HEIGHT,
    })
    expect(result).toEqual({ status: 'not-checked', reason: 'NO_PUBLISHERS' })
    expect(a.filters).toEqual([]) // it did not even query
  })

  it('refuses a single endpoint — one provider is not a cross-check (§9)', async () => {
    await expect(checkAnchors([rpc('only', [])], OPTIONS)).rejects.toThrow(ReaderError)
  })

  it('verifies when quorum distinct listed publishers agree on both endpoints', async () => {
    const logs = [anchored(ALICE), anchored(BOB)]
    const result = await checkAnchors([rpc('a', logs), rpc('b', logs)], OPTIONS)
    expect(result).toMatchObject({
      status: 'verified',
      height: HEIGHT,
      commitment: COMMITMENT,
      logDigest: DIGEST,
      cid: cidFromDigest(hexToBytes(DIGEST.slice(2))),
      staleness: { newestTimestamp: NOW - 3_600, ageSeconds: 3_600, stale: false },
    })
    expect([...(result as { publishers: readonly string[] }).publishers].sort()).toEqual([ALICE, BOB].sort())
  })

  it('ignores unknown publishers — never counted, never a mismatch', async () => {
    // Mallory anchors garbage at the same height; the quorum is unbothered.
    const logs = [anchored(ALICE), anchored(BOB), anchored(MALLORY, { root: OTHER_COMMITMENT, tx: '0x9999' })]
    const result = await checkAnchors([rpc('a', logs), rpc('b', logs)], OPTIONS)
    expect(result.status).toBe('verified')
  })

  it('one listed publisher anchoring twice is not a quorum', async () => {
    const logs = [anchored(ALICE), anchored(ALICE, { tx: '0xaaaa02' })]
    const result = await checkAnchors([rpc('a', logs), rpc('b', logs)], OPTIONS)
    expect(result).toMatchObject({ status: 'quorum-not-met', found: 1, required: CONSTANTS.ANCHOR_QUORUM })
  })

  it('hard divergence: a cross-checked listed anchor disagreeing with the quorum value', async () => {
    const logs = [anchored(ALICE), anchored(BOB, { root: OTHER_COMMITMENT, tx: '0xb0b2' })]
    const result = await checkAnchors([rpc('a', logs), rpc('b', logs)], OPTIONS)
    expect(result.status).toBe('divergence')
    const conflicting = (result as { conflicting: readonly { publisher: string }[] }).conflicting
    expect(conflicting.map((c) => c.publisher).sort()).toEqual([ALICE, BOB].sort())
  })

  it('a differing logDigest alone is the same divergence as a differing commitment', async () => {
    const otherDigest: Hex = `0x${'11'.repeat(32)}`
    const logs = [anchored(ALICE), anchored(BOB, { digest: otherDigest, tx: '0xb0b3' })]
    const result = await checkAnchors([rpc('a', logs), rpc('b', logs)], OPTIONS)
    expect(result.status).toBe('divergence')
  })

  it('reports staleness against the 48 h limit, and pending anchors as quorum-not-met', async () => {
    const old = NOW - CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC - 3_600
    const logs = [anchored(ALICE, { height: HEIGHT - 720, timestamp: old, tx: '0x0111' })]
    const result = await checkAnchors([rpc('a', logs), rpc('b', logs)], OPTIONS)
    expect(result).toMatchObject({
      status: 'quorum-not-met',
      found: 0,
      staleness: { newestTimestamp: old, stale: true },
    })
  })

  it('an empty window is reported stale — "nothing to anchor" is indistinguishable from "stopped"', async () => {
    const result = await checkAnchors([rpc('a', []), rpc('b', [])], OPTIONS)
    expect(result).toMatchObject({
      status: 'quorum-not-met',
      found: 0,
      staleness: { newestTimestamp: null, ageSeconds: null, stale: true },
    })
  })

  // ── The §9 cross-check: absence is never agreement ────────────────────────

  it('one endpoint erroring means unavailable, not an answer', async () => {
    const result = await checkAnchors([rpc('a', [anchored(ALICE), anchored(BOB)]), rpc('b', new Error('rate limited'))], OPTIONS)
    expect(result).toEqual({ status: 'unavailable', errors: [{ rpc: 'b', error: 'rate limited' }] })
  })

  it('quorum met only through a single-source event is rpc-disagreement, never verified', async () => {
    // Endpoint b is missing Bob's anchor: lag or censorship, unknowable.
    const result = await checkAnchors(
      [rpc('a', [anchored(ALICE), anchored(BOB)]), rpc('b', [anchored(ALICE)])],
      OPTIONS,
    )
    expect(result.status).toBe('rpc-disagreement')
    const singles = (result as { singleSource: readonly { publisher: string; rpc: string }[] }).singleSource
    expect(singles).toEqual([expect.objectContaining({ publisher: BOB, rpc: 'a' })])
  })

  it('a conflicting anchor only one endpoint reports is rpc-disagreement, not divergence', async () => {
    // A fabricated divergence must not trigger the publisher-divergence
    // alarm on one provider's word — but it must also never verify.
    const fabricated = anchored(BOB, { root: OTHER_COMMITMENT, tx: '0xfa8e' })
    const result = await checkAnchors(
      [rpc('a', [anchored(ALICE), anchored(BOB), fabricated]), rpc('b', [anchored(ALICE), anchored(BOB)])],
      OPTIONS,
    )
    expect(result.status).toBe('rpc-disagreement')
    expect((result as { detail: string }).detail).toContain('provider disagreement')
  })

  it('a single-source event that changes nothing does not block verification', async () => {
    // Endpoint a alone also sees an *agreeing* duplicate from Alice — the
    // outcome is identical with or without it, so it is not a disagreement.
    const extra = anchored(ALICE, { tx: '0xa11ce02' })
    const result = await checkAnchors(
      [rpc('a', [anchored(ALICE), anchored(BOB), extra]), rpc('b', [anchored(ALICE), anchored(BOB)])],
      OPTIONS,
    )
    expect(result.status).toBe('verified')
  })

  it('queries every endpoint with the topic filter over the lookback window', async () => {
    const a = rpc('a', [anchored(ALICE), anchored(BOB)])
    await checkAnchors([a, rpc('b', [anchored(ALICE), anchored(BOB)])], OPTIONS)
    expect(a.filters).toEqual([
      {
        address: CONTRACT,
        topics: [ANCHORED_TOPIC0],
        fromBlock: 1_000_000n - DEFAULT_READER_LOOKBACK_BLOCKS,
        toBlock: 'latest',
      },
    ])
  })
})

describe('latestAnchoredHeight', () => {
  // Discovery, not verification: it says which height to ask about, and
  // `checkAnchors` decides whether the answer there can be trusted. Keeping
  // those apart is what stops a caller reading "no anchor found" when the real
  // answer is "one publisher, and quorum is two".

  const publishers = [ALICE, BOB]

  it('reports the newest height two endpoints agree on', () => {
    const logs = [
      anchored(ALICE, { height: HEIGHT }),
      anchored(ALICE, { height: HEIGHT + 720, tx: '0xaaa1' as Hex }),
    ]
    return expect(
      latestAnchoredHeight([rpc('a', logs), rpc('b', logs)], { contractAddress: CONTRACT, publishers }),
    ).resolves.toEqual({ status: 'found', height: HEIGHT + 720, timestamp: NOW - 3_600, publishers: [ALICE] })
  })

  it('does not apply quorum — one publisher still names a height', async () => {
    // Otherwise a deployment with a single live publisher would look like a
    // chain with no anchors, instead of getting `quorum-not-met` from the real
    // check, which is the answer that says what to do about it.
    const logs = [anchored(ALICE)]
    await expect(
      latestAnchoredHeight([rpc('a', logs), rpc('b', logs)], { contractAddress: CONTRACT, publishers }),
    ).resolves.toEqual({ status: 'found', height: HEIGHT, timestamp: NOW - 3_600, publishers: [ALICE] })
  })

  it('ignores an unlisted publisher entirely (§8.5 #1)', async () => {
    const logs = [anchored(MALLORY, { height: HEIGHT + 1440 }), anchored(ALICE, { height: HEIGHT })]
    await expect(
      latestAnchoredHeight([rpc('a', logs), rpc('b', logs)], { contractAddress: CONTRACT, publishers }),
    ).resolves.toEqual({ status: 'found', height: HEIGHT, timestamp: NOW - 3_600, publishers: [ALICE] })
  })

  it('will not be raised by an anchor only one endpoint reports', async () => {
    // The whole point of §9's cross-check: a single endpoint that alone claims
    // a newer height would otherwise steer every caller to a height the others
    // have never heard of.
    const shared = [anchored(ALICE, { height: HEIGHT })]
    const alone = [...shared, anchored(BOB, { height: HEIGHT + 720, tx: '0xb0b1' as Hex })]
    await expect(
      latestAnchoredHeight([rpc('a', alone), rpc('b', shared)], { contractAddress: CONTRACT, publishers }),
    ).resolves.toEqual({ status: 'found', height: HEIGHT, timestamp: NOW - 3_600, publishers: [ALICE] })
  })

  it('names every listed publisher cross-checked at that height, and its newest block time', async () => {
    // What a display shows beside the height: who anchored it and when. The
    // older anchor of the pair sets neither — the answer is about the height
    // found, not the window.
    const logs = [
      anchored(ALICE, { height: HEIGHT, timestamp: NOW - 7_200 }),
      anchored(ALICE, { height: HEIGHT + 720, timestamp: NOW - 3_000, tx: '0xaaa1' as Hex }),
      anchored(BOB, { height: HEIGHT + 720, timestamp: NOW - 600, tx: '0xb0b1' as Hex }),
    ]
    await expect(
      latestAnchoredHeight([rpc('a', logs), rpc('b', logs)], { contractAddress: CONTRACT, publishers }),
    ).resolves.toEqual({ status: 'found', height: HEIGHT + 720, timestamp: NOW - 600, publishers: [ALICE, BOB] })
  })

  it('reports none when the window holds nothing listed', async () => {
    const result = await latestAnchoredHeight([rpc('a', []), rpc('b', [])], {
      contractAddress: CONTRACT,
      publishers,
    })
    expect(result).toEqual({ status: 'none', lookbackBlocks: DEFAULT_READER_LOOKBACK_BLOCKS })
  })

  it('reports not-checked with no publisher list, rather than checking nothing', async () => {
    await expect(
      latestAnchoredHeight([rpc('a', []), rpc('b', [])], { contractAddress: CONTRACT }),
    ).resolves.toEqual({ status: 'not-checked', reason: 'NO_PUBLISHERS' })
  })

  it('reports unavailable when fewer than two endpoints answer', async () => {
    const result = await latestAnchoredHeight(
      [rpc('a', [anchored(ALICE)]), rpc('b', new Error('gateway timeout'))],
      { contractAddress: CONTRACT, publishers },
    )
    expect(result.status).toBe('unavailable')
  })

  it('refuses a single endpoint — one is not a cross-check', async () => {
    await expect(
      latestAnchoredHeight([rpc('a', [])], { contractAddress: CONTRACT, publishers }),
    ).rejects.toThrow(ReaderError)
  })
})

describe('createAnchorReadRpc', () => {
  it('speaks plain JSON-RPC and maps the log shape', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url: String(input), body })
      if (body['method'] === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body['id'], result: '0xf4240' })
      return Response.json({
        jsonrpc: '2.0',
        id: body['id'],
        result: [
          {
            address: CONTRACT.toUpperCase(),
            topics: [ANCHORED_TOPIC0, COMMITMENT, addressTopic(ALICE)],
            data: `0x${'00'.repeat(96)}`,
            blockNumber: '0x1f4',
            transactionHash: '0xfeed',
          },
        ],
      })
    }) as typeof fetch

    const endpoint = createAnchorReadRpc('http://rpc.example', fakeFetch)
    expect(await endpoint.blockNumber()).toBe(1_000_000n)
    const logs = await endpoint.getLogs({
      address: CONTRACT,
      topics: [ANCHORED_TOPIC0 as Hex],
      fromBlock: 100n,
      toBlock: 'latest',
    })
    expect(logs).toEqual([
      {
        address: CONTRACT,
        topics: [ANCHORED_TOPIC0, COMMITMENT, addressTopic(ALICE)],
        data: `0x${'00'.repeat(96)}`,
        blockNumber: 500n,
        transactionHash: '0xfeed',
      },
    ])
    expect(requests[1]!.body['params']).toEqual([
      { address: CONTRACT, topics: [ANCHORED_TOPIC0], fromBlock: '0x64', toBlock: 'latest' },
    ])
  })

  it('surfaces HTTP and RPC errors with the endpoint named', async () => {
    const http500 = createAnchorReadRpc('http://bad.example', (async () =>
      new Response('oops', { status: 500 })) as typeof fetch)
    await expect(http500.blockNumber()).rejects.toThrow(/bad.example.*500/)

    const rpcError = createAnchorReadRpc('http://err.example', (async () =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'query too wide' } })) as typeof fetch)
    await expect(rpcError.blockNumber()).rejects.toThrow(/query too wide/)
  })
})
