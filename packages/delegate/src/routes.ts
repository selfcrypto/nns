/**
 * The two routes, as a pure `(method, url) → response` function — testable
 * without a socket, and the server file stays dumb. `packages/api` draws the
 * line in the same place for the same reason.
 *
 * §8.6 fixes one endpoint and one body:
 *
 *     GET https://<host>/<parent>/<label>  →  {"address": "NQ…", "ttl": N}
 *
 * and this serves exactly that. The optional signed variant (§16.5) is **not**
 * emitted: `timestamp` and `sig` are a format fixed early so a delegate can opt
 * in without a spec revision, and shipping the fields unsigned — or empty —
 * would invite a client to depend on a claim nothing makes.
 *
 * **The protocol reserves no prefix of its own (r25).** Through r24 the request
 * carried a fixed `delegated/v1` — r23's replacement for `/nns/v1/resolve/` —
 * and r25 dropped both segments for one reason: nothing is deployed that a
 * marker protects, and what the marker cost was the one arrangement the
 * registry API gets for free. `api.example.com/resolve/alice`
 * and `example.com/api/resolve/alice` are the same service mounted two ways,
 * because the word naming the *service* and the word naming the *route* are
 * different ones. A delegate had a single word doing both jobs and the path
 * held it unconditionally, so an operator who named the host after the service
 * got it twice: `delegated.example.com/delegated/alice/shop`.
 *
 * The word is now the operator's, placed once, wherever it reads:
 *
 *     D = nns.example.com          →  https://nns.example.com/alice/shop
 *     D = example.com/delegated    →  https://example.com/delegated/alice/shop
 *
 * Nothing here needs to know which was chosen, which is the next comment.
 *
 * ## One host, many names
 *
 * The parent is a path segment, so the lookup is `names → labels` and one
 * process answers for every name pointing at this host. That is what r23 put
 * the parent in the request for; §6 `D`'s short path is for mounting several
 * *processes* on one machine, and explicitly "**not** what separates two
 * names sharing a host".
 *
 * ## What a failure looks like on the wire, and why it can be honest
 *
 * A delegate genuinely knows whether it holds a label, and 404 is HTTP's word
 * for not holding it. That does not leak the distinction NNS must never draw,
 * because the distinction dies one layer up: `@nimiqnames/resolver`'s `askDelegate`
 * collapses every non-2xx, every timeout, every DNS and TLS failure and every
 * malformed body into the single code `DELEGATE_FAILED`. A client cannot tell
 * this 404 from a 502, so no user can ever be told a subdomain does not exist.
 * The property is enforced in the client's type, not asked of the host.
 *
 * **An unserved name and an unheld label are the same 404.** §8.6 requires it
 * — a distinguishable "wrong parent" would tell a client which names a host
 * serves — and with many names in one file the requirement stops being
 * theoretical: this host knows a roster, and the roster is not the caller's.
 * `/healthz` reports counts for the same reason.
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

import { formatAddress, validateLabel, validateNameSyntax } from '@nimiqnames/core'

import { countLabels } from './labels.js'
import type { LabelSource } from './store.js'

export interface DelegateResponse {
  readonly status: number
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}

export type RouteHandler = (method: string, url: string) => DelegateResponse

/** No options today. Kept because it is exported and callers pass `{}`. */
export interface RouteOptions {
  readonly _?: never
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

/**
 * Build the request handler.
 *
 * ## Where this server sits is not this server's business
 *
 * It never reads the `Host` header, and it is **not told what path it is
 * mounted at**. **The last two segments are the parent and the label**, and
 * whatever precedes them is where this server sits, so all of these are the
 * same request:
 *
 *     /alice/shop
 *     /delegated/alice/shop
 *     /some/deep/mount/alice/shop
 *
 * §6 `D` lets a host carry a short path, and that prefix arrives here because
 * the client builds the URL from the recorded host — no proxy can strip what
 * is part of the address. But the prefix says **where the delegate listens**,
 * not **which name is being asked about**: names come from the labels file and
 * from the parent segment, and a prefix cannot add to or contradict either.
 * §6 `D` says the same thing — the short path mounts several *processes* and
 * "is **not** what separates two names sharing a host".
 *
 * So there is nothing to configure. An operator who once had to declare a
 * mount per customer now edits the JSON and nothing else, and one container
 * answers on a bare subdomain and under any number of path mounts at once.
 *
 * **The prefix is not an access boundary and never was.** Routing between two
 * containers happens at the proxy, which is the layer that can enforce it;
 * this server refusing an unexpected prefix only ever bought the illusion.
 *
 * Counting from the **end** is what survives r25's removal of the marker: a
 * prefix can be any depth and the two segments that matter are always the last
 * two, so a proxy that strips the mount and one that does not reach the same
 * answer — and a `D` short path, which no proxy *can* strip because the client
 * builds the URL from it, needs no configuration here either.
 *
 * ## `/healthz` is the whole path, or it is not the probe
 *
 * A lookup is always two segments, so a **one**-segment request can never be
 * one, and that is the entire disambiguation — the marker used to be. It has
 * to fall this way round: `healthz` is a perfectly valid §4.4 label, an owner
 * may hold `healthz.alice`, and answering that lookup with a health body is a
 * wrong address returned silently, which is the failure this package exists to
 * avoid. Under a mount the proxy does not strip, `<prefix>/healthz` is
 * therefore read as a lookup and answers 404; probe the container directly, as
 * the compose healthcheck does, or the mount root behind a proxy that strips.
 */
export function createRoutes(source: LabelSource, _options: RouteOptions = {}): RouteHandler {
  return (method: string, url: string): DelegateResponse => {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return { ...error(405, 'METHOD_NOT_ALLOWED'), headers: { ...CORS, 'cache-control': 'no-store', allow: 'GET, HEAD, OPTIONS' } }
    }

    const parts = segments(url)
    // A malformed percent-escape cannot name a label, and cannot name a route
    // either. It is the label position it would have landed in, so it answers
    // as one.
    if (parts === null) return error(400, 'BAD_LABEL')

    if (method === 'OPTIONS') return { status: 204, body: null, headers: { ...CORS, 'cache-control': 'no-store' } }

    // The probe, and only as the whole path. One segment is never a lookup —
    // a lookup carries a parent and a label — so this cannot shadow one, which
    // it would the moment it were allowed to match under a prefix: `healthz`
    // is a valid §4.4 label and `healthz.alice` is a name an owner may hold.
    if (parts.length === 1 && parts[0] === 'healthz') {
      const file = source.current()
      return {
        status: 200,
        // Counts, never the roster. This package forbids a bulk listing
        // endpoint, and naming the served names here would be one — reachable
        // through the same public vhost that serves the answers. The boot log
        // names them, and logs are the operator's side of the wire.
        body: { ok: true, names: file.names.size, labels: countLabels(file), loadedAt: Math.floor(source.loadedAt() / 1_000) },
        headers: { ...CORS, 'cache-control': 'no-store' },
      }
    }

    // The last two segments. Anything before them is where this server is
    // mounted and is not ours to check.
    const start = parts.length - 2
    if (start < 0) return error(404, 'NOT_FOUND')

    const parent = parts[start] ?? ''
    const label = parts[start + 1] ?? ''
    // A parent that is not a §4.1 name cannot be one this file answers for, and
    // cannot have been sent by a conforming client — `parseQuery` rejects it
    // before a request exists. `validateNameSyntax`, not `validateName`: a
    // parent may be a short name a fired `U` released, which rule 6 still
    // rejects.
    const parentCheck = validateNameSyntax(parent)
    if (!parentCheck.ok) return error(400, 'BAD_PARENT')

    // §4.4 exactly, via core — no case folding and no other normalisation. A
    // label is lowercase by rule, `parseQuery` rejects the rest before a
    // request is ever built, and a delegate inventing a second normalisation
    // rule is a delegate answering for names the protocol does not admit.
    const check = validateLabel(label)
    if (!check.ok) return error(400, 'BAD_LABEL')

    // The gate the parent makes possible. A name absent from the file and a
    // label absent from that name are the **same** `NO_ANSWER`: a client must
    // not be able to learn which names a host serves, which is the
    // two-outcomes rule one level up.
    const labels = source.current().names.get(parent)
    const answer = labels?.get(label)
    if (answer === undefined) return error(404, 'NO_ANSWER')

    return {
      status: 200,
      body: { address: formatAddress(answer.address), ttl: answer.ttl },
      headers: { ...CORS, 'cache-control': `public, max-age=${answer.ttl}` },
    }
  }
}
