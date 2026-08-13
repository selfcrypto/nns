/**
 * The six read-only endpoints, as a pure `(method, url) → {status, body}`
 * function — testable without a socket, and the server file stays dumb.
 *
 * No protocol rules live here. Name syntax, address parsing and `MIN_PRICE`
 * all come from `@nns/core`; the one state-dependent judgement — that a name
 * resolves only while `REGISTERED` — is §7.3's rule as `core.resolve`
 * implements it, restated over a single row because the API reads rows, not
 * `NnsState`.
 *
 * Serialisation conventions, applied without exception:
 * - Luna amounts are decimal **strings** — `bigint` does not survive JSON,
 *   and a `number` would round.
 * - Heights are numbers.
 * - Addresses go out in the conventional spaced form; inputs are accepted
 *   with or without spaces (`parseAddress` handles both).
 * - Every state-derived response carries `height`, the snapshot it was read
 *   at (§8.7's first clock — what the answer is true *as of*).
 */

import {
  formatAddress,
  minPrice,
  parseQuery,
  tryParseAddress,
  validateName,
  type Address,
  type NameInvalidReason,
} from '@nns/core'

import {
  NotSyncedError,
  type ApiNameRecord,
  type ApiOffer,
  type Queries,
} from './queries.js'

export interface ApiResponse {
  readonly status: number
  /** Already JSON-serialisable: no `bigint` may reach this field. */
  readonly body: unknown
}

export interface RouteOptions {
  /** §4.1 rule 6 — must match the indexer's list. */
  readonly reservedNames: ReadonlySet<string>
  /** Listing fee for an `O` (§6 `O`), served by `/params`. */
  readonly listingFee: bigint
}

export type RouteHandler = (method: string, url: string) => Promise<ApiResponse>

const respond = (status: number, body: unknown): ApiResponse => ({ status, body })

function serialiseRecord(record: ApiNameRecord): Record<string, unknown> {
  return {
    name: record.name,
    owner: formatAddress(record.owner),
    target: formatAddress(record.target),
    expiry: record.expiry,
    status: record.status,
    recovery: record.recovery === null ? null : formatAddress(record.recovery),
    host: record.host,
  }
}

function serialiseOffer(offer: ApiOffer): Record<string, unknown> {
  return {
    name: offer.name,
    seller: formatAddress(offer.seller),
    price: offer.price.toString(),
    openedHeight: offer.openedHeight,
    expiryHeight: offer.expiryHeight,
  }
}

