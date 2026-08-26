/**
 * The anchor-sourced bootstrap input.
 *
 * Everything here is about what happens *before* a byte is replayed: which
 * height gets asked about, whether the §9 check passed, and where the snapshot
 * is fetched from. Whether the bytes are any good is `bootstrap.ts`'s question
 * and is answered by one comparison — see this module's own note on why the
 * CID cannot answer it.
 */

import { cidFromDigest, CONSTANTS, encodeRegister, feeFor, initialState, logFile, logHash } from '@nns/core'
import { ANCHORED_TOPIC0 } from '@nns/anchor'
import { addressTopic } from '@nns/anchor/publisher'
import type { AnchorReadRpc } from '@nns/anchor/reader'
import { describe, expect, it } from 'vitest'

import { anchoredSource, AnchorSourceError, gatewayUrl } from './anchored.js'
import type { Fetcher } from './peer.js'
import { collectingLogger, LAUNCH_HEIGHT, SELLER, send, stageLog, testConfig } from './test-fixtures.js'

const CONFIG = testConfig()
const CONTRACT = '0x0102030405060708090a0b0c0d0e0f1011121314'
const ALICE = '0x00000000000000000000000000000000000a11ce'
const BOB = '0x0000000000000000000000000000000000000b0b'
const HEIGHT = LAUNCH_HEIGHT + 720
const COMMITMENT = `0x${'ab'.repeat(32)}`
/** Any 32 bytes: this is the CID's multihash digest, not the §8.2 log hash. */
const DIGEST_BYTES = new Uint8Array(32).fill(0xcd)
const DIGEST = `0x${'cd'.repeat(32)}`
/**
 * What `core.cidFromDigest` mints from DIGEST. Derived rather than pinned: the
 * CID algorithm is `core`'s and its own tests hold it, and what this file has
 * to show is that the URL is built from the **anchored** digest and not from
 * anything a caller supplied.
 */
const CID = cidFromDigest(DIGEST_BYTES)

const staged = stageLog(
  [
    send(
      LAUNCH_HEIGHT + 10,
      0,
      SELLER,
      encodeRegister({ name: 'alicename', fee: feeFor('alicename', initialState().prices) }),
    ),
  ],
  CONFIG,
)

function anchoredLog(publisher: string, options: { height?: number; root?: string; timestamp?: number } = {}) {
  const height = options.height ?? HEIGHT
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000) - 3_600
  return {
    address: CONTRACT as `0x${string}`,
    topics: [ANCHORED_TOPIC0, (options.root ?? COMMITMENT) as `0x${string}`, addressTopic(publisher as `0x${string}`)],
    data: `0x${height.toString(16).padStart(64, '0')}${timestamp.toString(16).padStart(64, '0')}${DIGEST.slice(2)}` as `0x${string}`,
    blockNumber: 500n,
    transactionHash: `0x${publisher.slice(-4)}feed` as `0x${string}`,
  }
}

const rpc = (label: string, logs: readonly ReturnType<typeof anchoredLog>[]): AnchorReadRpc => ({
  label,
  blockNumber: async () => 1_000_000n,
  getLogs: async () => logs,
})

/** A gateway that serves the staged log at any URL, and records what was asked. */
function gateway(options: { bytes?: Uint8Array; status?: number } = {}): Fetcher & { asked: string[] } {
  const asked: string[] = []
  const bytes = options.bytes ?? logFile(staged.lines)
  const fetch_: Fetcher = (url: string) => {
    asked.push(url)
    const status = options.status ?? 200
    return Promise.resolve({
      ok: status < 400,
      status,
      headers: { get: () => null },
      arrayBuffer: () =>
        Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
      text: () => Promise.resolve('not found'),
    })
  }
  return Object.assign(fetch_, { asked })
}

const source = (
  logs: readonly ReturnType<typeof anchoredLog>[],
  overrides: Partial<Parameters<typeof anchoredSource>[0]> = {},
) => {
  const { logger } = collectingLogger()
  return anchoredSource({
    rpcs: [rpc('a', logs), rpc('b', logs)],
    contractAddress: CONTRACT,
    publishers: [ALICE, BOB],
    gateway: 'https://gw.example.com',
    fetcher: gateway(),
    logger,
    ...overrides,
  })
}

describe('gatewayUrl', () => {
  it('appends the path form every public gateway serves', () => {
    expect(gatewayUrl('https://gw.example.com', 'bafyabc')).toBe('https://gw.example.com/ipfs/bafyabc')
    expect(gatewayUrl('https://gw.example.com/', 'bafyabc')).toBe('https://gw.example.com/ipfs/bafyabc')
  })

  it('substitutes {cid} where the operator put it — subdomain gateways need that', () => {
    expect(gatewayUrl('https://{cid}.ipfs.dweb.link', 'bafyabc')).toBe('https://bafyabc.ipfs.dweb.link')
  })
})

