import { describe, expect, it } from 'vitest'
import {
  CHAT_MAX_BYTES,
  attributedFrom,
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

/**
 * Real mainnet material, block 59,516,314 — the same EarlyResolve proof
 * `core/attribution.test.ts` pins: Nimiq Pay's HTLC spending with the
 * co-signer's signature first and the contract sender's (the user's Local
 * wallet) second.
 */
const MAINNET_EARLY_RESOLVE =
  '010091b21f4b100273bd7034f6369c29d1f7ba72dba7de6720ad3cd8b8191621891300668acc228bf8ad0a832757b1e92b549e07f775937c2b4d2818d555943bef1c8421728d8f7bd4695d85fb3b626b541dcb0e3fbd791357d8720596c3b89547f506009e1ffbdc365402365800270b0b68904e51514e8bb05e48cd5e7310ba1412f6a2008525da9a0f4d04539a1a606df4b39307eeec06df1cf2e2c3d65030bcf4f675967425e34eb68cee64d3b7e9c6ea935ddc1ffa110565ead6a92aaf912d7fb1fb03'
const LOCAL = 'NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9'
const HTLC = 'NQ89 R3HN 70XQ 2E5A L4YS CV2Q UL5J 84TX 8L8H'

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

  /**
   * A subdomain has no owner and no record (§8.6) — the only party `rico.nns`
   * designates is the address its parent's host answered with. So the subject
   * has to be able to say `rico.nns`; naming the parent instead addressed
   * whoever runs the host (Kike, 2026-08-28).
   */
  it('accepts a dotted subject, and roundtrips it', () => {
    const encoded = encodeChatPayload('rico.nns', 'is this free?')
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(parseChatPayload(encoded.dataHex)).toEqual({ name: 'rico.nns', message: 'is this free?' })
  })

  it('applies label rules to the label and name rules to the parent', () => {
    // A label floors at 1 character and needs no letter (§4.4); the parent is
    // a name and takes §4.1's syntax.
    expect(encodeChatPayload('a.example', 'hi').ok).toBe(true)
    expect(encodeChatPayload('-rico.nns', 'hi')).toEqual({ ok: false, reason: 'BAD_NAME' })
    expect(encodeChatPayload('rico.-nns', 'hi')).toEqual({ ok: false, reason: 'BAD_NAME' })
    expect(encodeChatPayload('a.b.c', 'hi')).toEqual({ ok: false, reason: 'BAD_NAME' })
    expect(encodeChatPayload('rico.', 'hi')).toEqual({ ok: false, reason: 'BAD_NAME' })
    expect(encodeChatPayload('.nns', 'hi')).toEqual({ ok: false, reason: 'BAD_NAME' })
  })

  it('the budget shrinks by the whole dotted subject', () => {
    expect(chatByteBudget('rico.nns')).toBe(chatByteBudget('nns') - 5)
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

describe('attribution — the effective sender reaches the inbox (r25)', () => {
  it('attributes an HTLC send to its authorizing key, in spaced form', () => {
    expect(attributedFrom({ from: HTLC, fromType: 2, proof: MAINNET_EARLY_RESOLVE })).toBe(LOCAL)
  })

  it('answers the account unchanged when attribution does not apply', () => {
    // Not an HTLC; an HTLC with no proof carried; an unrecognised proof shape.
    expect(attributedFrom({ from: PEER, fromType: 0, proof: MAINNET_EARLY_RESOLVE })).toBe(PEER)
    expect(attributedFrom({ from: HTLC, fromType: 2 })).toBe(HTLC)
    expect(attributedFrom({ from: HTLC, fromType: 2, proof: '00ff' })).toBe(HTLC)
  })

  it('an incoming Pay message has the durable wallet as its peer, never the contract', () => {
    const messages = chatMessages(
      [tx({ from: HTLC, fromType: 2, proof: MAINNET_EARLY_RESOLVE })],
      [ME],
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.direction).toBe('in')
    expect(messages[0]?.peer).toBe(LOCAL)
  })

  it('my own Pay send is mine even when the signing contract is not in my set', () => {
    // The rotation case: the HTLC that signed has been destroyed and is no
    // longer a listAccounts member — the message must not vanish or flip 'in'.
    const messages = chatMessages(
      [tx({ from: HTLC, fromType: 2, proof: MAINNET_EARLY_RESOLVE, to: PEER })],
      [LOCAL],
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.direction).toBe('out')
    expect(messages[0]?.peer).toBe(PEER)
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
