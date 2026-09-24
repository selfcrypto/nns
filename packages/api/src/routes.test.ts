/**
 * Route behaviour over a stubbed `Queries` — status codes, error reasons and
 * serialisation, with no Postgres anywhere. The SQL behind the interface has
 * its own gated test in `queries.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CONSTANTS,
  formatAddress,
  leafHash,
  logFile,
  merkleRoot,
  parseAddress,
  verifyProof,
  type NameRecord,
  type NameStatus,
  type ProofStep,
} from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import {
  NotSyncedError,
  type ApiNameRecord,
  type CheckpointLookup,
  type LatestCheckpoint,
  type NameDetail,
  type ProofBase,
  type Queries,
  type Snapshot,
} from './queries.js'
import { ROUTES, createRoutes, type RouteHandler } from './routes.js'

const A = parseAddress('NQ34 248H 248H 248H 248H 248H 248H 248H 248H')
const B = parseAddress('NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2')
const C = parseAddress('NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK')

const HEIGHT = 58_200_000

const snap = <T>(value: T): Snapshot<T> => ({ height: HEIGHT, value })

const RECORD = {
  name: 'alice-example',
  owner: A,
  target: B,
  expiry: 215_880_000,
  status: 'REGISTERED' as const,
  evm: '',
  host: '',
}

const EMPTY_DETAIL: NameDetail = {
  record: null,
  transfer: null,
  offer: null,
  auction: null,
  unreserved: false,
}

const OFFER = { name: 'alice-example', seller: A, price: 50_000_000n, openedHeight: 58_190_000, expiryHeight: 59_486_000 }

/** A standing bid of 525 NIM: the next must add 5% of it — 551.25 NIM (§6 `A`). */
const AUCTION = {
  name: 'carol-example',
  seller: B,
  startingPrice: 50_000_000n,
  endHeight: 58_276_400,
  bidder: A,
  bid: 52_500_000n,
  bidRef: { height: 58_190_100, txIndex: 0 },
}

const AUCTION_WIRE = {
  name: 'carol-example',
  seller: formatAddress(B),
  startingPrice: '50000000',
  endHeight: 58_276_400,
  bidder: formatAddress(A),
  bid: '52500000',
  bidRef: { height: 58_190_100, txIndex: 0 },
  minimumBid: '55125000',
}

const PARAMS = {
  feeBase: 40_000_000n,
  commissionBp: 250n,
  lastGovernanceHeight: null,
  pending: null,
  // The ordinary answer: replayed from LAUNCH_HEIGHT, nothing downloaded.
  verification: { verifiedFrom: CONSTANTS.LAUNCH_HEIGHT, bootstrap: null, rebuilt: null },
}

/** Every method rejects unless the test stubs it, so a route that reaches for
 * the wrong query fails loudly instead of passing on a default — except
 * `proofBase`, which every successful resolve/available touches: it defaults
 * to "no checkpoint yet", the state every route must serve through. */
function queriesOf(partial: Partial<Queries>): Queries {
  const unstubbed = () => Promise.reject(new Error('query not stubbed'))
  return {
    record: unstubbed,
    detail: unstubbed,
    byOwner: unstubbed,
    offers: unstubbed,
    auctions: unstubbed,
    params: unstubbed,
    latestCheckpoint: unstubbed,
    checkpointAt: unstubbed,
    proofBase: () => Promise.resolve(snap(null)),
    logThroughCheckpoint: unstubbed,
    outstanding: unstubbed,
    burn: unstubbed,
    referrals: unstubbed,
    stats: unstubbed,
    ...partial,
  }
}

function routes(partial: Partial<Queries>): RouteHandler {
  // No options: `RESERVED_NAMES` and the `O` listing fee are `CONSTANTS` since
  // the launch freeze, so this service has nothing left to be configured with.
  // `nimiq` below is on the real published list, not a fixture entry.
  return createRoutes(queriesOf(partial))
}

describe('routing', () => {
  it('answers 404 for an unknown route and 405 for a write method', async () => {
    const handle = routes({})
    // The 404 body carries the route table and the spec's path — see the
    // `discovery` suite. Asserted by status and error here so that adding a
    // route does not fail this test for the wrong reason.
    for (const url of ['/nope', '/resolve/a/b']) {
      const response = await handle('GET', url)
      expect(response.status).toBe(404)
      expect((response.body as { error: string }).error).toBe('UNKNOWN_ROUTE')
    }
    expect((await handle('POST', '/params')).status).toBe(405)
    expect((await handle('DELETE', '/name/alice-example')).status).toBe(405)
  })

  it('treats HEAD like GET and ignores query strings', async () => {
    const handle = routes({ record: () => Promise.resolve(snap(RECORD)) })
    const response = await handle('HEAD', '/resolve/alice-example?x=1')
    expect(response.status).toBe(200)
  })

  it('maps NotSyncedError to 503 on every state route', async () => {
    const notSynced = () => Promise.reject(new NotSyncedError('the indexer has not written state yet'))
    const handle = routes({ record: notSynced, detail: notSynced, byOwner: notSynced, offers: notSynced, auctions: notSynced, params: notSynced })
    for (const url of ['/resolve/alice-example', '/available/alice-example', '/name/alice-example', `/address/${encodeURIComponent(formatAddress(A))}/names`, '/offers', '/auctions', '/params']) {
      const response = await handle('GET', url)
      expect(response.status, url).toBe(503)
      expect((response.body as { error: string }).error).toBe('NOT_SYNCED')
    }
  })

  it('rethrows unexpected errors for the server to turn into a 500', async () => {
    const handle = routes({ record: () => Promise.reject(new Error('boom')) })
    await expect(handle('GET', '/resolve/alice-example')).rejects.toThrow('boom')
  })
})

