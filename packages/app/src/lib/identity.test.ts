import { describe, expect, it } from 'vitest'
import { loadHubAddresses, saveHubAddresses, withAddress, type StorageLike } from './identity'

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

describe('the address set', () => {
  it('canonicalises and dedupes on add', () => {
    const one = withAddress([], A.toLowerCase())
    expect(one).toEqual([A])
    expect(withAddress(one, A)).toBe(one)
    expect(withAddress(one, B)).toEqual([A, B])
  })

  it('ignores garbage instead of growing the set', () => {
    expect(withAddress([A], 'not an address')).toEqual([A])
  })
})

describe('hub persistence', () => {
  it('round-trips the set', () => {
    const storage = memoryStorage()
    saveHubAddresses(storage, [A, B])
    expect(loadHubAddresses(storage)).toEqual([A, B])
  })

  it('a corrupt or foreign store loads as empty, never throws', () => {
    const storage = memoryStorage()
    storage.data.set('nns.hub.addresses', 'not json')
    expect(loadHubAddresses(storage)).toEqual([])
    storage.data.set('nns.hub.addresses', '{"a":1}')
    expect(loadHubAddresses(storage)).toEqual([])
    storage.data.set('nns.hub.addresses', JSON.stringify([A, 42, 'junk', A.toLowerCase()]))
    expect(loadHubAddresses(storage)).toEqual([A])
  })
})
