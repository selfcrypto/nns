/**
 * What happened to whom, from the §8.2 log replayed through `core`.
 *
 * The replay is settlement's shape (`packages/settlement/src/replay.ts`):
 * every line through `reduce`, the height effects through `advanceTo`, and
 * the answer read off the state rather than off the verdict tokens — a
 * close and a matured transfer have no line of their own. This file
 * restates no rule: which `B` is a bid and which a purchase is whatever the
 * state said before the line, and who owns a name after a close is whatever
 * the state says after it.
 *
 * Events are produced only for heights above `from`, the checkpoint the
 * previous poll ended at. History before a subscriber signed in is never
 * narrated: a first poll sets the cursor and emits nothing.
 */

import {
  addressEquals,
  advanceTo,
  formatAddress,
  initialState,
  parse,
  reduce,
  type ChainTransaction,
  type NnsConfig,
  type NnsState,
} from '@nimiqnames/core'

export type Category = 'renewal' | 'market' | 'transfer' | 'chat'

export type NotifyEvent =
  | { readonly kind: 'renewal_open' | 'grace_begun' | 'last_call'; readonly to: string; readonly name: string; readonly expiry: number }
  | { readonly kind: 'offer_bought'; readonly to: string; readonly name: string; readonly buyer: string; readonly price: bigint }
  | { readonly kind: 'bid_placed'; readonly to: string; readonly name: string; readonly bidder: string; readonly bid: bigint; readonly endHeight: number }
  | { readonly kind: 'outbid'; readonly to: string; readonly name: string; readonly bid: bigint; readonly endHeight: number }
  | { readonly kind: 'auction_sold'; readonly to: string; readonly name: string; readonly winner: string; readonly bid: bigint }
  | { readonly kind: 'auction_won'; readonly to: string; readonly name: string; readonly bid: bigint }
  | { readonly kind: 'auction_unsold'; readonly to: string; readonly name: string }
  | { readonly kind: 'transfer_pending'; readonly to: string; readonly name: string; readonly from: string; readonly effectiveHeight: number }
  | { readonly kind: 'transfer_arrived'; readonly to: string; readonly name: string }
  | { readonly kind: 'chat_message'; readonly to: string; readonly from: string; readonly hash: string; readonly height: number }

export const CATEGORY_OF: Record<NotifyEvent['kind'], Category> = {
  renewal_open: 'renewal',
  grace_begun: 'renewal',
  last_call: 'renewal',
  offer_bought: 'market',
  bid_placed: 'market',
  outbid: 'market',
  auction_sold: 'market',
  auction_won: 'market',
  auction_unsold: 'market',
  transfer_pending: 'transfer',
  transfer_arrived: 'transfer',
  chat_message: 'chat',
}

export const CATEGORIES: readonly Category[] = ['renewal', 'market', 'transfer', 'chat']

/**
 * The send-once identity of an event. Two polls that see the same fact
 * produce the same key, which is what the `sent` table is keyed on.
 */
export function eventKey(event: NotifyEvent): string {
  switch (event.kind) {
    case 'renewal_open':
    case 'grace_begun':
    case 'last_call':
      return `${event.kind}:${event.name}:${event.expiry}`
    case 'offer_bought':
      return `${event.kind}:${event.name}:${event.price}`
    case 'auction_sold':
    case 'auction_won':
      return `${event.kind}:${event.name}:${event.bid}`
    case 'bid_placed':
    case 'outbid':
      return `${event.kind}:${event.name}:${event.bid}`
    case 'auction_unsold':
      return `${event.kind}:${event.name}`
    case 'transfer_pending':
      return `${event.kind}:${event.name}:${event.effectiveHeight}`
    case 'transfer_arrived':
      return `${event.kind}:${event.name}:${event.to}`
    case 'chat_message':
      return `chat:${event.hash}`
  }
}

/**
 * The effects a height advance applied: closes and matured transfers. A
 * close either moved the name to the bidder or did not (no bid, or the
 * grace reset cancelled it); a transfer that matured moved the owner.
 */