describe('/resolve', () => {
  it('resolves a REGISTERED name, addresses in display form', async () => {
    const handle = routes({ record: () => Promise.resolve(snap({ ...RECORD, host: 'r.example.com' })) })
    expect(await handle('GET', '/resolve/alice-example')).toEqual({
      status: 200,
      body: {
        name: 'alice-example',
        target: 'NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2',
        status: 'REGISTERED',
        evm: '',
        expiry: 215_880_000,
        host: 'r.example.com',
        proof: null,
        height: HEIGHT,
      },
    })
  })

  it('distinguishes NOT_FOUND from IN_GRACE — §7.3 turns resolution off during grace', async () => {
    const missing = routes({ record: () => Promise.resolve(snap(null)) })
    expect(await missing('GET', '/resolve/alice-example')).toEqual({
      status: 404,
      body: { error: 'NOT_FOUND', name: 'alice-example', height: HEIGHT },
    })

    const grace = routes({ record: () => Promise.resolve(snap({ ...RECORD, status: 'GRACE' as const })) })
    expect(await grace('GET', '/resolve/alice-example')).toEqual({
      status: 404,
      body: { error: 'IN_GRACE', name: 'alice-example', expiry: RECORD.expiry, height: HEIGHT },
    })
  })

  it('rejects invalid names with the §4.1 reason, never touching the database', async () => {
    const handle = routes({})
    expect(await handle('GET', '/resolve/ab-')).toEqual({
      status: 400,
      body: { error: 'INVALID_NAME', reason: 'BAD_NAME', detail: 'TOO_SHORT' },
    })
    expect((await handle('GET', '/resolve/Alice-Example')).status).toBe(400)
  })

  it('resolves a reserved name — a `U` award registers it like any other', async () => {
    const handle = routes({ record: () => Promise.resolve(snap({ ...RECORD, name: 'nimiq' })) })
    expect((await handle('GET', '/resolve/nimiq')).status).toBe(200)
  })

  it('resolves an awarded short name — reserved by rule, registered like any other (r18)', async () => {
    const handle = routes({ record: () => Promise.resolve(snap({ ...RECORD, name: 'abcd' })) })
    expect((await handle('GET', '/resolve/abcd')).status).toBe(200)

    // Unawarded, it simply has no record — 404, not INVALID_NAME.
    const missing = routes({ record: () => Promise.resolve(snap(null)) })
    expect((await missing('GET', '/resolve/abcd')).status).toBe(404)
  })

  it('refuses dotted queries and points at the parent (§8.6 is client-side)', async () => {
    const handle = routes({})
    const response = await handle('GET', '/resolve/pay.alice-example')
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'DOTTED_QUERY', parent: 'alice-example' })
  })
})

describe('/available', () => {
  it('is available when valid, unreserved and unregistered', async () => {
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    expect(await handle('GET', '/available/alice-example')).toEqual({
      status: 200,
      body: { name: 'alice-example', available: true, proof: null, height: HEIGHT },
    })
  })

  it('answers 200 with the §4.1 reason for an invalid name', async () => {
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    expect(await handle('GET', '/available/ab-')).toEqual({
      status: 200,
      body: { name: 'ab-', available: false, reason: 'TOO_SHORT', height: HEIGHT },
    })
  })

  it('holds a short name as RESERVED while unreleased, and available once a U has fired (r18)', async () => {
    const held = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    expect(await held('GET', '/available/abcd')).toEqual({
      status: 200,
      body: { name: 'abcd', available: false, reason: 'RESERVED', height: HEIGHT },
    })

    const released = routes({ detail: () => Promise.resolve(snap({ ...EMPTY_DETAIL, unreserved: true })) })
    expect(await released('GET', '/available/abcd')).toEqual({
      status: 200,
      body: { name: 'abcd', available: true, proof: null, height: HEIGHT },
    })
  })

  it('reports TAKEN with the record status', async () => {
    const handle = routes({ detail: () => Promise.resolve(snap({ ...EMPTY_DETAIL, record: { ...RECORD, status: 'GRACE' as const } })) })
    expect(await handle('GET', '/available/alice-example')).toEqual({
      status: 200,
      body: { name: 'alice-example', available: false, reason: 'TAKEN', status: 'GRACE', expiry: RECORD.expiry, height: HEIGHT },
    })
  })

  it('reports RESERVED until the release fires, then available', async () => {
    const withheld = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    expect(await withheld('GET', '/available/nimiq')).toEqual({
      status: 200,
      body: { name: 'nimiq', available: false, reason: 'RESERVED', height: HEIGHT },
    })

    const released = routes({ detail: () => Promise.resolve(snap({ ...EMPTY_DETAIL, unreserved: true })) })
    expect(await released('GET', '/available/nimiq')).toEqual({
      status: 200,
      body: { name: 'nimiq', available: true, proof: null, height: HEIGHT },
    })
  })
})

describe('/name', () => {
  it('404s when the state knows nothing about the name', async () => {
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    expect(await handle('GET', '/name/alice-example')).toEqual({
      status: 404,
      body: { error: 'NOT_FOUND', name: 'alice-example', height: HEIGHT },
    })
  })

  it('400s an invalid name with its reason', async () => {
    const handle = routes({})
    expect(await handle('GET', '/name/-alice')).toEqual({
      status: 400,
      body: { error: 'INVALID_NAME', reason: 'LEADING_HYPHEN' },
    })
  })

  it('a reserved name with no state is still 200 — RESERVED is an answer', async () => {
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    const response = await handle('GET', '/name/nimiq')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ name: 'nimiq', reserved: true, unreserved: false, record: null })
  })

  it('serialises the record and every pending kind, luna as strings', async () => {
    const detail: NameDetail = {
      record: { ...RECORD, host: 'r.example.com' },
      transfer: { newOwner: B, effectiveHeight: 58_243_200 },
      offer: OFFER,
      auction: null,
      unreserved: false,
    }
    const handle = routes({ detail: () => Promise.resolve(snap(detail)) })
    expect(await handle('GET', '/name/alice-example')).toEqual({
      status: 200,
      body: {
        name: 'alice-example',
        reserved: false,
        unreserved: false,
        record: {
          name: 'alice-example',
          owner: formatAddress(A),
          target: formatAddress(B),
          expiry: 215_880_000,
          status: 'REGISTERED',
          evm: '',
          host: 'r.example.com',
        },
        pending: {
          transfer: { newOwner: formatAddress(B), effectiveHeight: 58_243_200 },
          offer: {
            name: 'alice-example',
            seller: formatAddress(A),
            price: '50000000',
            openedHeight: 58_190_000,
            expiryHeight: 59_486_000,
          },
          auction: null,
        },
        height: HEIGHT,
      },
    })
  })

  it('serialises an open auction with its standing bid, ref and the minimum next bid (§6 `A`, r28)', async () => {
    const detail: NameDetail = { ...EMPTY_DETAIL, record: { ...RECORD, name: 'carol-example', owner: B }, auction: AUCTION }
    const handle = routes({ detail: () => Promise.resolve(snap(detail)) })
    const response = await handle('GET', '/name/carol-example')
    expect(response.status).toBe(200)
    expect((response.body as { pending: { auction: unknown } }).pending.auction).toEqual(AUCTION_WIRE)
  })

  it('an auction with no bid yet asks for the starting price, and carries no bidder and no ref', async () => {
    const fresh = { ...AUCTION, bidder: null, bid: 0n, bidRef: null }
    const handle = routes({ detail: () => Promise.resolve(snap({ ...EMPTY_DETAIL, record: RECORD, auction: fresh })) })
    const body = (await handle('GET', '/name/carol-example')).body as { pending: { auction: Record<string, unknown> } }
    expect(body.pending.auction).toMatchObject({ bidder: null, bid: '0', bidRef: null, minimumBid: '50000000' })
  })

  it('reports a fired `U` as `unreserved`, and offers no pending unreserve at all (r22)', async () => {
    // Through r21 this route answered `pending.unreserve` with a recipient —
    // null for a release, an address for an award. r22 removed the pending
    // form, and the key with it rather than pinning it to null: a null would
    // read as "no U is scheduled for this name", which is now true of every
    // name and therefore says nothing.
    const fired: NameDetail = { ...EMPTY_DETAIL, unreserved: true }
    const handle = routes({ detail: () => Promise.resolve(snap(fired)) })
    const response = await handle('GET', '/name/nimiq')
    expect(response.body).toMatchObject({ unreserved: true, reserved: false })
    expect(Object.keys((response.body as { pending: object }).pending)).toEqual(['transfer', 'offer', 'auction'])
  })
})

