import { describe, expect, it } from 'vitest'
import { hideSender, loadHiddenSenders, unhideSender } from './hidden'
import type { StorageLike } from './identity'

const A = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const B = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

const memoryStorage = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

const brokenStorage = (): StorageLike => ({
  getItem: () => {
    throw new Error('no storage here')
  },
  setItem: () => {
    throw new Error('no storage here')
  },
})

describe('the hidden-sender list', () => {
  it('round-trips, canonicalises and refuses duplicates', () => {
    const storage = memoryStorage()
    expect(loadHiddenSenders(storage)).toEqual([])
    expect(hideSender(storage, A.toLowerCase())).toEqual([A])
    expect(hideSender(storage, A)).toEqual([A])
    expect(hideSender(storage, B)).toEqual([A, B])
    expect(loadHiddenSenders(storage)).toEqual([A, B])
  })

  it('unhides, and leaves the list alone for an address that was never hidden', () => {
    const storage = memoryStorage()
    hideSender(storage, A)
    expect(unhideSender(storage, B)).toEqual([A])
    expect(unhideSender(storage, A)).toEqual([])
    expect(loadHiddenSenders(storage)).toEqual([])
  })

  it('ignores an unparseable address rather than storing it', () => {
    const storage = memoryStorage()
    expect(hideSender(storage, 'not an address')).toEqual([])
  })

  it('reads junk and a broken store as nothing hidden — never as everything hidden', () => {
    const storage = memoryStorage()
    storage.data.set('nns.chat.hidden', '{"not":"an array"}')
    expect(loadHiddenSenders(storage)).toEqual([])
    storage.data.set('nns.chat.hidden', 'not json at all')
    expect(loadHiddenSenders(storage)).toEqual([])
    expect(loadHiddenSenders(brokenStorage())).toEqual([])
  })

  it('still hides for the session when the store cannot be written', () => {
    // The list is returned so the screen can set state; persistence is the
    // half that is allowed to fail. Refusing to hide because a device blocks
    // storage would punish the reader for the browser's settings.
    expect(hideSender(brokenStorage(), A)).toEqual([A])
  })
})