export function createRoutes(queries: Queries, options: RouteOptions): RouteHandler {
  /** Effectively reserved: on the list and not released by a fired `U`. */
  const reserved = (name: string, unreserved: boolean): boolean =>
    options.reservedNames.has(name) && !unreserved

  async function resolveRoute(name: string): Promise<ApiResponse> {
    // No reserved set on purpose: a reserved name awarded by a `U` (§6 `U`)
    // is registered and must resolve like any other.
    const parsed = parseQuery(name)
    if (!parsed.ok) {
      return respond(400, { error: 'INVALID_NAME', reason: parsed.reason, detail: parsed.detail })
    }
    if (parsed.query.kind === 'dotted') {
      // §8.6: delegated resolution is the client's job — it fetches the
      // parent (with proof, once proofs ship) and queries the delegate host
      // itself. An API that proxied the answer would launder an unverified
      // delegate response through a verified-looking endpoint.
      return respond(400, {
        error: 'DOTTED_QUERY',
        parent: parsed.query.parent,
        detail: 'resolve the parent via /name/{parent} and query its delegate host (§8.6)',
      })
    }

    const { height, value: record } = await queries.record(name)
    if (record === null) return respond(404, { error: 'NOT_FOUND', name, height })
    if (record.status === 'GRACE') {
      // §7.3: resolution is off during GRACE. The record still exists — the
      // owner can renew — so say which of the two absences this is.
      return respond(404, { error: 'IN_GRACE', name, expiry: record.expiry, height })
    }
    return respond(200, {
      name,
      target: formatAddress(record.target),
      status: record.status,
      expiry: record.expiry,
      host: record.host,
      height,
    })
  }

  async function availableRoute(name: string): Promise<ApiResponse> {
    const no = (height: number, reason: NameInvalidReason | 'TAKEN', extra?: Record<string, unknown>): ApiResponse =>
      respond(200, { name, available: false, reason, ...extra, height })

    const { height, value } = await queries.detail(name)

    // §4.1 order: structure first, the reserved list last — then state.
    const structural = validateName(name)
    if (!structural.ok) return no(height, structural.reason)
    if (reserved(name, value.unreserved)) return no(height, 'RESERVED')
    if (value.record !== null) {
      return no(height, 'TAKEN', { status: value.record.status, expiry: value.record.expiry })
    }
    return respond(200, { name, available: true, height })
  }

  async function nameRoute(name: string): Promise<ApiResponse> {
    // Structural check only: reserved names are legitimate subjects here.
    const structural = validateName(name)
    if (!structural.ok) return respond(400, { error: 'INVALID_NAME', reason: structural.reason })

    const { height, value } = await queries.detail(name)
    const isReserved = reserved(name, value.unreserved)
    const nothingKnown =
      value.record === null &&
      value.transfer === null &&
      value.recovery === null &&
      value.offer === null &&
      value.unreserve === null &&
      !isReserved &&
      !value.unreserved
    if (nothingKnown) return respond(404, { error: 'NOT_FOUND', name, height })

    return respond(200, {
      name,
      reserved: isReserved,
      unreserved: value.unreserved,
      record: value.record === null ? null : serialiseRecord(value.record),
      pending: {
        transfer:
          value.transfer === null
            ? null
            : {
                newOwner: formatAddress(value.transfer.newOwner),
                effectiveHeight: value.transfer.effectiveHeight,
                viaRecovery: value.transfer.viaRecovery,
              },
        recovery:
          value.recovery === null
            ? null
            : {
                // null clears the recovery address (§6 `R`) — a value, not an absence.
                recovery: value.recovery.recovery === null ? null : formatAddress(value.recovery.recovery),
                effectiveHeight: value.recovery.effectiveHeight,
              },
        offer: value.offer === null ? null : serialiseOffer(value.offer),
        unreserve:
          value.unreserve === null
            ? null
            : {
                // null releases, an address awards (§6 `U`, r17).
                recipient: value.unreserve.recipient === null ? null : formatAddress(value.unreserve.recipient),
                effectiveHeight: value.unreserve.effectiveHeight,
              },
      },
      height,
    })
  }

  async function addressRoute(input: string): Promise<ApiResponse> {
    const owner: Address | null = tryParseAddress(input)
    if (owner === null) return respond(400, { error: 'INVALID_ADDRESS' })

    const { height, value } = await queries.byOwner(owner)
    return respond(200, {
      address: formatAddress(owner),
      names: value.map((record) => ({
        name: record.name,
        target: formatAddress(record.target),
        expiry: record.expiry,
        status: record.status,
        host: record.host,
      })),
      height,
    })
  }

  async function offersRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.offers()
    return respond(200, { offers: value.map(serialiseOffer), height })
  }

  async function paramsRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.params()
    const prices = {
      feeStandard: value.feeStandard,
      feeLong: value.feeLong,
      commissionBp: value.commissionBp,
    }
    return respond(200, {
      prices: {
        feeStandard: value.feeStandard.toString(),
        feeLong: value.feeLong.toString(),
        commissionBp: value.commissionBp.toString(),
      },
      // §3 MIN_PRICE is FEE_LONG *as in effect at this height* — core's rule,
      // applied to the active prices, never a constant (§6 `O`).
      minPrice: minPrice(prices).toString(),
      listingFee: options.listingFee.toString(),
      lastGovernanceHeight: value.lastGovernanceHeight,
      pendingGovernance:
        value.pending === null
          ? null
          : {
              prices: {
                feeStandard: value.pending.feeStandard.toString(),
                feeLong: value.pending.feeLong.toString(),
                commissionBp: value.pending.commissionBp.toString(),
              },
              effectiveHeight: value.pending.effectiveHeight,
            },
      height,
    })
  }

  return async function handle(method: string, url: string): Promise<ApiResponse> {
    if (method !== 'GET' && method !== 'HEAD') {
      return respond(405, { error: 'METHOD_NOT_ALLOWED' })
    }

    let segments: string[]
    try {
      const pathname = new URL(url, 'http://api.invalid').pathname
      segments = pathname.split('/').filter((s) => s !== '').map(decodeURIComponent)
    } catch {
      return respond(400, { error: 'BAD_REQUEST' })
    }

    try {
      const [head, a, b] = segments
      if (head === 'resolve' && a !== undefined && segments.length === 2) return await resolveRoute(a)
      if (head === 'available' && a !== undefined && segments.length === 2) return await availableRoute(a)
      if (head === 'name' && a !== undefined && segments.length === 2) return await nameRoute(a)
      if (head === 'address' && a !== undefined && b === 'names' && segments.length === 3) {
        return await addressRoute(a)
      }
      if (head === 'offers' && segments.length === 1) return await offersRoute()
      if (head === 'params' && segments.length === 1) return await paramsRoute()
      return respond(404, { error: 'UNKNOWN_ROUTE' })
    } catch (error) {
      if (error instanceof NotSyncedError) {
        return respond(503, { error: 'NOT_SYNCED', detail: error.message })
      }
      throw error
    }
  }
}