describe('/address/{addr}/names', () => {
  it('rejects a malformed address', async () => {
    const handle = routes({})
    expect(await handle('GET', '/address/NQ00 not an address/names')).toEqual({
      status: 400,
      body: { error: 'INVALID_ADDRESS' },
    })
  })

  it('accepts spaced or compact input and lists owned names', async () => {
    const handle = routes({ byOwner: (owner) => Promise.resolve(snap(owner === A ? [RECORD] : [])) })
    for (const input of [encodeURIComponent(formatAddress(A)), A as string]) {
      expect(await handle('GET', `/address/${input}/names`)).toEqual({
        status: 200,
        body: {
          address: formatAddress(A),
          names: [
            { name: 'alice-example', target: formatAddress(B), evm: '', expiry: 215_880_000, status: 'REGISTERED', host: '' },
          ],
          height: HEIGHT,
        },
      })
    }
  })
})

describe('/offers', () => {
  it('lists open offers with string prices', async () => {
    const handle = routes({ offers: () => Promise.resolve(snap([OFFER])) })
    expect(await handle('GET', '/offers')).toEqual({
      status: 200,
      body: {
        offers: [
          {
            name: 'alice-example',
            seller: formatAddress(A),
            price: '50000000',
            openedHeight: 58_190_000,
            expiryHeight: 59_486_000,
          },
        ],
        height: HEIGHT,
      },
    })
  })
})

describe('/auctions', () => {
  it('lists open auctions with string amounts and the minimum next bid from core', async () => {
    const handle = routes({ auctions: () => Promise.resolve(snap([AUCTION])) })
    expect(await handle('GET', '/auctions')).toEqual({
      status: 200,
      body: { auctions: [AUCTION_WIRE], height: HEIGHT },
    })
  })
})

describe('/params', () => {
  it('serves the active prices with minPrice = feeBase (§3 MIN_PRICE) and the §10.1 bands priced', async () => {
    const handle = routes({ params: () => Promise.resolve(snap(PARAMS)) })
    expect(await handle('GET', '/params')).toEqual({
      status: 200,
      body: {
        prices: { feeBase: '40000000', commissionBp: '250' },
        minPrice: '40000000',
        // 400 NIM × the frozen multipliers, and ten of each for a lifetime.
        fees: [
          { upTo: 2, times: '200', yearly: '8000000000', lifetime: '80000000000' },
          { upTo: 3, times: '100', yearly: '4000000000', lifetime: '40000000000' },
          { upTo: 4, times: '50', yearly: '2000000000', lifetime: '20000000000' },
          { upTo: 5, times: '25', yearly: '1000000000', lifetime: '10000000000' },
          { upTo: 6, times: '10', yearly: '400000000', lifetime: '4000000000' },
          { upTo: 11, times: '5', yearly: '200000000', lifetime: '2000000000' },
          { upTo: 24, times: '1', yearly: '40000000', lifetime: '400000000' },
        ],
        listingFee: '0',
        lastGovernanceHeight: null,
        pendingGovernance: null,
        verification: { verifiedFrom: CONSTANTS.LAUNCH_HEIGHT, bootstrap: null, rebuilt: null },
        height: HEIGHT,
      },
    })
  })

  it('discloses a bootstrap, and the sweep re-deriving it (§8.4, §8.5)', async () => {
    const seeded = {
      ...PARAMS,
      verification: {
        verifiedFrom: CONSTANTS.LAUNCH_HEIGHT + 720_000,
        bootstrap: {
          height: CONSTANTS.LAUNCH_HEIGHT + 719_940,
          source: 'https://peer.example.com',
          verifiedThrough: CONSTANTS.LAUNCH_HEIGHT + 100_000,
        },
        rebuilt: null,
      },
    }
    const handle = routes({ params: () => Promise.resolve(snap(seeded)) })
    const response = await handle('GET', '/params')
    expect(response.body).toMatchObject({ verification: seeded.verification })
  })

  it('surfaces a scheduled governance change', async () => {
    const pending = {
      ...PARAMS,
      lastGovernanceHeight: 58_150_000,
      pending: { feeBase: 80_000_000n, commissionBp: 300n, effectiveHeight: 58_243_200 },
    }
    const handle = routes({ params: () => Promise.resolve(snap(pending)) })
    const response = await handle('GET', '/params')
    expect(response.body).toMatchObject({
      lastGovernanceHeight: 58_150_000,
      pendingGovernance: {
        prices: { feeBase: '80000000', commissionBp: '300' },
        // The bands a client will pay once it bites, priced the same way.
        fees: expect.arrayContaining([
          { upTo: 2, times: '200', yearly: '16000000000', lifetime: '160000000000' },
          { upTo: 24, times: '1', yearly: '80000000', lifetime: '800000000' },
        ]),
        effectiveHeight: 58_243_200,
      },
    })
    expect((response.body as { pendingGovernance: { fees: unknown[] } }).pendingGovernance.fees).toHaveLength(7)
  })
})

