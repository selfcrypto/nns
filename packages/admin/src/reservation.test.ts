import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminError } from './cli.js'
import {
  createReservationSource,
  describeAvailability,
  isReservedNow,
  parseAvailability,
  type NameAvailability,
} from './reservation.js'

const URL_ = 'http://api.test/available/binance'

/** The three answers the live API gave on 2026-08-21, verbatim in shape. */
const RESERVED = { name: 'binance', available: false, reason: 'RESERVED', height: 59_479_080 }
const TAKEN = {
  name: 'nimiq',
  available: false,
  reason: 'TAKEN',
  status: 'REGISTERED',
  expiry: 59_765_881,
  height: 59_479_080,
}
const AVAILABLE = { name: 'probe-name', available: true, proof: null, height: 59_479_080 }

const parsed = (body: unknown): NameAvailability => parseAvailability(body, URL_)

describe('parseAvailability', () => {
  it('reads the reserved answer — the one state in which a U lands', () => {
    expect(parsed(RESERVED)).toEqual({
      name: 'binance',
      available: false,
      reason: 'RESERVED',
      status: null,
      expiry: null,
      height: 59_479_080,
      url: URL_,
    })
  })

  it('reads the taken answer, keeping the status and expiry the refusal quotes', () => {
    expect(parsed(TAKEN)).toMatchObject({ available: false, reason: 'TAKEN', status: 'REGISTERED', expiry: 59_765_881 })
  })

  it('reads the available answer, ignoring the §8.3 proof a U has no use for', () => {
    expect(parsed(AVAILABLE)).toMatchObject({ available: true, reason: null, status: null })
  })

  it('refuses a body that is not an answer at all, rather than reading undefined as false', () => {
    // `available` missing would otherwise be falsy, and falsy here reads as
    // "not available" — which is the half of the verdict that lets a U through.
    expect(() => parsed({ name: 'binance', height: 1 })).toThrow(AdminError)
    expect(() => parsed({ ...RESERVED, available: 'no' })).toThrow(/expected a boolean/)
    expect(() => parsed({ ...RESERVED, height: -1 })).toThrow(/expected a block height/)
    expect(() => parsed(null)).toThrow(/expected an \/available document/)
  })
})

describe('isReservedNow', () => {
  it('is true only for available:false with reason RESERVED', () => {
    expect(isReservedNow(parsed(RESERVED))).toBe(true)
    expect(isReservedNow(parsed(TAKEN))).toBe(false)
    expect(isReservedNow(parsed(AVAILABLE))).toBe(false)
  })

  it('is false for a §4.1 reason — unavailable is not the same as reserved', () => {
    // The trap this function exists to avoid: `!available` alone would read
    // an invalid name as reservable, and a U for it forfeits INVALID_NAME.
    expect(isReservedNow(parsed({ name: 'ab-', available: false, reason: 'INVALID_NAME', height: 1 }))).toBe(false)
  })
})

describe('describeAvailability', () => {
  it('says who holds it rather than repeating the log token', () => {
    // NAME_NOT_RESERVED does not distinguish "never on the list" from
    // "registered to somebody until next March".
    expect(describeAvailability(parsed(TAKEN))).toContain('REGISTERED to somebody')
    expect(describeAvailability(parsed(TAKEN))).toContain('59765881')
    expect(describeAvailability(parsed({ ...TAKEN, status: 'GRACE' }))).toContain('GRACE')
    expect(describeAvailability(parsed(AVAILABLE))).toContain('nothing to release')
    expect(describeAvailability(parsed(AVAILABLE))).toContain('an award lands')
    expect(describeAvailability(parsed(RESERVED))).toBe('RESERVED')
  })
})

describe('createReservationSource', () => {
  afterEach(() => void vi.unstubAllGlobals())

  it('asks the name endpoint, encoding the name into the path', async () => {
    let asked = ''
    vi.stubGlobal('fetch', (url: string) => {
      asked = url
      return Promise.resolve(new Response(JSON.stringify(RESERVED), { headers: { 'content-type': 'application/json' } }))
    })
    const answer = await createReservationSource('http://api.test/').fetchAvailability('binance')
    expect(asked).toBe('http://api.test/available/binance')
    expect(answer.reason).toBe('RESERVED')
  })

  it('names the URL when the API is unreachable or unhappy', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expect(createReservationSource('http://api.test').fetchAvailability('binance')).rejects.toThrow(
      /GET http:\/\/api.test\/available\/binance failed: fetch failed/,
    )
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"error":"NOT_SYNCED"}', { status: 503 })))
    await expect(createReservationSource('http://api.test').fetchAvailability('binance')).rejects.toThrow(
      /answered 503/,
    )
  })
})
