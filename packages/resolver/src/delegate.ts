/**
 * §8.6 delegated resolution — `label.parent`.
 *
 * **This lives here because `packages/api` refuses to do it, and that refusal
 * is deliberate.** The API will not proxy a delegate's answer: doing so would
 * launder an unverified response through an endpoint that looks verified, and
 * a client receiving it could no longer tell which half of its answer was
 * proven. So the boundary is drawn at the client, where the distinction can
 * actually be rendered (§8.5 #6), and this file is the only place in the
 * package that returns an address nothing cryptographic vouches for.
 *
 * What is proven and what is not, exactly:
 *
 * - **Proven:** that `parent` is `REGISTERED`, and that it designates this
 *   host. Both come out of the checkpoint, through the same inclusion proof
 *   any other name gets.
 * - **Not proven:** the address the host returns. §8.6 says that boundary is
 *   the right one — an exchange already controls the deposit addresses it is
 *   naming — but the user has to be told which side of it they are on, which
 *   is why every delegated result carries `DELEGATED_ANSWER`.
 *
 * §8.6's optional signed response is **not implemented**, and cannot be as
 * specified: the signature is Ed25519 "by the parent's owner key", but the
 * response carries no public key and NNS state holds only the owner's
 * *address* — which is a hash of that key. There is nothing to verify
 * against. v1 requires neither producing nor verifying it, so nothing is lost
 * today; recorded in `docs/decisions.md` as a gap in a format §8.6 fixed
 * early precisely so it could be adopted without a spec revision.
 */

import { CONSTANTS, validateHost } from '@nns/core'

import { readDelegateResponse, readErrorCode, type DelegateResponse } from './documents.js'
import { DelegateError } from './errors.js'
import { getJson, type HttpFetch } from './transport.js'

/** §8.6 step 4: cache for `ttl`, capped at one hour by the client. */
export const MAX_DELEGATE_TTL_SEC = 3_600

/** How the delegated half of an answer is described on a result. */
export interface DelegateInfo {
  readonly parent: string
  readonly label: string
  /** The host asked, taken from the parent's `D` record (§6 `D`). */
  readonly host: string
  /** Seconds the answer may be cached, already capped. */
  readonly ttl: number
}

interface CacheEntry {
  readonly response: DelegateResponse
  readonly expiresAtMs: number
}

/**
 * The §8.6 cache. Keyed by `host` and `label` rather than by the dotted query
 * — two parents pointing at one host are two different questions, and one
 * parent that re-points elsewhere must not keep serving the old host's
 * answers.
 */
export class DelegateCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  get(host: string, label: string): DelegateResponse | null {
    const key = `${host}/${label}`
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    if (entry.expiresAtMs <= this.#now()) {
      this.#entries.delete(key)
      return null
    }
    return entry.response
  }

  set(host: string, label: string, response: DelegateResponse, ttlSec: number): void {
    this.#entries.set(`${host}/${label}`, { response, expiresAtMs: this.#now() + ttlSec * 1_000 })
  }

  clear(): void {
    this.#entries.clear()
  }
}

/**
 * Ask a delegate host about one label.
 *
 * The host is re-validated against §6 `D`'s rules before it goes into a URL.
 * It arrives from a record this package did not author, and a host that
 * smuggled a `/` or a `?` past validation would be choosing the path being
 * requested rather than merely the server answering it.
 */
export async function askDelegate(
  fetchImpl: HttpFetch,
  cache: DelegateCache,
  host: string,
  label: string,
  timeoutMs: number,
): Promise<{ readonly response: DelegateResponse; readonly ttl: number }> {
  const hostCheck = validateHost(host)
  if (!hostCheck.ok || host.length === 0) {
    throw new DelegateError('PARENT_NOT_DELEGATING', `delegate host ${JSON.stringify(host)} is not a valid §6 D host`)
  }
  if (label.length === 0 || label.length > CONSTANTS.MAX_LABEL_LEN) {
    throw new DelegateError('DELEGATE_FAILED', `label ${JSON.stringify(label)} is not a valid §4.4 label`)
  }

  const cached = cache.get(host, label)
  if (cached !== null) return { response: cached, ttl: cached.ttl }

  const url = `https://${host}/nns/v1/resolve/${encodeURIComponent(label)}`
  const fetched = await getJson(fetchImpl, url, timeoutMs)
  if (!fetched.ok) {
    throw new DelegateError('DELEGATE_FAILED', `delegate ${host} did not answer: ${fetched.reason}`)
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    const code = readErrorCode(fetched.body)
    throw new DelegateError(
      'DELEGATE_FAILED',
      `delegate ${host} answered ${fetched.status}${code === null ? '' : ` ${code}`}`,
    )
  }

  // A malformed body is the host's failure, and must read as one. Left
  // uncaught it surfaces as `DOCUMENT_MALFORMED` — the same code a *resolver*
  // serving a broken §8.3 document earns — which conflates our own
  // infrastructure misbehaving with a third party's, and is the one hole in
  // the rule that everything at or beyond the host collapses to one outcome.
  let response: DelegateResponse
  try {
    response = readDelegateResponse(fetched.body, `delegate ${host}`)
  } catch (error) {
    throw new DelegateError(
      'DELEGATE_FAILED',
      `delegate ${host} answered with something that is not §8.6's shape: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const ttl = Math.min(response.ttl, MAX_DELEGATE_TTL_SEC)
  cache.set(host, label, response, ttl)
  return { response, ttl }
}