// ── Proofs (§8.3) ───────────────────────────────────────────────────────────

const CHECKPOINT_HEIGHT = 58_198_320 // a multiple of 720

function treeOf(records: readonly ApiNameRecord[]): {
  base: ProofBase
  rootHex: string
  stub: Partial<Queries>
} {
  const map = new Map(records.map((record) => [record.name, record]))
  const rootHex = Buffer.from(merkleRoot({ names: map })).toString('hex')
  const checkpoint: LatestCheckpoint = {
    height: CHECKPOINT_HEIGHT,
    layout: 3,
    nameRoot: rootHex,
    pricesRoot: '11'.repeat(32),
    pendingRoot: '22'.repeat(32),
    unreservedRoot: '33'.repeat(32),
    logHash: '44'.repeat(32),
    commitment: '55'.repeat(32),
  }
  const base: ProofBase = { checkpoint, records: map }
  return { base, rootHex, stub: { proofBase: () => Promise.resolve(snap(base)) } }
}

/**
 * The package's promise, as code: rebuild the leaf from the
 * document's own fields and recombine it with the proof — **core only**, no
 * API code anywhere in the path. This is also why the document must carry
 * every §8.1 leaf field, `delegate` included: without them the preimage below
 * cannot be built.
 */
function verifiesWithCoreAlone(doc: Record<string, unknown>, rootHex0x: string): boolean {
  const record: NameRecord = {
    name: doc['name'] as string,
    owner: parseAddress(doc['owner'] as string),
    target: parseAddress(doc['target'] as string),
    evm: doc['evm'] as string,
    expiry: doc['expiry'] as number,
    status: doc['status'] as NameStatus,
    host: doc['delegate'] as string,
  }
  const steps: ProofStep[] = (doc['proof'] as { hash: string; side: 'left' | 'right' }[]).map((step) => ({
    hash: Buffer.from(step.hash.slice(2), 'hex'),
    side: step.side,
  }))
  return verifyProof(leafHash(record), steps, Buffer.from(rootHex0x.slice(2), 'hex'))
}

describe('/resolve proof (§8.3)', () => {
  const RECORDS: ApiNameRecord[] = [
    { ...RECORD, name: 'alice-example', host: 'r.example.com' },
    { ...RECORD, name: 'middle-name', owner: B, target: A },
    { ...RECORD, name: 'omega-name', status: 'GRACE' },
  ]

  it('serves a document that verifies against the checkpoint root using only core', async () => {
    const { rootHex, stub } = treeOf(RECORDS)
    const handle = routes({ record: () => Promise.resolve(snap(RECORDS[0]!)), ...stub })

    const response = await handle('GET', '/resolve/alice-example')
    expect(response.status).toBe(200)
    const doc = (response.body as { proof: Record<string, unknown> }).proof
    expect(doc).toMatchObject({
      name: 'alice-example',
      owner: formatAddress(A),
      target: formatAddress(B),
      delegate: 'r.example.com',
      root: `0x${rootHex}`,
      nimiq_height: CHECKPOINT_HEIGHT,
      anchor: null,
    })
    expect(typeof doc['leaf_index']).toBe('number')

    expect(verifiesWithCoreAlone(doc, doc['root'] as string)).toBe(true)

    // Tampering with any served field breaks verification — the proof binds
    // the fields, which is the entire point of rebuilding the leaf.
    expect(verifiesWithCoreAlone({ ...doc, owner: formatAddress(B) }, doc['root'] as string)).toBe(false)
    // A stripped leaf field must break verification too — `delegate` is the
    // witness for that rule now that r20 removed `recovery` (§8.3).
    expect(verifiesWithCoreAlone({ ...doc, delegate: '' }, doc['root'] as string)).toBe(false)
  })

  it('is null for a name the checkpoint tree does not hold yet (§8.7: depth pending, not an error)', async () => {
    const { stub } = treeOf([RECORDS[1]!, RECORDS[2]!])
    const handle = routes({ record: () => Promise.resolve(snap(RECORD)), ...stub })
    const response = await handle('GET', '/resolve/alice-example')
    expect(response.status).toBe(200)
    expect((response.body as { proof: unknown }).proof).toBeNull()
  })

  it('is null when the snapshot cannot back the checkpoint', async () => {
    const { base } = treeOf(RECORDS)
    const degraded: ProofBase = { checkpoint: base.checkpoint, records: null }
    const handle = routes({
      record: () => Promise.resolve(snap(RECORD)),
      proofBase: () => Promise.resolve(snap(degraded)),
    })
    expect(((await handle('GET', '/resolve/alice-example')).body as { proof: unknown }).proof).toBeNull()
  })
})

