import { describe, expect, it, vi } from 'vitest'

import {
  isReferralName,
  isSelfReferral,
  memoryReferralStore,
  REFERRAL_TTL_MS,
  referralFromLink,
  referralFromLocation,
  shareLinkFor,
} from './referral'

describe('referralFromLocation', () => {
  it('reads ?ref= from the search string — the shape a share link has', () => {
    expect(referralFromLocation('?ref=ricomav', '')).toBe('ricomav')
    expect(referralFromLocation('?utm=x&ref=ricomav', '#/buy')).toBe('ricomav')
  })

  it('reads a query on the hash too, so #/buy?ref=x works from a pasted route', () => {
    expect(referralFromLocation('', '#/buy?ref=ricomav')).toBe('ricomav')
    expect(referralFromLocation('', '#/buy/newname?ref=ricomav')).toBe('ricomav')
  })

  it('the search string wins when both carry one', () => {
    expect(referralFromLocation('?ref=first', '#/buy?ref=second')).toBe('first')
  })

  it('a ref that is not a name is nothing, never an error (§6 G is inert)', () => {
    expect(referralFromLocation('?ref=', '')).toBeNull()
    expect(referralFromLocation('?ref=-bad', '')).toBeNull()
    expect(referralFromLocation('?ref=has%20space', '')).toBeNull()
    expect(referralFromLocation('?ref=' + 'a'.repeat(25), '')).toBeNull()
    expect(referralFromLocation('', '')).toBeNull()
    expect(referralFromLocation('?', '#')).toBeNull()
  })

  it('lowercases and trims, since a link gets retyped', () => {
    expect(referralFromLocation('?ref=%20RicoMav%20', '')).toBe('ricomav')
  })
})

describe('isReferralName', () => {
  it('is the name syntax and the ref alphabet together', () => {
    expect(isReferralName('ricomav')).toBe(true)
    expect(isReferralName('rico-mav')).toBe(true)
    expect(isReferralName('Rico')).toBe(false)
    expect(isReferralName('a|b')).toBe(false)
  })
})

describe('shareLinkFor', () => {
  it('is the origin plus ?ref=<name>, whatever page the owner is on', () => {
    expect(shareLinkFor('ricomav', 'https://nimiqnames.com/#/names/ricomav')).toBe('https://nimiqnames.com/?ref=ricomav')
    expect(shareLinkFor('ricomav', 'http://localhost:5173/')).toBe('http://localhost:5173/?ref=ricomav')
  })

  it('falls back to a relative link when there is no base to read', () => {
    expect(shareLinkFor('ricomav', '')).toBe('/?ref=ricomav')
  })
})

describe('referralFromLink', () => {
  it('reads a pasted share link, with or without a scheme', () => {
    expect(referralFromLink('https://nimiqnames.com/?ref=ricomav')).toBe('ricomav')
    expect(referralFromLink('nimiqnames.com/?ref=ricomav')).toBe('ricomav')
    expect(referralFromLink('  https://nimiqnames.com/?ref=RicoMav  ')).toBe('ricomav')
  })

  it('reads one on the hash too — the route a share of an inner page carries', () => {
    expect(referralFromLink('https://nimiqnames.com/#/buy?ref=ricomav')).toBe('ricomav')
  })

  // The search box hands this function everything typed. A name is a search.
  it('a name, a plain link and a link with a useless ref are all nothing', () => {
    expect(referralFromLink('ricomav')).toBeNull()
    expect(referralFromLink('https://nimiqnames.com/')).toBeNull()
    expect(referralFromLink('https://nimiqnames.com/?ref=-bad')).toBeNull()
    expect(referralFromLink('https://nimiqnames.com/?utm=x')).toBeNull()
    expect(referralFromLink('')).toBeNull()
    expect(referralFromLink('?')).toBeNull()
  })

  it('takes the ref from any host — the app is independently hostable', () => {
    expect(referralFromLink('http://localhost:5173/?ref=ricomav')).toBe('ricomav')
  })
})

describe('isSelfReferral', () => {
  const A = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
  const B = 'NQ88 0000 0000 0000 0000 0000 0000 0000 0001'
  const C = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

  it('is true when the viewer owns the referring name — the share would pay the payer', () => {
    expect(isSelfReferral({ owner: A, target: C }, [B, A])).toBe(true)
  })

  it('is true when the viewer is the payee, whoever owns it — `M` pays the target', () => {
    expect(isSelfReferral({ owner: C, target: A }, [A])).toBe(true)
  })

  it('is false for somebody else’s name, and for a record nobody could fetch', () => {
    expect(isSelfReferral({ owner: B, target: C }, [A])).toBe(false)
    expect(isSelfReferral(null, [A])).toBe(false)
    expect(isSelfReferral({ owner: B, target: C }, [])).toBe(false)
  })

  it('compares addresses, not strings — spacing and case are not identity', () => {
    expect(isSelfReferral({ owner: A.replace(/ /g, ''), target: C }, [A.toLowerCase()])).toBe(true)
  })
})

describe('the store', () => {
  it('keeps the first ref, clears on request', async () => {
    const store = memoryReferralStore()
    expect(await store.get()).toBeNull()
    await store.remember('first')
    await store.remember('second')
    expect(await store.get()).toBe('first')
    await store.clear()
    expect(await store.get()).toBeNull()
    await store.remember('second')
    expect(await store.get()).toBe('second')
  })

  it('forgets a ref once the window has passed, and takes the next one', async () => {
    vi.useFakeTimers()
    try {
      const store = memoryReferralStore()
      await store.remember('first')
      vi.advanceTimersByTime(REFERRAL_TTL_MS - 1)
      expect(await store.get()).toBe('first')
      vi.advanceTimersByTime(1)
      expect(await store.get()).toBeNull()
      // An expired slot is an empty slot: first-wins must not lock it shut.
      await store.remember('second')
      expect(await store.get()).toBe('second')
    } finally {
      vi.useRealTimers()
    }
  })
})
