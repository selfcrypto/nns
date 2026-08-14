/**
 * HTTP, and nothing else.
 *
 * No verification, no policy, no interpretation of a body beyond "did JSON
 * come back". Kept separate so the quorum tests can drive whole scenarios —
 * one resolver lying, one timing out, two disagreeing — through a plain
 * function instead of a socket, the way `packages/api` keeps its routes a
 * pure `(method, url) → {status, body}`.
 *
 * The `fetch` shape is declared structurally rather than as `typeof fetch`.
 * The global signature drags in `Request`, `Headers` and a `Response` a test
 * would have to construct in full; this narrows it to what the package
 * actually calls, and both the browser and Node globals satisfy it.
 */

import { ResolverError } from './errors.js'

export interface HttpResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export type HttpFetch = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<HttpResponse>

/**
 * One resolver, as the host app configures it.
 *
 * `name` is not decoration: §8.5 #2's disagreement has to be reportable as
 * "these two parties said different things", and a URL is not a party.
 */
export interface ResolverEndpoint {
  /** How this party is named to the user when it disagrees or fails. */
  readonly name: string
  /** Base URL of an NNS API. Trailing slash optional. */
  readonly url: string
}

/** A reply that arrived and parsed. Its `status` may still be 404 or 503 — those are answers. */
export interface FetchedOk {
  readonly ok: true
  readonly status: number
  readonly body: unknown
}

/** What came back, with the transport's own failures folded into one shape. */
export type Fetched = FetchedOk | { readonly ok: false; readonly status: number | null; readonly reason: string }

const DEFAULT_TIMEOUT_MS = 5_000

/** Join a base URL with an already-encoded path, tolerating a trailing slash on either. */
export function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * GET one URL and parse JSON.
 *
 * A non-2xx is **not** a transport failure: the API answers 404 `NOT_FOUND`
 * and 404 `IN_GRACE` with bodies that are real answers, and quorum has to
 * compare them against what the other resolvers said. Only an unreachable
 * host, a timeout or a body that is not JSON lands in the `ok: false` branch,
 * where it removes the party from the count rather than becoming a
 * disagreement.
 */
export async function getJson(
  fetchImpl: HttpFetch,
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Fetched> {
  let response: HttpResponse
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.message : 'request failed' }
  }

  try {
    return { ok: true, status: response.status, body: await response.json() }
  } catch {
    return { ok: false, status: response.status, reason: 'response body is not JSON' }
  }
}

/** The default `fetch`, or a clear error if the runtime has none. */
export function defaultFetch(): HttpFetch {
  const global = (globalThis as { fetch?: HttpFetch }).fetch
  if (global === undefined) {
    throw new ResolverError('CONFIGURATION', 'no global fetch in this runtime — pass one as options.fetch')
  }
  return (url, init) => global(url, init)
}