describe('/available non-inclusion proof (§8.3)', () => {
  const available = routes.bind(null)

  async function proofFor(name: string, records: readonly ApiNameRecord[]): Promise<Record<string, unknown>> {
    const { stub } = treeOf(records)
    const handle = available({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)), ...stub })
    const response = await handle('GET', `/available/${name}`)
    expect(response.status).toBe(200)
    const body = response.body as { available: boolean; proof: Record<string, unknown> }
    expect(body.available).toBe(true)
    return body.proof
  }

  const leafVerifies = (doc: Record<string, unknown>, leaf: unknown): void => {
    expect(verifiesWithCoreAlone(leaf as Record<string, unknown>, doc['root'] as string)).toBe(true)
  }

  it('BETWEEN: both bracketing leaves verify against the same root', async () => {
    const records = [
      { ...RECORD, name: 'alpha-name' },
      { ...RECORD, name: 'omega-name' },
    ]
    const doc = await proofFor('middle-name', records)
    expect(doc).toMatchObject({ kind: 'BETWEEN', nimiq_height: CHECKPOINT_HEIGHT, anchor: null })
    expect((doc['previous'] as Record<string, unknown>)['name']).toBe('alpha-name')
    expect((doc['next'] as Record<string, unknown>)['name']).toBe('omega-name')
    leafVerifies(doc, doc['previous'])
    leafVerifies(doc, doc['next'])
  })

  it('single-leaf edges: BEFORE_FIRST and AFTER_LAST carry one boundary leaf', async () => {
    const records = [{ ...RECORD, name: 'middle-name' }]

    const before = await proofFor('alpha-name', records)
    expect(before['kind']).toBe('BEFORE_FIRST')
    expect(before['previous']).toBeNull()
    leafVerifies(before, before['next'])

    const after = await proofFor('omega-name', records)
    expect(after['kind']).toBe('AFTER_LAST')
    expect(after['next']).toBeNull()
    leafVerifies(after, after['previous'])
  })

  it('EMPTY_TREE: the all-zero root is itself the proof', async () => {
    const doc = await proofFor('alice-example', [])
    expect(doc).toMatchObject({
      kind: 'EMPTY_TREE',
      previous: null,
      next: null,
      root: `0x${'00'.repeat(32)}`,
    })
  })

  it('is null when the checkpoint tree still holds the name (released since the boundary)', async () => {
    const { stub } = treeOf([RECORD])
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)), ...stub })
    const body = (await handle('GET', '/available/alice-example')).body as { available: boolean; proof: unknown }
    expect(body.available).toBe(true)
    expect(body.proof).toBeNull()
  })
})

describe('/checkpoints/latest', () => {
  it('404s while no checkpoint exists', async () => {
    const handle = routes({ latestCheckpoint: () => Promise.resolve(snap(null)) })
    expect((await handle('GET', '/checkpoints/latest')).status).toBe(404)
  })

  it('serves every digest 0x-prefixed', async () => {
    const { base } = treeOf([RECORD])
    const handle = routes({ latestCheckpoint: () => Promise.resolve(snap(base.checkpoint)) })
    expect(await handle('GET', '/checkpoints/latest')).toEqual({
      status: 200,
      body: {
        checkpoint: {
          height: CHECKPOINT_HEIGHT,
          layout: 3,
          nameRoot: `0x${base.checkpoint.nameRoot}`,
          pricesRoot: `0x${'11'.repeat(32)}`,
          pendingRoot: `0x${'22'.repeat(32)}`,
          unreservedRoot: `0x${'33'.repeat(32)}`,
          logHash: `0x${'44'.repeat(32)}`,
          commitment: `0x${'55'.repeat(32)}`,
        },
        height: HEIGHT,
      },
    })
  })
})

describe('/checkpoints/{height}', () => {
  const { base } = treeOf([RECORD])
  const found = { checkpoint: base.checkpoint, retained: null }
  const at = (value: CheckpointLookup) => ({ checkpointAt: () => Promise.resolve(snap(value)) })

  it('serves the same six digests as /checkpoints/latest', async () => {
    // The two endpoints must be byte-identical in shape: a client verifies
    // against whichever it got, with the same code.
    const handle = routes({
      checkpointAt: () => Promise.resolve(snap(found)),
      latestCheckpoint: () => Promise.resolve(snap(base.checkpoint)),
    })
    const byHeight = await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT}`)
    const latest = await handle('GET', '/checkpoints/latest')
    expect(byHeight).toEqual(latest)
    expect(byHeight.status).toBe(200)
  })

  it('400s a height that is not a checkpoint boundary — not a 404', async () => {
    // No checkpoint can ever exist off a boundary, so this is malformed in
    // the way a fractional height would be. A 404 would invite a client to
    // retry forever for something that will never appear.
    const handle = routes(at(found))
    const response = await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT + 1}`)
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      error: 'NOT_A_CHECKPOINT_HEIGHT',
      interval: 60,
      nearest: { below: CHECKPOINT_HEIGHT, above: CHECKPOINT_HEIGHT + 60 },
    })
  })

  it('400s a height that is not a decimal integer', async () => {
    const handle = routes(at(found))
    for (const bad of ['abc', '-720', '72.0', '0x2d0', '1e3']) {
      const response = await handle('GET', `/checkpoints/${bad}`)
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'INVALID_HEIGHT' })
    }
  })

  it('accepts height 0, which is a multiple of the interval', async () => {
    const handle = routes(at({ checkpoint: null, retained: { oldest: 720, newest: 1440 } }))
    // Not a 400: 0 is a boundary. It is simply older than anything retained.
    expect((await handle('GET', '/checkpoints/0')).status).toBe(410)
  })

  it('404s CHECKPOINT_PENDING above the newest retained, and says how far', async () => {
    const handle = routes(at({ checkpoint: null, retained: { oldest: 720, newest: CHECKPOINT_HEIGHT } }))
    const response = await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT + 720}`)
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: 'CHECKPOINT_PENDING', latest: CHECKPOINT_HEIGHT })
  })

  it('410s CHECKPOINT_NOT_RETAINED below the oldest, and says where the range starts', async () => {
    // 410 Gone: the resource is real, this server does not have it. The
    // phrasing is "not retained" rather than "pruned" because the API cannot
    // tell pruning from a database that started at a later LAUNCH_HEIGHT.
    const handle = routes(at({ checkpoint: null, retained: { oldest: CHECKPOINT_HEIGHT, newest: CHECKPOINT_HEIGHT } }))
    const response = await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT - 720}`)
    expect(response.status).toBe(410)
    expect(response.body).toMatchObject({ error: 'CHECKPOINT_NOT_RETAINED', oldest: CHECKPOINT_HEIGHT })
  })

  it('404s CHECKPOINT_MISSING for a gap inside the retained range', async () => {
    // Should never happen — the indexer writes every boundary — so it gets
    // its own code to be alerted on, and stays a 404 because retrying will
    // not help.
    const handle = routes(
      at({ checkpoint: null, retained: { oldest: CHECKPOINT_HEIGHT - 1440, newest: CHECKPOINT_HEIGHT + 1440 } }),
    )
    const response = await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT}`)
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: 'CHECKPOINT_MISSING' })
  })

  it('404s NO_CHECKPOINT when the database holds none at all', async () => {
    const handle = routes(at({ checkpoint: null, retained: null }))
    const response = await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT}`)
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: 'NO_CHECKPOINT' })
  })

  it('gives the four misses four different codes', async () => {
    // The point of the endpoint's error design, asserted as one statement:
    // wait, ask elsewhere, alert, and fix your request are four instructions.
    const codes = new Set<string>()
    const cases: readonly [CheckpointLookup, number][] = [
      [{ checkpoint: null, retained: { oldest: 720, newest: CHECKPOINT_HEIGHT - 720 } }, CHECKPOINT_HEIGHT],
      [{ checkpoint: null, retained: { oldest: CHECKPOINT_HEIGHT + 720, newest: CHECKPOINT_HEIGHT + 1440 } }, CHECKPOINT_HEIGHT],
      [{ checkpoint: null, retained: { oldest: 720, newest: CHECKPOINT_HEIGHT + 720 } }, CHECKPOINT_HEIGHT],
      [{ checkpoint: null, retained: null }, CHECKPOINT_HEIGHT],
    ]
    for (const [lookup, height] of cases) {
      const body = (await routes(at(lookup))('GET', `/checkpoints/${height}`)).body as { error: string }
      codes.add(body.error)
    }
    expect(codes).toEqual(
      new Set(['CHECKPOINT_PENDING', 'CHECKPOINT_NOT_RETAINED', 'CHECKPOINT_MISSING', 'NO_CHECKPOINT']),
    )
  })

  it('is still 503 when the indexer has not initialised the database', async () => {
    const handle = routes({ checkpointAt: () => Promise.reject(new NotSyncedError('not yet')) })
    expect((await handle('GET', `/checkpoints/${CHECKPOINT_HEIGHT}`)).status).toBe(503)
  })
})