describe('anchoredSource', () => {
  it('takes the newest verified anchor and fetches its CID', async () => {
    const fetcher = gateway()
    const result = await source([anchoredLog(ALICE), anchoredLog(BOB)], { fetcher })
    expect(result.height).toBe(HEIGHT)
    expect(result.commitment).toBe('ab'.repeat(32))
    expect(result.evidence).toBe('anchor')
    // The CID is rebuilt from the anchored digest, never taken from a caller.
    expect(fetcher.asked).toEqual([`https://gw.example.com/ipfs/${CID}`])
    expect(result.lines).toEqual(staged.lines)
  })

  it('carries no components — an Anchored event has the root and nothing else', async () => {
    const result = await source([anchoredLog(ALICE), anchoredLog(BOB)])
    expect(result.components).toBeNull()
  })

  it('refuses when quorum is not met, and says which way to fix it', async () => {
    await expect(source([anchoredLog(ALICE)])).rejects.toThrow(AnchorSourceError)
    await expect(source([anchoredLog(ALICE)])).rejects.toThrow(/only 1 of the required 2 listed publishers/)
  })

  it('accepts a deliberately lowered quorum, and warns rather than hides it', async () => {
    const { logger, lines } = collectingLogger()
    const result = await anchoredSource({
      rpcs: [rpc('a', [anchoredLog(ALICE)]), rpc('b', [anchoredLog(ALICE)])],
      contractAddress: CONTRACT,
      publishers: [ALICE, BOB],
      quorum: 1,
      gateway: 'https://gw.example.com',
      fetcher: gateway(),
      logger,
    })
    expect(result.height).toBe(HEIGHT)
    const warning = lines.find((line) => line['msg'] === 'anchor.quorum-below-spec')
    expect(warning).toMatchObject({ quorum: 1, spec: CONSTANTS.ANCHOR_QUORUM })
  })

  it('refuses a publisher disagreement outright — that is the §8.5 #7 signal', async () => {
    const conflicting = [anchoredLog(ALICE), anchoredLog(BOB, { root: `0x${'ee'.repeat(32)}` })]
    await expect(source(conflicting)).rejects.toThrow(/publishers disagree/)
    await expect(source(conflicting)).rejects.toThrow(/do not bootstrap from anywhere/)
  })

  it('refuses when no publisher is listed — an empty list is no check, not a lenient one', async () => {
    await expect(source([anchoredLog(ALICE)], { publishers: [] })).rejects.toThrow(
      /NNS_SNAPSHOT_ANCHOR_PUBLISHERS/,
    )
  })

  it('refuses when nothing has been anchored in the window', async () => {
    await expect(source([])).rejects.toThrow(/no listed publisher has anchored anything/)
  })

  it('refuses when fewer than two endpoints answer', async () => {
    const { logger } = collectingLogger()
    const broken: AnchorReadRpc = {
      label: 'b',
      blockNumber: async () => {
        throw new Error('gateway timeout')
      },
      getLogs: async () => [],
    }
    await expect(
      anchoredSource({
        rpcs: [rpc('a', [anchoredLog(ALICE), anchoredLog(BOB)]), broken],
        contractAddress: CONTRACT,
        publishers: [ALICE, BOB],
        gateway: 'https://gw.example.com',
        fetcher: gateway(),
        logger,
      }),
    ).rejects.toThrow(/§9 cross-check could not run/)
  })

  it('names the gateway when it does not serve the CID', async () => {
    await expect(
      source([anchoredLog(ALICE), anchoredLog(BOB)], { fetcher: gateway({ status: 404 }) }),
    ).rejects.toThrow(/returned 404/)
  })

  it('refuses bytes that are not a canonical §8.2 file', async () => {
    const truncated = logFile(staged.lines).slice(0, -1)
    await expect(
      source([anchoredLog(ALICE), anchoredLog(BOB)], { fetcher: gateway({ bytes: truncated }) }),
    ).rejects.toThrow(/does not end with a newline/)
  })

  it('does not check the bytes against the anchored digest — the CID is a locator', async () => {
    // A gateway serving a *different* well-formed log gets past this module
    // entirely, and must: `logDigest` is the CID's sha2-256 multihash, not the
    // §8.2 keccak hash, so rebuilding it here would mean a second UnixFS
    // implementation. `bootstrap.ts`'s commitment comparison is the check, and
    // it covers every byte through the log hash inside that commitment.
    const other = logFile([...staged.lines, ...staged.lines])
    const result = await source([anchoredLog(ALICE), anchoredLog(BOB)], { fetcher: gateway({ bytes: other }) })
    expect(result.lines).toHaveLength(staged.lines.length * 2)
    expect(result.commitment).toBe('ab'.repeat(32))
    void logHash
  })
})
