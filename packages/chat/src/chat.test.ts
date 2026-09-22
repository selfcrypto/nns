import { describe, expect, it } from 'vitest'
import {
  CHAT_MAX_BYTES,
  CHAT_MIN_HEIGHT,
  attributedFrom,
  chatByteBudget,
  chatConversations,
  chatMessages,
  encodeChatPayload,
  messageBytes,
  parseChatPayload,
  peerIdentity,
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

// In the era by default: `chatMessages` drops anything below CHAT_MIN_HEIGHT.
const tx = (over: Partial<ChatTx>): ChatTx => ({
  hash: 'h1',
  blockNumber: CHAT_MIN_HEIGHT,
  timestamp: 1_000,
  from: PEER,
  to: ME,
  recipientData: hex('NC1hello'),
  executionResult: true,
  ...over,
})

describe('encode/parse roundtrip', () => {
  it('roundtrips a message', () => {
    const encoded = encodeChatPayload('want to sell?')
    expect(encoded.ok).toBe(true)
    if (encoded.ok) {
      expect(parseChatPayload(encoded.dataHex)).toEqual({ message: 'want to sell?' })
    }
  })

  it('the prefix is NC1 and never anything starting NNS1', () => {
    const encoded = encodeChatPayload('hi')
    expect(encoded.ok && Buffer.from(encoded.dataHex, 'hex').toString().startsWith('NC1')).toBe(true)
    expect(encoded.ok && Buffer.from(encoded.dataHex, 'hex').toString().startsWith('NNS1')).toBe(false)
  })

  it('64 bytes exactly fits; 65 is refused — the network cap is a silent drop', () => {
    const budget = chatByteBudget()
    expect(budget).toBe(CHAT_MAX_BYTES - 3)
    const atLimit = encodeChatPayload('a'.repeat(budget))
    expect(atLimit.ok).toBe(true)
    if (atLimit.ok) expect(atLimit.dataHex.length / 2).toBe(64)
    const over = encodeChatPayload('a'.repeat(budget + 1))
    expect(over).toEqual({ ok: false, reason: 'OVER_BUDGET' })
  })

  // The subject used to eat 4 + len(name): 57 bytes for a message about a
  // 5-character name, 11 for the longest dotted one (Rico, 2026-09-15).
  it('is the same budget whatever the message is about', () => {
    expect(chatByteBudget()).toBe(61)
  })

  it('counts UTF-8 bytes, not characters', () => {
    expect(messageBytes('🙂')).toBe(4)
    const emojis = '🙂'.repeat(Math.floor(chatByteBudget() / 4) + 1)
    expect(encodeChatPayload(emojis)).toEqual({ ok: false, reason: 'OVER_BUDGET' })
  })

  it('refuses control characters and empty messages', () => {
    expect(encodeChatPayload('a\nb')).toEqual({ ok: false, reason: 'CONTROL_CHARS' })
    expect(encodeChatPayload('')).toEqual({ ok: false, reason: 'EMPTY_MESSAGE' })
  })

  it('roundtrips a message and nothing else', () => {
    const encoded = encodeChatPayload('is this free?')
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(parseChatPayload(encoded.dataHex)).toEqual({ message: 'is this free?' })
  })

  /**
   * The prefix was kept when the subject was dropped (Rico, 2026-09-15), so a
   * payload written in the old three-field shape still parses — as the literal
   * text it now is. `CHAT_MIN_HEIGHT` is what keeps that from mattering: every
   * message older than this era is dropped before a reader sees it.
   */
  it('reads a pre-2026-09-15 payload as the message it now is', () => {
    expect(parseChatPayload(hex('NC1nns|testing message'))).toEqual({ message: 'nns|testing message' })
  })

  it('parse refuses non-NC1 data, NNS1 payloads included', () => {
    expect(parseChatPayload(hex('NNS1Gexample'))).toBeNull()
    expect(parseChatPayload(hex('NC2example|hi'))).toBeNull()
    expect(parseChatPayload(hex('NC1'))).toBeNull()
    expect(parseChatPayload('zz')).toBeNull()
    expect(parseChatPayload('')).toBeNull()
  })
})

describe('inbox derivation', () => {
  it('keeps only executed NC transactions touching me, in timestamp order', () => {
    const messages = chatMessages(
      [
        tx({ hash: 'h2', timestamp: 3_000, from: ME, to: PEER, recipientData: hex('NC1reply') }),
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

  it('is one conversation per peer', () => {
    const messages = chatMessages(
      [
        tx({ hash: 'h1', timestamp: 1_000, recipientData: hex('NC1first') }),
        tx({ hash: 'h2', timestamp: 2_000, recipientData: hex('NC1second') }),
      ],
      [ME],
    )
    const conversations = chatConversations(messages)
    expect(conversations).toHaveLength(1)
    expect(conversations[0]?.peer).toBe(PEER)
    expect(conversations[0]?.messages).toHaveLength(2)
  })

  /**
   * The inbox showed threads from before this era — about names that had since
   * changed hands, so a conversation was headed by a name the address no
   * longer held (Rico, 2026-09-15). No reader in the path applied a floor.
   */
  it('drops anything below CHAT_MIN_HEIGHT', () => {
    const messages = chatMessages(
      [
        tx({ hash: 'old', timestamp: 1_000, blockNumber: CHAT_MIN_HEIGHT - 1, recipientData: hex('NC1before the era') }),
        tx({ hash: 'new', timestamp: 2_000, blockNumber: CHAT_MIN_HEIGHT, recipientData: hex('NC1in the era') }),
      ],
      [ME],
    )
    expect(messages.map((message) => message.hash)).toEqual(['new'])
  })

  it('orders conversations newest first', () => {
    const other = 'NQ55 5555 5555 5555 5555 5555 5555 5555 5555'
    const messages = chatMessages(
      [
        tx({ hash: 'h1', timestamp: 1_000 }),
        tx({ hash: 'h2', timestamp: 5_000, from: other, recipientData: hex('NC1later') }),
      ],
      [ME],
    )
    expect(chatConversations(messages).map((one) => one.peer)).toEqual([other, PEER])
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
        { name: 'rico', status: 'REGISTERED' },
        { name: 'rico', status: 'REGISTERED' },
        { name: 'abc', status: 'REGISTERED' },
      ],
      2,
    )
    expect(identity.shown).toEqual(['abc', 'rico'])
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
