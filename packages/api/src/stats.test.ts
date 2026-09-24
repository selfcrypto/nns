import { parseAddress } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { RECENT_REGISTRATIONS, tallyAccepted, type AcceptedLine } from './stats.js'

const SENDER = parseAddress('NQ07 0000 0000 0000 0000 0000 0000 0000 0000')

let height = 100
const line = (payload: string, value = 1n): AcceptedLine => ({
  height: height++,
  sender: SENDER,
  value,
  data: Buffer.from(payload, 'ascii').toString('hex'),
})

describe('tallyAccepted', () => {
  it('reads a B as a sale after an O and as a bid after an A', () => {
    const tally = tallyAccepted([
      line('NNS1Oalpha|500000'),
      line('NNS1Balpha', 500_000n),
      line('NNS1Abravo|100000|999999'),
      line('NNS1Bbravo', 100_000n),
      line('NNS1Bbravo', 150_000n),
    ])
    expect(tally.market).toEqual({
      listings: 1,
      sales: 1,
      saleVolume: 500_000n,
      topSale: { name: 'alpha', price: 500_000n },
      auctions: 1,
      bids: 2,
      topBid: { name: 'bravo', bid: 150_000n },
    })
  })

  it('reads the latest opening: an auction after a sold offer takes bids, not sales', () => {
    const tally = tallyAccepted([
      line('NNS1Oalpha|500000'),
      line('NNS1Balpha', 500_000n),
      line('NNS1Aalpha|100000|999999'),
      line('NNS1Balpha', 120_000n),
    ])
    expect(tally.market.sales).toBe(1)
    expect(tally.market.bids).toBe(1)
  })

  it('counts referrals by referrer, most sign-ups first, with what they paid', () => {
    const tally = tallyAccepted([
      line('NNS1Gone-name|alice', 5n),
      line('NNS1Gtwo-name|bob', 7n),
      line('NNS1Gthree-name|bob', 7n),
      line('NNS1Gfour-name'),
    ])
    expect(tally.referrals).toEqual({
      registrations: 3,
      referrers: 2,
      top: [
        { name: 'bob', registrations: 2, volume: 14n },
        { name: 'alice', registrations: 1, volume: 5n },
      ],
    })
  })

  it('counts every lifetime term: registrations, renewals and awards', () => {
    const tally = tallyAccepted([line('NNS1Gforever-name||L'), line('NNS1Nsome-name|L'), line('NNS1Nsome-name'), line('NNS1Ugift-name|L')])
    expect(tally.lifetimeTerms).toBe(3)
    expect(tally.renewals).toBe(2)
  })

  it('keeps the latest registrations, newest first, and skips what does not decode', () => {
    const lines = Array.from({ length: RECENT_REGISTRATIONS + 2 }, (_, index) => line(`NNS1Gname-number-${index}`))
    const tally = tallyAccepted([...lines, { ...line('x'), data: 'zz' }])
    expect(tally.recent).toHaveLength(RECENT_REGISTRATIONS)
    expect(tally.recent[0]?.name).toBe(`name-number-${RECENT_REGISTRATIONS + 1}`)
  })
})
