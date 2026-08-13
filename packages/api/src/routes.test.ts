/**
 * Route behaviour over a stubbed `Queries` — status codes, error reasons and
 * serialisation, with no Postgres anywhere. The SQL behind the interface has
 * its own gated test in `queries.test.ts`.
 */

import { formatAddress, parseAddress } from '@nns/core'
import { describe, expect, it } from 'vitest'

import { NotSyncedError, type NameDetail, type Queries, type Snapshot } from './queries.js'
import { createRoutes, type RouteHandler } from './routes.js'

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
  recovery: null,
  host: '',
}

const EMPTY_DETAIL: NameDetail = {
  record: null,
  transfer: null,
  recovery: null,
  offer: null,
  unreserve: null,
  unreserved: false,
}

const OFFER = { name: 'alice-example', seller: A, price: 50_000_000n, openedHeight: 58_190_000, expiryHeight: 59_486_000 }

const PARAMS = {
  feeStandard: 400_000_000n,
  feeLong: 40_000_000n,
  commissionBp: 250n,
  lastGovernanceHeight: null,
  pending: null,
}

/** Every method rejects unless the test stubs it, so a route that reaches for
 * the wrong query fails loudly instead of passing on a default. */
function queriesOf(partial: Partial<Queries>): Queries {
  const unstubbed = () => Promise.reject(new Error('query not stubbed'))
  return { record: unstubbed, detail: unstubbed, byOwner: unstubbed, offers: unstubbed, params: unstubbed, ...partial }
}

function routes(partial: Partial<Queries>, reservedNames: ReadonlySet<string> = new Set()): RouteHandler {
  return createRoutes(queriesOf(partial), { reservedNames, listingFee: 100_000n })
}

describe('routing', () => {
  it('answers 404 for an unknown route and 405 for a write method', async () => {
    const handle = routes({})
    expect(await handle('GET', '/nope')).toEqual({ status: 404, body: { error: 'UNKNOWN_ROUTE' } })
    expect(await handle('GET', '/resolve/a/b')).toEqual({ status: 404, body: { error: 'UNKNOWN_ROUTE' } })
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
    const handle = routes({ record: notSynced, detail: notSynced, byOwner: notSynced, offers: notSynced, params: notSynced })
    for (const url of ['/resolve/alice-example', '/available/alice-example', '/name/alice-example', `/address/${encodeURIComponent(formatAddress(A))}/names`, '/offers', '/params']) {
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
        expiry: 215_880_000,
        host: 'r.example.com',
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
    expect(await handle('GET', '/resolve/abcd')).toEqual({
      status: 400,
      body: { error: 'INVALID_NAME', reason: 'BAD_NAME', detail: 'TOO_SHORT' },
    })
    expect((await handle('GET', '/resolve/Alice-Example')).status).toBe(400)
  })

  it('resolves a reserved name — a `U` award registers it like any other', async () => {
    const handle = routes({ record: () => Promise.resolve(snap({ ...RECORD, name: 'nimiq' })) }, new Set(['nimiq']))
    expect((await handle('GET', '/resolve/nimiq')).status).toBe(200)
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
      body: { name: 'alice-example', available: true, height: HEIGHT },
    })
  })

  it('answers 200 with the §4.1 reason for an invalid name', async () => {
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) })
    expect(await handle('GET', '/available/abcd')).toEqual({
      status: 200,
      body: { name: 'abcd', available: false, reason: 'TOO_SHORT', height: HEIGHT },
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
    const withheld = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) }, new Set(['nimiq']))
    expect(await withheld('GET', '/available/nimiq')).toEqual({
      status: 200,
      body: { name: 'nimiq', available: false, reason: 'RESERVED', height: HEIGHT },
    })

    const released = routes({ detail: () => Promise.resolve(snap({ ...EMPTY_DETAIL, unreserved: true })) }, new Set(['nimiq']))
    expect(await released('GET', '/available/nimiq')).toEqual({
      status: 200,
      body: { name: 'nimiq', available: true, height: HEIGHT },
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
    const handle = routes({ detail: () => Promise.resolve(snap(EMPTY_DETAIL)) }, new Set(['nimiq']))
    const response = await handle('GET', '/name/nimiq')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ name: 'nimiq', reserved: true, unreserved: false, record: null })
  })

  it('serialises the record and every pending kind, luna as strings', async () => {
    const detail: NameDetail = {
      record: { ...RECORD, recovery: C, host: 'r.example.com' },
      transfer: { newOwner: B, effectiveHeight: 58_243_200, viaRecovery: false },
      recovery: { recovery: null, effectiveHeight: 58_243_200 },
      offer: OFFER,
      unreserve: null,
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
          recovery: formatAddress(C),
          host: 'r.example.com',
        },
        pending: {
          transfer: { newOwner: formatAddress(B), effectiveHeight: 58_243_200, viaRecovery: false },
          recovery: { recovery: null, effectiveHeight: 58_243_200 },
          offer: {
            name: 'alice-example',
            seller: formatAddress(A),
            price: '50000000',
            openedHeight: 58_190_000,
            expiryHeight: 59_486_000,
          },
          unreserve: null,
        },
        height: HEIGHT,
      },
    })
  })

  it('a pending `U` award carries its recipient; a release carries null (r17)', async () => {
    const award: NameDetail = { ...EMPTY_DETAIL, unreserve: { recipient: C, effectiveHeight: 58_250_000 } }
    const handle = routes({ detail: () => Promise.resolve(snap(award)) }, new Set(['nimiq']))
    const response = await handle('GET', '/name/nimiq')
    expect(response.body).toMatchObject({
      pending: { unreserve: { recipient: formatAddress(C), effectiveHeight: 58_250_000 } },
    })
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
          names: [{ name: 'alice-example', target: formatAddress(B), expiry: 215_880_000, status: 'REGISTERED', host: '' }],
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

describe('/params', () => {
  it('serves the active prices with minPrice = feeLong (§3 MIN_PRICE)', async () => {
    const handle = routes({ params: () => Promise.resolve(snap(PARAMS)) })
    expect(await handle('GET', '/params')).toEqual({
      status: 200,
      body: {
        prices: { feeStandard: '400000000', feeLong: '40000000', commissionBp: '250' },
        minPrice: '40000000',
        listingFee: '100000',
        lastGovernanceHeight: null,
        pendingGovernance: null,
        height: HEIGHT,
      },
    })
  })

  it('surfaces a scheduled governance change', async () => {
    const pending = {
      ...PARAMS,
      lastGovernanceHeight: 58_150_000,
      pending: { feeStandard: 800_000_000n, feeLong: 80_000_000n, commissionBp: 300n, effectiveHeight: 58_243_200 },
    }
    const handle = routes({ params: () => Promise.resolve(snap(pending)) })
    const response = await handle('GET', '/params')
    expect(response.body).toMatchObject({
      lastGovernanceHeight: 58_150_000,
      pendingGovernance: {
        prices: { feeStandard: '800000000', feeLong: '80000000', commissionBp: '300' },
        effectiveHeight: 58_243_200,
      },
    })
  })
})
