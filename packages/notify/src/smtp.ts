/**
 * SMTP submission, the small subset a notifier needs: EHLO, STARTTLS (or
 * implicit TLS on 465), AUTH PLAIN, one recipient, one text part, QUIT.
 *
 * Written rather than depended on for the workspace's usual reason: a mail
 * library is a large surface for one message shape, and this service's
 * whole job is to be boring. The sending server is Kike's own, with DKIM
 * and DMARC in place there (tasks/26), so this client signs nothing and
 * only has to speak the protocol correctly.
 *
 * Every string the message carries is UTF-8: the body goes base64, the
 * subject goes RFC 2047 when it needs to. `List-Unsubscribe` and its
 * `One-Click` form (RFC 8058) are set so a mail client can offer the
 * unsubscribe itself.
 */

import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { randomBytes } from 'node:crypto'

import type { SmtpSettings } from './env.js'
import { DeliveryRefused, type EmailMessage, type EmailSender } from './transport.js'

export class SmtpError extends Error {
  override readonly name = 'SmtpError'
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

interface Reply {
  readonly code: number
  readonly lines: readonly string[]
}

/** A line-oriented reader over a socket, one reply at a time. */
class Session {
  private buffer = ''
  private waiting: ((reply: Reply) => void) | null = null
  private failed: ((error: Error) => void) | null = null
  private socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.feed(chunk))
    socket.on('error', (error) => this.failed?.(error))
    socket.on('close', () => this.failed?.(new SmtpError(0, 'connection closed')))
  }

  swap(socket: Socket): void {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.feed(chunk))
    socket.on('error', (error) => this.failed?.(error))
    socket.on('close', () => this.failed?.(new SmtpError(0, 'connection closed')))
  }

  get raw(): Socket {
    return this.socket
  }

  private feed(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\r\n')
      if (end < 0) return
      // A reply is complete at the first line whose fourth character is a space.
      const lines = this.buffer.split('\r\n')
      let count = 0
      let done = -1
      for (const line of lines) {
        if (line === '' && count === lines.length - 1) break
        count++
        if (/^\d{3}( |$)/.test(line)) {
          done = count
          break
        }
        if (!/^\d{3}-/.test(line)) {
          this.failed?.(new SmtpError(0, `malformed reply: ${line}`))
          return
        }
      }
      if (done < 0) return
      const reply = lines.slice(0, done)
      this.buffer = lines.slice(done).join('\r\n')
      const code = Number(reply[0]?.slice(0, 3))
      const waiting = this.waiting
      this.waiting = null
      waiting?.({ code, lines: reply.map((line) => line.slice(4)) })
      if (this.buffer === '') return
    }
  }

  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.waiting = resolve
      this.failed = reject
    })
  }

  async command(line: string, expect: number): Promise<Reply> {
    const pending = this.read()
    this.socket.write(`${line}\r\n`)
    const reply = await pending
    if (Math.floor(reply.code / 100) !== expect) {
      throw new SmtpError(reply.code, `${line.split(' ')[0]} answered ${reply.code} ${reply.lines.join(' / ')}`)
    }
    return reply
  }
}