describe('/log', () => {
  it('serves the exact §8.2 file bytes through the checkpoint, with its committed hash in a header', async () => {
    const lines = [
      '58177017 0 aa11 NQ340000000000000000000000000000000000 NQ930000000000000000000000000000000000 1 4e4e5331 OK',
      '58177020 2 bb22 NQ340000000000000000000000000000000000 NQ930000000000000000000000000000000000 1 4e4e5331 WRONG_RECIPIENT',
    ]
    const handle = routes({
      logThroughCheckpoint: () =>
        Promise.resolve(snap({ checkpointHeight: CHECKPOINT_HEIGHT, logHash: '44'.repeat(32), lines })),
    })
    const response = await handle('GET', '/log')
    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/plain; charset=utf-8')
    expect(response.headers).toEqual({
      'x-nns-checkpoint-height': String(CHECKPOINT_HEIGHT),
      'x-nns-log-hash': `0x${'44'.repeat(32)}`,
    })
    expect(response.body).toEqual(logFile(lines))
  })

  it('404s while no checkpoint exists', async () => {
    const handle = routes({ logThroughCheckpoint: () => Promise.resolve(snap(null)) })
    expect((await handle('GET', '/log')).status).toBe(404)
  })
})

describe('GET /log/decoded', () => {
  // NNS1Dnimiq|delegated.nimiqnames.com — a real line from the deployment.
  const D_HEX =
    '4e4e5331446e696d69717c64656c6567617465642e6e696d69716e616d65732e636f6d'
  // Compact form, as §8.2 writes them: the spacing would break a
  // space-separated format.
  const NQ_A = A.replace(/ /g, '')
  const NQ_B = B.replace(/ /g, '')
  const lines = [`59185480 0 8576 ${NQ_A} ${NQ_B} 1 ${D_HEX} OK`]

  const decoded = (over: string[] = lines) =>
    routes({
      logThroughCheckpoint: () =>
        Promise.resolve(snap({ checkpointHeight: CHECKPOINT_HEIGHT, logHash: '44'.repeat(32), lines: over })),
    })

  it('renders the payload as text, which is the whole point', async () => {
    const response = await decoded()('GET', '/log/decoded')
    expect(response.status).toBe(200)
    const entry = (response.body as { entries: Record<string, unknown>[] }).entries[0]
    expect(entry).toMatchObject({
      blockHeight: 59_185_480,
      txIndex: 0,
      message: 'NNS1Dnimiq|delegated.nimiqnames.com',
      type: 'D',
      parseFailure: null,
      verdict: 'OK',
    })
  })

  it('carries the canonical hex beside the rendering, so it can be checked not trusted', async () => {
    const response = await decoded()('GET', '/log/decoded')
    const entry = (response.body as { entries: Record<string, unknown>[] }).entries[0]
    expect(entry?.['data']).toBe(D_HEX)
  })

  it('cannot be mistaken for the canonical artifact', async () => {
    // Hashing this by accident would produce a wrong answer confidently, so it
    // is JSON rather than text and carries no x-nns-log-hash header.
    const response = await decoded()('GET', '/log/decoded')
    expect(response.contentType).toBeUndefined()
    expect(response.headers?.['x-nns-log-hash']).toBeUndefined()
    expect((response.body as { canonical: Record<string, unknown> }).canonical).toMatchObject({
      path: '/log',
      logHash: `0x${'44'.repeat(32)}`,
    })
  })

  it('escapes a payload that would otherwise forge a line', async () => {
    // §8.2's reason for hex in the first place: a malformed but NNS1-prefixed
    // payload can carry a newline. Rendered, it must not survive as one.
    const injection = Buffer.from('NNS1G\n99999999 0 forged', 'ascii').toString('hex')
    const response = await decoded([`59185481 0 aa11 ${NQ_A} ${NQ_B} 1 ${injection} OK`])('GET', '/log/decoded')
    const entry = (response.body as { entries: Record<string, unknown>[] }).entries[0]
    expect(entry?.['message']).toBe('NNS1G%0a99999999 0 forged')
    expect(String(entry?.['message'])).not.toContain('\n')
  })

  it('types an `A` line as A — the codec parses it, so the view does (r28)', async () => {
    // NNS1Acarol-example|50000000|58276400
    const aHex = Buffer.from('NNS1Acarol-example|50000000|58276400', 'ascii').toString('hex')
    const response = await decoded([`59185484 0 dd44 ${NQ_A} ${NQ_B} 1 ${aHex} OK`])('GET', '/log/decoded')
    const body = response.body as { entries: { type: string | null; message: string | null }[] }
    expect(body.entries[0]).toMatchObject({ type: 'A', message: 'NNS1Acarol-example|50000000|58276400' })
  })

  it('names the failure for a payload that does not parse, rather than dropping the line', async () => {
    const garbage = Buffer.from('NNS1Z', 'ascii').toString('hex')
    const response = await decoded([`59185482 0 bb22 ${NQ_A} ${NQ_B} 1 ${garbage} OK`])('GET', '/log/decoded')
    const entry = (response.body as { entries: Record<string, unknown>[] }).entries[0]
    expect(entry).toMatchObject({ type: null, parseFailure: 'UNKNOWN_TYPE', message: 'NNS1Z' })
  })

  it('spaces addresses for display, as every other route does', async () => {
    const response = await decoded()('GET', '/log/decoded')
    const entry = (response.body as { entries: Record<string, unknown>[] }).entries[0]
    expect(entry?.['sender']).toBe(formatAddress(A))
  })

  it('falls back to the log\'s own bytes for an address that does not parse', async () => {
    // A line is a line even when something in it is wrong; the view must show
    // what the log holds rather than drop the entry or throw.
    const bad = 'NQ340000000000000000000000000000000000'
    const response = await decoded([`59185483 0 cc33 ${bad} ${NQ_B} 1 ${D_HEX} OK`])('GET', '/log/decoded')
    const entry = (response.body as { entries: Record<string, unknown>[] }).entries[0]
    expect(entry?.['sender']).toBe(bad)
  })

  it('404s while no checkpoint exists', async () => {
    const handle = routes({ logThroughCheckpoint: () => Promise.resolve(snap(null)) })
    expect((await handle('GET', '/log/decoded')).status).toBe(404)
  })

  describe('?format=text', () => {
    const text = async (over: string[] = lines): Promise<string> => {
      const response = await decoded(over)('GET', '/log/decoded?format=text')
      expect(response.contentType).toBe('text/plain; charset=utf-8')
      return Buffer.from(response.body as Uint8Array).toString('utf8')
    }

    it('renders the aligned table a person can actually read', async () => {
      const body = await text()
      const row = body.split('\n').find((line) => line.includes('NNS1Dnimiq'))
      // Fields, not spacing: the columns size themselves to the data, so
      // pinning exact padding would make every future entry a test failure.
      expect(row?.trim().split(/\s+/)).toEqual([
        '59185480',
        '0',
        'D',
        'NNS1Dnimiq|delegated.nimiqnames.com',
        ...'serves subdomains of nimiq from delegated.nimiqnames.com'.split(' '),
        '0.00001',
        NQ_A,
        'OK',
      ])
    })

    it('shows the value in NIM and the sender compact, one token each', async () => {
      const body = await text([
        `59185480 0 8576 ${NQ_A} ${NQ_B} 625000000 ${D_HEX} OK`,
        `59185481 0 8577 ${NQ_B} ${NQ_A} 62500000 ${D_HEX} OK`,
        `59185482 0 8578 ${NQ_A} ${NQ_B} 150000 ${D_HEX} OK`,
      ])
      const rows = body.split('\n').filter((line) => line.startsWith('  '))
      expect(rows.map((line) => line.trim().split(/\s+/).slice(-3, -1))).toEqual([
        ['6250', NQ_A],
        ['625', NQ_B],
        ['1.5', NQ_A],
      ])
    })

    it('aligns the columns, which is the only reason to prefer it over JSON', async () => {
      const body = await text([
        lines[0] as string,
        `59185999 12 bb22 ${NQ_A} ${NQ_B} 1 ${Buffer.from('NNS1Gnns', 'ascii').toString('hex')} OK`,
      ])
      const rows = body.split('\n').filter((line) => line.startsWith('  '))
      expect(rows).toHaveLength(2)
      // Every verdict starts at the same column.
      const columns = rows.map((line) => line.lastIndexOf('OK'))
      expect(new Set(columns).size).toBe(1)
    })

    it('cannot be parsed as a §8.2 log or hashed into a match', async () => {
      // The real hazard of a text view: /log is text/plain too. Every §8.2 line
      // starts with a decimal height, so a leading `#` is impossible in one.
      const body = await text()
      expect(body.startsWith('# NNS log, DECODED')).toBe(true)
      expect(body).toContain('NOT the §8.2 artifact')
      // And it points at the real thing, with the hash to check it against.
      expect(body).toContain(`keccak256 0x${'44'.repeat(32)}`)
      for (const line of body.split('\n').slice(0, 4)) {
        expect(/^\d/.test(line)).toBe(false)
      }
    })

    it('carries no x-nns-log-hash header, exactly as the JSON view does not', async () => {
      const response = await decoded()('GET', '/log/decoded?format=text')
      expect(response.headers?.['x-nns-log-hash']).toBeUndefined()
    })

    it('keeps an escaped payload on one line, so a forged line stays impossible', async () => {
      const injection = Buffer.from('NNS1G\n99999999 0 forged', 'ascii').toString('hex')
      const body = await text([`59185481 0 aa11 ${NQ_A} ${NQ_B} 1 ${injection} OK`])
      expect(body).toContain('NNS1G%0a99999999 0 forged')
      // Preamble (4) + one entry + trailing newline.
      expect(body.trimEnd().split('\n')).toHaveLength(5)
    })

    it('serves JSON by default and for an explicit json', async () => {
      expect((await decoded()('GET', '/log/decoded')).contentType).toBeUndefined()
      expect((await decoded()('GET', '/log/decoded?format=json')).contentType).toBeUndefined()
    })

    it('names the accepted formats rather than quietly serving JSON', async () => {
      const response = await decoded()('GET', '/log/decoded?format=csv')
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'UNKNOWN_FORMAT', accepted: ['json', 'text'] })
    })

    it('404s while no checkpoint exists, before deciding a format', async () => {
      const handle = routes({ logThroughCheckpoint: () => Promise.resolve(snap(null)) })
      expect((await handle('GET', '/log/decoded?format=text')).status).toBe(404)
    })
  })
})

