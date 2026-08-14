import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminError } from './cli.js'
import { createParamsSource, parseParams } from './params.js'

const URL_ = 'http://api.test/params'

const document_ = {
  prices: { feeStandard: '400000000', feeLong: '40000000', commissionBp: '250' },
  minPrice: '40000000',
  listingFee: '0',
  lastGovernanceHeight: null,
  pendingGovernance: null,
  height: 58_099_850,
}

describe('parseParams', () => {
  it('reads the four values §10.6 measures against, luna as bigint', () => {
    expect(parseParams(document_, URL_)).toEqual({
      prices: { feeStandard: 400_000_000n, feeLong: 40_000_000n, commissionBp: 250n },
      lastGovernanceHeight: null,
      pending: null,
      height: 58_099_850,
      url: URL_,
    })
  })

  it('reads a pending change and the last governance height', () => {
    const parsed = parseParams(
      {
        ...document_,
        lastGovernanceHeight: 58_000_100,
        pendingGovernance: {
          prices: { feeStandard: '500000000', feeLong: '50000000', commissionBp: '300' },
          effectiveHeight: 58_150_000,
        },
      },
      URL_,
    )
    expect(parsed.lastGovernanceHeight).toBe(58_000_100)
    expect(parsed.pending).toEqual({
      prices: { feeStandard: 500_000_000n, feeLong: 50_000_000n, commissionBp: 300n },
      effectiveHeight: 58_150_000,
    })
  })

  it('refuses a number where luna is a decimal string — a float is how precision is lost', () => {
    const prices = { ...document_.prices, feeStandard: 400_000_000 as unknown as string }
    expect(() => parseParams({ ...document_, prices }, URL_)).toThrow(AdminError)
    expect(() => parseParams({ ...document_, prices }, URL_)).toThrow(/prices.feeStandard/)
  })

  it('names the URL and the field on anything else it cannot read', () => {
    expect(() => parseParams({ ...document_, height: null }, URL_)).toThrow(/http:\/\/api.test\/params answered height/)
    expect(() => parseParams(null, URL_)).toThrow(/expected a \/params document/)
  })
})

describe('createParamsSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs {base}/params, tolerating a trailing slash on the base', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url)
      return Promise.resolve(new Response(JSON.stringify(document_), { headers: { 'content-type': 'application/json' } }))
    })
    const parsed = await createParamsSource('http://api.test/').fetchParams()
    expect(seen).toEqual([URL_])
    expect(parsed.height).toBe(58_099_850)
    expect(parsed.url).toBe(URL_)
  })

  it('names the URL when the API is unreachable or unhappy — a bare "fetch failed" names nothing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(createParamsSource('http://api.test').fetchParams()).rejects.toThrow(
      /GET http:\/\/api.test\/params failed: fetch failed/,
    )

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"error":"NOT_SYNCED"}', { status: 503 })))
    await expect(createParamsSource('http://api.test').fetchParams()).rejects.toThrow(/answered 503/)
  })
})
