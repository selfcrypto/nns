/**
 * The two routes, as a pure `(method, url) → response` function — testable
 * without a socket, and the server file stays dumb. `packages/api` draws the
 * line in the same place for the same reason.
 *
 * §8.6 fixes one endpoint and one body:
 *
 *     GET https://<host>/nns/v1/resolve/<label>  →  {"address": "NQ…", "ttl": N}
 *
 * and this serves exactly that. The optional signed variant (§16.5) is **not**
 * emitted: `timestamp` and `sig` are a format fixed early so a delegate can opt
 * in without a spec revision, and shipping the fields unsigned — or empty —
 * would invite a client to depend on a claim nothing makes.
 *
 * ## What a failure looks like on the wire, and why it can be honest
 *
 * A delegate genuinely knows whether it holds a label, and 404 is HTTP's word
 * for not holding it. That does not leak the distinction NNS must never draw,
 * because the distinction dies one layer up: `@nns/resolver`'s `askDelegate`
 * collapses every non-2xx, every timeout, every DNS and TLS failure and every
 * malformed body into the single code `DELEGATE_FAILED`. A client cannot tell
 * this 404 from a 502, so no user can ever be told a subdomain does not exist.
 * The property is enforced in the client's type, not asked of the host.
 *
 * ## Two headers that are not decoration
 *
 * - `access-control-allow-origin: *`. `packages/app` is a browser mini app, so
 *   a delegate without it fails the whole flow in a browser and passes every
 *   test. §8.6 does not mention it, which is why it gets forgotten.
 * - `cache-control: public, max-age=<ttl>`, agreeing with the body's `ttl`.
 *   The opposite of the API's `no-store`, for the opposite reason: §8.6 step 4
 *   tells the client to cache, so the proxy layer should agree with it rather
 *   than fight it. Everything that is not an answer is `no-store` — an owner
 *   adding a label a minute from now must not be shadowed by a cached 404.
 */

import { formatAddress, validateLabel } from '@nns/core'

import type { LabelSource } from './store.js'

export interface DelegateResponse {
  readonly status: number
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}

export type RouteHandler = (method: string, url: string) => DelegateResponse

export interface RouteOptions {
  /** `''`, or a path prefix with a leading and no trailing slash (`/binance`). */
  readonly basePath?: string
}

const CORS = {
  // The whole point of a delegate is that anyone's client may ask it.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
} as const

const error = (status: number, code: string): DelegateResponse => ({
  status,
  body: { error: code },
  headers: { ...CORS, 'cache-control': 'no-store' },
})

/** Split a URL's path into decoded segments, or `null` if an escape is malformed. */
function segments(url: string): readonly string[] | null {
  const path = url.split(/[?#]/, 1)[0] ?? '/'
  const parts = path.split('/').filter((part) => part !== '')
  const decoded: string[] = []
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part))
    } catch {
      return null
    }
  }
  return decoded
}

export function createRoutes(source: LabelSource, options: RouteOptions = {}): RouteHandler {
  const prefix = (options.basePath ?? '').split('/').filter((part) => part !== '')

  return (method: string, url: string): DelegateResponse => {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return { ...error(405, 'METHOD_NOT_ALLOWED'), headers: { ...CORS, 'cache-control': 'no-store', allow: 'GET, HEAD, OPTIONS' } }
    }

    const parts = segments(url)
    // A malformed percent-escape cannot name a label, and cannot name a route
    // either. It is the label position it would have landed in, so it answers
    // as one.
    if (parts === null) return error(400, 'BAD_LABEL')

    if (parts.length < prefix.length || prefix.some((part, i) => parts[i] !== part)) {
      return error(404, 'NOT_FOUND')
    }
    const rest = parts.slice(prefix.length)

    if (method === 'OPTIONS') return { status: 204, body: null, headers: { ...CORS, 'cache-control': 'no-store' } }

    // `/healthz` sits under the base path, not at the root: two delegates
    // behind one proxy are distinguished by their prefix, and a liveness probe
    // that ignores the prefix cannot say which of them answered.
    if (rest.length === 1 && rest[0] === 'healthz') {
      const file = source.current()
      return {
        status: 200,
        body: { ok: true, name: file.name, labels: file.labels.size, loadedAt: Math.floor(source.loadedAt() / 1_000) },
        headers: { ...CORS, 'cache-control': 'no-store' },
      }
    }

    if (rest.length !== 4 || rest[0] !== 'nns' || rest[1] !== 'v1' || rest[2] !== 'resolve') {
      return error(404, 'NOT_FOUND')
    }

    const label = rest[3] ?? ''
    // §4.4 exactly, via core — no case folding and no other normalisation. A
    // label is lowercase by rule, `parseQuery` rejects the rest before a
    // request is ever built, and a delegate inventing a second normalisation
    // rule is a delegate answering for names the protocol does not admit.
    const check = validateLabel(label)
    if (!check.ok) return error(400, 'BAD_LABEL')

    const answer = source.current().labels.get(label)
    if (answer === undefined) return error(404, 'NO_ANSWER')

    return {
      status: 200,
      body: { address: formatAddress(answer.address), ttl: answer.ttl },
      headers: { ...CORS, 'cache-control': `public, max-age=${answer.ttl}` },
    }
  }
}
