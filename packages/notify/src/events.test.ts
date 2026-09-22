/**
 * The narration, against the real reducer: a log built from `core`'s own
 * encoders, replayed, and the events read off the state diff.
 */

import {
  CONSTANTS,
  LAUNCH_PRICES,
  defineConfig,
  encodeAuction,
  encodeBuy,
  encodeOffer,
  encodeRegister,
  encodeTransfer,
  feeFor,
  formatAddress,
  minPrice,
  parseAddress,
  requiredBid,
  type BuiltTransaction,
  type ChainTransaction,
} from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { eventKey, replayEvents, type NotifyEvent } from './events.js'

const config = defineConfig({ networkId: 24 })
const LAUNCH = CONSTANTS.LAUNCH_HEIGHT
const ALICE = parseAddress('NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H')
const BOB = parseAddress('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')
const CAROL = parseAddress('NQ19 KSMT HHEJ TYNF J1GK 40NK LHSL C5P7 P24M')
const alice = formatAddress(ALICE)
const bob = formatAddress(BOB)
const carol = formatAddress(CAROL)
const NAME = 'riconame'
const FEE = feeFor(NAME, LAUNCH_PRICES)
const FLOOR = minPrice(LAUNCH_PRICES)

let counter = 0
const tx = (built: BuiltTransaction, sender: typeof ALICE, at: number, value?: bigint): ChainTransaction => ({
  blockNumber: at,
  txIndex: 0,
  hash: `0x${(counter++).toString(16).padStart(64, '0')}`,
  sender,
  recipient: built.recipient,
  value: value ?? built.value,
  recipientData: built.data,
  executionResult: true,
  networkId: 24,
})

const kinds = (events: readonly NotifyEvent[]) => events.map((event) => `${event.kind}→${event.to === alice ? 'alice' : event.to === bob ? 'bob' : 'carol'}`)

describe('replayEvents', () => {
  it('narrates nothing at or below `from`, and a first poll narrates nothing at all', () => {
    const log = [tx(encodeRegister({ name: NAME, fee: FEE }), ALICE, LAUNCH), tx(encodeTransfer({ name: NAME, newOwner: BOB }), ALICE, LAUNCH + 10)]
    expect(replayEvents(log, config, LAUNCH + 10, LAUNCH + 10).events).toEqual([])
    expect(replayEvents(log, config, LAUNCH + 720, LAUNCH + 720).events).toEqual([])
    expect(kinds(replayEvents(log, config, LAUNCH, LAUNCH + 720).events)).toEqual(['transfer_pending→bob'])
  })

  it('tells the new owner about a pending transfer, then about its arrival', () => {
    const log = [tx(encodeRegister({ name: NAME, fee: FEE }), ALICE, LAUNCH), tx(encodeTransfer({ name: NAME, newOwner: BOB }), ALICE, LAUNCH + 10)]
    const first = replayEvents(log, config, LAUNCH, LAUNCH + 720)
    expect(first.events).toEqual([
      { kind: 'transfer_pending', to: bob, name: NAME, from: alice, effectiveHeight: LAUNCH + 10 + CONSTANTS.XFER_TIMELOCK },
    ])
    const matured = LAUNCH + 10 + CONSTANTS.XFER_TIMELOCK
    const second = replayEvents(log, config, LAUNCH + 720, matured + 720)
    expect(second.events).toEqual([{ kind: 'transfer_arrived', to: bob, name: NAME }])
    expect(formatAddress(second.state.names.get(NAME)!.owner)).toBe(bob)
    // Reported once: the next poll starts past it.
    expect(replayEvents(log, config, matured + 720, matured + 1440).events).toEqual([])
  })

  it('tells the seller when an offer is bought', () => {
    const price = FLOOR * 2n
    const log = [
      tx(encodeRegister({ name: NAME, fee: FEE }), ALICE, LAUNCH),
      tx(encodeOffer({ name: NAME, price, minPrice: FLOOR }), ALICE, LAUNCH + 5),
      tx(encodeBuy({ name: NAME, price }), BOB, LAUNCH + 6),
    ]
    const { events } = replayEvents(log, config, LAUNCH + 5, LAUNCH + 720)
    expect(events).toEqual([{ kind: 'offer_bought', to: alice, name: NAME, buyer: bob, price }])
  })

  it('narrates an auction: the bid to the seller, the outbid to the loser, the close to both sides', () => {
    const end = LAUNCH + 5 + CONSTANTS.AUCTION_MIN_DURATION + 100
    const open = [
      tx(encodeRegister({ name: NAME, fee: FEE }), ALICE, LAUNCH),
      tx(encodeAuction({ name: NAME, startingPrice: FLOOR, endHeight: end, minPrice: FLOOR }), ALICE, LAUNCH + 5),
    ]
    const opened = replayEvents(open, config, LAUNCH, LAUNCH + 720)
    expect(opened.events).toEqual([])
    const auction = opened.state.auctions.get(NAME)!
    const first = requiredBid(auction)
    const withBid = [...open, tx(encodeBuy({ name: NAME, price: first }), BOB, LAUNCH + 100)]
    const bid = replayEvents(withBid, config, LAUNCH + 5, LAUNCH + 720)
    expect(bid.events).toEqual([{ kind: 'bid_placed', to: alice, name: NAME, bidder: bob, bid: first, endHeight: end }])

    const second = requiredBid(bid.state.auctions.get(NAME)!)
    const outbid = [...withBid, tx(encodeBuy({ name: NAME, price: second }), CAROL, LAUNCH + 200)]
    const outbidEvents = replayEvents(outbid, config, LAUNCH + 100, LAUNCH + 720).events
    expect(kinds(outbidEvents)).toEqual(['bid_placed→alice', 'outbid→bob'])

    const closed = replayEvents(outbid, config, LAUNCH + 720, end + 720)
    expect(closed.events).toEqual([
      { kind: 'auction_sold', to: alice, name: NAME, winner: carol, bid: second },
      { kind: 'auction_won', to: carol, name: NAME, bid: second },
    ])
    expect(formatAddress(closed.state.names.get(NAME)!.owner)).toBe(carol)
  })

  it('tells the seller when an auction closes with no bid', () => {
    const end = LAUNCH + 5 + CONSTANTS.AUCTION_MIN_DURATION
    const log = [
      tx(encodeRegister({ name: NAME, fee: FEE }), ALICE, LAUNCH),
      tx(encodeAuction({ name: NAME, startingPrice: FLOOR, endHeight: end, minPrice: FLOOR }), ALICE, LAUNCH + 5),
    ]
    expect(replayEvents(log, config, LAUNCH + 720, end + 720).events).toEqual([{ kind: 'auction_unsold', to: alice, name: NAME }])
  })

  it('keys an event the same way on every poll', () => {
    const event: NotifyEvent = { kind: 'outbid', to: bob, name: NAME, bid: 5n, endHeight: 9 }
    expect(eventKey(event)).toBe(eventKey({ ...event }))
    expect(eventKey({ kind: 'chat_message', to: bob, from: alice, hash: '0xab', height: 1 })).toBe('chat:0xab')
  })
})
