import { describe, expect, it } from 'vitest'
import { createBuckets } from './limits.js'

describe('token buckets', () => {
  it('allows a burst up to capacity, then refuses with a retry hint', () => {
    let at = 0
    const buckets = createBuckets({ capacity: 3, refillPerMinute: 60, now: () => at })
    expect(buckets.take('a').ok).toBe(true)
    expect(buckets.take('a').ok).toBe(true)
    expect(buckets.take('a').ok).toBe(true)
    const refused = buckets.take('a')
    expect(refused.ok).toBe(false)
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1)
  })

  it('refills with time and keys are independent', () => {
    let at = 0
    const buckets = createBuckets({ capacity: 1, refillPerMinute: 60, now: () => at })
    expect(buckets.take('a').ok).toBe(true)
    expect(buckets.take('a').ok).toBe(false)
    expect(buckets.take('b').ok).toBe(true)
    at += 1_000 // one token per second at 60/min
    expect(buckets.take('a').ok).toBe(true)
  })

  it('never exceeds capacity after a long idle stretch', () => {
    let at = 0
    const buckets = createBuckets({ capacity: 2, refillPerMinute: 60, now: () => at })
    expect(buckets.take('a').ok).toBe(true)
    at += 3_600_000
    expect(buckets.take('a').ok).toBe(true)
    expect(buckets.take('a').ok).toBe(true)
    expect(buckets.take('a').ok).toBe(false)
  })

  it('prunes idle keys', () => {
    let at = 0
    const buckets = createBuckets({ capacity: 1, refillPerMinute: 60, now: () => at })
    buckets.take('a')
    buckets.take('b')
    at += 700_000
    buckets.take('c')
    buckets.prune()
    expect(buckets.size()).toBe(1)
  })
})
