import { afterEach, describe, expect, it, vi } from 'vitest'

import { pollThroughOutage, sleep } from './loop.js'
import { SourceError, SourceUnavailable } from './source.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('sleep', () => {
  it('ends early when the stop signal fires — a SIGTERM does not wait out the interval', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const slept = sleep(60_000, controller.signal)
    controller.abort()
    await slept
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('returns at once on a signal that already fired', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined()
  })
})

describe('pollThroughOutage', () => {
  it('passes a result through untouched', async () => {
    await expect(pollThroughOutage(() => Promise.resolve('snapshot'), { once: false, pollSeconds: 1 })).resolves.toBe('snapshot')
  })

  it('sits out an unavailable source: says so, prints the retry line, never the healthy one, and skips the cycle', async () => {
    quiet()
    const controller = new AbortController()
    controller.abort() // the wait itself is not under test
    const result = await pollThroughOutage(() => Promise.reject(new SourceUnavailable('GET /x returned 502: bad gateway')), {
      once: false,
      pollSeconds: 15,
      signal: controller.signal,
    })
    expect(result).toBeNull()
    expect(console.error).toHaveBeenCalledWith('SourceUnavailable: GET /x returned 502: bad gateway')
    expect(console.log).toHaveBeenCalledWith('(retry in 15s)')
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toMatch(/next (cycle|poll) in/)
  })

  it('never sits out a refusal about the log — a divergence must not become a quiet retry loop', async () => {
    const refusal = new SourceError('served log does not hash to the hash served with it')
    await expect(pollThroughOutage(() => Promise.reject(refusal), { once: false, pollSeconds: 1 })).rejects.toBe(refusal)
  })

  it('never sits out anything else either', async () => {
    const other = new Error('went backwards')
    await expect(pollThroughOutage(() => Promise.reject(other), { once: false, pollSeconds: 1 })).rejects.toBe(other)
  })

  it('--once has no next cycle to wait for, so an outage fails it', async () => {
    const outage = new SourceUnavailable('GET /x could not be reached: ECONNREFUSED')
    await expect(pollThroughOutage(() => Promise.reject(outage), { once: true, pollSeconds: 1 })).rejects.toBe(outage)
  })
})
