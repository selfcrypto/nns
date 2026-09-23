/**
 * The HTTP surface. CORS open to any origin, as the chat index is: the app
 * is a static bundle anyone may host (§2.2). Authority comes from the
 * bearer session, never from the origin.
 *
 *   POST /challenge            {address}                    → {nonce, text, expires}
 *   POST /session              {nonce, publicKey, signature} → {token, address, expires}
 *   GET  /settings             bearer                       → the address's contacts, preferences, channels
 *   PUT  /settings             bearer {preferences}
 *   POST /contacts/email       bearer {email}               → 202, a confirmation is mailed
 *   POST /contacts/telegram    bearer                       → {link, expires}
 *   DELETE /contacts/{id}      bearer
 *   POST /logout               bearer
 *   POST /delete               bearer                       → everything about the address is gone
 *   GET  /confirm/{token}                                   → a page: the email is confirmed
 *   GET|POST /unsubscribe/{token}                           → a page: the contact is gone
 *   GET  /healthz
 *
 * A contact is shown masked (`k…e@example.com`, a chat id never): the sheet
 * needs to say "which one", not to repeat it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { emailBody, greetingFor } from './email.js'
import { CATEGORIES } from './events.js'
import { Limiter } from './limiter.js'
import type { Logger } from './logger.js'
import { CHALLENGE_TTL_MS, canonicalAddress, challengeText, verifyChallenge } from './session.js'
import { isEmail } from './smtp.js'
import { hashToken, isToken, randomNonce, randomToken } from './tokens.js'
import type { Contact, Preferences, Store } from './store.js'
import type { EmailSender } from './transport.js'
import type { SignedMessageConvention } from '@nimiqnames/core'

export interface ServerOptions {
  readonly store: Store
  readonly logger: Logger
  readonly host: string
  readonly publicUrl: string
  readonly appUrl: string
  readonly conventions: readonly SignedMessageConvention[]
  readonly sessionTtlMs: number
  /** The bot's username, or null when Telegram is off. */
  readonly telegramBot: string | null
  readonly email: EmailSender | null
  /** The first name an address holds, for the greeting. Null when unknown or absent. */
  readonly nameOf?: (address: string) => Promise<string | null>
  readonly now?: () => number
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
}

const MAX_BODY = 4096
const EMAIL_CONFIRM_TTL_MS = 24 * 3_600_000
const TELEGRAM_LINK_TTL_MS = 60 * 60_000

export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...CORS })
  response.end(JSON.stringify(body))
}

const page = (response: ServerResponse, status: number, title: string, text: string, appUrl: string): void => {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...CORS })
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;color:#1f2348;background:#f6f7fb}main{max-width:480px;margin:0 auto}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5}a{color:#0582ca}</style></head>` +
      `<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p><p><a href="${escape(appUrl)}">Back to the app</a></p></main></body></html>`,
  )
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', `the body may not exceed ${MAX_BODY} bytes`)
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'the body must be a JSON object')
  }
}

/** The caller's address: the edge's header when behind one, else the socket's. */
const clientIp = (request: IncomingMessage): string => {
  const forwarded = request.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return first !== undefined && first !== '' ? first : (request.socket.remoteAddress ?? 'unknown')
}

export const maskEmail = (email: string): string => {
  const at = email.indexOf('@')
  if (at < 1) return '…'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  return `${local[0]}${local.length > 2 ? '…' : ''}${local.length > 1 ? local[local.length - 1] : ''}${domain}`
}

const publicContact = (contact: Contact) => ({
  id: contact.id,
  channel: contact.channel,
  target: contact.channel === 'email' ? maskEmail(contact.target) : null,
  confirmed: contact.confirmed,
})

function parsePreferences(value: unknown): Preferences {
  if (typeof value !== 'object' || value === null) throw new HttpError(400, 'BAD_PREFERENCES', 'preferences must be an object of booleans')
  const record = value as Record<string, unknown>
  const prefs: Record<string, boolean> = {}
  for (const category of CATEGORIES) {
    const flag = record[category]
    if (typeof flag !== 'boolean') throw new HttpError(400, 'BAD_PREFERENCES', `preferences.${category} must be a boolean`)
    prefs[category] = flag
  }
  return prefs as Preferences
}

