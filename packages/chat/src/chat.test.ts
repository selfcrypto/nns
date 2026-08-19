import { describe, expect, it } from 'vitest'
import {
  CHAT_MAX_BYTES,
  chatByteBudget,
  chatConversations,
  chatMessages,
  encodeChatPayload,
  messageBytes,
  parseChatPayload,
  peerIdentity,
  subjectBreaks,
  type ChatTx,
} from './index.js'

const ME = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const PEER = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const tx = (over: Partial<ChatTx>): ChatTx => ({
  hash: 'h1',
  blockNumber: 100,
  timestamp: 1_000,
  from: PEER,
  to: ME,
  recipientData: hex('NC1example|hello'),
  executionResult: true,
  ...over,
})

describe('encode/parse roundtrip', () => {
  it('roundtrips a message', () => {
    const encoded = encodeChatPayload('example', 'want to sell?')
    expect(encoded.ok).toBe(true)
    if (encoded.ok) {
      expect(parseChatPayload(encoded.dataHex)).toEqual({ name: 'example', message: 'want to sell?' })
    }
  })

  it('the prefix is NC1 and never anything starting NNS1', () => {
    const encoded = encodeChatPayload('example', 'hi')
    expect(encoded.ok && Buffer.from(encoded.dataHex, 'hex').toString().startsWith('NC1')).toBe(true)
    expect(encoded.ok && Buffer.from(encoded.dataHex, 'hex').toString().startsWith('NNS1')).toBe(false)
  })

  it('64 bytes exactly fits; 65 is refused — the network cap is a silent drop', () => {
    const name = 'example'
    const budget = chatByteBudget(name)
    expect(budget).toBe(CHAT_MAX_BYTES - 3 - name.length - 1)
    const atLimit = encodeChatPayload(name, 'a'.repeat(budget))
    expect(atLimit.ok).toBe(true)
    if (atLimit.ok) expect(atLimit.dataHex.length / 2).toBe(64)
    const over = encodeChatPayload(name, 'a'.repeat(budget + 1))
    expect(over).toEqual({ ok: false, reason: 'OVER_BUDGET' })
  })

  it('counts UTF-8 bytes, not characters', () => {
    expect(messageBytes('🙂')).toBe(4)
    const budget = chatByteBudget('example')
    const emojis = '🙂'.repeat(Math.floor(budget / 4) + 1)
    expect(encodeChatPayload('example', emojis)).toEqual({ ok: false, reason: 'OVER_BUDGET' })
  })

  it('refuses control characters, empty messages, and bad names', () => {
    expect(encodeChatPayload('example', 'a\nb')).toEqual({ ok: false, reason: 'CONTROL_CHARS' })
    expect(encodeChatPayload('example', '')).toEqual({ ok: false, reason: 'EMPTY_MESSAGE' })
    expect(encodeChatPayload('-bad-', 'hi')).toEqual({ ok: false, reason: 'BAD_NAME' })
  })

  it('accepts an awarded short name — syntax, not the reserved floor', () => {
    expect(encodeChatPayload('nq', 'hi').ok).toBe(true)
  })

  it('parse refuses non-NC1 data, NNS1 payloads included', () => {
    expect(parseChatPayload(hex('NNS1Gexample'))).toBeNull()
    expect(parseChatPayload(hex('NC2example|hi'))).toBeNull()
    expect(parseChatPayload(hex('NC1example'))).toBeNull()
    expect(parseChatPayload('zz')).toBeNull()
    expect(parseChatPayload('')).toBeNull()
  })
})

describe('inbox derivation', () => {
  it('keeps only executed NC transactions touching me, in timestamp order', () => {
    const messages = chatMessages(
      [
        tx({ hash: 'h2', timestamp: 3_000, from: ME, to: PEER, recipientData: hex('NC1example|reply') }),
        tx({ hash: 'h1', timestamp: 1_000 }),
        tx({ hash: 'h3', recipientData: hex('NNS1Gexample'), timestamp: 2_000 }),
        tx({ hash: 'h4', executionResult: false, timestamp: 2_500 }),
        tx({ hash: 'h5', recipientData: '', timestamp: 2_600 }),
      ],
      [ME],
    )
    expect(messages.map((message) => message.hash)).toEqual(['h1', 'h2'])
    expect(messages[0]?.direction).toBe('in')
    expect(messages[1]?.direction).toBe('out')
    expect(messages[1]?.peer).toBe(PEER)
  })

  it('is one conversation per peer, whatever names the messages are about', () => {
    const messages = chatMessages(
      [
        tx({ hash: 'h1', timestamp: 1_000, recipientData: hex('NC1example|about example') }),
        tx({ hash: 'h2', timestamp: 2_000, recipientData: hex('NC1other-name|about other') }),
      ],
      [ME],
    )
    const conversations = chatConversations(messages)
    expect(conversations).toHaveLength(1)
    expect(conversations[0]?.peer).toBe(PEER)
    expect(conversations[0]?.messages).toHaveLength(2)
    // A reply continues the newest subject, not the one the thread opened on.
    expect(conversations[0]?.lastName).toBe('other-name')
  })

  it('orders conversations newest first', () => {
    const other = 'NQ55 5555 5555 5555 5555 5555 5555 5555 5555'
    const messages = chatMessages(
      [
        tx({ hash: 'h1', timestamp: 1_000 }),
        tx({ hash: 'h2', timestamp: 5_000, from: other, recipientData: hex('NC1example|later') }),
      ],
      [ME],
    )
    expect(chatConversations(messages).map((one) => one.peer)).toEqual([other, PEER])
  })

  it('announces the subject once, and again only when it changes', () => {
    const messages = chatMessages(
      [
        tx({ hash: 'h1', timestamp: 1_000, recipientData: hex('NC1example|first') }),
        tx({ hash: 'h2', timestamp: 2_000, recipientData: hex('NC1example|same subject') }),
        tx({ hash: 'h3', timestamp: 3_000, recipientData: hex('NC1other-name|new subject') }),
      ],
      [ME],
    )
    expect(subjectBreaks(messages).map((entry) => entry.showSubject)).toEqual([true, false, true])
  })
})

describe('peer identity', () => {
  it('shows live names shortest first and counts the overflow', () => {
    const identity = peerIdentity(
      [
        { name: 'longer-name', status: 'REGISTERED' },
        { name: 'kike', status: 'REGISTERED' },
        { name: 'rico', status: 'REGISTERED' },
        { name: 'abc', status: 'REGISTERED' },
      ],
      2,
    )
    expect(identity.shown).toEqual(['abc', 'kike'])
    expect(identity.more).toBe(2)
  })

  it('leaves out a name in GRACE — it has stopped resolving', () => {
    const identity = peerIdentity([
      { name: 'lapsed', status: 'GRACE' },
      { name: 'held', status: 'REGISTERED' },
    ])
    expect(identity.shown).toEqual(['held'])
    expect(identity.more).toBe(0)
  })

  it('answers empty for an address holding nothing, so the UI falls back to the address', () => {
    expect(peerIdentity([])).toEqual({ shown: [], more: 0 })
  })
})