describe('/settlements', () => {
  const OBLIGATION = {
    refHeight: 58_190_001,
    refTxIndex: 3,
    ordinal: 0,
    kind: 'SALE_PROCEEDS',
    owedBy: A,
    owedTo: B,
    amount: 390_000_000_000n,
  }

  it('lists outstanding obligations with string amounts', async () => {
    const handle = routes({ outstanding: () => Promise.resolve(snap([OBLIGATION])) })
    expect(await handle('GET', '/settlements')).toEqual({
      status: 200,
      body: {
        outstanding: [
          {
            ref: { height: 58_190_001, txIndex: 3 },
            ordinal: 0,
            kind: 'SALE_PROCEEDS',
            owedBy: formatAddress(A),
            owedTo: formatAddress(B),
            amount: '390000000000',
          },
        ],
        height: HEIGHT,
      },
    })
  })

  it('forwards a parsed owed_to filter and rejects a malformed one', async () => {
    let seen: unknown = 'not called'
    const handle = routes({
      outstanding: (owedTo) => {
        seen = owedTo
        return Promise.resolve(snap([]))
      },
    })
    await handle('GET', `/settlements?owed_to=${encodeURIComponent(formatAddress(B))}`)
    expect(seen).toBe(B)
    expect((await handle('GET', '/settlements?owed_to=junk')).status).toBe(400)
  })
})