export function createNotifyServer(options: ServerOptions): Server {
  const { store, logger } = options
  const now = options.now ?? Date.now
  const challengePerIp = new Limiter(20, 60_000, now)
  const sessionPerIp = new Limiter(20, 60_000, now)
  const emailPerIp = new Limiter(10, 3_600_000, now)
  const emailPerAddress = new Limiter(3, 600_000, now)
  const confirmPerIp = new Limiter(30, 60_000, now)
  const sweep = setInterval(() => {
    for (const limiter of [challengePerIp, sessionPerIp, emailPerIp, emailPerAddress, confirmPerIp]) limiter.sweep()
  }, 600_000)
  sweep.unref()

  const bearer = async (request: IncomingMessage): Promise<{ address: string; tokenHash: string }> => {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!isToken(token)) throw new HttpError(401, 'NO_SESSION', 'sign in first')
    const tokenHash = hashToken(token)
    const address = await store.sessionAddress(tokenHash, new Date(now()))
    if (address === null) throw new HttpError(401, 'NO_SESSION', 'the session has expired; sign in again')
    return { address, tokenHash }
  }

  const settingsOf = async (address: string) => ({
    address,
    preferences: await store.preferences(address),
    contacts: (await store.contacts(address)).map(publicContact),
    channels: { email: options.email !== null, telegram: options.telegramBot !== null },
  })

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const method = request.method ?? 'GET'
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const ip = clientIp(request)

    if (method === 'OPTIONS') {
      response.writeHead(204, CORS)
      response.end()
      return
    }

    if (path === '/healthz' && method === 'GET') {
      json(response, 200, { ok: true, channels: { email: options.email !== null, telegram: options.telegramBot !== null } })
      return
    }

    if (path === '/challenge' && method === 'POST') {
      if (!challengePerIp.take(ip)) throw new HttpError(429, 'RATE_LIMITED', 'too many challenges; try again in a minute')
      const body = await readJson(request)
      const address = canonicalAddress(body['address'])
      if (address === null) throw new HttpError(400, 'BAD_ADDRESS', 'address must be a Nimiq address')
      const nonce = randomNonce()
      const expires = new Date(now() + CHALLENGE_TTL_MS)
      const text = challengeText(address, options.host, nonce, expires)
      await store.createChallenge(nonce, address, text, expires)
      json(response, 200, { nonce, text, expires: expires.toISOString() })
      return
    }

    if (path === '/session' && method === 'POST') {
      if (!sessionPerIp.take(ip)) throw new HttpError(429, 'RATE_LIMITED', 'too many sign-ins; try again in a minute')
      const body = await readJson(request)
      const { nonce, publicKey, signature } = body
      if (typeof nonce !== 'string' || typeof publicKey !== 'string' || typeof signature !== 'string') {
        throw new HttpError(400, 'BAD_REQUEST', 'nonce, publicKey and signature are required')
      }
      const challenge = await store.takeChallenge(nonce, new Date(now()))
      if (challenge === null) throw new HttpError(410, 'CHALLENGE_EXPIRED', 'the challenge is unknown or expired; ask for a new one')
      const verdict = verifyChallenge(challenge.text, challenge.address, publicKey, signature, options.conventions)
      if (!verdict.ok) {
        if (verdict.reason === 'ADDRESS_MISMATCH') {
          json(response, 409, { error: 'ADDRESS_MISMATCH', message: 'the signature is from a different address', signer: verdict.signer })
          return
        }
        throw new HttpError(401, 'BAD_SIGNATURE', 'the signature does not verify')
      }
      const token = randomToken()
      const expires = new Date(now() + options.sessionTtlMs)
      await store.createSession(hashToken(token), verdict.address, expires)
      logger.info('notify.signed-in', { convention: verdict.convention })
      json(response, 200, { token, address: verdict.address, expires: expires.toISOString() })
      return
    }

    if (path === '/settings' && method === 'GET') {
      const { address } = await bearer(request)
      json(response, 200, await settingsOf(address))
      return
    }

    if (path === '/settings' && method === 'PUT') {
      const { address } = await bearer(request)
      const body = await readJson(request)
      await store.setPreferences(address, parsePreferences(body['preferences']))
      json(response, 200, await settingsOf(address))
      return
    }

    if (path === '/contacts/email' && method === 'POST') {
      const { address } = await bearer(request)
      if (options.email === null) throw new HttpError(503, 'NO_EMAIL', 'this service does not send email')
      if (!emailPerIp.take(ip) || !emailPerAddress.take(address)) {
        throw new HttpError(429, 'RATE_LIMITED', 'too many confirmation emails; try again later')
      }
      const body = await readJson(request)
      const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : ''
      if (!isEmail(email)) throw new HttpError(400, 'BAD_EMAIL', 'email must be a mailbox')
      const confirm = randomToken()
      const contact = await store.addEmail(address, email, hashToken(confirm), new Date(now() + EMAIL_CONFIRM_TTL_MS), randomToken())
      if (!contact.confirmed) {
        try {
          const name = options.nameOf === undefined ? null : await options.nameOf(address)
          // One click deletes the pending row: the same as ignoring it, sooner.
          const unsubscribeUrl = `${options.publicUrl}/unsubscribe/${contact.unsubscribeToken}`
          const body = emailBody(options.appUrl, {
            greeting: greetingFor(name),
            paragraphs: [
              'Thank you for using Nimiq Names.',
              `This email address was added in the app to receive notifications for ${address}: renewal reminders, sales and bids, transfers and new messages.`,
              'Confirm it with the button below. The link works once and expires in 24 hours.',
              'If you did not add it, ignore this message: nothing is sent until the link is opened.',
            ],
            cta: { label: 'Confirm email', url: `${options.publicUrl}/confirm/${confirm}` },
            reason: `You receive this because this address was entered in the Nimiq Names app for ${address}.`,
            unsubscribeUrl,
          })
          await options.email.send({ to: email, subject: 'Confirm your email for Nimiq Names', text: body.text, html: body.html, unsubscribeUrl })
        } catch (error) {
          // A row waiting for a mail that never left is a lie the sheet would
          // keep telling; the address is dropped and the caller told to retry.
          await store.deleteContact(address, contact.id)
          logger.error('notify.confirm.failed', { error })
          throw new HttpError(502, 'MAIL_FAILED', 'the confirmation email could not be sent; try again')
        }
      }
      json(response, 202, { contact: publicContact(contact) })
      return
    }

    if (path === '/contacts/telegram' && method === 'POST') {
      const { address } = await bearer(request)
      if (options.telegramBot === null) throw new HttpError(503, 'NO_TELEGRAM', 'this service has no Telegram bot')
      const token = randomToken()
      const expires = new Date(now() + TELEGRAM_LINK_TTL_MS)
      await store.createTelegramLink(hashToken(token), address, expires)
      json(response, 200, { link: `https://t.me/${options.telegramBot}?start=${token}`, expires: expires.toISOString() })
      return
    }

    const contactMatch = /^\/contacts\/(\d{1,12})$/.exec(path)
    if (contactMatch !== null && method === 'DELETE') {
      const { address } = await bearer(request)
      const removed = await store.deleteContact(address, Number(contactMatch[1]))
      if (!removed) throw new HttpError(404, 'NO_CONTACT', 'no such contact')
      json(response, 200, await settingsOf(address))
      return
    }

    if (path === '/logout' && method === 'POST') {
      const { tokenHash } = await bearer(request)
      await store.deleteSession(tokenHash)
      json(response, 200, { ok: true })
      return
    }

    if (path === '/delete' && method === 'POST') {
      const { address } = await bearer(request)
      await store.deleteAddress(address)
      logger.info('notify.deleted', {})
      json(response, 200, { ok: true })
      return
    }

    const confirmMatch = /^\/confirm\/([A-Za-z0-9_-]{16,64})$/.exec(path)
    if (confirmMatch !== null && method === 'GET') {
      if (!confirmPerIp.take(ip)) throw new HttpError(429, 'RATE_LIMITED', 'too many requests')
      const contact = await store.confirmEmail(hashToken(confirmMatch[1] ?? ''), new Date(now()))
      if (contact === null) {
        page(response, 410, 'This link has expired', 'Open the app, sign in and add the email again to get a fresh one.', options.appUrl)
        return
      }
      page(response, 200, 'Email confirmed', `${maskEmail(contact.target)} will receive notifications for ${contact.address}.`, options.appUrl)
      return
    }

    const unsubscribeMatch = /^\/unsubscribe\/([A-Za-z0-9_-]{16,64})$/.exec(path)
    if (unsubscribeMatch !== null && (method === 'GET' || method === 'POST')) {
      if (!confirmPerIp.take(ip)) throw new HttpError(429, 'RATE_LIMITED', 'too many requests')
      const contact = await store.unsubscribe(unsubscribeMatch[1] ?? '')
      if (contact === null) {
        page(response, 200, 'Already unsubscribed', 'This contact receives no notifications.', options.appUrl)
        return
      }
      page(response, 200, 'Unsubscribed', `No more notifications will be sent to this ${contact.channel === 'email' ? 'mailbox' : 'chat'} for ${contact.address}.`, options.appUrl)
      return
    }

    throw new HttpError(404, 'UNKNOWN_ROUTE', 'no such route')
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.code, message: error.message })
        return
      }
      logger.error('notify.http.failed', { path: request.url, error })
      json(response, 500, { error: 'INTERNAL', message: 'the service could not answer' })
    })
  })
}
