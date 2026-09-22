/**
 * The SMTP client against a fake server on a local port: the exact command
 * sequence, the message on the wire, and the two refusals that matter (no
 * STARTTLS offered, a recipient the server rejects).
 */

import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import type { SmtpSettings } from './env.js'
import { SmtpSender, composeMessage, isEmail } from './smtp.js'
import { DeliveryRefused } from './transport.js'

interface FakeSmtp {
  readonly server: Server
  readonly port: number
  readonly received: string[]
  readonly data: string[]
}

function fakeSmtp(options: { starttls?: boolean; rejectRcpt?: boolean } = {}): Promise<FakeSmtp> {
  const received: string[] = []
  const data: string[] = []
  const server = createServer((socket: Socket) => {
    let inData = false
    let buffer = ''
    socket.write('220 fake.example ESMTP\r\n')
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 queued\r\n')
          } else data.push(line)
          continue
        }
        received.push(line)
        const verb = line.split(' ')[0]?.toUpperCase()
        if (verb === 'EHLO') socket.write(options.starttls ? '250-fake.example\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n' : '250-fake.example\r\n250 AUTH PLAIN\r\n')
        else if (verb === 'AUTH') socket.write('235 ok\r\n')
        else if (verb === 'MAIL') socket.write('250 ok\r\n')
        else if (verb === 'RCPT') socket.write(options.rejectRcpt ? '550 no such user\r\n' : '250 ok\r\n')
        else if (verb === 'DATA') {
          inData = true
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else socket.write('500 what\r\n')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, received, data }))
  })
}

const settings = (port: number, secure: SmtpSettings['secure']): SmtpSettings => ({
  host: '127.0.0.1',
  port,
  secure,
  user: 'notify@nimiqnames.com',
  password: 'hunter2',
  from: 'Nimiq Names <notify@nimiqnames.com>',
})

describe('SmtpSender', () => {
  let fake: FakeSmtp | null = null
  afterEach(async () => {
    if (fake !== null) await new Promise<void>((resolve) => fake?.server.close(() => resolve()))
    fake = null
  })

  it('speaks the submission sequence and puts the message on the wire', async () => {
    fake = await fakeSmtp()
    const sender = new SmtpSender(settings(fake.port, 'plain'), () => Date.parse('2026-09-23T12:00:00Z'))
    await sender.send({ to: 'kike@example.com', subject: 'riconame can be renewed', text: 'Hello\n.\nbye', unsubscribeUrl: 'https://nimiqnames.com/notify/unsubscribe/t0k' })
    expect(fake.received.map((line) => line.split(' ')[0])).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    expect(fake.received[1]).toBe(`AUTH PLAIN ${Buffer.from('\0notify@nimiqnames.com\0hunter2').toString('base64')}`)
    expect(fake.received[2]).toBe('MAIL FROM:<notify@nimiqnames.com>')
    expect(fake.received[3]).toBe('RCPT TO:<kike@example.com>')
    const wire = fake.data.join('\r\n')
    expect(wire).toContain('From: Nimiq Names <notify@nimiqnames.com>')
    expect(wire).toContain('Subject: riconame can be renewed')
    expect(wire).toContain('List-Unsubscribe: <https://nimiqnames.com/notify/unsubscribe/t0k>')
    expect(wire).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
    const body = Buffer.from(wire.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '', 'base64').toString('utf8')
    expect(body).toContain('Hello\n.\nbye')
    expect(body).toContain('Stop these messages: https://nimiqnames.com/notify/unsubscribe/t0k')
  })

  it('refuses to authenticate in the clear when STARTTLS is not offered', async () => {
    fake = await fakeSmtp({ starttls: false })
    const sender = new SmtpSender(settings(fake.port, 'starttls'))
    await expect(sender.send({ to: 'kike@example.com', subject: 's', text: 't', unsubscribeUrl: null })).rejects.toThrow(/STARTTLS/)
    expect(fake.received.some((line) => line.startsWith('AUTH'))).toBe(false)
  })

  it('reports a rejected recipient as a refusal, not a transient failure', async () => {
    fake = await fakeSmtp({ rejectRcpt: true })
    const sender = new SmtpSender(settings(fake.port, 'plain'))
    await expect(sender.send({ to: 'nobody@example.com', subject: 's', text: 't', unsubscribeUrl: null })).rejects.toBeInstanceOf(DeliveryRefused)
  })
})

describe('composeMessage', () => {
  it('encodes a non-ASCII subject and always base64s the body', () => {
    const wire = composeMessage({ to: 'a@b.co', subject: 'Última llamada', text: 'ñ', unsubscribeUrl: null }, 'n@x.io', 0, 'id1')
    expect(wire).toContain(`Subject: =?UTF-8?B?${Buffer.from('Última llamada').toString('base64')}?=`)
    expect(wire).toContain('Message-ID: <id1@x.io>')
    expect(wire).not.toContain('List-Unsubscribe')
    expect(wire.endsWith(`${Buffer.from('ñ').toString('base64')}\r\n`)).toBe(true)
  })

  it('knows a mailbox from a string', () => {
    expect(isEmail('kike@example.com')).toBe(true)
    expect(isEmail('kike@example')).toBe(false)
    expect(isEmail('@example.com')).toBe(false)
    expect(isEmail(42)).toBe(false)
  })
})
