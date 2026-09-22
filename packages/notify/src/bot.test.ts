import { describe, expect, it, vi } from 'vitest'

import { botReply, type BotDeps } from './bot.js'
import type { NameLookup } from './source.js'

const ADDRESS = 'NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H'
const HEAD = 62_400_000

const deps = (over: Partial<BotDeps> = {}): BotDeps => ({
  link: vi.fn(async (token: string) => (token === 'good-token-good-token' ? ADDRESS : null)),
  unlink: vi.fn(async () => 1),
  addressesOf: vi.fn(async () => [ADDRESS]),
  namesOf: vi.fn(async () => ['riconame', 'other']),
  lookup: vi.fn(async (name: string): Promise<NameLookup> => {
    if (name === 'riconame') {
      return { kind: 'registered', record: { name, owner: ADDRESS, target: ADDRESS, expiry: HEAD + 86_400 * 10, status: 'REGISTERED' } }
    }
    if (name === 'nimiq') return { kind: 'reserved' }
    return { kind: 'available' }
  }),
  head: async () => HEAD,
  appUrl: 'https://nimiqnames.com',
  nowMs: () => Date.parse('2026-09-23T12:00:00Z'),
  ...over,
})

describe('botReply', () => {
  it('binds the chat on /start with the app’s token, and explains itself without one', async () => {
    const d = deps()
    expect(await botReply('/start good-token-good-token', '42', d)).toContain(`notifications for ${ADDRESS}`)
    expect(d.link).toHaveBeenCalledWith('good-token-good-token', '42')
    expect(await botReply('/start stale', '42', d)).toContain('expired')
    expect(await botReply('/start', '42', d)).toContain('Connect Telegram')
  })

  it('unlinks on /stop', async () => {
    expect(await botReply('/stop', '42', deps())).toContain('Unlinked')
    expect(await botReply('/stop', '42', deps({ unlink: async () => 0 }))).toContain('not linked')
  })

  it('lists the names of the linked addresses', async () => {
    expect(await botReply('/names', '42', deps())).toBe(`${ADDRESS}\nriconame\nother`)
    expect(await botReply('/names', '42', deps({ addressesOf: async () => [] }))).toContain('No address is linked')
  })

  it('resolves a bare name, with the expiry as a date from the head', async () => {
    const reply = await botReply('riconame', '42', deps())
    expect(reply).toContain(`Pays to: ${ADDRESS}`)
    expect(reply).toContain('Expires: 2026-10-03')
    expect(reply).toContain('#/pay/riconame')
    expect(await botReply('/resolve nimiq', '42', deps())).toContain('reserved')
    expect(await botReply('somethingfree', '42', deps())).toContain('not registered')
    expect(await botReply('not a name!', '42', deps())).toContain('not a valid name')
  })

  it('answers anything else with the help text', async () => {
    expect(await botReply('/whatever', '42', deps())).toContain('Send a name to look it up')
  })
})
