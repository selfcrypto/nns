import { describe, expect, it } from 'vitest'

import { isReferralName, memoryReferralStore, referralFromLocation, shareLinkFor } from './referral'

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
})
