import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminError } from './cli.js'
import { auctionFor, createAuctionsSource, parseAuctions } from './auctions.js'

const URL_ = 'http://api.test/auctions'

/** `/auctions` as the API serves it (openapi.yaml `Auction`), one with a bid and one without. */
const document_ = {
  auctions: [
    {
      name: 'nns',
      seller: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
      reserve: '100000',
      endHeight: 59_200_000,
      bidder: null,
      bid: '0',
      bidRef: null,
      minimumBid: '100000',
    },
    {
      name: 'binance',
      seller: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
      reserve: '100000',
      endHeight: 59_210_000,
      bidder: 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK',
      bid: '200000',
      bidRef: { height: 59_150_000, txIndex: 0 },
      minimumBid: '210000',
    },
  ],
  height: 59_100_000,
}

describe('parseAuctions', () => {
  it('reads every open auction with the fields a refusal quotes, luna as bigint', () => {
    const parsed = parseAuctions(document_, URL_)
    expect(parsed.height).toBe(59_100_000)
    expect(parsed.url).toBe(URL_)
    expect(parsed.auctions).toEqual([
      { name: 'nns', seller: document_.auctions[0]?.seller, reserve: 100_000n, endHeight: 59_200_000, bidder: null, bid: 0n },
      {
        name: 'binance',
        seller: document_.auctions[1]?.seller,
        reserve: 100_000n,
        endHeight: 59_210_000,
        bidder: 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK',
        bid: 200_000n,
      },
    ])
  })

  it('reads an empty list — the ordinary answer, and the one that lets an A through', () => {
    const parsed = parseAuctions({ auctions: [], height: 1 }, URL_)
    expect(parsed.auctions).toEqual([])
    expect(auctionFor(parsed, 'nns')).toBeNull()
  })

  it('finds the auction for a name, or null', () => {
    const parsed = parseAuctions(document_, URL_)
    expect(auctionFor(parsed, 'binance')?.bid).toBe(200_000n)
    expect(auctionFor(parsed, 'coinbase')).toBeNull()
  })

  it('names the URL and the entry on anything it cannot read', () => {
    expect(() => parseAuctions(null, URL_)).toThrow(/expected an \/auctions document/)
    expect(() => parseAuctions({ auctions: 'none', height: 1 }, URL_)).toThrow(/expected the list of open auctions/)
    expect(() => parseAuctions({ auctions: [{ ...document_.auctions[0], bid: 5 }], height: 1 }, URL_)).toThrow(
      /auctions\[0\]\.bid/,
    )
    expect(() => parseAuctions({ auctions: [], height: null }, URL_)).toThrow(AdminError)
  })
})

describe('createAuctionsSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs {base}/auctions, tolerating a trailing slash on the base', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url)
      return Promise.resolve(new Response(JSON.stringify(document_), { headers: { 'content-type': 'application/json' } }))
    })
    const parsed = await createAuctionsSource('http://api.test/').fetchAuctions()
    expect(seen).toEqual([URL_])
    expect(parsed.auctions).toHaveLength(2)
  })

  it('names the URL when the API is unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(createAuctionsSource('http://api.test').fetchAuctions()).rejects.toThrow(
      /GET http:\/\/api.test\/auctions failed: fetch failed/,
    )
  })
})
