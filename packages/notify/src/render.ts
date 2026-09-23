/**
 * One event → one message, in words: a subject, the paragraphs, and the one
 * button. `email.ts` lays it out for mail; Telegram gets the words and the
 * link. No chat body is ever quoted (tasks/26); a sender is named by a name
 * when one reverse-resolves, else by the address.
 *
 * Every date is derived from the head at render time and every duration
 * from `CONSTANTS`. Nothing here types a number of days.
 */

import { CONSTANTS, LUNA_PER_NIM } from '@nimiqnames/core'

import type { NotifyEvent } from './events.js'

export interface RenderContext {
  /** The checkpoint the event was seen at. */
  readonly head: number
  readonly nowMs: number
  readonly appUrl: string
  /** A name for an address, or null: the sender of a chat message, the buyer of a name. */
  readonly nameOf: (address: string) => string | null
}

export interface Rendered {
  readonly subject: string
  /** The paragraphs, blank-line separated, with no link: the button carries it. */
  readonly text: string
  /** The one thing to do about it. */
  readonly cta: { readonly label: string; readonly url: string }
}

/** Nimiq's ~1 s blocks: a height as a calendar date, from the head and the clock. */
export function approxDate(height: number, head: number, nowMs: number): Date {
  return new Date(nowMs + (height - head) * 1000)
}

const day = (date: Date): string => date.toISOString().slice(0, 10)

/** A block count as a rough duration, the app's rule (`lib/format.ts`). */
export function blocksApprox(blocks: number): string {
  const days = blocks / 86_400
  if (days >= 2) return `about ${Math.round(days)} days`
  const hours = blocks / 3_600
  if (hours >= 2) return `about ${Math.round(hours)} hours`
  return `about ${Math.max(1, Math.round(blocks / 60))} minutes`
}

export function nim(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM
  const rest = luna % LUNA_PER_NIM
  if (rest === 0n) return `${whole} NIM`
  return `${whole}.${rest.toString().padStart(5, '0').replace(/0+$/, '')} NIM`
}

const who = (address: string, ctx: RenderContext): string => ctx.nameOf(address) ?? address

const nameLink = (name: string, ctx: RenderContext): string => `${ctx.appUrl}/#/names/${encodeURIComponent(name)}`
const marketLink = (name: string, ctx: RenderContext): string => `${ctx.appUrl}/#/market/${encodeURIComponent(name)}`
const inboxLink = (ctx: RenderContext): string => `${ctx.appUrl}/#/inbox`

export function render(event: NotifyEvent, ctx: RenderContext): Rendered {
  switch (event.kind) {
    case 'renewal_open': {
      const until = day(approxDate(event.expiry, ctx.head, ctx.nowMs))
      return {
        subject: `${event.name} can be renewed`,
        text: `${event.name} is yours until ${until}. Renewal is open now, and renewing adds ${blocksApprox(CONSTANTS.TERM_LENGTH)} from the current expiry, so there is nothing lost by doing it early.`,
        cta: { label: `Renew ${event.name}`, url: nameLink(event.name, ctx) },
      }
    }
    case 'grace_begun': {
      const free = day(approxDate(event.expiry + CONSTANTS.GRACE_PERIOD, ctx.head, ctx.nowMs))
      return {
        subject: `${event.name} has stopped resolving`,
        text: `${event.name} reached the end of its term. It no longer resolves, but it is still yours: you can renew it until ${free}. After that date anyone can register it.`,
        cta: { label: `Renew ${event.name}`, url: nameLink(event.name, ctx) },
      }
    }
    case 'last_call': {
      const free = day(approxDate(event.expiry + CONSTANTS.GRACE_PERIOD, ctx.head, ctx.nowMs))
      return {
        subject: `Last call for ${event.name}`,
        text: `${event.name} becomes free for anyone to register on ${free}. This is the last message about it. Renew before then to keep it.`,
        cta: { label: `Renew ${event.name}`, url: nameLink(event.name, ctx) },
      }
    }
    case 'offer_bought':
      return {
        subject: `${event.name} sold for ${nim(event.price)}`,
        text: `${who(event.buyer, ctx)} bought ${event.name} for ${nim(event.price)}. The proceeds are paid out by the marketplace.`,
        cta: { label: `See ${event.name}`, url: nameLink(event.name, ctx) },
      }
    case 'bid_placed': {
      const ends = day(approxDate(event.endHeight, ctx.head, ctx.nowMs))
      return {
        subject: `New bid on ${event.name}: ${nim(event.bid)}`,
        text: `${who(event.bidder, ctx)} bid ${nim(event.bid)} on ${event.name}. The auction ends around ${ends}.`,
        cta: { label: 'See the auction', url: marketLink(event.name, ctx) },
      }
    }
    case 'outbid': {
      const ends = day(approxDate(event.endHeight, ctx.head, ctx.nowMs))
      return {
        subject: `You were outbid on ${event.name}`,
        text: `Someone bid ${nim(event.bid)} on ${event.name}, more than your bid, which is being refunded. The auction ends around ${ends}.`,
        cta: { label: 'Bid again', url: marketLink(event.name, ctx) },
      }
    }
    case 'auction_sold':
      return {
        subject: `${event.name} sold at auction for ${nim(event.bid)}`,
        text: `The auction for ${event.name} closed. ${who(event.winner, ctx)} won it with ${nim(event.bid)}. The proceeds are paid out by the marketplace.`,
        cta: { label: `See ${event.name}`, url: nameLink(event.name, ctx) },
      }
    case 'auction_won':
      return {
        subject: `You won ${event.name}`,
        text: `The auction for ${event.name} closed and your bid of ${nim(event.bid)} won. The name is yours.`,
        cta: { label: `See ${event.name}`, url: nameLink(event.name, ctx) },
      }
    case 'auction_unsold':
      return {
        subject: `The auction for ${event.name} closed without a sale`,
        text: `The auction for ${event.name} ended with no winning bid. The name stays yours.`,
        cta: { label: `See ${event.name}`, url: nameLink(event.name, ctx) },
      }
    case 'transfer_pending': {
      const when = day(approxDate(event.effectiveHeight, ctx.head, ctx.nowMs))
      return {
        subject: `${event.name} is being transferred to you`,
        text: `${who(event.from, ctx)} started a transfer of ${event.name} to your address. It completes around ${when} unless the sender cancels it before then.`,
        cta: { label: `See ${event.name}`, url: nameLink(event.name, ctx) },
      }
    }
    case 'transfer_arrived':
      return {
        subject: `${event.name} is now yours`,
        text: `The transfer of ${event.name} to your address completed.`,
        cta: { label: `See ${event.name}`, url: nameLink(event.name, ctx) },
      }
    case 'chat_message':
      return {
        subject: `New message from ${who(event.from, ctx)}`,
        text: `${who(event.from, ctx)} sent you a message.`,
        cta: { label: 'Read it', url: inboxLink(ctx) },
      }
  }
}
