import { describe, expect, it } from 'vitest'

import { parseRoute } from './route'
import { payLinkFor, payMessageBytes, payMessageFault, payRequestFromHash, payRequestFromLink } from './payRequest'

describe('payRequestFromHash', () => {
  it('reads the amount and the message a payment link carries', () => {
    expect(payRequestFromHash('#/pay/donald?amount=25&message=INV-42')).toEqual({
      amount: '25',
      message: 'INV-42',
      asset: null,
    })
  })

  it('reads either one alone, so a junk half never costs the other', () => {
    expect(payRequestFromHash('#/pay/donald?amount=25')).toEqual({ amount: '25', message: null, asset: null })
    expect(payRequestFromHash('#/pay/donald?message=INV-42')).toEqual({ amount: null, message: 'INV-42', asset: null })
  })

  it('is nothing for a hash that carries no query', () => {
    expect(payRequestFromHash('#/pay/donald')).toEqual({ amount: null, message: null, asset: null })
    expect(payRequestFromHash('')).toEqual({ amount: null, message: null, asset: null })
    expect(payRequestFromHash('#/pay/donald?')).toEqual({ amount: null, message: null, asset: null })
  })

  it('never throws on a malformed query — a mistyped link still opens the screen', () => {
    expect(() => payRequestFromHash('#/pay/x?%')).not.toThrow()
    expect(() => payRequestFromHash('#/pay/x?amount=%E0%A4%A')).not.toThrow()
  })

  it('decodes a space written either way, since a link gets retyped', () => {
    expect(payRequestFromHash('#/pay/x?message=order+17').message).toBe('order 17')
    expect(payRequestFromHash('#/pay/x?message=order%2017').message).toBe('order 17')
  })

  it('leaves the amount as written — the field judges it, so there is one NIM parser', () => {
    expect(payRequestFromHash('#/pay/x?amount=1,5').amount).toBe('1,5')
    expect(payRequestFromHash('#/pay/x?amount=nonsense').amount).toBe('nonsense')
    expect(payRequestFromHash('#/pay/x?amount=').amount).toBeNull()
  })

  it('takes the asset only when it names one this app pays; unsaid is NIM', () => {
    expect(payRequestFromHash('#/pay/x?asset=usdt').asset).toBe('usdt')
    expect(payRequestFromHash('#/pay/x?asset=NIM').asset).toBe('nim')
    expect(payRequestFromHash('#/pay/x?asset=eth').asset).toBeNull()
    expect(payRequestFromHash('#/pay/x?amount=25').asset).toBeNull()
  })
})

describe('payMessageFault', () => {
  it('passes an ordinary reference, and an empty one — a plain transfer is fine', () => {
    expect(payMessageFault('INV-42')).toBeNull()
    expect(payMessageFault('')).toBeNull()
  })

  it('refuses a reference that would be read as a protocol message (§7.5)', () => {
    expect(payMessageFault('NNS1Gdonald')).toBe('RESERVED_PREFIX')
    // Exact case is the whole mechanism: every reader matches `NNS1` literally,
    // so a lowercase one is invisible to every indexer and must not be refused.
    expect(payMessageFault('nns1 invoice')).toBeNull()
  })

  it('refuses over 64 bytes — the measured silent-drop boundary (§5.1)', () => {
    expect(payMessageFault('a'.repeat(64))).toBeNull()
    expect(payMessageFault('a'.repeat(65))).toBe('OVER_BUDGET')
  })

  it('counts bytes, not characters: an accent costs two and an emoji four', () => {
    expect(payMessageBytes('café')).toBe(5)
    expect(payMessageFault('é'.repeat(33))).toBe('OVER_BUDGET')
    expect(payMessageFault('🙂'.repeat(17))).toBe('OVER_BUDGET')
  })
})

describe('payLinkFor', () => {
  const base = 'https://nimiqnames.com/#/names/donald'

  it('builds the link a seller shares — the path form, so a chat can draw a card for it', () => {
    expect(payLinkFor('donald', { amount: '25', message: 'INV-42', asset: null }, base)).toBe(
      'https://nimiqnames.com/pay/donald?amount=25&message=INV-42',
    )
  })

  it('writes the hash form for a host with no edge rule', () => {
    expect(payLinkFor('donald', { amount: '25', message: 'INV-42', asset: null }, base, 'hash')).toBe(
      'https://nimiqnames.com/#/pay/donald?amount=25&message=INV-42',
    )
    expect(payLinkFor('donald', { amount: null, message: null, asset: null }, base, 'hash')).toBe(
      'https://nimiqnames.com/#/pay/donald',
    )
  })

  it('writes only what was asked for, and never asset=nim — absent already says NIM', () => {
    expect(payLinkFor('donald', { amount: null, message: null, asset: null }, base)).toBe(
      'https://nimiqnames.com/pay/donald',
    )
    expect(payLinkFor('donald', { amount: '25', message: null, asset: 'nim' }, base)).toBe(
      'https://nimiqnames.com/pay/donald?amount=25',
    )
    expect(payLinkFor('donald', { amount: '25', message: null, asset: 'usdt' }, base)).toBe(
      'https://nimiqnames.com/pay/donald?amount=25&asset=usdt',
    )
  })

  it('round-trips through its own parser, whatever the reference contains', () => {
    for (const message of ['INV-42', 'order 17', 'a&b=c', 'für Kaffee', '#3 / 2026', '100% paid']) {
      const link = payLinkFor('donald', { amount: '1.5', message, asset: null }, base, 'hash')
      expect(payRequestFromHash(new URL(link).hash)).toEqual({ amount: '1.5', message, asset: null })
      expect(payRequestFromLink(payLinkFor('donald', { amount: '1.5', message, asset: null }, base))).toEqual({
        name: 'donald',
        request: { amount: '1.5', message, asset: null },
      })
    }
  })

  it('leaves the query out of the route, so the link still opens Pay on the name', () => {
    const link = payLinkFor('donald', { amount: '25', message: 'INV-42', asset: 'usdt' }, base, 'hash')
    expect(parseRoute(new URL(link).hash, 'home')).toEqual({ tab: 'pay', param: 'donald' })
  })

  it('falls back to a relative link when there is no origin to read', () => {
    expect(payLinkFor('donald', { amount: '25', message: null, asset: null }, '')).toBe('/pay/donald?amount=25')
    expect(payLinkFor('donald', { amount: '25', message: null, asset: null }, '', 'hash')).toBe('/#/pay/donald?amount=25')
  })
})

