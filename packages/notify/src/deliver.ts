/**
 * Events → messages, once each. For every event, every confirmed contact of
 * the address whose category is on, unless the ledger says it already went.
 *
 * A refusal (`DeliveryRefused`: a dead mailbox, a chat that blocked the bot)
 * counts against the contact, which is dropped at `maxFailures`. Anything
 * else is logged and left for the next poll, which will find the same event
 * unsent and try again.
 */

import { CATEGORY_OF, eventKey, type NotifyEvent } from './events.js'
import type { Logger } from './logger.js'
import { render, type RenderContext } from './render.js'
import type { Contact, Store } from './store.js'
import { DeliveryRefused, type Transport } from './transport.js'

export interface DeliverOptions {
  readonly store: Store
  readonly transport: Transport
  readonly logger: Logger
  readonly context: RenderContext
  /** The base of the unsubscribe link: `<publicUrl>/unsubscribe/<token>`. */
  readonly unsubscribeUrl: (contact: Contact) => string | null
  readonly maxFailures: number
}

export interface DeliveryReport {
  readonly sent: number
  readonly skipped: number
  readonly failed: number
}

export async function deliver(events: readonly NotifyEvent[], options: DeliverOptions): Promise<DeliveryReport> {
  const { store, transport, logger } = options
  let sent = 0
  let skipped = 0
  let failed = 0
  const contactsOf = new Map<string, readonly Contact[]>()
  const prefsOf = new Map<string, Awaited<ReturnType<Store['preferences']>>>()

  for (const event of events) {
    const category = CATEGORY_OF[event.kind]
    let prefs = prefsOf.get(event.to)
    if (prefs === undefined) {
      prefs = await store.preferences(event.to)
      prefsOf.set(event.to, prefs)
    }
    if (!prefs[category]) continue
    let contacts = contactsOf.get(event.to)
    if (contacts === undefined) {
      contacts = await store.confirmedContacts(event.to)
      contactsOf.set(event.to, contacts)
    }
    if (contacts.length === 0) continue
    const key = eventKey(event)
    const message = render(event, options.context)

    for (const contact of contacts) {
      if (await store.wasSent(event.to, key, contact.id)) {
        skipped++
        continue
      }
      try {
        if (contact.channel === 'email') {
          if (transport.email === null) continue
          await transport.email.send({ to: contact.target, subject: message.subject, text: message.text, unsubscribeUrl: options.unsubscribeUrl(contact) })
        } else {
          if (transport.telegram === null) continue
          await transport.telegram.send(contact.target, `${message.subject}\n\n${message.text}`)
        }
        await store.markSent(event.to, key, contact.id)
        if (contact.failures > 0) await store.clearFailures(contact.id)
        sent++
        logger.info('notify.sent', { kind: event.kind, channel: contact.channel, contact: contact.id })
      } catch (error) {
        failed++
        if (error instanceof DeliveryRefused) {
          const failures = await store.recordFailure(contact.id, options.maxFailures)
          logger.warn('notify.refused', { kind: event.kind, channel: contact.channel, contact: contact.id, failures, error })
          if (failures >= options.maxFailures) {
            contactsOf.set(event.to, contacts.filter((other) => other.id !== contact.id))
          }
        } else {
          logger.error('notify.failed', { kind: event.kind, channel: contact.channel, contact: contact.id, error })
        }
      }
    }
  }
  return { sent, skipped, failed }
}
