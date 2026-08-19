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
 * The request carries **the parent and the label** (r23):
 *
 *     GET https://<host>/<parent>/<label>
 *
 * Through r22 it carried only the label, which made two names delegating to
 * one bare host a single shared namespace — `shop.a` and `shop.b` were the
 * same request and one answer served both, silently, with a payment address
 * as the wrong answer. §6 `D`'s short path was the stated remedy and did not
 * stretch: `MAX_HOST_LEN` is 30 characters for host and path together, which
 * fits one exchange on its own domain and fails for a provider serving
 * customers by name.
 *
 * §8.6's optional signed response is **not implemented**, and cannot be as
 * specified: the signature is Ed25519 "by the parent's owner key", but the
 * response carries no public key and NNS state holds only the owner's
 * *address* — which is a hash of that key. There is nothing to verify
 * against. r23 added the parent to that payload, which closes a replay
 * between two names one owner holds, but does **not** make the scheme
 * implementable — the missing public key is a separate, still-open gap
 * recorded in `docs/decisions.md`. v1 requires neither producing nor
 * verifying it, so nothing is lost today.
 */

import { CONSTANTS, validateHost, validateNameSyntax } from '@nns/core'

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
 * The §8.6 cache, keyed by `host`, `parent` and `label` — the same triple the
 * request carries, so the key is the question.
 *
 * Through r22 the key was `host` and `label` alone, because the request was
 * label-only and two parents on one host were genuinely the same question.
 * That is what r23 fixed: the parent is now in the request, so two parents on
 * one host are two questions and must be two entries. The host stays in the
 * key for the reason it always was — a parent that re-points elsewhere must
 * not keep serving the old host's answers.
 */
export class DelegateCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  get(host: string, parent: string, label: string): DelegateResponse | null {
    const key = `${host}/${parent}/${label}`
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    if (entry.expiresAtMs <= this.#now()) {
      this.#entries.delete(key)
      return null
    }
    return entry.response
  }

  set(host: string, parent: string, label: string, response: DelegateResponse, ttlSec: number): void {
    this.#entries.set(`${host}/${parent}/${label}`, { response, expiresAtMs: this.#now() + ttlSec * 1_000 })
  }

  clear(): void {
    this.#entries.clear()
  }
}

/**
 * Ask a delegate host about one label under one parent.
 *
 * The host is re-validated against §6 `D`'s rules before it goes into a URL.
 * It arrives from a record this package did not author, and a host that
 * smuggled a `/` or a `?` past validation would be choosing the path being
 * requested rather than merely the server answering it. The **parent** is
 * checked for the same reason and not because the caller is doubted: `resolve`
 * always supplies one `parseQuery` produced, but this function is exported for
 * delegate implementations to test against, so a parent carrying a `/` would
 * inject a path segment exactly as a bad host would. `validateNameSyntax` is
 * the right rule rather than `validateName` — a parent may be a short name a
 * fired `U` released, which rule 6 would still reject.
 *
 * **No fallback to any earlier path.** A client that retried the r22
 * `/nns/v1/resolve/<label>` on a 404 would keep the shape that made two names
 * on one host share a namespace reachable forever, and hand anyone able to
 * force a 404 a downgrade to it. The same holds for r24's
 * `/delegated/v1/<parent>/<label>`, which r25 dropped entire: one shape, tried
 * once. An un-migrated delegate fails loudly instead — every label under it
 * stops resolving at once, which is a diagnosis rather than a wrong address.
 *
 * **Nothing is appended before the parent (r25).** The path is the host's,
 * end to end: an operator who wants the word `delegated` in the URL puts it in
 * the `D` — as a subdomain or as §6's short path — and one who does not, does
 * not. Appending it here made that choice for them and then made it twice,
 * since the obvious host to record is the one named after the service:
 * `delegated.example.com/delegated/alice/shop`. The registry API never had the
 * problem because `api` names its host and `resolve` names its route.
 */
export async function askDelegate(
  fetchImpl: HttpFetch,
  cache: DelegateCache,
  host: string,
  parent: string,
  label: string,
  timeoutMs: number,
): Promise<{ readonly response: DelegateResponse; readonly ttl: number }> {
  const hostCheck = validateHost(host)
  if (!hostCheck.ok || host.length === 0) {
    throw new DelegateError('PARENT_NOT_DELEGATING', `delegate host ${JSON.stringify(host)} is not a valid §6 D host`)
  }
  const parentCheck = validateNameSyntax(parent)
  if (!parentCheck.ok) {
    throw new DelegateError('DELEGATE_FAILED', `parent ${JSON.stringify(parent)} is not a valid §4.1 name: ${parentCheck.reason}`)
  }
  if (label.length === 0 || label.length > CONSTANTS.MAX_LABEL_LEN) {
    throw new DelegateError('DELEGATE_FAILED', `label ${JSON.stringify(label)} is not a valid §4.4 label`)
  }

  const cached = cache.get(host, parent, label)
  if (cached !== null) return { response: cached, ttl: cached.ttl }

  const url = `https://${host}/${encodeURIComponent(parent)}/${encodeURIComponent(label)}`
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
  cache.set(host, parent, label, response, ttl)
  return { response, ttl }
}
