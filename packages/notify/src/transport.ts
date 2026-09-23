/**
 * The seam between "what to say" and "how it leaves": one interface, two
 * real implementations (`smtp.ts`, `telegram.ts`) and a fake in the tests.
 * Delivery code never sees a socket.
 */

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
  /** The same words laid out (`email.ts`); without it the text is rendered plainly. */
  readonly html?: string
  /** One click, no login. Goes in the body and in `List-Unsubscribe`. */
  readonly unsubscribeUrl: string | null
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export interface TelegramSender {
  send(chatId: string, text: string): Promise<void>
}

/**
 * A delivery that will never succeed for this contact: a mailbox that does
 * not exist, a chat that blocked the bot. Counted against the contact;
 * anything else is a transient the next poll retries.
 */
export class DeliveryRefused extends Error {
  override readonly name = 'DeliveryRefused'
}

export interface Transport {
  readonly email: EmailSender | null
  readonly telegram: TelegramSender | null
}
