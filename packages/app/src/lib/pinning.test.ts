import { describe, expect, it } from 'vitest'
import { checkAndPin, memoryPinStore, overridePin, type PinStore } from './pinning'

const A = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
const B = 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H'

describe('checkAndPin (app-states.md §2)', () => {
  it('first use pins; the same address afterwards is a silent match', async () => {
    const store = memoryPinStore()
    expect(await checkAndPin(store, 'example', A, 1_000)).toEqual({ kind: 'first-use' })
    expect(await checkAndPin(store, 'example', A, 2_000)).toEqual({ kind: 'match' })
  })

  it('matches canonically, not textually', async () => {
    const store = memoryPinStore()
    await checkAndPin(store, 'example', A, 1_000)
    expect((await checkAndPin(store, 'example', A.toLowerCase(), 2_000)).kind).toBe('match')
  })

  it('a changed mapping is a mismatch carrying the pinned record — never an overwrite', async () => {
    const store = memoryPinStore()
    await checkAndPin(store, 'example', A, 1_000)
    const verdict = await checkAndPin(store, 'example', B, 2_000)
    expect(verdict).toEqual({ kind: 'mismatch', pinned: { query: 'example', address: A, pinnedAt: 1_000 } })
    // The mismatch must not have touched the pin: the same check repeats.
    expect((await checkAndPin(store, 'example', B, 3_000)).kind).toBe('mismatch')
  })

  it('pins are per query: a dotted query and its parent are separate pins', async () => {
    const store = memoryPinStore()
    await checkAndPin(store, 'exchange', A, 1_000)
    expect((await checkAndPin(store, 'alice.exchange', B, 2_000)).kind).toBe('first-use')
    expect((await checkAndPin(store, 'exchange', A, 3_000)).kind).toBe('match')
  })

  it('only the explicit override replaces a pin', async () => {
    const store = memoryPinStore()
    await checkAndPin(store, 'example', A, 1_000)
    await overridePin(store, 'example', B, 2_000)
    expect(await checkAndPin(store, 'example', B, 3_000)).toEqual({ kind: 'match' })
    expect((await checkAndPin(store, 'example', A, 4_000)).kind).toBe('mismatch')
  })

  it('a broken store is unchecked — never a fresh first-use, which would silently unpin', async () => {
    const broken: PinStore = {
      get: () => Promise.reject(new Error('storage gone')),
      put: () => Promise.reject(new Error('storage gone')),
    }
    expect(await checkAndPin(broken, 'example', A, 1_000)).toEqual({ kind: 'unchecked' })
  })

  it('a failed write after a first use still answers first-use, not an error', async () => {
    const readOnly: PinStore = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('quota')),
    }
    expect(await checkAndPin(readOnly, 'example', A, 1_000)).toEqual({ kind: 'first-use' })
  })
})
