import { describe, expect, it } from 'vitest'
import { ApiError, getNameInfo, getOffers, getParams, type JsonFetch } from './api'

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
    expiry: 2_000_000,
    status: 'REGISTERED',
    host: '',
  },
  pending: { transfer: null, offer: null },
  height: 1_500_000,
}

describe('getNameInfo', () => {
  it('parses the r22 shape — pending is {transfer, offer}, no third key', async () => {
    const info = await getNameInfo('http://api', 'example', respond({ '/name/example': { status: 200, body: nameBody } }))
    expect(info?.record?.status).toBe('REGISTERED')
    expect(info?.pending).toEqual({ transfer: null, offer: null })
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

  it('a non-decimal luna string is refused', async () => {
    await expect(
      getParams(
        'http://api',
        respond({
          '/params': {
            status: 200,
            body: {
              prices: { feeStandard: '2e8', feeLong: '40000000', commissionBp: '250' },
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

  it('params carries a scheduled governance change with its own prices', async () => {
    const params = await getParams(
      'http://api',
      respond({
        '/params': {
          status: 200,
          body: {
            prices: { feeStandard: '200000000', feeLong: '40000000', commissionBp: '250' },
            minPrice: '40000000',
            listingFee: '0',
            lastGovernanceHeight: 5,
            pendingGovernance: { prices: { feeStandard: '100000000', feeLong: '40000000', commissionBp: '250' }, effectiveHeight: 99 },
            height: 10,
          },
        },
      }),
    )
    expect(params.prices.feeStandard).toBe(200_000_000n)
    expect(params.pendingGovernance?.prices.feeStandard).toBe(100_000_000n)
    expect(params.pendingGovernance?.effectiveHeight).toBe(99)
  })
})