const needsEncoding = (value: string): boolean => /[^\x20-\x7e]/.test(value)
const encodeHeader = (value: string): string =>
  needsEncoding(value) ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=` : value

const wrap76 = (base64: string): string => base64.replace(/(.{76})/g, '$1\r\n')

/** `Name <box@host>` or `box@host` → the bare mailbox for the envelope. */
export const mailbox = (from: string): string => {
  const match = /<([^>]+)>/.exec(from)
  return (match?.[1] ?? from).trim()
}

const domainOf = (address: string): string => address.slice(address.indexOf('@') + 1)

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/**
 * The text as a minimal HTML part: paragraphs on blank lines, URLs as links.
 * Not a design, a second rendering of the same words: a text-only message
 * carrying one bare link is the shape spam filters were trained on, and a
 * multipart with a real anchor is what every mail client sends.
 */
export function textToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) =>
    escapeHtml(paragraph)
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, '<br>'),
  )
  return (
    '<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f2348">' +
    paragraphs.map((p) => `<p>${p}</p>`).join('') +
    '</body></html>'
  )
}

const encoded = (value: string): string => wrap76(Buffer.from(value, 'utf8').toString('base64'))

/** The RFC 5322 message, ready for DATA: multipart/alternative, text then HTML. Exported for the tests. */
export function composeMessage(message: EmailMessage, from: string, nowMs: number, id: string): string {
  const boundary = `=_nns_${id}`
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date(nowMs).toUTCString()}`,
    `Message-ID: <${id}@${domainOf(mailbox(from))}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    'Auto-Submitted: auto-generated',
  ]
  if (message.unsubscribeUrl !== null) {
    headers.push(`List-Unsubscribe: <${message.unsubscribeUrl}>`)
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }
  const body = message.unsubscribeUrl === null ? message.text : `${message.text}\n\nStop these messages: ${message.unsubscribeUrl}`
  const part = (type: string, content: string): string =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded(content)}\r\n`
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', body)}${part('text/html', textToHtml(body))}--${boundary}--\r\n`
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && EMAIL.test(value)

function open(settings: SmtpSettings): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      settings.secure === 'tls'
        ? connectTls({ host: settings.host, port: settings.port, servername: settings.host }, () => resolve(socket))
        : connectTcp({ host: settings.host, port: settings.port }, () => resolve(socket))
    socket.setTimeout(30_000, () => socket.destroy(new SmtpError(0, 'timed out')))
    socket.once('error', reject)
  })
}

function upgrade(socket: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket, servername: host }, () => resolve(tls))
    tls.once('error', reject)
  })
}

/**
 * One connection per message. A notifier sends a handful of messages an
 * hour; a pooled connection would be complexity for nothing.
 */
export class SmtpSender implements EmailSender {
  private readonly settings: SmtpSettings
  private readonly now: () => number

  constructor(settings: SmtpSettings, now: () => number = Date.now) {
    this.settings = settings
    this.now = now
  }

  async send(message: EmailMessage): Promise<void> {
    if (!isEmail(message.to)) throw new DeliveryRefused(`not a mailbox: ${message.to}`)
    const socket = await open(this.settings)
    const session = new Session(socket)
    try {
      await session.read()
      const hello = () => session.command(`EHLO ${domainOf(mailbox(this.settings.from)) || 'localhost'}`, 2)
      let features = await hello()
      if (this.settings.secure === 'starttls') {
        if (!features.lines.some((line) => line.toUpperCase().startsWith('STARTTLS'))) {
          throw new SmtpError(0, 'server offers no STARTTLS; refusing to authenticate in the clear')
        }
        await session.command('STARTTLS', 2)
        session.swap(await upgrade(session.raw, this.settings.host))
        features = await hello()
      }
      if (this.settings.user !== '') {
        const plain = Buffer.from(`\0${this.settings.user}\0${this.settings.password}`, 'utf8').toString('base64')
        await session.command(`AUTH PLAIN ${plain}`, 2)
      }
      await session.command(`MAIL FROM:<${mailbox(this.settings.from)}>`, 2)
      try {
        await session.command(`RCPT TO:<${message.to}>`, 2)
      } catch (error) {
        // A 5xx on the recipient is the server saying "never": count it.
        if (error instanceof SmtpError && error.code >= 500) throw new DeliveryRefused(error.message)
        throw error
      }
      await session.command('DATA', 3)
      const data = composeMessage(message, this.settings.from, this.now(), randomBytes(12).toString('hex'))
      // Dot-stuffing: a line that is a single dot would end the message.
      await session.command(`${data.replace(/\r\n\./g, '\r\n..')}.`, 2)
      await session.command('QUIT', 2).catch(() => undefined)
    } finally {
      session.raw.destroy()
    }
  }
}
