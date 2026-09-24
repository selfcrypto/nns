import { describe, expect, it } from 'vitest'
import { ApiError, getAuctions, getBurn, getNameInfo, getOffers, getParams, getReferrals, getStats, type JsonFetch } from './api'

const FEES_WIRE = ([[2, 200n], [3, 100n], [4, 50n], [5, 25n], [6, 10n], [11, 5n], [24, 1n]] as const).map(([upTo, times]) => ({
  upTo,
  times: times.toString(),
  yearly: (40_000_000n * times).toString(),
  lifetime: (400_000_000n * times).toString(),
}))

const respond =
  (routes: Record<string, { status: number; body: unknown }>): JsonFetch =>
  (url) => {
    const path = new URL(url).pathname
    const match = routes[path]
    if (!match) throw new Error(`unexpected request: ${url}`)
    return Promise.resolve(match)
  }

const nameBody = {
  name: 'example',
  reserved: false,
  unreserved: false,
  record: {
    name: 'example',
    owner: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    target: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    evm: '',
    expiry: 2_000_000,
    status: 'REGISTERED',
    host: '',
  },
  pending: { transfer: null, offer: null, auction: null },
  height: 1_500_000,
}

describe('getNameInfo', () => {
  it('parses the r28 shape — pending is {transfer, offer, auction}, no unreserve key', async () => {
    const info = await getNameInfo('http://api', 'example', respond({ '/name/example': { status: 200, body: nameBody } }))
    expect(info?.record?.status).toBe('REGISTERED')
    expect(info?.pending).toEqual({ transfer: null, offer: null, auction: null })
  })

  it('404 NOT_FOUND is null — nothing known is an answer, not an error', async () => {
    const info = await getNameInfo(
      'http://api',
      'example',
      respond({ '/name/example': { status: 404, body: { error: 'NOT_FOUND' } } }),
    )
    expect(info).toBeNull()
  })

  it('503 NOT_SYNCED surfaces as an ApiError carrying the code', async () => {
    await expect(
      getNameInfo('http://api', 'example', respond({ '/name/example': { status: 503, body: { error: 'NOT_SYNCED' } } })),
    ).rejects.toMatchObject({ code: 'NOT_SYNCED', status: 503 })
  })

  it('a malformed record is refused, never half-parsed', async () => {
    const broken = { ...nameBody, record: { ...nameBody.record, expiry: '2000000' } }
    await expect(
      getNameInfo('http://api', 'example', respond({ '/name/example': { status: 200, body: broken } })),
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('luna amounts', () => {
  it('offers parse price to bigint from the decimal string', async () => {
    const offers = await getOffers(
      'http://api',
      respond({
        '/offers': {
          status: 200,
          body: {
            offers: [{ name: 'a-name', seller: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', price: '123456789012345', openedHeight: 1, expiryHeight: 2 }],
            height: 3,
          },
        },
      }),
    )
    expect(offers.offers[0]?.price).toBe(123_456_789_012_345n)
  })

  it('auctions parse every amount to bigint, and a fresh one carries no bidder', async () => {
    const wire = {
      name: 'a-name',
      seller: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
      startingPrice: '100000000',
      endHeight: 1_100_000,
      bidder: null,
      bid: '0',
      bidRef: null,
      minimumBid: '100000000',
    }
    const auctions = await getAuctions('http://api', respond({ '/auctions': { status: 200, body: { auctions: [wire], height: 3 } } }))
    expect(auctions.auctions[0]).toEqual({ name: 'a-name', seller: wire.seller, startingPrice: 100_000_000n, endHeight: 1_100_000, bidder: null, bid: 0n, minimumBid: 100_000_000n })
    const info = await getNameInfo(
      'http://api',
      'example',
      respond({ '/name/example': { status: 200, body: { ...nameBody, pending: { transfer: null, offer: null, auction: { ...wire, bidder: wire.seller, bid: '105000000', minimumBid: '110250000' } } } } }),
    )
    expect(info?.pending.auction?.minimumBid).toBe(110_250_000n)
  })

  it('a non-decimal luna string is refused', async () => {
    await expect(
      getParams(
        'http://api',
        respond({
          '/params': {
            status: 200,
            body: {
              prices: { feeBase: '2e8', commissionBp: '250' },
              fees: FEES_WIRE,
              minPrice: '40000000',
              listingFee: '0',
              lastGovernanceHeight: null,
              pendingGovernance: null,
              height: 1,
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('the burn record parses both §10.2 halves to bigint — burned alone is not an answer', async () => {
    const burn = await getBurn(
      'http://api',
      respond({
        '/burn': {
          status: 200,
          body: { revenue: '1000000000', owed: '200000000', burned: '150000000', attestations: [], height: 42 },
        },
      }),
    )
    expect(burn.owed).toBe(200_000_000n)
    expect(burn.burned).toBe(150_000_000n)
    expect(burn.revenue).toBe(1_000_000_000n)
    expect(burn.height).toBe(42)
  })

  it('params carries a scheduled governance change with its own prices', async () => {
    const params = await getParams(
      'http://api',
      respond({
        '/params': {
          status: 200,
          body: {
            prices: { feeBase: '40000000', commissionBp: '250' },
            fees: FEES_WIRE,
            minPrice: '40000000',
            listingFee: '0',
            lastGovernanceHeight: 5,
            pendingGovernance: {
              prices: { feeBase: '80000000', commissionBp: '250' },
              fees: FEES_WIRE.map((row) => ({ ...row, yearly: '1', lifetime: '10' })),
              effectiveHeight: 99,
            },
            height: 10,
          },
        },
      }),
    )
    expect(params.prices.feeBase).toBe(40_000_000n)
    expect(params.fees).toHaveLength(7)
    expect(params.fees[5]).toEqual({ upTo: 11, times: 5n, yearly: 200_000_000n, lifetime: 2_000_000_000n })
    expect(params.pendingGovernance?.prices.feeBase).toBe(80_000_000n)
    expect(params.pendingGovernance?.fees[0]?.lifetime).toBe(10n)
    expect(params.pendingGovernance?.effectiveHeight).toBe(99)
  })
})

// A same-origin base (`VITE_NNS_RESOLVERS[].url = "/api"`) is what lets one
// `web` image run on any hostname — `config.ts`'s `isEndpointUrl`. It only
// works because `request` concatenates: anything here that reached for
// `new URL(base)` would throw on a relative base instead of resolving it
// against the document, which is a failure no absolute-URL test would catch.
describe('a same-origin base', () => {
  const capturing = (seen: string[]): JsonFetch => {
    return (url) => {
      seen.push(url)
      return Promise.resolve({ status: 200, body: nameBody })
    }
  }

  it('builds a root-relative request path, with no origin invented', async () => {
    const seen: string[] = []
    await getNameInfo('/api', 'example', capturing(seen))
    expect(seen).toEqual(['/api/name/example'])
  })

  it('treats a bare "/" as the origin root', async () => {
    const seen: string[] = []
    await getNameInfo('/', 'example', capturing(seen))
    expect(seen).toEqual(['/name/example'])
  })

  it('still joins an absolute base the same way', async () => {
    const seen: string[] = []
    await getNameInfo('https://api.example.com', 'example', capturing(seen))
    expect(seen).toEqual(['https://api.example.com/name/example'])
  })
})

describe('getReferrals', () => {
  it('reads the referred registrations, value as luna', async () => {
    const fetchJson = respond({
      '/referrals/ricomav': {
        status: 200,
        body: {
          name: 'ricomav',
          count: 1,
          registrations: [
            { height: 61_200_000, txIndex: 2, txHash: 'ab'.repeat(32), name: 'newcomer', sender: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', value: '400000', lifetime: false },
            { height: 61_200_010, txIndex: 0, txHash: 'cd'.repeat(32), name: 'lifelong', sender: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', value: '4000000', lifetime: true },
          ],
          height: 61_200_060,
        },
      },
    })
    const result = await getReferrals('http://api', 'ricomav', fetchJson)
    expect(result.count).toBe(1)
    expect(result.registrations[0]).toMatchObject({ name: 'newcomer', height: 61_200_000, value: 400_000n, lifetime: false })
    expect(result.registrations[1]).toMatchObject({ name: 'lifelong', value: 4_000_000n, lifetime: true })
    expect(result.height).toBe(61_200_060)
  })
})

describe('getStats', () => {
  const tally = (count: number, amount: string) => ({ count, amount })
  const body = {
    chain: { launchHeight: 1_000, scannedThrough: 5_000, checkpointInterval: 60 },
    checkpoints: { retained: 3, latest: { height: 4_980, commitment: '0xab', createdAt: '2026-09-24T00:00:00.000Z' } },
    names: {
      total: 2, registered: 2, grace: 0, owners: 1, withEvm: 0, delegated: 0, pointedElsewhere: 0, renewSoon: 0, released: 0,
      lifetimeTerms: 1, renewals: 0,
      byLength: [{ length: 12, names: 2 }],
      topHolders: [{ owner: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', names: 2 }],
      recent: [{ name: 'example-name', height: 4_000, lifetime: true }],
    },
    market: {
      openOffers: 0, openAuctions: 0, pendingTransfers: 0, listings: 1, sales: 1, saleVolume: '123456789012345678901',
      topSale: { name: 'example-name', price: '123456789012345678901' }, auctions: 0, bids: 0, topBid: null,
    },
    log: {
      lines: 3, senders: 1,
      byType: [{ type: 'G', lines: 3, ok: 3 }],
      byVerdict: [{ verdict: 'OK', lines: 3 }],
      daily: [{ bucket: 0, lines: 3, registrations: 2 }],
      hourly: [],
      dayBlocks: 86_400, hourBlocks: 3_600,
    },
    money: {
      revenue: '1000', owed: '200', burned: '0',
      payouts: tally(0, '0'), refunded: tally(0, '0'), forfeited: tally(0, '0'), outstanding: tally(0, '0'),
    },
    referrals: { registrations: 1, referrers: 1, top: [{ name: 'ref-name', registrations: 1, volume: '1000' }] },
    height: 5_000,
  }

  it('reads amounts as bigint, beyond what a number holds', async () => {
    const stats = await getStats('http://api', respond({ '/stats': { status: 200, body } }))
    expect(stats.market.saleVolume).toBe(123_456_789_012_345_678_901n)
    expect(stats.market.topBid).toBeNull()
    expect(stats.referrals.top[0]?.volume).toBe(1_000n)
    expect(stats.names.recent[0]?.lifetime).toBe(true)
  })

  it('refuses a body that has lost a field', async () => {
    const broken = { ...body, money: { ...body.money, owed: 200 } }
    await expect(getStats('http://api', respond({ '/stats': { status: 200, body: broken } }))).rejects.toBeInstanceOf(ApiError)
  })
})