describe('payRequestFromLink', () => {
  it('reads the path form — the one the sheet copies — with or without a scheme', () => {
    const expected = { name: 'donald', request: { amount: '25', message: 'INV-42', asset: null } }
    expect(payRequestFromLink('https://nimiqnames.com/pay/donald?amount=25&message=INV-42')).toEqual(expected)
    expect(payRequestFromLink('nimiqnames.com/pay/donald?amount=25&message=INV-42')).toEqual(expected)
    expect(payRequestFromLink('/pay/donald?amount=25&message=INV-42')).toEqual(expected)
    expect(payRequestFromLink('  https://nimiqnames.com/pay/donald  ')).toEqual({
      name: 'donald',
      request: { amount: null, message: null, asset: null },
    })
  })

  it('is null for what the edge answers 404 — a second segment, a trailing slash, no name', () => {
    expect(payRequestFromLink('https://nimiqnames.com/pay/donald/')).toBeNull()
    expect(payRequestFromLink('https://nimiqnames.com/pay/a/b')).toBeNull()
    expect(payRequestFromLink('https://nimiqnames.com/pay/')).toBeNull()
    expect(payRequestFromLink('https://nimiqnames.com/pay/%E0%A4%A')).toBeNull()
  })

  it('reads a full link, so a payer inside Nimiq Pay can paste one in', () => {
    expect(payRequestFromLink('https://nimiqnames.com/#/pay/donald?amount=25&message=INV-42')).toEqual({
      name: 'donald',
      request: { amount: '25', message: 'INV-42', asset: null },
    })
  })

  it('reads the shapes a link gets copied as', () => {
    for (const text of [
      '#/pay/donald',
      '/#/pay/donald',
      'nimiqnames.com/#/pay/donald',
      'https://nimiqnames.com/#/pay/donald',
      'https://example.test/app/#/pay/donald',
      '  https://nimiqnames.com/#/pay/donald  ',
    ]) {
      expect(payRequestFromLink(text)?.name).toBe('donald')
    }
  })

  it('is null for everything a person types, since this runs on every keystroke', () => {
    for (const text of ['', 'd', 'donald', 'pay.donald', 'NQ07 0000 …', 'https://nimiqnames.com/']) {
      expect(payRequestFromLink(text)).toBeNull()
    }
  })

  it('is null for a link that does not name a payee — nothing to fill the field with', () => {
    expect(payRequestFromLink('https://nimiqnames.com/#/pay')).toBeNull()
    expect(payRequestFromLink('https://nimiqnames.com/#/buy/donald')).toBeNull()
    expect(payRequestFromLink('https://nimiqnames.com/#/names/donald')).toBeNull()
    expect(payRequestFromLink('#/nonsense/donald')).toBeNull()
  })

  it('carries the asset, so a pasted USDT link opens the USDT screen', () => {
    expect(payRequestFromLink('https://nimiqnames.com/#/pay/donald?amount=25&asset=usdt')?.request).toEqual({
      amount: '25',
      message: null,
      asset: 'usdt',
    })
  })

  it('decodes the name the one way the router does', () => {
    expect(payRequestFromLink('https://nimiqnames.com/#/pay/pay.shopper')?.name).toBe('pay.shopper')
    expect(payRequestFromLink('https://nimiqnames.com/#/pay/pay%2Eshopper')?.name).toBe('pay.shopper')
  })

  it('never throws on a mangled link — a retyped one still fills what it can', () => {
    expect(() => payRequestFromLink('https://nimiqnames.com/#/pay/donald?%')).not.toThrow()
    expect(payRequestFromLink('https://nimiqnames.com/#/pay/donald?%')?.name).toBe('donald')
    expect(payRequestFromLink('#/pay/%E0%A4%A')).toBeNull()
  })

  it('round-trips what the builder writes, reference and all', () => {
    const link = payLinkFor('donald', { amount: '1.5', message: '#3 / 2026', asset: null }, 'https://nimiqnames.com/')
    expect(payRequestFromLink(link)).toEqual({
      name: 'donald',
      request: { amount: '1.5', message: '#3 / 2026', asset: null },
    })
  })
})