describe('/burn', () => {
  it('sums only accepted attestations; rejected lines stay listed', async () => {
    const attestations = [
      { height: 58_190_000, txIndex: 1, txHash: 'aa11', sender: A, value: 100_000n, verdict: 'OK' },
      { height: 58_190_060, txIndex: 0, txHash: 'bb22', sender: B, value: 999_999n, verdict: 'WRONG_SENDER' },
      { height: 58_190_120, txIndex: 2, txHash: 'cc33', sender: A, value: 25_000n, verdict: 'OK' },
    ]
    const handle = routes({ burn: () => Promise.resolve(snap({ attestations, revenue: 0n })) })
    const response = await handle('GET', '/burn')
    expect(response.status).toBe(200)
    const body = response.body as { burned: string; attestations: { verdict: string; value: string }[] }
    expect(body.burned).toBe('125000')
    expect(body.attestations).toHaveLength(3)
    expect(body.attestations[1]).toMatchObject({ verdict: 'WRONG_SENDER', value: '999999' })
  })

  it('serves both halves of §10.2: owed is BURN_SHARE of accepted revenue, floored to whole luna', async () => {
    // 1,000,003 luna of revenue → 20% is 200,000.6, floored to 200,000. The
    // flooring direction matters: owed rounds down, so the ceiling a burn is
    // checked against can only ever under-burn.
    const handle = routes({ burn: () => Promise.resolve(snap({ attestations: [], revenue: 1_000_003n })) })
    const body = (await handle('GET', '/burn')).body as { revenue: string; owed: string; burned: string }
    expect(body.revenue).toBe('1000003')
    expect(body.owed).toBe('200000')
    expect(body.burned).toBe('0')
  })
})

describe('discovery', () => {
  it('serves the OpenAPI document as YAML, with no snapshot and no 503 gate', async () => {
    // The stub throws NotSyncedError on every query, so a route that reached
    // for a snapshot would 503 here. This one must not: the contract is true
    // during a backfill, and an integrator reading it should not be told the
    // service is down.
    const handle = createRoutes(
      new Proxy({} as Queries, {
        get: () => () => Promise.reject(new NotSyncedError('no state yet')),
      }),
    )
    const response = await handle('GET', '/openapi.yaml')
    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/yaml; charset=utf-8')
    const text = Buffer.from(response.body as Uint8Array).toString('utf8')
    expect(text).toContain('openapi: 3.1.0')
    expect(text).toContain('title: NNS resolver API')
  })

  it('names the routes in UNKNOWN_ROUTE — REST has no discovery of its own', async () => {
    const handle = routes({})
    const response = await handle('GET', '/')
    expect(response.status).toBe(404)
    const body = response.body as { error: string; routes: string[]; spec: string }
    expect(body.error).toBe('UNKNOWN_ROUTE')
    expect(body.spec).toBe('/openapi.yaml')
    expect(body.routes).toContain('/resolve/{name}')
    expect(body.routes).toContain('/openapi.yaml')
  })

  it('ROUTES and openapi.yaml describe the same surface, exactly', () => {
    // The published contract and the server must not drift. A hand-maintained
    // spec stops matching the moment a route is added without one, and a
    // contract that has quietly stopped being true is worse than none — an
    // integrator generates a client from it and the failure lands on them.
    const spec = readFileSync(fileURLToPath(new URL('../openapi.yaml', import.meta.url)), 'utf8')
    const paths = spec
      .slice(spec.indexOf('\npaths:'), spec.indexOf('\ncomponents:'))
      .split('\n')
      .filter((line) => /^ {2}\/\S*:$/.test(line))
      .map((line) => line.trim().replace(/:$/, ''))

    expect(paths.length).toBeGreaterThan(0)
    expect([...paths].sort()).toEqual([...ROUTES].sort())
  })
})

describe('GET /referrals/{name} (§10.7)', () => {
  const REFERRED = [
    { height: 58_190_050, txIndex: 1, txHash: 'ab'.repeat(32), name: 'newcomer', sender: B, value: 400_000_000n, lifetime: false },
    { height: 58_190_060, txIndex: 0, txHash: 'cd'.repeat(32), name: 'lifelong', sender: B, value: 4_000_000_000n, lifetime: true },
  ]

  it('lists the accepted registrations that named the referrer, and no share', async () => {
    const handle = routes({ referrals: (name) => Promise.resolve(snap(name === 'alice-example' ? REFERRED : [])) })
    expect(await handle('GET', '/referrals/alice-example')).toEqual({
      status: 200,
      body: {
        name: 'alice-example',
        count: 2,
        registrations: [
          { height: 58_190_050, txIndex: 1, txHash: 'ab'.repeat(32), name: 'newcomer', sender: formatAddress(B), value: '400000000', lifetime: false },
          { height: 58_190_060, txIndex: 0, txHash: 'cd'.repeat(32), name: 'lifelong', sender: formatAddress(B), value: '4000000000', lifetime: true },
        ],
        height: HEIGHT,
      },
    })
    expect(await handle('GET', '/referrals/nobody-yet')).toEqual({
      status: 200,
      body: { name: 'nobody-yet', count: 0, registrations: [], height: HEIGHT },
    })
  })

  it('refuses a query that is not a name', async () => {
    const handle = routes({})
    const response = await handle('GET', '/referrals/Not%20A%20Name')
    expect(response.status).toBe(400)
    expect((response.body as { error: string }).error).toBe('INVALID_NAME')
  })
})
