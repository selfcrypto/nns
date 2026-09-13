import { ANCHORED_TOPIC0 } from '@nimiqnames/anchor'
import type { AnchorReadRpc } from '@nimiqnames/anchor/reader'
import { CONSTANTS } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { DEFAULT_RESOLVERS } from './defaults.js'
import { AnchorError, ConfigurationError } from './errors.js'
import { NnsResolver, type ResolverOptions } from './resolve.js'
import { CHECKPOINT_HEIGHT, availableJson, checkpointJson, commitmentOf, record, resolveJson } from './test-fixtures.js'
import type { HttpFetch, ResolverEndpoint } from './transport.js'

// ── A chain made of functions ───────────────────────────────────────────────

const PUBLISHER_A = '0x1111111111111111111111111111111111111111'
const PUBLISHER_B = '0x2222222222222222222222222222222222222222'
const OUTSIDER = '0x9999999999999999999999999999999999999999'
const CONTRACT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const LOG_DIGEST = `0x${'ab'.repeat(32)}`

const NOW = 1_780_000_000

interface Anchored {
  readonly publisher: string
  readonly commitment: string
  readonly height?: number
  readonly logDigest?: string
  /** Seconds before {@link NOW}. Default: fresh. */
  readonly ageSeconds?: number
}

const word = (value: number | bigint): string => value.toString(16).padStart(64, '0')

