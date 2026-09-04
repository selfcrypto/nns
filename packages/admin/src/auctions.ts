/**
 * Where an `A` finds out whether the name it names is already under auction.
 *
 * The reducer's `A` case has one row after state and authority that the
 * message cannot answer about itself (`reduce.ts`): `state.auctions.has(name)`
 * — a second `A` for a name under auction forfeits `AUCTION_OPEN` (§6 `A`),
 * mined and unretractable like every forfeit. For a still-reserved name that
 * state lives nowhere a `/available` read can see: the name has no record,
 * so `/available/{name}` answers `RESERVED` whether or not the admin opened an
 * auction on it last week. `GET /auctions` is the endpoint that lists every
 * open auction (tasks/13 D3), and membership there is `state.auctions.has`
 * exactly.
 *
 * Like `reservation.ts`, this decides nothing protocol-shaped. It parses a
 * response and stamps it with the height it was read at.
 */

import { apiBase, getJson, heightField, lunaField } from './api.js'
import { AdminError } from './cli.js'

/** One open auction, as `/auctions` serves it — the fields a refusal quotes. */
export interface OpenAuction {
  readonly name: string
  readonly seller: string
  readonly startingPrice: bigint
  readonly endHeight: number
  /** `null` until the first bid stands. */
  readonly bidder: string | null
  readonly bid: bigint
}

/** `GET /auctions`, as an `A` needs it. */
export interface OpenAuctions {
  readonly auctions: readonly OpenAuction[]
  /** The API's "as of" stamp — the indexer head the snapshot was read at. */
  readonly height: number
  /** The URL it came from, so the plan can name it. */
  readonly url: string
}

export interface AuctionsSource {
  fetchAuctions(): Promise<OpenAuctions>
}

/** The auction open for `name`, if the snapshot holds one. */
export function auctionFor(snapshot: OpenAuctions, name: string): OpenAuction | null {
  return snapshot.auctions.find((auction) => auction.name === name) ?? null
}

function stringField(value: unknown, field: string, url: string): string {
  if (typeof value !== 'string') {
    throw new AdminError(`${url} answered ${field} = ${JSON.stringify(value)} — expected a string`)
  }
  return value
}

function parseAuction(value: unknown, index: number, url: string): OpenAuction {
  if (typeof value !== 'object' || value === null) {
    throw new AdminError(`${url} answered auctions[${index}] = ${JSON.stringify(value)} — expected an auction`)
  }
  const raw = value as Record<string, unknown>
  const field = (name: string): string => `auctions[${index}].${name}`
  const bidder = raw['bidder']
  return Object.freeze({
    name: stringField(raw['name'], field('name'), url),
    seller: stringField(raw['seller'], field('seller'), url),
    startingPrice: lunaField(raw['startingPrice'], field('startingPrice'), url),
    endHeight: heightField(raw['endHeight'], field('endHeight'), url),
    bidder: bidder === null || bidder === undefined ? null : stringField(bidder, field('bidder'), url),
    bid: lunaField(raw['bid'], field('bid'), url),
  })
}

export function parseAuctions(body: unknown, url: string): OpenAuctions {
  if (typeof body !== 'object' || body === null) {
    throw new AdminError(`${url} answered ${JSON.stringify(body)} — expected an /auctions document`)
  }
  const raw = body as Record<string, unknown>
  const list = raw['auctions']
  if (!Array.isArray(list)) {
    throw new AdminError(`${url} answered auctions = ${JSON.stringify(list)} — expected the list of open auctions`)
  }
  return Object.freeze({
    auctions: list.map((entry, index) => parseAuction(entry, index, url)),
    height: heightField(raw['height'], 'height', url),
    url,
  })
}

/** `GET {baseUrl}/auctions`. */
export function createAuctionsSource(baseUrl: string): AuctionsSource {
  const url = `${apiBase(baseUrl)}/auctions`
  return {
    async fetchAuctions(): Promise<OpenAuctions> {
      return parseAuctions(await getJson(url), url)
    },
  }
}
