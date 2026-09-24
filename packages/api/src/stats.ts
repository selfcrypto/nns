/**
 * `/stats`' reading of the accepted log lines — the part of the numbers SQL
 * cannot count, because it needs the payload decoded or the order of a
 * name's lines. Pure: `queries.ts` hands it rows, `routes.ts` serialises
 * what comes back.
 *
 * Nothing here is a protocol rule or feeds one. A sale is told from a bid the
 * only way the log allows: a `B` that took effect bought whatever the name's
 * latest accepted `O` or `A` had opened, since the two are exclusive (§6 `A`,
 * §7.3's one pending thing per name) and a `B` with nothing open forfeits.
 */

import { parse, type Address } from '@nimiqnames/core'

/** One `OK` log line, as `queries.ts` reads it. */
export interface AcceptedLine {
  readonly height: number
  readonly sender: Address
  readonly value: bigint
  readonly data: string
}

export interface ReferrerTally {
  readonly name: string
  readonly registrations: number
  /** Σ value of the referred `G`s — what the referred paid, not the share. */
  readonly volume: bigint
}

export interface RecentRegistration {
  readonly name: string
  readonly height: number
  readonly lifetime: boolean
}

export interface AcceptedTally {
  /** Accepted `G|L`, `N|L` and `U|L` award lines. */
  readonly lifetimeTerms: number
  readonly renewals: number
  readonly referrals: {
    readonly registrations: number
    readonly referrers: number
    readonly top: readonly ReferrerTally[]
  }
  readonly market: {
    readonly listings: number
    readonly sales: number
    readonly saleVolume: bigint
    readonly topSale: { readonly name: string; readonly price: bigint } | null
    readonly auctions: number
    readonly bids: number
    readonly topBid: { readonly name: string; readonly bid: bigint } | null
  }
  /** Newest first. */
  readonly recent: readonly RecentRegistration[]
}

export const TOP_REFERRERS = 10
export const RECENT_REGISTRATIONS = 8

/** Lines in canonical order (§5.2); anything that does not decode is skipped. */
export function tallyAccepted(lines: readonly AcceptedLine[]): AcceptedTally {
  let lifetimeTerms = 0
  let renewals = 0
  let referred = 0
  const referrers = new Map<string, { registrations: number; volume: bigint }>()
  const open = new Map<string, 'offer' | 'auction'>()
  let listings = 0
  let sales = 0
  let saleVolume = 0n
  let topSale: { name: string; price: bigint } | null = null
  let auctions = 0
  let bids = 0
  let topBid: { name: string; bid: bigint } | null = null
  const registrations: RecentRegistration[] = []

  for (const line of lines) {
    const parsed = parse(line.data)
    if (!parsed.ok) continue
    const message = parsed.message
    switch (message.type) {
      case 'G': {
        if (message.lifetime) lifetimeTerms++
        registrations.push({ name: message.name, height: line.height, lifetime: message.lifetime })
        if (message.ref !== null) {
          referred++
          const entry = referrers.get(message.ref) ?? { registrations: 0, volume: 0n }
          entry.registrations++
          entry.volume += line.value
          referrers.set(message.ref, entry)
        }
        break
      }
      case 'N':
        renewals++
        if (message.lifetime) lifetimeTerms++
        break
      case 'U':
        // An award names a lifetime with `|L`; a release ignores the flag.
        if (message.lifetime) lifetimeTerms++
        break
      case 'O':
        listings++
        open.set(message.name, 'offer')
        break
      case 'A':
        auctions++
        open.set(message.name, 'auction')
        break
      case 'B': {
        const kind = open.get(message.name)
        if (kind === 'offer') {
          sales++
          saleVolume += line.value
          if (topSale === null || line.value > topSale.price) topSale = { name: message.name, price: line.value }
          open.delete(message.name)
        } else if (kind === 'auction') {
          bids++
          if (topBid === null || line.value > topBid.bid) topBid = { name: message.name, bid: line.value }
        }
        break
      }
      default:
        break
    }
  }

  const top = [...referrers.entries()]
    .map(([name, entry]) => ({ name, registrations: entry.registrations, volume: entry.volume }))
    .sort((a, b) => b.registrations - a.registrations || (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0) || (a.name < b.name ? -1 : 1))
    .slice(0, TOP_REFERRERS)

  return {
    lifetimeTerms,
    renewals,
    referrals: { registrations: referred, referrers: referrers.size, top },
    market: { listings, sales, saleVolume, topSale, auctions, bids, topBid },
    recent: registrations.slice(-RECENT_REGISTRATIONS).reverse(),
  }
}