/** One `Anchored` event, in the shape `decodeAnchored` reads. */
const logFor = (anchor: Anchored, index: number) => ({
  address: CONTRACT as `0x${string}`,
  topics: [ANCHORED_TOPIC0, anchor.commitment, `0x${'0'.repeat(24)}${anchor.publisher.slice(2)}`] as `0x${string}`[],
  data: `0x${word(anchor.height ?? CHECKPOINT_HEIGHT)}${word(NOW - (anchor.ageSeconds ?? 60))}${(
    anchor.logDigest ?? LOG_DIGEST
  ).slice(2)}` as `0x${string}`,
  blockNumber: 1_000n + BigInt(index),
  transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}` as `0x${string}`,
})

/** An endpoint that reports `anchors`. `calls` counts what the resolver actually spent. */
function fakeRpc(label: string, anchors: readonly Anchored[]): AnchorReadRpc & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    label,
    calls,
    async blockNumber() {
      calls.push('blockNumber')
      return 2_000n
    },
    async getLogs() {
      calls.push('getLogs')
      return anchors.map(logFor)
    },
  }
}

const failingRpc = (label: string): AnchorReadRpc => ({
  label,
  async blockNumber() {
    throw new Error('endpoint down')
  },
  async getLogs() {
    throw new Error('endpoint down')
  },
})

// ── A network made of functions ─────────────────────────────────────────────

type Reply = { readonly status: number; readonly body: unknown } | 'unreachable'

const RECORDS = [record('alpha'), record('kikeee'), record('zulued')]
const OTHER_RECORDS = [...RECORDS, record('mikeee')]

const A: ResolverEndpoint = { name: 'reference', url: 'https://a.example' }
const B: ResolverEndpoint = { name: 'community', url: 'https://b.example' }

/** Both resolvers serve the same answer, and `/checkpoints/{h}` from `checkpoint`. */
function network(options: { readonly proof?: boolean; readonly checkpoint?: Reply } = {}) {
  const paths: string[] = []
  const body = resolveJson(RECORDS, 'kikeee', options.proof === false ? { proof: false } : {})
  const fetchImpl: HttpFetch = async (url) => {
    const path = new URL(url).pathname
    paths.push(path)
    const reply: Reply = path.startsWith('/checkpoints/')
      ? (options.checkpoint ?? { status: 200, body: checkpointJson(RECORDS) })
      : path.startsWith('/available/')
        ? { status: 200, body: availableJson(RECORDS, 'freename') }
        : { status: 200, body }
    if (reply === 'unreachable') throw new Error('ECONNREFUSED')
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body }
  }
  return { fetchImpl, paths }
}

function resolverWith(
  net: ReturnType<typeof network>,
  anchors: ResolverOptions['anchors'],
  overrides: Partial<ResolverOptions> = {},
) {
  return new NnsResolver({
    resolvers: [A, B],
    fetch: net.fetchImpl,
    onWarning: () => {},
    ...(anchors === undefined ? {} : { anchors }),
    ...overrides,
  })
}

const policy = (rpcs: readonly AnchorReadRpc[], publishers: readonly string[]) => ({
  contract: CONTRACT,
  rpcs,
  publishers,
  now: () => NOW,
})

const GOOD = commitmentOf(RECORDS)

// ── What ships ──────────────────────────────────────────────────────────────

describe('the shipped default', () => {
  it('reports not-checked and costs nothing when no anchor policy is configured', async () => {
    const net = network()
    const result = await resolverWith(net, undefined).resolve('kikeee')

    expect(result.anchor).toMatchObject({ status: 'not-checked', reason: 'NOT_CONFIGURED', check: null })
    expect(result.warnings.map((w) => w.code)).toContain('ANCHOR_NOT_CHECKED')
    // No §8.1 binding was fetched: an unconfigured check must not cost a round trip.
    expect(net.paths.filter((p) => p.startsWith('/checkpoints/'))).toEqual([])
  })

  it('reports the reader’s own not-checked when ANCHOR_PUBLISHERS is empty', async () => {
    // The state of the world today: a contract and endpoints could be
    // configured, and there is still nobody listed to have anchored anything.
    const net = network()
    const rpcs = [fakeRpc('one', []), fakeRpc('two', [])]
    const result = await resolverWith(net, policy(rpcs, [])).resolve('kikeee')

    expect(result.anchor.status).toBe('not-checked')
    expect(result.anchor.check).toEqual({ status: 'not-checked', reason: 'NO_PUBLISHERS' })
    expect(result.warnings.map((w) => w.code)).toContain('ANCHOR_NOT_CHECKED')
    // Neither the chain nor the binding endpoint was touched.
    expect(rpcs[0]?.calls).toEqual([])
    expect(net.paths.filter((p) => p.startsWith('/checkpoints/'))).toEqual([])
  })

  it('still resolves, and the answer is unchanged by any of it', async () => {
    const net = network()
    const result = await resolverWith(net, undefined).resolve('kikeee')
    expect(result.verification).toBe('PROVEN')
  })
})

// ── The check, when it runs ─────────────────────────────────────────────────

describe('§8.5 #1 over a configured list', () => {
  it('verifies when listed publishers anchored the commitment this checkpoint binds', async () => {
    const net = network()
    const rpcs = [
      fakeRpc('one', [
        { publisher: PUBLISHER_A, commitment: GOOD },
        { publisher: PUBLISHER_B, commitment: GOOD },
      ]),
      fakeRpc('two', [
        { publisher: PUBLISHER_A, commitment: GOOD },
        { publisher: PUBLISHER_B, commitment: GOOD },
      ]),
    ]
    const result = await resolverWith(net, policy(rpcs, [PUBLISHER_A, PUBLISHER_B])).resolve('kikeee')

    expect(result.anchor.status).toBe('verified')
    // A check that passes says nothing: no anchor warning at all.
    expect(result.warnings.map((w) => w.code).filter((c) => c.startsWith('ANCHOR'))).toEqual([])
    expect(net.paths).toContain(`/checkpoints/${CHECKPOINT_HEIGHT}`)
  })

  it('ignores an unlisted publisher rather than counting it', async () => {
    const anchors = [
      { publisher: PUBLISHER_A, commitment: GOOD },
      { publisher: OUTSIDER, commitment: GOOD },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const result = await resolverWith(network(), policy(rpcs, [PUBLISHER_A, PUBLISHER_B])).resolve('kikeee')

    expect(result.anchor.status).toBe('quorum-not-met')
    expect(result.anchor.check).toMatchObject({ found: 1, required: 2 })
    expect(result.warnings.map((w) => w.code)).toContain('ANCHOR_QUORUM_NOT_MET')
  })

  it('warns rather than halts when the anchor is stale (§8.5 #8)', async () => {
    const anchors = [
      { publisher: PUBLISHER_A, commitment: GOOD, ageSeconds: 200_000 },
      { publisher: PUBLISHER_B, commitment: GOOD, ageSeconds: 200_000 },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const result = await resolverWith(network(), policy(rpcs, [PUBLISHER_A, PUBLISHER_B])).resolve('kikeee')

    expect(result.anchor.status).toBe('verified')
    expect(result.warnings.map((w) => w.code)).toContain('ANCHOR_STALE')
    expect(result.address).toBeDefined()
  })

  it('treats one endpoint being down as “couldn’t check”, never as agreement', async () => {
    const rpcs = [
      fakeRpc('one', [
        { publisher: PUBLISHER_A, commitment: GOOD },
        { publisher: PUBLISHER_B, commitment: GOOD },
      ]),
      failingRpc('two'),
    ]
    const result = await resolverWith(network(), policy(rpcs, [PUBLISHER_A, PUBLISHER_B])).resolve('kikeee')

    expect(result.anchor.status).toBe('unavailable')
    expect(result.warnings.map((w) => w.code)).toContain('ANCHOR_UNAVAILABLE')
  })

  it('has nothing to ask about when no proof was served', async () => {
    const rpcs = [fakeRpc('one', []), fakeRpc('two', [])]
    const net = network({ proof: false })
    const result = await resolverWith(net, policy(rpcs, [PUBLISHER_A, PUBLISHER_B])).resolve('kikeee')

    expect(result.anchor).toMatchObject({ status: 'not-checked', reason: 'NO_CHECKPOINT' })
    expect(net.paths.filter((p) => p.startsWith('/checkpoints/'))).toEqual([])
  })

  it('degrades to not-checked when the serving resolver cannot supply the binding', async () => {
    const anchors = [
      { publisher: PUBLISHER_A, commitment: GOOD },
      { publisher: PUBLISHER_B, commitment: GOOD },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const net = network({ checkpoint: { status: 410, body: { error: 'CHECKPOINT_NOT_RETAINED' } } })
    const result = await resolverWith(net, policy(rpcs, [PUBLISHER_A, PUBLISHER_B])).resolve('kikeee')

    // The resolution stands — it agreed and its proof verified. Only the
    // anchor tier could not run, and it says which party and why.
    expect(result.verification).toBe('PROVEN')
    expect(result.anchor).toMatchObject({ status: 'not-checked', reason: 'BINDING_UNAVAILABLE' })
    expect(result.anchor.detail).toContain('reference')
  })
})

// ── The hard stops ──────────────────────────────────────────────────────────

describe('halting', () => {
  it('halts when publishers anchored a different commitment than the resolver serves', async () => {
    // The whole point of the tier: this resolver's state is not the state that
    // was anchored. Its proof verifies against its own root regardless.
    const other = commitmentOf(OTHER_RECORDS)
    const anchors = [
      { publisher: PUBLISHER_A, commitment: other },
      { publisher: PUBLISHER_B, commitment: other },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const error = await resolverWith(network(), policy(rpcs, [PUBLISHER_A, PUBLISHER_B]))
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).code).toBe('ANCHOR_MISMATCH')
    expect((error as AnchorError).check).toMatchObject({ status: 'verified' })
  })

  it('halts on a mismatch even below quorum — one listed publisher contradicting is not “wait”', async () => {
    const anchors = [{ publisher: PUBLISHER_A, commitment: commitmentOf(OTHER_RECORDS) }]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const error = await resolverWith(network(), policy(rpcs, [PUBLISHER_A, PUBLISHER_B]))
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).code).toBe('ANCHOR_MISMATCH')
    expect((error as AnchorError).message).toContain('below quorum')
  })

  it('halts when listed publishers contradict each other (§8.5 #7)', async () => {
    const anchors = [
      { publisher: PUBLISHER_A, commitment: GOOD },
      { publisher: PUBLISHER_B, commitment: commitmentOf(OTHER_RECORDS) },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const error = await resolverWith(network(), policy(rpcs, [PUBLISHER_A, PUBLISHER_B]))
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).code).toBe('ANCHOR_DIVERGENCE')
  })

  it('halts when a checkpoint document’s commitment is not §8.1 over its own components', async () => {
    // The attack the recomputation exists to stop: pair a genuinely anchored
    // commitment with a forged nameRoot. Every other check still passes —
    // the proof verifies, the quorum agrees, the anchor matches — and the
    // address the user is about to pay is whatever this party chose.
    const stolen = commitmentOf(OTHER_RECORDS)
    const anchors = [
      { publisher: PUBLISHER_A, commitment: stolen },
      { publisher: PUBLISHER_B, commitment: stolen },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    const net = network({ checkpoint: { status: 200, body: checkpointJson(RECORDS, { overrides: { commitment: stolen } }) } })

    const error = await resolverWith(net, policy(rpcs, [PUBLISHER_A, PUBLISHER_B]))
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).code).toBe('CHECKPOINT_BINDING_INVALID')
  })

  it('halts when the served checkpoint is not the one the proof verified against', async () => {
    const anchors = [
      { publisher: PUBLISHER_A, commitment: commitmentOf(OTHER_RECORDS) },
      { publisher: PUBLISHER_B, commitment: commitmentOf(OTHER_RECORDS) },
    ]
    const rpcs = [fakeRpc('one', anchors), fakeRpc('two', anchors)]
    // A well-formed checkpoint over a *different* name set: internally
    // consistent, and not the tree the proof recombined to.
    const net = network({ checkpoint: { status: 200, body: checkpointJson(OTHER_RECORDS) } })

    const error = await resolverWith(net, policy(rpcs, [PUBLISHER_A, PUBLISHER_B]))
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).code).toBe('CHECKPOINT_BINDING_INVALID')
  })
})

// ── Refusals at construction ────────────────────────────────────────────────

describe('configuration', () => {
  const net = network()
  const build = (anchors: ResolverOptions['anchors']) => () => resolverWith(net, anchors)

  it('refuses a single anchor endpoint — one endpoint is not a cross-check (§9)', () => {
    expect(build(policy([fakeRpc('one', [])], [PUBLISHER_A]))).toThrow(ConfigurationError)
  })

  it('refuses a contract address that is not 20 bytes', () => {
    expect(build({ ...policy([fakeRpc('one', []), fakeRpc('two', [])], []), contract: '0xdead' })).toThrow(
      ConfigurationError,
    )
  })

  it('refuses a malformed publisher, which would silently lower the quorum', () => {
    expect(build(policy([fakeRpc('one', []), fakeRpc('two', [])], ['0xnope']))).toThrow(ConfigurationError)
  })

  it('refuses an anchor quorum larger than the list that has to meet it', () => {
    expect(build({ ...policy([fakeRpc('one', []), fakeRpc('two', [])], [PUBLISHER_A]), quorum: 2 })).toThrow(
      ConfigurationError,
    )
  })

  it('constructs with no resolvers at all: the shipped default meets RESOLVER_QUORUM', () => {
    // The list is two entries since 2026-09-13, so the zero-configuration
    // construction is the one that enforces the spec's quorum rather than the
    // one that cannot be built. If this ever fails, `DEFAULT_RESOLVERS` went
    // back below `RESOLVER_QUORUM` and every consumer who omits `resolvers`
    // is broken.
    expect(DEFAULT_RESOLVERS.length).toBeGreaterThanOrEqual(CONSTANTS.RESOLVER_QUORUM)
    expect(() => new NnsResolver({ fetch: net.fetchImpl })).not.toThrow()
  })

  it('refuses an explicitly empty list, naming the way back to the default', () => {
    expect(() => new NnsResolver({ resolvers: [], fetch: net.fetchImpl })).toThrow(/omit `resolvers`/)
  })
})

// ── available() takes the same tier ─────────────────────────────────────────

describe('available()', () => {
  it('carries the anchor report too', async () => {
    const net = network()
    const result = await resolverWith(net, undefined).available('freename')
    expect(result.anchor.status).toBe('not-checked')
  })
})