function advanceEvents(before: NnsState, after: NnsState, out: NotifyEvent[]): void {
  for (const [name, auction] of before.auctions) {
    if (after.auctions.has(name)) continue
    const seller = formatAddress(auction.seller)
    const owner = after.names.get(name)?.owner
    if (auction.bidder !== null && owner !== undefined && addressEquals(owner, auction.bidder)) {
      const winner = formatAddress(auction.bidder)
      out.push({ kind: 'auction_sold', to: seller, name, winner, bid: auction.bid })
      out.push({ kind: 'auction_won', to: winner, name, bid: auction.bid })
    } else {
      out.push({ kind: 'auction_unsold', to: seller, name })
    }
  }
  for (const [name, transfer] of before.transfers) {
    if (after.transfers.has(name)) continue
    const owner = after.names.get(name)?.owner
    if (owner !== undefined && addressEquals(owner, transfer.newOwner)) {
      out.push({ kind: 'transfer_arrived', to: formatAddress(transfer.newOwner), name })
    }
  }
}

/** What an accepted line did, read against the state it was applied to. */
function lineEvents(tx: ChainTransaction, before: NnsState, after: NnsState, out: NotifyEvent[]): void {
  const parsed = parse(tx.recipientData)
  if (!parsed.ok) return
  const message = parsed.message
  if (message.type === 'B') {
    const offer = before.offers.get(message.name)
    const auction = before.auctions.get(message.name)
    if (offer !== undefined && !after.offers.has(message.name)) {
      out.push({ kind: 'offer_bought', to: formatAddress(offer.seller), name: message.name, buyer: formatAddress(tx.sender), price: offer.price })
    } else if (auction !== undefined) {
      const now = after.auctions.get(message.name)
      if (now === undefined || now.bidder === null || !addressEquals(now.bidder, tx.sender)) return
      out.push({ kind: 'bid_placed', to: formatAddress(auction.seller), name: message.name, bidder: formatAddress(tx.sender), bid: now.bid, endHeight: now.endHeight })
      if (auction.bidder !== null && !addressEquals(auction.bidder, tx.sender)) {
        out.push({ kind: 'outbid', to: formatAddress(auction.bidder), name: message.name, bid: now.bid, endHeight: now.endHeight })
      }
    }
  } else if (message.type === 'X') {
    const pending = after.transfers.get(message.name)
    if (pending === undefined) return
    out.push({
      kind: 'transfer_pending',
      to: formatAddress(pending.newOwner),
      name: message.name,
      from: formatAddress(tx.sender),
      effectiveHeight: pending.effectiveHeight,
    })
  }
}

export interface ReplayedEvents {
  /** The state at `through`. */
  readonly state: NnsState
  /** Everything that happened above `from`, in log order. */
  readonly events: readonly NotifyEvent[]
}

/**
 * Replay the whole log and narrate the part above `from`.
 *
 * @param txs the log's lines as transactions, in canonical order.
 * @param from the height the previous poll advanced to; effects at or below
 *   it were reported then. Pass `through` itself on a first poll.
 * @param through the checkpoint the log was served through.
 */
export function replayEvents(
  txs: readonly ChainTransaction[],
  config: NnsConfig,
  from: number,
  through: number,
): ReplayedEvents {
  const events: NotifyEvent[] = []
  let state = initialState()
  let narrating = false

  for (const tx of txs) {
    if (!narrating && tx.blockNumber > from) {
      // Everything through `from` was reported by the previous poll, so its
      // height effects are applied silently before the first new line.
      if (from > state.height) state = advanceTo(state, from)
      narrating = true
    }
    const advanced = tx.blockNumber > state.height ? advanceTo(state, tx.blockNumber) : state
    if (narrating) advanceEvents(state, advanced, events)
    const result = reduce(advanced, tx, config)
    if (narrating && result.verdict.kind === 'OK') lineEvents(tx, advanced, result.state, events)
    state = result.state
  }

  if (!narrating && from > state.height) state = advanceTo(state, from)
  const final = advanceTo(state, through)
  if (through > from) advanceEvents(state, final, events)
  return { state: final, events }
}
