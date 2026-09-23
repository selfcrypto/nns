/**
 * What the bot says. A pure function of the message and the answers it
 * gets from its dependencies, so the tests need no Telegram and no
 * database.
 *
 * Commands only: `/start <token>` from the app's deep link (the binding),
 * `/stop`, `/names`, and `/resolve <name>`, looked up on the public API. In a
 * private chat anything else gets the help text; in a group or a channel
 * anything else gets silence, and only `/resolve` and `/help` answer at all.
 * A bare name was a lookup until 2026-09-23 — a bot that examines every
 * word said in front of it and replies is noise, not a feature (Kike) — and
 * `/start` outside a private chat would bind the group to someone's address.
 */

import { validateNameSyntax } from '@nimiqnames/core'

import type { NameLookup } from './source.js'
import { approxDate } from './render.js'

export interface BotDeps {
  /** Bind a deep-link token to this chat. The address, or null for an unknown or expired token. */
  readonly link: (token: string, chatId: string) => Promise<string | null>
  /** Unbind every address from this chat. How many were bound. */
  readonly unlink: (chatId: string) => Promise<number>
  readonly addressesOf: (chatId: string) => Promise<readonly string[]>
  readonly namesOf: (address: string) => Promise<readonly string[]>
  readonly lookup: (name: string) => Promise<NameLookup>
  /** The current head, for turning an expiry into a date. */
  readonly head: () => Promise<number | null>
  readonly appUrl: string
  readonly nowMs: () => number
}

const HELP = (appUrl: string): string =>
  `This bot sends notifications for Nimiq Name Service addresses: renewal reminders, sales and bids, transfers and new messages.\n\n` +
  `To link an address, open the app, sign in with the address and tap Connect Telegram: ${appUrl}\n\n` +
  `/resolve <name> looks a name up. /names lists the names of your linked addresses. /stop unlinks this chat.`

const day = (height: number, head: number, nowMs: number): string => approxDate(height, head, nowMs).toISOString().slice(0, 10)

async function describe(name: string, deps: BotDeps): Promise<string> {
  const lower = name.toLowerCase()
  if (!validateNameSyntax(lower).ok) return `${name} is not a valid name.`
  const found = await deps.lookup(lower)
  switch (found.kind) {
    case 'invalid':
      return `${name} is not a valid name.`
    case 'reserved':
      return `${lower} is reserved and not registered.`
    case 'available':
      return `${lower} is not registered. Register it: ${deps.appUrl}/#/buy/${encodeURIComponent(lower)}`
    case 'registered': {
      const head = await deps.head()
      const { record } = found
      const expiry = head === null ? `block ${record.expiry}` : day(record.expiry, head, deps.nowMs())
      const lines = [`${lower}`, `Pays to: ${record.target}`]
      if (record.owner !== record.target) lines.push(`Owner: ${record.owner}`)
      lines.push(record.status === 'GRACE' ? `In grace: it stopped resolving on ${expiry}` : `Expires: ${expiry}`)
      lines.push(`Pay: ${deps.appUrl}/#/pay/${encodeURIComponent(lower)}`)
      return lines.join('\n')
    }
  }
}

/** The reply, or null for a message the bot lets pass in silence. */
export async function botReply(text: string, chatId: string, deps: BotDeps, privateChat = true): Promise<string | null> {
  const trimmed = text.trim()
  const [command = '', ...rest] = trimmed.split(/\s+/)
  const argument = rest.join(' ')
  const verb = command.toLowerCase().replace(/@.*$/, '')

  if (!privateChat && verb !== '/resolve' && verb !== '/help') return null

  switch (verb) {
    case '/start': {
      if (argument === '') return HELP(deps.appUrl)
      const address = await deps.link(argument, chatId)
      if (address === null) return 'That link has expired. Open the app, sign in and tap Connect Telegram again.'
      return `Linked. This chat now receives notifications for ${address}.\n\nSend /stop at any time to unlink.`
    }
    case '/stop': {
      const count = await deps.unlink(chatId)
      return count === 0 ? 'This chat was not linked to any address.' : 'Unlinked. This chat will receive no more notifications.'
    }
    case '/names': {
      const addresses = await deps.addressesOf(chatId)
      if (addresses.length === 0) return 'No address is linked to this chat. Open the app, sign in and tap Connect Telegram.'
      const blocks: string[] = []
      for (const address of addresses) {
        const names = await deps.namesOf(address)
        blocks.push(`${address}\n${names.length === 0 ? 'holds no names' : names.join('\n')}`)
      }
      return blocks.join('\n\n')
    }
    case '/help':
      return HELP(deps.appUrl)
    case '/resolve':
      return argument === '' ? 'Send /resolve followed by a name.' : describe(argument.replace(/^@/, ''), deps)
    default:
      return HELP(deps.appUrl)
  }
}
