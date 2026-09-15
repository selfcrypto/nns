import { describe, expect, it } from 'vitest'
import { getJson, join } from './transport.js'

// `join` is what turns a configured endpoint into a request URL, on the path
// that produces addresses (`quorum.ts`, `anchors.ts`). It is deliberately
// string concatenation rather than `new URL(path, base)`: concatenation
// carries a **root-relative** base through unchanged, which is what lets a
// host app configure `/api` and serve the bundle from any hostname without a
// rebuild. `new URL` would need an origin this package does not have.
describe('join', () => {
  it('carries a same-origin base through as a relative path', () => {
    expect(join('/api', 'resolve/alice')).toBe('/api/resolve/alice')
    expect(join('/api/', '/resolve/alice')).toBe('/api/resolve/alice')
  })

  it('treats a bare "/" as the origin root', () => {
    expect(join('/', 'resolve/alice')).toBe('/resolve/alice')
  })

  it('joins an absolute base the same way, trailing slash or not', () => {
    expect(join('https://api.example.com', 'resolve/alice')).toBe('https://api.example.com/resolve/alice')
    expect(join('https://api.example.com/', 'resolve/alice')).toBe('https://api.example.com/resolve/alice')
  })
})

/**
 * The round trip is measured here or nowhere: this is the one function every
 * endpoint's request goes through. It is reported to a person — a client
 * lists the parties that agreed and says how each performed — and it is
 * **never** read by verification, because a slow resolver is not a wrong one.
 */
describe('getJson times the round trip', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  it('reports whole milliseconds on an answer', async () => {
    const fetched = await getJson(async () => ok({ hello: 'world' }), 'https://a.example/x')
    expect(fetched.ok).toBe(true)
    expect(fetched.ms).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(fetched.ms)).toBe(true)
  })

  it('reports it on a failure too, so a silent party can still be timed', async () => {
    const fetched = await getJson(async () => {
      throw new Error('connect ECONNREFUSED')
    }, 'https://a.example/x')
    expect(fetched).toMatchObject({ ok: false, status: null, reason: 'connect ECONNREFUSED' })
    expect(fetched.ms).toBeGreaterThanOrEqual(0)
  })

  it('counts the body, not just the headers', async () => {
    const slowBody = {
      ok: true,
      status: 200,
      json: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {}
      },
    }
    const fetched = await getJson(async () => slowBody, 'https://a.example/x')
    // A resolver that streams headers instantly and then takes a second over
    // the body is slow, and the number a user reads has to say so.
    expect(fetched.ms).toBeGreaterThanOrEqual(15)
  })
})
