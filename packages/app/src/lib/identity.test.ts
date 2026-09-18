import { describe, expect, it } from 'vitest'
import { actingAs, clearHubAddresses, loadHubAddresses, primaryAddress, saveHubAddresses, withActive, withAddress, type StorageLike } from './identity'

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

describe('disconnect (so a different address can be chosen)', () => {
  it('forgets the whole set, and loads back as empty', () => {
    const storage = memoryStorage()
    saveHubAddresses(storage, [A, B])
    expect(loadHubAddresses(storage)).toEqual([A, B])
    clearHubAddresses(storage)
    expect(loadHubAddresses(storage)).toEqual([])
  })

  it('leaves a store that can be written to again — disconnect is not a teardown', () => {
    const storage = memoryStorage()
    clearHubAddresses(storage)
    saveHubAddresses(storage, withAddress(loadHubAddresses(storage), B))
    expect(loadHubAddresses(storage)).toEqual([B])
  })
})

describe('the acting address', () => {
  it('is the first, alone — never the set', () => {
    const identity = { kind: 'hub' as const, addresses: [A, B] }
    expect(primaryAddress(identity)).toBe(A)
    expect(actingAs(identity)).toEqual([A])
    expect(actingAs({ kind: 'none', addresses: [] })).toEqual([])
  })

  it('picking moves an address to the front and keeps the rest in order', () => {
    const C = withAddress([A, B], 'NQ82 ALHC H1LK HFYF X67T TNS3 YXVM PYR6 JAFP')
    const third = C[2] as string
    expect(withActive(C, third)).toEqual([third, A, B])
    expect(withActive(C, B.toLowerCase())).toEqual([B, A, third])
  })

  it('picking the acting address, an unknown one or garbage changes nothing', () => {
    const set = [A, B]
    expect(withActive(set, A)).toBe(set)
    expect(withActive(set, 'NQ82 ALHC H1LK HFYF X67T TNS3 YXVM PYR6 JAFP')).toBe(set)
    expect(withActive(set, 'not an address')).toBe(set)
  })

  it('the pick survives a reload as the saved order', () => {
    const storage = memoryStorage()
    saveHubAddresses(storage, withActive([A, B], B))
    expect(primaryAddress({ kind: 'hub', addresses: loadHubAddresses(storage) })).toBe(B)
  })
})
